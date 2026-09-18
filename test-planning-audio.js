const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs'), os=require('os'), path=require('path');
const {execFileSync,spawnSync}=require('child_process');
const {AlphaClawdVoiceBot}=require('./bot');
function fixture(t) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'planning-test-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'tail-index.m4a');
 execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','anoisesrc=duration=20:sample_rate=48000',
  '-c:a','aac','-b:a','192k',file]);
 return {dir,file,bytes:fs.readFileSync(file)};
}
function bot(){return Object.assign(Object.create(AlphaClawdVoiceBot.prototype),{planningAudioTranscriptionEnabled:true,planningAudioDecodeTimeoutMs:30000});}
function temps(){return fs.readdirSync(os.tmpdir()).filter(n=>n.startsWith('planning-audio-')).sort();}
test('tail-index M4A decodes completely and reaches planning transcription despite video/mp4 MIME',async t=>{
 const f=fixture(t), b=bot(), before=temps();
 assert(f.bytes.indexOf(Buffer.from('moov'))>f.bytes.indexOf(Buffer.from('mdat')));
 const args=['-v','error','-i',f.file,'-f','s16le','-ac','2','-ar','48000','pipe:1'];
 const expected=execFileSync('ffmpeg',args,{maxBuffer:16*1024*1024});
 const old=spawnSync('ffmpeg',args.map(a=>a===f.file?'pipe:0':a),{input:f.bytes,maxBuffer:16*1024*1024});
 assert(old.status!==0||old.stdout.length!==expected.length,'fixture must expose the old pipe failure');
 b.downloadPlanningAudioAttachment=async()=>f.bytes;
 b.voiceProvider={transcribe:async(pcm,opts)=>{
  assert.deepEqual(pcm,expected);assert.equal(opts.sampleRate,48000);assert.equal(opts.channels,2);
  return {text:'Complete audio transcript'};
 }};
 const record=await b.buildPlanningMessageRecord({content:'Plan from this.',author:{id:'u',username:'Jensen'},
  attachments:new Map([['a',{name:'notes.m4a',contentType:'video/mp4',url:'https://example.invalid/audio'}]])});
 assert.match(record.text,/Plan from this/);assert.match(record.text,/Complete audio transcript/);
 assert.deepEqual(temps(),before);
});
test('OGG voice notes still decode; invalid files and timeout clean temporary files',async t=>{
 const f=fixture(t), b=bot(), before=temps(), ogg=path.join(f.dir,'note.ogg');
 execFileSync('ffmpeg',['-v','error','-i',f.file,'-t','1','-c:a','libopus',ogg]);
 const pcm=await b.decodePlanningAudioToPcm(fs.readFileSync(ogg),{name:'voice-message.ogg'});
 assert(pcm.length>180000 && pcm.length<200000);
 await assert.rejects(b.decodePlanningAudioToPcm(Buffer.from('invalid')),/audio decode failed/);
 b.planningAudioDecodeTimeoutMs=1;
 await assert.rejects(b.decodePlanningAudioToPcm(f.bytes),/timed out/);
 assert.deepEqual(temps(),before);
});
