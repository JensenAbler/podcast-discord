#!/usr/bin/env node
// Resumable timestamped ASR of publisher audio for fixture alignment.
const fs=require('fs'),path=require('path'),cp=require('child_process');
process.loadEnvFile('/opt/podcast-discord/.env');
const {FishAudioProvider}=require('/opt/podcast-discord/fish-audio-provider');
const base=process.argv[2];if(!base)throw Error('audio directory required');
const tasks=[];
for(const name of ['jacob','horn']){
 const file=path.join(base,name+'-podcast.mp3');
 const duration=Number(cp.execFileSync('ffprobe',['-v','error','-show_entries','format=duration','-of','default=noprint_wrappers=1:nokey=1',file],{encoding:'utf8'}));
 fs.mkdirSync(path.join(base,name+'-asr'),{recursive:true});
 for(let start=0;start<duration;start+=90) tasks.push({name,file,start,duration:Math.min(90,duration-start)});
}
let done=0;
async function worker(){
 const p=new FishAudioProvider({asrDownmix:false,timeout:120000});
 while(tasks.length){
  const task=tasks.shift(),out=path.join(base,task.name+'-asr',String(task.start).padStart(6,'0')+'.json');
  if(fs.existsSync(out)){done++;continue;}
  const wav=cp.execFileSync('ffmpeg',['-v','error','-ss',String(task.start),'-i',task.file,'-t',String(task.duration),'-ac','1','-ar','16000','-f','wav','pipe:1'],{maxBuffer:10000000});
  let result;
  for(let attempt=0;attempt<3;attempt++){try{result=await p.transcribe(wav,{sampleRate:16000,channels:1,ignoreTimestamps:false});break;}catch(e){if(/credit|balance|402/i.test(e.message)||attempt===2)throw e;await new Promise(r=>setTimeout(r,2000*(attempt+1)));}}
  fs.writeFileSync(out+'.tmp',JSON.stringify({...task,result}));fs.renameSync(out+'.tmp',out);
  console.log('ASR_COMPLETE',++done,task.name,task.start);
 }
}
Promise.all(Array.from({length:4},worker)).catch(e=>{console.error(e.message);process.exit(1)});
