#!/usr/bin/env node
'use strict';
// Offline replay through the deployed Quartz path. No Discord publishing or runtime edits.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),cp=require('child_process');
const {EventEmitter}=require('events');
const {performance,monitorEventLoopDelay}=require('perf_hooks');
const {runTimeline,ReplayIntegrityError,validity}=require('./replay-timing');
const root=path.resolve(__dirname,'..'), runtimeRoot='/opt/podcast-discord';
const [episode,out,startArg='0',durationArg='300',warmupArg='0',replayMode='continuous']=process.argv.slice(2);
const startMs=Math.round(Number(startArg)*1000),durationMs=Math.round(Number(durationArg)*1000),warmupMs=Math.round(Number(warmupArg)*1000),endMs=startMs+durationMs,maxLateMs=100;
if(!episode||!out||fs.existsSync(out)||![startMs,durationMs,warmupMs].every(Number.isFinite)||startMs<0||durationMs<=0||durationMs>600000||warmupMs<0||warmupMs>=durationMs)throw Error('Need unique output, nonnegative start and warmup, and duration <=600 seconds');
const lock='/var/lib/praxis-root/home/quartz-eval.lock';
let lockFd;
try{lockFd=fs.openSync(lock,'wx',0o600);fs.writeSync(lockFd,JSON.stringify({pid:process.pid,out,startedAt:new Date().toISOString()}));}
catch(e){throw Error('Another eval holds '+lock+'; inspect its owner before recovery');}
const release=()=>{try{fs.closeSync(lockFd);fs.unlinkSync(lock);}catch{}};
process.on('exit',release);
fs.mkdirSync(out,{recursive:true});
const pid=cp.execFileSync('systemctl',['show','podcast-discord','--property=MainPID','--value'],{encoding:'utf8'}).trim();
const env=Object.fromEntries(fs.readFileSync('/proc/'+pid+'/environ','utf8').split('\0').filter(Boolean).map(s=>{const i=s.indexOf('=');return [s.slice(0,i),s.slice(i+1)]}));
for(const line of fs.readFileSync(path.join(runtimeRoot,'.env'),'utf8').split('\n')){const m=line.match(/^([^=]+)=(.*)$/);if(m&&!env[m[1]])env[m[1]]=m[2];}
for(const k of ['PODCAST_QUARTZ_STATE_CHANNEL','PODCAST_QUARTZ_OUTPUT_GAIN'])if(env[k])process.env[k]=env[k];else delete process.env[k];
const {QuartzPlayback}=require(root+'/quartz-playback');
const {BACKCHANNEL_PROMPT}=require(root+'/gpt-live-backchannel');
const {createAudioPlayer}=require(root+'/node_modules/@discordjs/voice');
const Opus=require(root+'/node_modules/opusscript');
// Warm the local WASM codec before starting the measured source clock.
// This sends no audio to the provider and preserves the production codec path.
const codecWarmupStart=performance.now(),warmEncoder=new Opus(48000,2,Opus.Application.AUDIO),warmDecoder=new Opus(48000,2,Opus.Application.AUDIO),warmPcm=Buffer.alloc(3840);
for(let i=0;i<960;i++){const v=Math.round(1000*Math.sin(i/20));warmPcm.writeInt16LE(v,i*4);warmPcm.writeInt16LE(v,i*4+2);}
for(let i=0;i<100;i++)warmDecoder.decode(warmEncoder.encode(warmPcm,960));
warmEncoder.delete();warmDecoder.delete();const codecWarmupMs=performance.now()-codecWarmupStart;

