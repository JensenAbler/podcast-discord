'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EvolveSession, validateManifest, contained } = require('./evolve-session');
const { PodcastGenerator } = require('./podcast-generator');
const { PreparedClipPlayer, validateCues, decodeAudio } = require('./prepared-clip');
const { buildEvolveCommand } = require('./evolve-controls');
const { inventory, prepare } = require('./evolve-prepare');
function temp(t) { const dir=fs.mkdtempSync(path.join(os.tmpdir(),'evolve-test-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true})); return dir; }
function session(t) {
 const dir=temp(t);
 return new EvolveSession(validateManifest({version:1,episodes:[
 {id:'1',title:'First title',transcript:'FIRST FULL TRANSCRIPT\nA: every single word',complete:true},
 {id:'2',title:'Future title',transcript:'SECRET SECOND TRANSCRIPT',complete:true}]},dir),path.join(dir,'state.json'),'operator');
}
function alpha(s,text) { s.observe({speaker:'Alpha-Clawd',transcription:text,source:'direct',playbackStatus:'completed'}); }
test('prediction/reveal gate hides future titles and full transcripts; reflection accumulates',t=>{
 const s=session(t);
 assert.doesNotMatch(s.context(),/FIRST FULL|SECRET SECOND|Future title/);
 s.next();
 assert.match(s.context(),/First title/);assert.doesNotMatch(s.context(),/FIRST FULL|SECRET SECOND|Future title/);
 assert.throws(()=>s.reveal(),/No audible/);
 s.observe({speaker:'Alpha-Clawd',transcription:'not played',playbackStatus:'not_started'});
 assert.throws(()=>s.reveal(),/No audible/);
 alpha(s,'I predict a conversation about choice');
 s.reveal();assert.match(s.context(),/FIRST FULL/);assert.doesNotMatch(s.context(),/SECRET SECOND|Future title/);
 assert.throws(()=>s.next(),/Finish/);assert.throws(()=>s.reflect(),/No audible/);
 alpha(s,'I was surprised by the first full transcript');s.reflect();s.next();
 assert.match(s.context(),/FIRST FULL/);assert.match(s.context(),/surprised/);assert.doesNotMatch(s.context(),/SECRET SECOND/);
});
test('prompt stage remains undisclosed until requested; proposal is verbatim and no code is changed',t=>{
 const s=session(t);s.next();alpha(s,'prediction');s.reveal();alpha(s,'reflection');s.reflect();
 assert.throws(()=>s.prompt('EXACT SYSTEM'),/Finish/);
 s.next();alpha(s,'prediction2');s.reveal();alpha(s,'reflection2');s.reflect();
 assert.doesNotMatch(s.context(),/EXACT SYSTEM/);
 s.prompt('EXACT SYSTEM\n  spacing');alpha(s,'I choose to retain it.');
 assert.equal(s.proposal()[0].text,'I choose to retain it.');
 assert.match(s.context(),/EXACT SYSTEM\n  spacing/);
});
test('durable recovery preserves exact corpus, phase, and operator',t=>{
 const s=session(t);s.next();alpha(s,'prediction');s.reveal();
 const restored=EvolveSession.resume(s.file,'operator');
 assert.equal(restored.context(),s.context());
 assert.throws(()=>EvolveSession.resume(s.file,'other'),/original/);
 assert.throws(()=>new EvolveSession(s.state.manifest,s.file,'operator'),/already exists/);
});
test('full context survives legacy history limits and Quartz mode; budget overflow fails closed',t=>{
 const s=session(t);s.next();alpha(s,'prediction');s.reveal();
 const gen=new PodcastGenerator({apiKey:'test',maxHistoryTurns:1,maxRequestTokens:200000});
 gen.evolveSession=s;gen.hasBackchannels=true;
 for(let i=0;i<8;i++)gen.observeSpokenTranscript({speaker:'Jensen',transcription:'retained moment '+i,timestamp:new Date(i*1000).toISOString()});
 const content=JSON.stringify(gen.buildMessages({transcript:'reflect'}));
 assert.match(content,/FIRST FULL TRANSCRIPT/);assert.match(content,/retained moment 0/);assert.match(content,/retained moment 7/);
 assert.doesNotMatch(content,/SECRET SECOND/);
 gen.maxRequestTokens=1000;
 assert.throws(()=>gen.buildMessages({transcript:'reflect'}),/No transcript was trimmed/);
 assert.match(s.context(),/FIRST FULL TRANSCRIPT/);
 gen.endSession();assert.equal(gen.evolveSession,null);
});
test('manifest rejects summaries, duplicate ids, and paths outside content root',t=>{
 const dir=temp(t),outside=temp(t);fs.writeFileSync(path.join(outside,'secret'),'secret');
 fs.symlinkSync(path.join(outside,'secret'),path.join(dir,'escape'));
 assert.throws(()=>contained(dir,'escape'),/escapes/);
 assert.throws(()=>validateManifest({version:1,episodes:[{id:'a',title:'A',transcript:'summary'}]},dir),/complete:true/);
 assert.throws(()=>validateManifest({version:1,episodes:[{id:'a',title:'A',transcript:'x',complete:true},{id:'a',title:'B',transcript:'y',complete:true}]},dir),/unique/);
});
test('cue validation requires ordered timed text within decoded duration',()=>{
 assert.throws(()=>validateCues([{startMs:0,endMs:1100,text:'x'}],1000),/Invalid/);
 assert.throws(()=>validateCues([{startMs:0,endMs:500,text:'x'},{startMs:100,endMs:600,text:'y'}],1000),/Invalid/);
 assert.equal(validateCues([{startMs:0,endMs:1000,text:'exact'}],1000)[0].text,'exact');
});
function playbackBot(t,options={}) {
 const dir=temp(t);fs.writeFileSync(path.join(dir,'audio.bin'),'fake');
 const rows=[],chunks=[];const resource={playbackDuration:0};let finish;
 const bot={podcastGenerator:{history:[]},noteHostPlaybackStart(){},noteHostPlaybackEnd(){},isRecordingActive(){return true},
 voiceManager:{
 transmitters:new Map([['g',{currentResource:resource}]]),recordingPaths:new Map([['g',dir]]),
 addBotAudioToRecording(g,b,o){chunks.push({b:Buffer.from(b),o});},
 saveTranscriptEntry(g,e){rows.push(e);},
 async speakWithTiming(g,a,o){
   const timing={playbackStartedAt:'2026-01-01T00:00:00Z'};
   o.onStart(timing);
   const finished=new Promise(resolve=>{finish=()=>{
      resource.playbackDuration=options.playedMs??1000;
      const result={...timing,playbackInterrupted:!!options.interrupted,playbackEndedAt:'2026-01-01T00:00:01Z'};
      o.onFinish(result); resolve(result);
   };setImmediate(finish);});
   return {timing,finished};
 },
 stopPlayback(){finish?.();}
 }};
 return {dir,bot,rows,chunks};
}
test('completed clip records PCM once at playback time and injects exact curated cues',async t=>{
 const b=playbackBot(t);const pcm=Buffer.alloc(192000,1);
 const player=new PreparedClipPlayer(b.bot,'g',{decode:async()=>pcm});
 const r=await player.play({audioFile:'audio.bin',cues:[{startMs:0,endMs:500,text:'first'},{startMs:500,endMs:1000,text:'second'}]},b.dir);
 assert.equal(r.interrupted,false);assert.equal(r.deliveredCues,2);
 assert.equal(Buffer.concat(b.chunks.map(c=>c.b)).length,pcm.length);
 assert.equal(b.chunks[0].o.startTime,Date.parse('2026-01-01T00:00:00Z'));
 assert.deepEqual(b.rows.map(x=>x.transcription),['first','second']);
 assert.equal(b.bot.podcastGenerator.history.length,2);
});
test('interruption records only consumed PCM and does not leak unfinished cues',async t=>{
 const b=playbackBot(t,{playedMs:650,interrupted:true});
 const player=new PreparedClipPlayer(b.bot,'g',{decode:async()=>Buffer.alloc(192000)});
 const r=await player.play({audioFile:'audio.bin',cues:[{startMs:0,endMs:500,text:'heard'},{startMs:500,endMs:1000,text:'UNHEARD ENDING'}]},b.dir);
 assert.equal(r.interrupted,true);assert.equal(r.playedMs,650);
 assert.equal(Buffer.concat(b.chunks.map(c=>c.b)).length,650*192);
 assert.deepEqual(b.rows.map(x=>x.transcription),['heard']);
 assert.doesNotMatch(JSON.stringify(b.bot.podcastGenerator.history),/UNHEARD/);
});
test('cancel during decode never starts playback or injects text',async t=>{
 const b=playbackBot(t);let decodeResolve;
 const player=new PreparedClipPlayer(b.bot,'g',{decode:()=>new Promise(r=>decodeResolve=r)});
 const result=player.play({audioFile:'audio.bin',cues:[{startMs:0,endMs:1000,text:'not played'}]},b.dir);
 player.stop();decodeResolve(Buffer.alloc(192000));
 assert.equal((await result).playedMs,0);assert.equal(b.rows.length,0);
});
test('real ffmpeg decoding produces expected PCM and invalid input rejects',async t=>{
 const dir=temp(t),f=path.join(dir,'tone.wav');
 const {execFileSync}=require('child_process');
 execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=440:duration=0.5','-y',f]);
 const pcm=await decodeAudio(f);assert.equal(pcm.length,96000);
 fs.writeFileSync(path.join(dir,'bad'),'not audio');
 await assert.rejects(decodeAudio(path.join(dir,'bad')),/decoding failed/);
});
test('reveal is a single command with no options',()=>{
 const c=buildEvolveCommand().toJSON();
 assert.equal(c.name,'reveal');assert.ok(c.default_member_permissions);
 assert.equal(c.options?.length || 0,0);
});
test('feed inventory deduplicates by actual published reference and reports missing material',t=>{
 const dir=temp(t);fs.mkdirSync(path.join(dir,'episodes'));fs.writeFileSync(path.join(dir,'episodes','ep5_transcript.txt'),'FULL');
 fs.writeFileSync(path.join(dir,'feed.xml'),'<rss><channel><item><title>Fifth &amp; final</title><itunes:episode>5</itunes:episode><description>https://example.org/episodes/ep5_transcript.txt</description></item><item><title>Early</title><itunes:episode>0</itunes:episode></item></channel></rss>');
 const data=inventory(dir);assert.equal(data.episodes[0].title,'Fifth & final');assert.equal(data.missing.length,1);
 const result=prepare(dir,'sample');assert.equal(result.bundles.length,3);
 assert.throws(()=>prepare(dir,'sample'),/already exists/);
});

test('production voice handoff preserves interruption result through Quartz release',async()=>{
 const { VoiceManager }=require('./voice-manager');
 let options,released=0;
 const vm=Object.create(VoiceManager.prototype);
 vm.transmitters=new Map([['g',{async play(audio,o){options=o;}}]]);
 vm.quartzBackchannels=new Map([['g',{async acquireAlpha(){return ()=>released++;}}]]);
 const playback=await vm.speakWithTiming('g',Buffer.from('audio'));
 options.onStart();options.onFinish({interrupted:true});
 const result=await playback.finished;
 assert.equal(result.playbackInterrupted,true);assert.equal(released,1);
});
test('reveal auto-loads, advances once, retains full context, resumes and rolls back budget failures',async t=>{
 const {handleEvolveCommand}=require('./evolve-controls');
 const root=temp(t), prior=process.env.CLAWCAST_CONTENT_ROOT;
 process.env.CLAWCAST_CONTENT_ROOT=root;
 t.after(()=>{if(prior===undefined)delete process.env.CLAWCAST_CONTENT_ROOT;else process.env.CLAWCAST_CONTENT_ROOT=prior;});
 fs.mkdirSync(path.join(root,'episodes'));
 const recording=path.join(root,'recordings','now');fs.mkdirSync(recording,{recursive:true});
 for(const n of [1,2])fs.writeFileSync(path.join(root,'episodes',n+'_transcript.txt'),'FULL TRANSCRIPT '+n);
 fs.writeFileSync(path.join(root,'feed.xml'),'<rss><channel>'+[2,1].map(n=>'<item><title>Episode '+n+'</title><itunes:episode>'+n+'</itunes:episode><description>https://example.org/episodes/'+n+'_transcript.txt</description></item>').join('')+'</channel></rss>');
 const gen=new PodcastGenerator({apiKey:'test'}), replies=[];let calls=0, busy=false;
 const bot={podcastGenerator:gen,isRecordingActive:()=>true,useGatewayGenerator:()=>false,isLiveAlphaSession:()=>false,
 voiceManager:{getPlaybackStatus:()=>({isPlaying:busy,queueLength:0}),recordingPaths:new Map([['g',recording]])},
 async handleDirectGeneratorFlush(g,u,c,w,opts){
  calls++;assert.equal(opts.evolveControl,true);
  const messages=JSON.stringify(gen.buildMessages({transcript:c}));
  assert.match(messages,/FULL TRANSCRIPT 1/);
  if(calls===1)assert.doesNotMatch(messages,/FULL TRANSCRIPT 2/);else assert.match(messages,/FULL TRANSCRIPT 2/);
  gen.observeSpokenTranscript({speaker:'Alpha-Clawd',transcription:'Reflection '+calls,playbackStatus:'completed'});
 }};
 async function reveal(user='owner', customId=null){
  await handleEvolveCommand(bot,{guildId:'g',user:{id:user},customId,isButton:()=>!!customId,memberPermissions:{has:()=>true},
   guild:{members:{fetch:async()=>({voice:{channelId:'v'}}),me:{voice:{channelId:'v'}}}},
   async deferReply(){},async deferUpdate(){},async editReply(r){replies.push(r);}});
 }
 await reveal();assert.equal(calls,0);assert.equal(gen.evolveSession.state.index,-1);
 assert.match(replies.at(-1).content,/About to reveal .*Episode 1/);
 assert.doesNotMatch(gen.evolveSession.context(),/FULL TRANSCRIPT 1/);
 const first=replies.at(-1).components[0].toJSON().components[0].custom_id;
 await reveal('owner',first);assert.equal(calls,1);assert.equal(gen.evolveSession.state.index,0);
 assert.match(replies.at(-1).content,/Next \/reveal: Episode 2/);
 await reveal('owner',first);assert.equal(calls,1);
 assert.match(replies.at(-1).content,/out of date/);
 await reveal('other');assert.equal(calls,1);
 await reveal();const second=replies.at(-1).components[0].toJSON().components[0].custom_id;
 busy=true;await reveal('owner',second);busy=false;assert.equal(gen.evolveSession.state.index,0);
 const budget=gen.maxRequestTokens;gen.maxRequestTokens=1;
 await reveal('owner',second);assert.equal(gen.evolveSession.state.index,0);
 assert.equal(JSON.parse(fs.readFileSync(path.join(recording,'evolve-state.json'))).index,0);
 gen.maxRequestTokens=budget;
 bot.evolveSessions.clear();gen.evolveSession=null;
 await reveal('owner',second);assert.equal(calls,2);assert.equal(gen.evolveSession.state.index,1);
 assert.match(gen.evolveSession.context(),/Reflection 1/);
 await reveal();assert.equal(calls,2);assert.equal(gen.evolveSession.state.index,1);
 assert.match(replies.at(-1).content,/already been revealed/);
 assert.equal(bot.evolveCommandLocks.size,0);
});
test('playback failures preserve consumed audio and never inject future cues',async t=>{
 const b=playbackBot(t);
 b.bot.voiceManager.speakWithTiming=async(g,a,o)=>{
  o.onStart({playbackStartedAt:'2026-01-01T00:00:00Z'});
  b.bot.voiceManager.transmitters.get('g').currentResource.playbackDuration=400;
  o.onError(new Error('decoder failed'));
  return {finished:Promise.reject(new Error('decoder failed'))};
 };
 const player=new PreparedClipPlayer(b.bot,'g',{decode:async()=>Buffer.alloc(192000)});
 await assert.rejects(player.play({audioFile:'audio.bin',cues:[{startMs:0,endMs:300,text:'heard'},{startMs:300,endMs:1000,text:'not finished'}]},b.dir),/decoder failed/);
 assert.deepEqual(b.rows.map(x=>x.transcription),['heard']);
 assert.equal(Buffer.concat(b.chunks.map(x=>x.b)).length,400*192);
});

test('an interrupted host response cannot satisfy the prediction gate',t=>{
 const s=session(t);s.next();
 s.observe({speaker:'Alpha-Clawd',transcription:'[Host playback incomplete; audible words unverified.]',playbackStatus:'incomplete'});
 assert.throws(()=>s.reveal(),/No audible/);
});
