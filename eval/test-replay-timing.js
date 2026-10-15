const test=require('node:test'),assert=require('node:assert/strict');
const {runTimeline,ReplayIntegrityError,validity}=require('./replay-timing');
test('replays on a monotonic schedule without a sleep for already-due actions',async()=>{
 let t=0;const sent=[],waits=[];
 await runTimeline([{t:0,kind:'pcm'},{t:20,kind:'pcm'}],{now:()=>t,sleep:async ms=>{waits.push(ms);t+=ms;},dispatch:a=>sent.push([a.t,t]),endMs:40});
 assert.deepEqual(sent,[[0,0],[20,20]]);assert.deepEqual(waits,[20,20]);
});
test('stall rejects stale audio before dispatch and records the rejected deadline',async()=>{
 let t=0;const sent=[],records=[];
 await assert.rejects(runTimeline([{t:0,kind:'pcm'},{t:20,kind:'pcm'}],{now:()=>t,sleep:async ms=>{t+=ms+200;},dispatch:a=>sent.push(a.t),record:r=>records.push(r),endMs:40}),e=>e.code==='timing-invalid');
 assert.deepEqual(sent,[0]);assert.equal(records.at(-1).rejected,true);
});
test('gradual CPU overrun also fails rather than draining an overdue backlog',async()=>{
 let t=0,count=0;
 await assert.rejects(runTimeline(Array.from({length:50},(_,i)=>({t:i*20,kind:'pcm'})),{now:()=>t,sleep:async ms=>{t+=ms;},dispatch:()=>{count++;t+=35;},endMs:1000}),e=>e.code==='timing-invalid');
 assert.ok(count<10);
});
test('provider rejection stops dispatch without retry',async()=>{
 let t=0,count=0;
 await assert.rejects(runTimeline([{t:0},{t:20}],{now:()=>t,sleep:async ms=>{t+=ms;},dispatch:()=>count++,check:()=>{if(count)throw new ReplayIntegrityError('provider-content-filter','blocked');},endMs:40}),e=>e.code==='provider-content-filter');
 assert.equal(count,1);
});
test('cancel is checked during a long silent gap',async()=>{
 let t=0;
 await assert.rejects(runTimeline([{t:60000}],{now:()=>t,sleep:async ms=>{assert.ok(ms<=100);t+=ms;},dispatch:()=>assert.fail(),check:()=>{if(t>=300)throw new ReplayIntegrityError('cancelled','cancel');},endMs:60000}),e=>e.code==='cancelled');
 assert.equal(t,300);
});
test('only a complete, timely, lossless, stable run is valid',()=>{
 const good={completedMs:300000,durationMs:300000,maxLag:8,maxLateMs:100,failure:null};
 assert.equal(validity(good).timingValid,true);
 for(const change of [{completedMs:100},{maxLag:101},{inputUnavailable:1},{inputDrops:1},{configurationChanged:true},{failure:{code:'provider-content-filter'}}])assert.equal(validity({...good,...change}).timingValid,false);
});