const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const productionCommit=()=>cp.execFileSync('git',['-C',runtimeRoot,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
const rows=n=>fs.readFileSync(path.join(episode,n),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const inputManifest=JSON.parse(fs.readFileSync(path.join(episode,'audio-journal/manifest.json')));
const journal=rows('audio-journal/chunks.jsonl'),transcript=rows('transcript.jsonl'),origin=inputManifest.startedAtMs;
const parts=journal.filter(e=>e.type==='pcm'&&e.sourceType==='participant'&&e.timelineOffsetMs>=startMs&&e.timelineOffsetMs<endMs);
if(!parts.length)throw Error('No input PCM in requested window');
const files=new Map(),actions=[],activity=[];
for(const e of parts){const f=path.join(episode,'audio-journal',e.file);if(!files.has(f))files.set(f,fs.openSync(f,'r'));actions.push({t:e.timelineOffsetMs-startMs,kind:'pcm',id:e.sourceId,fd:files.get(f),byteLength:e.byteLength,byteOffset:e.byteOffset});}
for(const id of new Set(parts.map(e=>e.sourceId))){
 let span=null;
 for(const e of parts.filter(e=>e.sourceId===id).sort((a,b)=>a.timelineOffsetMs-b.timelineOffsetMs)){
  const s=e.timelineOffsetMs-startMs,z=Math.min(durationMs,s+e.durationMs);
  if(!span||s-span.end>150){span={id,start:s,end:z};activity.push(span);}else span.end=Math.max(span.end,z);
 }
}
for(const s of activity)actions.push({t:s.start,kind:'guest-start',id:s.id},{t:s.end,kind:'guest-end',id:s.id});
const hosts=transcript.filter(e=>e.speakerRole==='host'&&e.source!=='quartz'&&e.playbackStartedAt&&e.playbackEndedAt).map(e=>({start:Date.parse(e.playbackStartedAt)-origin-startMs,end:Date.parse(e.playbackEndedAt)-origin-startMs})).filter(e=>e.end>0&&e.start<durationMs);
for(const h of hosts)actions.push({t:Math.max(0,h.start),kind:'alpha-start'},{t:Math.min(durationMs,h.end),kind:'alpha-end'});
// Audio-only replay: no duplicate transcript actions or future reference labels.
const priority={'alpha-end':0,'alpha-start':1,'guest-end':2,'guest-start':3,'text':4,'pcm':5};
actions.sort((a,b)=>a.t-b.t||priority[a.kind]-priority[b.kind]);
const events=[],consumed=[],played=[],raw=[],errors=[],lags=[],actionTiming=[];
let zero=performance.now(),started=false,offset=0,progressTimer=null,cancelled=false,inputUnavailable=0,inputDrops=0,maxLag=0;
const now=()=>started?performance.now()-zero:0;
const fd=fs.openSync(path.join(out,'consumed.pcm'),'w'),traceFd=fs.openSync(path.join(out,'trace.jsonl'),'w');
const trace=(type,data)=>fs.writeSync(traceFd,JSON.stringify({type,...data})+'\n');
const record=(type,list,data)=>{list.push(data);trace(type,data);};
for(const sig of ['SIGTERM','SIGINT'])process.on(sig,()=>{cancelled=true;});
class Sink extends EventEmitter{
 constructor(){super();this.state={status:'ready'};this.decoder=new Opus(48000,2,Opus.Application.AUDIO);}
 subscribe(player){if(this.subscription?.player===player)return this.subscription;this.subscription?.unsubscribe();return this.subscription=player.subscribe(this);}
 onSubscriptionRemoved(s){if(this.subscription===s)this.subscription=null;}setSpeaking(){}dispatchAudio(){}
 prepareAudioPacket(packet){
  if(!started)return;
  const pcm=Buffer.from(this.decoder.decode(packet));let sum=0;for(let i=0;i<pcm.length;i+=4){const v=pcm.readInt16LE(i);sum+=v*v;}
  record('consumed',consumed,{t:now(),rms:Math.sqrt(sum/(pcm.length/4)),state:q.client.environment,offset,bytes:pcm.length});
  fs.writeSync(fd,pcm);offset+=pcm.length;
 }
}
const history=transcript.filter(e=>e.speakerRole==='guest' && e.text && e.asrCompletedAt &&
 Date.parse(e.asrCompletedAt)<=origin+startMs).map(e=>({role:'user',text:e.text}));
const sink=new Sink(),alpha=createAudioPlayer();
const q=new QuartzPlayback({connection:sink,alphaPlayer:alpha,apiKey:env.PODCAST_LIVE_API_KEY,voice:'quartz',stateChannel:'instructions',history,
 onLog:message=>{if(message.startsWith('Input audio dropped:'))inputDrops++;record('event',events,{t:now(),phase:started?'replay':'startup',message});},
 onError:e=>record('error',errors,{t:now(),message:e.message}),
 onPlayedTranscript:e=>record('played',played,{t:now(),...e}),onTranscript:e=>record('raw',raw,{t:now(),...e})});
const codeHash=()=>sha(Buffer.concat(['gpt-live-backchannel.js','quartz-playback.js','live-context-queue.js'].map(n=>fs.readFileSync(path.join(root,n)))));
const manifest={sourceRoot:root,schemaVersion:2,replayMode,transcriptInput:'startup-history-only; no live transcript appends',startupHistoryMessages:q.client.recoveryHistory.length,episode,startMs,durationMs,scoreStartMs:warmupMs,productionCommit:productionCommit(),stateChannel:q.client.stateChannel,voice:q.client.voice,turnControl:q.client.turnControl,promptSha256:sha(BACKCHANNEL_PROMPT),outputGain:env.PODCAST_QUARTZ_OUTPUT_GAIN||'4',clock:'performance.now monotonic',maxLateMs,codecWarmupMs,
 harnessSha256:sha(fs.readFileSync(__filename)),timingModuleSha256:sha(fs.readFileSync(path.join(__dirname,'replay-timing.js'))),
 productionCodeSha256:codeHash(),
 journalSha256:sha(fs.readFileSync(path.join(episode,'audio-journal/chunks.jsonl'))),transcriptSha256:sha(fs.readFileSync(path.join(episode,'transcript.jsonl'))),
 scope:inputManifest.scope||'Isolated participant replay; recorded Alpha timing, no new Alpha generation.',alignment:inputManifest.sourceType==='aligned-publisher-mix'?inputManifest:undefined};
if(inputManifest.referenceFile&&sha(fs.readFileSync(inputManifest.referenceFile))!==inputManifest.referenceSha256)throw Error('Reference changed since input preparation');
fs.writeFileSync(path.join(out,'manifest.json'),JSON.stringify(manifest,null,2));
const sleep=ms=>new Promise(r=>setTimeout(r,ms)),delay=monitorEventLoopDelay({resolution:10});delay.enable();
(async()=>{
 let failure=null,completedMs=0;const active=new Set();
 const check=()=>{
  if(cancelled)throw new ReplayIntegrityError('cancelled','Replay cancelled');
  if(errors.length){const message=errors.at(-1).message;throw new ReplayIntegrityError(/content_filter/.test(message)?'provider-content-filter':'provider-error',message);}
  if(inputDrops)throw new ReplayIntegrityError('input-loss','Mixer reported dropped input');
 };
 try{
  await q.start();
  { // Wait for startup controls while continuous silence advances the Live timeline.
   if(activity.some(s=>s.start===0))q.updateAlphaProgress('guest speaking');
   const readyDeadline=performance.now()+15000;
   while(q.client.contextQueue.pending.size||q.client.contextQueue.waiting.length){
    check();
    if(q.client.recovering||!q.client.started)throw new ReplayIntegrityError('startup-not-ready','Quartz restarted before startup context was accepted');
    if(performance.now()>readyDeadline)throw new ReplayIntegrityError('startup-not-ready','Startup context acknowledgment timed out');
    await sleep(10);
   }
   if(!q.client.started||q.client.recovering)throw new ReplayIntegrityError('startup-not-ready','Quartz not ready after startup context');
  }
  zero=performance.now();started=true;
  progressTimer=setInterval(()=>{const p={elapsedMs:now(),durationMs,consumedFrames:consumed.length,errorCount:errors.length,maxLagMs:maxLag,inputUnavailable};fs.writeFileSync(path.join(out,'progress.json'),JSON.stringify(p));console.log('REPLAY_PROGRESS',JSON.stringify(p));},60000);
  console.log('REPLAY_STARTED',JSON.stringify({stateChannel:q.client.stateChannel,durationMs,actions:actions.length}));
  await runTimeline(actions,{now,sleep,maxLateMs,endMs:durationMs,check,
   record:t=>{maxLag=Math.max(maxLag,t.lagMs);if(t.lagMs>80)lags.push(t.lagMs);actionTiming.push(t);trace('action',t);},
   dispatch:a=>{
    if(a.kind==='pcm'){
     if(!q.client.started||q.client.closing){inputUnavailable++;throw new ReplayIntegrityError('input-loss','Quartz unavailable at scheduled guest audio',{sourceMs:startMs+a.t});}
     const pcm=Buffer.alloc(a.byteLength);if(fs.readSync(a.fd,pcm,0,pcm.length,a.byteOffset)!==pcm.length)throw Error('Incomplete PCM');q.pushAudio(a.id,pcm);
    }
    if(a.kind==='guest-start'){active.add(a.id);q.updateAlphaProgress('guest speaking');}
    if(a.kind==='guest-end'){active.delete(a.id);if(!active.size)q.updateAlphaProgress('guest finished');}
    if(a.kind==='alpha-start'){q.setBlocked(true);}
    if(a.kind==='alpha-end')q.setBlocked(false);
   }});
 }catch(e){failure={code:e.code||'harness-error',message:e.message,details:e.details||{}};console.error('REPLAY_FAILURE',JSON.stringify(failure));}
 finally{
  completedMs=started?Math.min(durationMs,now()):0;clearInterval(progressTimer);
  try{await q.stop();}catch(e){failure=failure||{code:'shutdown-error',message:e.message};}
  alpha.stop();sink.subscription?.unsubscribe();sink.decoder.delete();delay.disable();
  for(const f of files.values())fs.closeSync(f);fs.closeSync(fd);
  const quality=validity({failure,completedMs,durationMs,maxLag,maxLateMs,inputUnavailable,inputDrops,configurationChanged:codeHash()!==manifest.productionCodeSha256});
  const eventLoop={p50Ms:delay.percentile(50)/1e6,p95Ms:delay.percentile(95)/1e6,maxMs:delay.max/1e6};
  trace('final',{failure,completedMs,validity:quality,eventLoop});fs.closeSync(traceFd);
  const metrics={manifest,activity,hosts,consumed,played,raw,events,errors,lags,actionTiming,failure,completedMs,validity:quality,eventLoop,inputUnavailable,inputDrops};
  fs.writeFileSync(path.join(out,'metrics.json.tmp'),JSON.stringify(metrics));fs.renameSync(path.join(out,'metrics.json.tmp'),path.join(out,'metrics.json'));
  fs.writeFileSync(path.join(out,'validity.json'),JSON.stringify(quality,null,2));
  console.log('REPLAY_COMPLETE',JSON.stringify({out,failure,validity:quality,eventLoop}));release();process.exit(quality.timingValid?0:1);
 }
})();
