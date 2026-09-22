'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { PreparedClipPlayer, validateCues, decodeAudio } = require('./prepared-clip');
function temp(t) { const dir=fs.mkdtempSync(path.join(os.tmpdir(),'prepared-clip-test-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true})); return dir; }
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

