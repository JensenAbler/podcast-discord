#!/usr/bin/env node
// Offline speaker diarization only; never changes production ASR configuration.
const fs=require('fs'),path=require('path'),cp=require('child_process');
process.loadEnvFile('/opt/podcast-discord/.env');
const {fetch,Agent,FormData}=require('/opt/podcast-discord/node_modules/undici');
const dispatcher=new Agent({headersTimeout:900000,bodyTimeout:900000,connect:{timeout:30000}});
const base=process.argv[2],tasks=[];
for(const name of [process.argv[3]||'horn']){
 const m=JSON.parse(fs.readFileSync(path.join(base,name+'-aligned/audio-journal/manifest.json')));
 fs.mkdirSync(path.join(base,name+'-diarization'),{recursive:true});
 for(let start=m.startSec;start<m.endSec;start+=1200)tasks.push({name,start,duration:Math.min(1200,m.endSec-start)});
}
async function worker(){
 while(tasks.length){
 const task=tasks.shift(),out=path.join(base,task.name+'-diarization',task.start.toFixed(2)+'.json');
 if(fs.existsSync(out))continue;
 const mp3=cp.execFileSync('ffmpeg',['-v','error','-ss',String(task.start),'-i',path.join(base,task.name+'-podcast.mp3'),'-t',String(task.duration),'-ac','1','-ar','16000','-b:a','48k','-f','mp3','pipe:1'],{maxBuffer:30000000});
 for(let attempt=0;attempt<3;attempt++){
 const form=new FormData();form.append('audio',new Blob([mp3],{type:'audio/mpeg'}),'interview.mp3');form.append('ignore_timestamps','false');form.append('diarize','true');form.append('num_speakers','2');
 let res;try{res=await fetch((process.env.FISH_AUDIO_BASE_URL||'https://api.fish.audio')+'/v1/asr',{method:'POST',headers:{Authorization:'Bearer '+(process.env.FISH_AUDIO_API_KEY||process.env.FISH_API_KEY),model:'transcribe-1-pro'},body:form,dispatcher,signal:AbortSignal.timeout(900000)});}catch(e){console.error('NETWORK_RETRY',task.name,task.start,attempt,e.cause?.code||e.message);if(attempt===2)throw e;await new Promise(r=>setTimeout(r,3000));continue;}
 if(!res.ok){const error=await res.text();if((res.status===429||res.status>=500)&&attempt<2){await new Promise(r=>setTimeout(r,2000*(attempt+1)));continue;}throw Error('ASR '+res.status+' '+error);}
 const result=await res.json();if(!result.speaker_turns?.length)throw Error('Missing speaker turns');
 fs.writeFileSync(out,JSON.stringify({...task,model:'transcribe-1-pro',result}));
 console.log('DIARIZATION_COMPLETE',task.name,task.start,result.speaker_turns.length);break;
 }
 }
}
Promise.all(Array.from({length:2},worker)).then(()=>dispatcher.close()).catch(e=>{console.error(e.message);process.exit(1)});
