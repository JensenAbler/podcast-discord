#!/usr/bin/env node
// Opt-in end-to-end diagnostic: real bot/providers, local Discord transport only.
const fs=require('node:fs'),path=require('node:path'),{EventEmitter}=require('node:events'),{PassThrough}=require('node:stream');
const [episode, output, channel='thinking', timing='response-relative', hold='0']=process.argv.slice(2);
const minimumHoldMs=Number(hold);
if(!Number.isFinite(minimumHoldMs)||minimumHoldMs<0||minimumHoldMs>25000)throw Error('hold must be 0..25000 ms');
if(process.env.QUARTZ_FULL_EVAL!=='1'||!episode||!output||!['thinking','instructions','commentary'].includes(channel))
 throw Error('Set QUARTZ_FULL_EVAL=1; arguments: episode output channel');
fs.mkdirSync(output,{recursive:true});
process.env.RECORDING_DIR=path.join(output,'recordings');
process.env.PODCAST_LOG_FILE=path.join(output,'runtime.log');
process.env.TARGET_SESSION_KEY='agent:main:quartz-eval-'+path.basename(output);
const Opus=require('opusscript');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const read=n=>JSON.parse(fs.readFileSync(path.join(episode,n),'utf8'));
const rows=n=>fs.readFileSync(path.join(episode,n),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const raw=[],consumed=[],events=[],rawPcm=[];let zero=Date.now(),rawOffset=0, sinkOffset=0;
const sinkFd=fs.openSync(path.join(output,'consumed.pcm'),'w');
const live=require('../gpt-live-backchannel'),RealLive=live.GptLiveBackchannel;
live.GptLiveBackchannel=class extends RealLive{
 constructor(options){
  super({...options,stateChannel:channel,onOutputAudio:(pcm,span)=>{
   let sum=0,peak=0;for(let i=0;i<pcm.length;i+=2){const v=pcm.readInt16LE(i);sum+=v*v;peak=Math.max(peak,Math.abs(v));}
   raw.push({t:Date.now()-zero,state:this.environment,blocked:span.blocked,session:span.sessionId,offset:rawOffset,bytes:pcm.length,rms:Math.sqrt(sum/(pcm.length/2)),peak});
   rawPcm.push(Buffer.from(pcm));rawOffset+=pcm.length;options.onOutputAudio?.(pcm,span);
  },onLog:message=>{events.push({t:Date.now()-zero,message});options.onLog?.(message);}});
 }
};
const {AlphaClawdVoiceBot}=require('../bot'),{loadResumeSource}=require('../podcast-resume');
class LocalVoiceConnection extends EventEmitter{
 constructor(){
  super();this.state={status:'ready'};this.streams=new Map();this.decoder=new Opus(48000,2,Opus.Application.AUDIO);
  this.receiver={speaking:new EventEmitter(),subscriptions:this.streams,ssrcMap:new Map(),subscribe:id=>{
   if(!this.streams.has(id))this.streams.set(id,new PassThrough({objectMode:true}));
   return this.streams.get(id);
  }};
 }
 subscribe(player){
  if(this.subscription?.player===player)return this.subscription;
  this.subscription?.unsubscribe();this.subscription=player.subscribe(this);return this.subscription;
 }
 onSubscriptionRemoved(s){if(this.subscription===s)this.subscription=null;}
 setSpeaking(){}
 prepareAudioPacket(packet){
  const pcm=Buffer.from(this.decoder.decode(packet)), quartz=bot.voiceManager.quartzBackchannels.get(guild);
  let sum=0;for(let i=0;i<pcm.length;i+=4){const v=pcm.readInt16LE(i);sum+=v*v;}
  consumed.push({t:Date.now()-zero,source:this.subscription?.player===bot.voiceManager.players.get(guild)?'alpha':'quartz',
   state:quartz?.client.environment,rms:Math.sqrt(sum/(pcm.length/4)),offset:sinkOffset,bytes:pcm.length});
  fs.writeSync(sinkFd,pcm);sinkOffset+=pcm.length;
 }
 dispatchAudio(){}
 destroy(){this.subscription?.unsubscribe();this.state={status:'destroyed'};this.decoder.delete();}
}
const identity=read('resume-identity.json'),guild=identity.guildId;
const guestRows=rows('transcript.jsonl').filter(e=>e.speakerRole==='guest');
const speakerMap=Object.fromEntries(guestRows.map(e=>[e.userId,{name:e.speaker,role:'guest'}]));
const bot=new AlphaClawdVoiceBot({speakerMap});
let providerFailure=null;
const noteProviderFailure=error=>{
 providerFailure ||= error;
 events.push({t:Date.now()-zero,message:'Harness provider failure: '+error.message});
};
for(const method of ['generate','generateStreaming']){
 const original=bot.podcastGenerator[method].bind(bot.podcastGenerator);
 bot.podcastGenerator[method]=async(...args)=>{
  if(providerFailure)throw providerFailure;
  try{
   const result=await original(...args);
   result?.completed?.catch(noteProviderFailure);
   return result;
  }catch(error){noteProviderFailure(error);throw error;}
 };
}
const connection=new LocalVoiceConnection();
let lastGuestEnd=null;
const progress=bot.voiceManager.updateQuartzProgress.bind(bot.voiceManager);
bot.voiceManager.updateQuartzProgress=(id,stage,...rest)=>{
 if(stage==='guest finished')lastGuestEnd=Date.now();
 if(stage==='guest speaking')lastGuestEnd=null;
 return progress(id,stage,...rest);
};
const speak=bot.voiceManager.speak.bind(bot.voiceManager);
bot.voiceManager.speak=async(id,audio,options)=>{
 // Controlled latency stress only. Generation and synthesis are still real.
 if(minimumHoldMs&&lastGuestEnd!==null){
  const delay=Math.max(0,lastGuestEnd+minimumHoldMs-Date.now());
  events.push({t:Date.now()-zero,message:'Harness readiness delay: '+JSON.stringify({delay,minimumHoldMs})});
  await wait(delay);
 }
 return speak(id,audio,options);
};
bot.voiceManager.connectToVoiceChannel=async()=>connection;
// A diagnostic does not need to pause production cron jobs or publish to Discord.
bot.gatewayBridge.disableAllCronJobs=async()=>[];
const members=new Map(Object.entries(speakerMap).map(([id,s])=>[id,{id,displayName:s.name,user:{bot:false,username:s.name}}]));
const localChannel={id:'quartz-evaluation',name:'Local evaluation',guild:{id:guild},members};
connection.joinConfig={channelId:localChannel.id,guildId:guild,selfDeaf:false,selfMute:false};
const source=loadResumeSource(path.dirname(episode),read('resume-source.json').sourceRecording,identity.ownerId,guild);
const journal=rows('audio-journal/chunks.jsonl').filter(e=>e.type==='pcm'&&e.sourceType==='participant');
if(!journal.length)throw Error('No recorded guest audio');
const sources=new Map(); let mixedFallback=null;
for(const e of journal){
 if(e.sampleRate!==48000||e.channels!==2)throw Error('Unsupported fixture format');
 const name=path.join(episode,'audio-journal',e.file);
 if(fs.existsSync(name)){
  if(!sources.has(name))sources.set(name,fs.readFileSync(name));
  e.pcm=sources.get(name).subarray(e.byteOffset,e.byteOffset+e.byteLength);
 }else{
  if(!mixedFallback){
   const decoded=require('node:child_process').spawnSync('ffmpeg',['-v','error','-i',path.join(episode,'mixed-audio.mp3'),'-f','s16le','-ar','48000','-ac','2','pipe:1'],{maxBuffer:128*1024*1024});
   if(decoded.status!==0)throw Error('Cannot decode finalized guest fixture');
   mixedFallback=decoded.stdout;
  }
  const start=Math.round(e.timelineOffsetMs)*192;
  e.pcm=mixedFallback.subarray(start,start+e.byteLength);
 }
 if(e.pcm.length!==e.byteLength)throw Error('Incomplete fixture audio');
}
const actions=[];
for(const id of new Set(journal.map(e=>e.sourceId))){
 const chunks=journal.filter(e=>e.sourceId===id).sort((a,b)=>a.timelineOffsetMs-b.timelineOffsetMs);
 chunks.forEach((e,i)=>{
  if(!i||e.timelineOffsetMs-(chunks[i-1].timelineOffsetMs+chunks[i-1].durationMs)>150)
   actions.push({t:e.timelineOffsetMs,kind:'start',id});
  actions.push({t:e.timelineOffsetMs,kind:'pcm',id,pcm:e.pcm});
  if(i===chunks.length-1||chunks[i+1].timelineOffsetMs-(e.timelineOffsetMs+e.durationMs)>150)
   actions.push({t:e.timelineOffsetMs+e.durationMs,kind:'end',id});
 });
}
actions.sort((a,b)=>a.t-b.t);
const encoder=new Opus(48000,2,Opus.Application.AUDIO);
(async()=>{
 let recordingPath=null,failure=null;
 try{
  await bot.voiceManager.joinChannel(localChannel,speakerMap);
  if(bot.shouldConnectGatewayWs())await bot.wsClient.connect();
  await bot.grantConsent(guild,source.topic,'current',null,{resume:source,ownerId:identity.ownerId});
  recordingPath=bot.voiceManager.recordingPaths.get(guild);zero=Date.now();
  fs.writeFileSync(path.join(output,'manifest.json'),JSON.stringify({channel,timing,minimumHoldMs,episode,source:source.recording,historyEntries:source.entries.length,recordingPath,startedAt:zero,
   model:bot.podcastGenerator.model,voiceMode:bot.voiceProvider.mode,gatewayAuthenticated:bot.wsClient.isAuthenticated,
   fixtureAudio:mixedFallback?'Guest-timestamp crops from mixed audio; overlapping original Quartz may remain':'Original isolated guest PCM',
   transport:'local Opus sink; real receiver, ASR, bot, generator, TTS, Quartz, recording, idle loop and handoff'},null,2));
  const apply = a => {
   if(providerFailure)throw providerFailure;
   if(a.kind==='start'||a.kind==='end')connection.receiver.speaking.emit(a.kind,a.id);
   else connection.streams.get(a.id).write(Buffer.from(encoder.encode(a.pcm,960)));
  };
  const awaitResponse = async after => {
   const deadline=Date.now()+120000, start=Date.now();
   while(Date.now()<deadline){
    if(providerFailure)throw providerFailure;
    const spoke=consumed.some(f=>f.source==='alpha'&&f.t>=after&&f.rms>80);
    const busy=bot.directResponseInFlight.has(guild)||bot.voiceManager.players.get(guild)?.state.status!=='idle';
    if(spoke&&!busy)return;
    if(!spoke&&!busy&&Date.now()-start>=30000)return;
    await wait(100);
   }
   throw Error('Full pipeline response did not settle within 120 seconds');
  };
  if(timing==='absolute'){
   for(const a of actions){await wait(Math.max(0,zero+a.t-Date.now()));apply(a);}
   await wait(Math.max(0,zero+read('audio-recording-metadata.json').episode.duration*1000-Date.now()));
   await awaitResponse(actions.at(-1).t);
  }else{
   const origin=Date.parse(read('resume-source.json').resumedAt);
   const hosts=rows('transcript.jsonl').filter(e=>e.speakerRole==='host'&&e.source!=='quartz'&&e.playbackStartedAt&&e.playbackEndedAt);
   const groups=[];
   for(const a of actions){
    const index=hosts.filter(h=>Date.parse(h.playbackStartedAt)-origin<a.t).length;
    (groups[index]||=[]).push(a);
   }
   for(let index=0;index<groups.length;index++){
    const group=groups[index];if(!group?.length)continue;
    const first=group[0].t;
    const originalEnd=index?Date.parse(hosts[index-1].playbackEndedAt)-origin:0;
    const pause=Math.max(0,first-originalEnd);
    const groupStart=Date.now()+pause;
    events.push({t:Date.now()-zero,message:'Harness guest group: '+JSON.stringify({index,pause,originalStart:first})});
    for(const a of group){await wait(Math.max(0,groupStart+a.t-first-Date.now()));apply(a);}
    await awaitResponse(groupStart-zero);
   }
   await wait(2000);
  }
 }catch(e){failure={message:e.message,stack:e.stack};console.error('EVAL FAILED',e.message);}
 finally{
  if(providerFailure)failure ||= {message:providerFailure.message};
  bot.stopIdleDecisionLoop(guild);
  try{await bot.leavePodcastSession(guild,{reason:'diagnostic-complete'});}catch(e){failure||={message:e.message};}
  await bot.stop();encoder.delete();fs.closeSync(sinkFd);
  fs.writeFileSync(path.join(output,'raw.pcm'),Buffer.concat(rawPcm));
  fs.writeFileSync(path.join(output,'metrics.json'),JSON.stringify({channel,recordingPath,raw,consumed,events,failure}));
  console.log('EVAL_FINAL',JSON.stringify({channel,recordingPath,rawFrames:raw.length,consumedFrames:consumed.length,failure}));
  process.exit(failure?1:0);
 }
})();
