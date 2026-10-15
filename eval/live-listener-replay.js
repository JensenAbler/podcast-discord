#!/usr/bin/env node
// Isolated replay of deployed Quartz listening/playback; recorded Alpha timing, no Alpha generation.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),cp=require('child_process'),{EventEmitter}=require('events');
const root='/opt/podcast-discord';
const pid=cp.execFileSync('systemctl',['show','podcast-discord','--property=MainPID','--value'],{encoding:'utf8'}).trim();
const runningEnv=Object.fromEntries(fs.readFileSync('/proc/'+pid+'/environ','utf8').split('\0').filter(Boolean).map(s=>{const i=s.indexOf('=');return [s.slice(0,i),s.slice(i+1)]}));
const env={...runningEnv};
for(const line of fs.readFileSync(path.join(root,'.env'),'utf8').split('\n')){const m=line.match(/^([^=]+)=(.*)$/);if(m&&!env[m[1]])env[m[1]]=m[2];}
for(const k of ['PODCAST_QUARTZ_STATE_CHANNEL','PODCAST_QUARTZ_OUTPUT_GAIN']) if(env[k])process.env[k]=env[k];else delete process.env[k];
const {QuartzPlayback}=require(root+'/quartz-playback');
const {BACKCHANNEL_PROMPT}=require(root+'/gpt-live-backchannel');
const {createAudioPlayer}=require(root+'/node_modules/@discordjs/voice');
const Opus=require(root+'/node_modules/opusscript');
const [episode,out,startArg='0',durationArg='300']=process.argv.slice(2),startMs=Number(startArg)*1000,durationMs=Number(durationArg)*1000,endMs=startMs+durationMs;
if(!episode||!out||fs.existsSync(out))throw Error('Need episode and unique output directory');
fs.mkdirSync(out,{recursive:true});
const rows=n=>fs.readFileSync(path.join(episode,n),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const journal=rows('audio-journal/chunks.jsonl'), transcript=rows('transcript.jsonl'), origin=JSON.parse(fs.readFileSync(path.join(episode,'audio-journal/manifest.json'))).startedAtMs;
const parts=journal.filter(e=>e.type==='pcm'&&e.sourceType==='participant'&&e.timelineOffsetMs>=startMs&&e.timelineOffsetMs<endMs);
const files=new Map(),actions=[],activity=[];
for(const e of parts){const f=path.join(episode,'audio-journal',e.file);if(!files.has(f))files.set(f,fs.openSync(f,'r'));const pcm=Buffer.alloc(e.byteLength);if(fs.readSync(files.get(f),pcm,0,pcm.length,e.byteOffset)!==pcm.length)throw Error('Incomplete PCM');actions.push({t:e.timelineOffsetMs-startMs,kind:'pcm',id:e.sourceId,pcm});}
for(const id of new Set(parts.map(e=>e.sourceId))){
 const chunks=parts.filter(e=>e.sourceId===id).sort((a,b)=>a.timelineOffsetMs-b.timelineOffsetMs);let span=null;
 for(const e of chunks){const s=e.timelineOffsetMs-startMs,z=Math.min(durationMs,s+e.durationMs);if(!span||s-span.end>150){span={id,start:s,end:z};activity.push(span);}else span.end=Math.max(span.end,z);}
}
for(const span of activity){actions.push({t:span.start,kind:'guest-start',id:span.id},{t:span.end,kind:'guest-end',id:span.id});}
const hosts=transcript.filter(e=>e.speakerRole==='host'&&e.source!=='quartz'&&e.playbackStartedAt&&e.playbackEndedAt).map(e=>({start:Date.parse(e.playbackStartedAt)-origin-startMs,end:Date.parse(e.playbackEndedAt)-origin-startMs})).filter(e=>e.end>0&&e.start<durationMs);
for(const h of hosts){actions.push({t:Math.max(0,h.start),kind:'alpha-start'},{t:Math.min(durationMs,h.end),kind:'alpha-end'});}
for(const e of transcript.filter(e=>e.speakerRole==='guest'&&e.text&&e.asrCompletedAt)){const t=Date.parse(e.asrCompletedAt)-origin-startMs;if(t>=0&&t<durationMs)actions.push({t,kind:'text',text:e.text});}
actions.sort((a,b)=>a.t-b.t || (a.kind==='guest-start'?-1:1));
const events=[],consumed=[],played=[],raw=[],errors=[],lags=[];
let zero=Date.now(),offset=0;
const fd=fs.openSync(path.join(out,'consumed.pcm'),'w');
class Sink extends EventEmitter{
 constructor(){super();this.state={status:'ready'};this.decoder=new Opus(48000,2,Opus.Application.AUDIO);}
 subscribe(player){if(this.subscription?.player===player)return this.subscription;this.subscription?.unsubscribe();return this.subscription=player.subscribe(this);}
 onSubscriptionRemoved(s){if(this.subscription===s)this.subscription=null;}setSpeaking(){}dispatchAudio(){}
 prepareAudioPacket(packet){const pcm=Buffer.from(this.decoder.decode(packet));let sum=0;for(let i=0;i<pcm.length;i+=4){const v=pcm.readInt16LE(i);sum+=v*v;}const t=Date.now()-zero;consumed.push({t,rms:Math.sqrt(sum/(pcm.length/4)),state:q.client.environment,offset,bytes:pcm.length});fs.writeSync(fd,pcm);offset+=pcm.length;}
}
const sink=new Sink(),alpha=createAudioPlayer(),q=new QuartzPlayback({connection:sink,alphaPlayer:alpha,apiKey:env.PODCAST_LIVE_API_KEY,voice:'quartz',
 onLog:message=>events.push({t:Date.now()-zero,message}),onError:e=>errors.push({t:Date.now()-zero,message:e.message}),onPlayedTranscript:e=>played.push({t:Date.now()-zero,...e}),onTranscript:e=>raw.push({t:Date.now()-zero,...e})});
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const manifest={episode,startMs,durationMs,productionCommit:cp.execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),stateChannel:q.client.stateChannel,voice:q.client.voice,turnControl:q.client.turnControl,promptSha256:sha(BACKCHANNEL_PROMPT),outputGain:env.PODCAST_QUARTZ_OUTPUT_GAIN||'4',inputs:[...files.keys()].map(f=>({path:f,bytes:fs.statSync(f).size})),journalSha256:sha(fs.readFileSync(path.join(episode,'audio-journal/chunks.jsonl'))),transcriptSha256:sha(fs.readFileSync(path.join(episode,'transcript.jsonl'))),scope:'Recorded isolated participant PCM and original ASR completion updates; real production Quartz client, mixer, gate, gain, Opus player and local sink. Recorded Alpha playback state/reset timing; no live Alpha generation or fresh ASR. Human turn grouping and acknowledgments require separate analysis.'};
fs.writeFileSync(path.join(out,'manifest.json'),JSON.stringify(manifest,null,2));
const wait=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{let failure=null;const active=new Set();try{
 await q.start();zero=Date.now();console.log('REPLAY_STARTED',JSON.stringify({stateChannel:q.client.stateChannel,durationMs,actions:actions.length}));
 for(const a of actions){await wait(Math.max(0,a.t-(Date.now()-zero)));const lag=Date.now()-zero-a.t;if(lag>80)lags.push(lag);
 if(errors.length)throw Error(errors.at(-1).message);
 if(a.kind==='pcm')q.pushAudio(a.id,a.pcm);
 if(a.kind==='guest-start'){active.add(a.id);q.updateAlphaProgress('guest speaking');}
 if(a.kind==='guest-end'){active.delete(a.id);if(!active.size)q.updateAlphaProgress('guest finished');}
 if(a.kind==='text')q.appendConversation('Guest transcript',a.text);
 if(a.kind==='alpha-start'){q.setBlocked(true);q.client.resetForAlphaPlayback();}
 if(a.kind==='alpha-end')q.setBlocked(false);
 }
 await wait(Math.max(0,durationMs-(Date.now()-zero)));
}catch(e){failure=e.message;console.error('REPLAY_FAILURE',failure);}
finally{await q.stop();alpha.stop();sink.subscription?.unsubscribe();sink.decoder.delete();fs.closeSync(fd);for(const f of files.values())fs.closeSync(f);
 fs.writeFileSync(path.join(out,'metrics.json'),JSON.stringify({manifest,activity,hosts,consumed,played,raw,events,errors,lags,failure}));
 console.log('REPLAY_COMPLETE',JSON.stringify({out,failure,consumedFrames:consumed.length,playedRows:played.length,lateActions:lags.length,maxLateMs:Math.max(0,...lags)}));process.exit(failure?1:0);}
})();
