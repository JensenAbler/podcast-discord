'use strict';
class ReplayIntegrityError extends Error {
 constructor(code,message,details={}) { super(message); this.code=code; this.details=details; }
}
async function runTimeline(actions,{now,sleep,dispatch,record=()=>{},check=()=>{},maxLateMs=100,endMs}) {
 let maxLag=0,count=0;
 for(const action of actions){
  for(;;){check();const delay=action.t-now();if(delay<=0)break;await sleep(Math.min(delay,100));}
  check();const actual=now(),lag=Math.max(0,actual-action.t);maxLag=Math.max(maxLag,lag);
  if(lag>maxLateMs){record({kind:action.kind,scheduledMs:action.t,actualMs:actual,lagMs:lag,rejected:true});throw new ReplayIntegrityError('timing-invalid','Replay missed its timing budget',{scheduledMs:action.t,actualMs:actual,lagMs:lag,maxLateMs});}
  const before=now();await dispatch(action);count++;
  record({kind:action.kind,scheduledMs:action.t,actualMs:actual,lagMs:lag,dispatchMs:now()-before});
 }
 while(now()<endMs){check();await sleep(Math.min(100,endMs-now()));}
 check();return {count,maxLag};
}
function validity({failure,completedMs,durationMs,maxLag,maxLateMs,inputUnavailable=0,inputDrops=0,configurationChanged=false}){
 const reasons=[];
 if(failure)reasons.push(failure.code||'failed');
 if(completedMs+1<durationMs)reasons.push('incomplete');
 if(maxLag>maxLateMs)reasons.push('timing-invalid');
 if(inputUnavailable||inputDrops)reasons.push('input-loss');
 if(configurationChanged)reasons.push('configuration-changed');
 return {schemaVersion:2,timingValid:reasons.length===0,reasons:[...new Set(reasons)],maxLateMs,maxObservedLagMs:maxLag};
}
module.exports={runTimeline,ReplayIntegrityError,validity};
