#!/usr/bin/env python3
"""Serial, resumable, bounded replays. Failed cases are recorded, never retried."""
import json,sys,subprocess,hashlib
from pathlib import Path
def digest(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def main(plan_file,batch_dir):
 plan_path=Path(plan_file);plan=json.loads(plan_path.read_text());out=Path(batch_dir);out.mkdir(parents=True,exist_ok=True)
 import re
 ids=[c['id'] for c in plan['cases']]
 if len(ids)!=len(set(ids)) or not all(re.fullmatch(r'[a-zA-Z0-9_-]+',cid) for cid in ids):raise ValueError('Unique safe case IDs required')
 identity={'planSha256':digest(plan_path),'harnessSha256':digest('eval/live-listener-replay.js'),'timingSha256':digest('eval/replay-timing.js'),'scorerSha256':digest('eval/score-reference-timing.py')}
 statefile=out/'batch.json'
 if statefile.exists():
  state=json.loads(statefile.read_text())
  if state['identity']!=identity:raise ValueError('Plan/harness changed; use a new batch directory')
  if state['status']=='blocked':raise ValueError('Blocked batch needs review; automatic retry prohibited')
 else:state={'identity':identity,'status':'running','cases':{},'plan':plan}
 def save():
  (out/'batch.json.tmp').write_text(json.dumps(state,indent=2));(out/'batch.json.tmp').replace(statefile)
 save()
 for case in plan['cases']:
  cid=case['id']
  if cid in state['cases']:continue
  run=out/cid
  if run.exists():state['status']='blocked';state['reason']='Incomplete prior attempt requires review';save();return 1
  for key in ['journalSha256','transcriptSha256','referenceSha256']:
   paths={'journalSha256':'audio-journal/chunks.jsonl','transcriptSha256':'transcript.jsonl','referenceSha256':'reference.json'}
   if digest(Path(case['episode'])/paths[key])!=case[key]:raise ValueError('Prepared input changed')
  command=['node','eval/live-listener-replay.js',case['episode'],str(run),str(case['startSec']),str(case['durationSec']),str(case.get('warmupSec',30)),plan.get('mode','continuous')]
  with (out/(cid+'.log')).open('w') as log:r=subprocess.run(command,stdout=log,stderr=subprocess.STDOUT)
  metrics=run/'metrics.json'
  if not metrics.exists():state['cases'][cid]={'status':'invalid','exitCode':r.returncode,'reason':'missing-metrics'};state['status']='blocked';save();return 1
  m=json.loads(metrics.read_text());valid=m.get('validity',{}).get('timingValid',False) and r.returncode==0
  result={'status':'valid' if valid else 'invalid','exitCode':r.returncode,'failure':m.get('failure'),'validity':m.get('validity'),'run':str(run)}
  state['cases'][cid]=result
  if 'productionFingerprint' not in state:
   state['productionFingerprint']={k:m['manifest'][k] for k in ['productionCommit','productionCodeSha256','stateChannel','voice','outputGain','promptSha256']}
  elif any(m['manifest'][k]!=v for k,v in state['productionFingerprint'].items()):
   result['status']='invalid';m['validity']={'schemaVersion':2,'timingValid':False,'reasons':['configuration-changed']};metrics.write_text(json.dumps(m));(run/'validity.json').write_text(json.dumps(m['validity'],indent=2));result['validity']=m['validity'];valid=False
  with (run/'reference-timing.log').open('w') as log:a=subprocess.run(['python3','eval/score-reference-timing.py',str(run)],stdout=log,stderr=subprocess.STDOUT)
  result['scorerExitCode']=a.returncode
  if not valid or a.returncode:
   state['status']='blocked';state['reason']='Invalid timing, input loss, provider rejection, or analysis error; remaining cases not run';save();return 1
  save()
 state['status']='completed';save();return 0
if __name__=='__main__':sys.exit(main(*sys.argv[1:]))
