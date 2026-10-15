#!/usr/bin/env python3
"""One-to-one timing agreement with provisional independent reference events."""
import json,sys,statistics,math
from pathlib import Path
def match_events(ref,pred,tolerance):
 # Maximum cardinality first, minimum total onset error second.
 n,m=len(ref),len(pred);prev=[(0,0)]*(m+1);choice=[bytearray(m+1) for _ in range(n+1)]
 for i in range(1,n+1):
  row=[(0,0)]*(m+1)
  for j in range(1,m+1):
   best=prev[j];direction=1
   if row[j-1]>best:best=row[j-1];direction=2
   error=abs(ref[i-1]-pred[j-1])
   if error<=tolerance:
    candidate=(prev[j-1][0]+1,prev[j-1][1]-error)
    if candidate>best:best=candidate;direction=3
   row[j]=best;choice[i][j]=direction
  prev=row
 pairs=[];i=n;j=m
 while i and j:
  d=choice[i][j]
  if d==3:pairs.append((i-1,j-1));i-=1;j-=1
  elif d==1:i-=1
  else:j-=1
 return pairs[::-1]
def main(run):
 out=Path(run);m=json.loads((out/'metrics.json').read_text());manifest=m['manifest']
 quality=m.get('validity',{})
 if quality.get('schemaVersion')!=2 or not quality.get('timingValid'):
  report={'status':'invalid-run-no-timing-score','complete':False,'failure':m.get('failure'),'validity':quality or {'reasons':['legacy-run-without-timing-integrity-gate']},'scoresByToleranceSec':None}
  (out/'reference-timing.json').write_text(json.dumps(report,indent=2));print(json.dumps(report));return
 reference=json.loads(Path(manifest['alignment']['referenceFile']).read_text())
 duration=m.get('completedMs',manifest['durationMs']) if m.get('failure') else manifest['durationMs']
 origin=manifest['startMs']/1000;start=origin+manifest.get('scoreStartMs',0)/1000;end=origin+duration/1000
 refs=sorted([t for t in reference['candidates'] if t['scorable'] and start+1<=t['start'] and t['end']<end-1],key=lambda t:t['start'])
 # 20ms consumed output, energy threshold matching existing listener analyzer.
 groups=[]
 for f in m['consumed']:
  if not 0<=f['t']<duration or f['rms']<=80:continue
  t=origin+f['t']/1000
  if not start+1<=t<end-1:continue
  if groups and t-groups[-1]['end']<=.18:groups[-1]['end']=t+.02
  else:groups.append({'start':t,'end':t+.02})
 blocks=reference['outputBlockIntervals']
 blocked=[g for g in groups if any(s<=g['start']<e for s,e in blocks)]
 pred=sorted([g for g in groups if not any(s<=g['start']<e for s,e in blocks)],key=lambda g:g['start'])
 results={}
 for tol in [.25,.5,1.0]:
  pairs=match_events([r['start'] for r in refs],[p['start'] for p in pred],tol)
  ri={i for i,j in pairs};pi={j for i,j in pairs};errors=[pred[j]['start']-refs[i]['start'] for i,j in pairs]
  precision=len(pairs)/len(pred) if pred else None;recall=len(pairs)/len(refs) if refs else None
  results[str(tol)]={'matched':len(pairs),'missed':len(refs)-len(pairs),'extra':len(pred)-len(pairs),'precision':precision,'recall':recall,'f1':2*len(pairs)/(len(pred)+len(refs)) if pred or refs else None,'medianSignedOnsetErrorSec':statistics.median(errors) if errors else None,'medianAbsoluteOnsetErrorSec':statistics.median(map(abs,errors)) if errors else None,'matches':[{'reference':refs[i],'quartz':pred[j],'onsetErrorSec':pred[j]['start']-refs[i]['start']} for i,j in pairs],'missedReferences':[r for i,r in enumerate(refs) if i not in ri],'extraOutputs':[p for j,p in enumerate(pred) if j not in pi]}
 report={'status':'provisional-reference-timing-agreement','complete':m['failure'] is None,'failure':m['failure'],'observedDurationSec':duration/1000,'referenceCandidates':len(refs),'quartzGroups':len(pred),'blockedOutputGroups':blocked,'scoresByToleranceSec':results,'limitations':reference['limitations']+['Not a verified ground-truth pass rate or a listening-fit judgment. Extra sounds may reflect missed human labels. Exact same-moment matching is evaluated with explicit onset tolerances.']}
 (out/'reference-timing.json').write_text(json.dumps(report,indent=2))
 print(json.dumps({k:v for k,v in report.items() if k not in ['scoresByToleranceSec','blockedOutputGroups']}))
 print(json.dumps({t:{k:v for k,v in s.items() if k not in ['matches','missedReferences','extraOutputs']} for t,s in results.items()}))
if __name__=='__main__':main(sys.argv[1])
