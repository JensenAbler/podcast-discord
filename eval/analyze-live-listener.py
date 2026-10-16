import json, math, struct, statistics, re, sys
from pathlib import Path
from backchannel_loudness import replay_loudness
out=Path(sys.argv[1]); manifest=json.loads((out/'manifest.json').read_text()); p=Path(manifest['episode']); startMs=manifest['startMs']; durationMs=manifest['durationMs']
earlyMetrics=out/'metrics.json'
if earlyMetrics.exists():
 early=json.loads(earlyMetrics.read_text())
 if early.get('failure'):durationMs=min(durationMs,early.get('completedMs',durationMs))
journal=[json.loads(x) for x in (p/'audio-journal/chunks.jsonl').read_text().splitlines()]
data={};handles={}
for r in journal:
 if r.get('type')!='pcm' or r.get('sourceType')!='participant' or not(startMs<=r['timelineOffsetMs']<startMs+durationMs):continue
 f=r['file']
 if f not in handles:handles[f]=open(p/'audio-journal'/f,'rb')
 h=handles[f];h.seek(r['byteOffset']);b=h.read(r['byteLength']);v=struct.unpack('<'+'h'*(len(b)//2),b)[::2]
 rms=math.sqrt(sum(x*x for x in v)/len(v));data.setdefault(r['sourceId'],[]).append({'t':r['timelineOffsetMs']-startMs,'rms':rms,'duration':r['durationMs']})
def groups(frames,threshold,gap):
 result=[]
 for f in sorted(frames,key=lambda f:f['t']):
  if f['rms']<=threshold:continue
  s=f['t'];e=s+f.get('duration',20)
  if result and s-result[-1]['end']<=gap:result[-1]['end']=max(e,result[-1]['end'])
  else:result.append({'start':s,'end':e})
 return result
def med(v):return statistics.median(v) if v else None
baseline={}
for threshold in [100,200,400]:
 for gap in [700,1200]:
  turns={k:groups(v,threshold,gap) for k,v in data.items()}
  rows=[]
  for speaker,ts in turns.items():
   for t in ts:
    if t['end']-t['start']<2000:continue
    other=[{**a,'speaker':k} for k,gs in turns.items() if k!=speaker for a in gs if t['start']<=a['start']<t['end'] and a['end']-a['start']<=2000]
    rows.append({**t,'speaker':speaker,'otherShortOverlaps':other})
  baseline[str(threshold)+'/'+str(gap)]={'turns':len(rows),'turnsWithOtherShortOverlap':sum(bool(t['otherShortOverlaps']) for t in rows),'otherShortOverlapCount':sum(len(t['otherShortOverlaps']) for t in rows),'rows':rows}
summary={'humanBaseline':{k:{a:b for a,b in v.items() if a!='rows'} for k,v in baseline.items()},'limitations':['Energy-derived speech spans, not manually labeled conversational turns. Short other-speaker overlaps are backchannel candidates, not verified acknowledgments.','One replay excerpt; original ASR may be fragmented, and replay uses historical completion times. Recorded Alpha state timing, no new Alpha generation. Boundary speech spans may be censored; first-contact latency is conditional on receiving contact.']}
if manifest.get('alignment'):
 summary['limitations']=[manifest['scope'],'No isolated interviewer track: human overlap/backchannel rates are unavailable. Energy groups measure guest-audio spans, not verified conversational turns.','Alignment exclusions and source hashes are in configuration.alignment. Rates use observed timeline duration including blocked interviewer/excluded intervals. No blind listening-fit score has been assigned.']
 summary['humanBaselineAvailable']=False
metrics=out/'metrics.json'
if metrics.exists():
 m=json.loads(metrics.read_text()); summary['validity']=m.get('validity',{'timingValid':False,'reasons':['legacy-run-without-timing-integrity-gate']}); summary['diagnosticOnly']=not summary['validity'].get('timingValid',False); frames=[f for f in m['consumed'] if 0<=f['t']<durationMs]; qg=groups(frames,80,180)
 rows=baseline['200/700']['rows']
 for t in rows:
  qs=[q for q in qg if t['start']<=q['start']<t['end']]
  t['quartzCount']=len(qs);t['quartzFirstLatencyMs']=qs[0]['start']-t['start'] if qs else None
 def turnstats(rr):
  return {'turns':len(rr),'withQuartz':sum(t['quartzCount']>0 for t in rr),'quartzCount':sum(t['quartzCount'] for t in rr),'medianFirstLatencyMs':med([t['quartzFirstLatencyMs'] for t in rr if t['quartzFirstLatencyMs'] is not None])}
 states={}
 for f in frames:
  state=f['state'];v=states.setdefault(state,{'frames':0,'activeFrames':0});v['frames']+=1;v['activeFrames']+=int(f['rms']>80)
 summary['loudness']=replay_loudness(frames, [f for ff in data.values() for f in ff])
 events=m['events'];stateTimes={}
 last=0;state='listening'
 for e in events:
  if e['message'].startswith('Environment: '):
   update=json.loads(e['message'].split(': ',1)[1]);nxt=update['state'];t=0 if update.get('revision')==1 else max(last,min(durationMs,e['t']))
   stateTimes[state]=stateTimes.get(state,0)+max(0,t-last);last=t;state=nxt
 stateTimes[state]=stateTimes.get(state,0)+max(0,durationMs-last)
 summary.update({'observedDurationMs':durationMs,'failure':m['failure'],'configuration':m['manifest'],'quartz':{'vocalizationGroups':len(qg),'groupsPerMinute':len(qg)/(durationMs/60000),'medianGroupDurationMs':med([q['end']-q['start'] for q in qg]),'medianInterOnsetMs':med([b['start']-a['start'] for a,b in zip(qg,qg[1:])]),'activeSeconds':sum(f['rms']>80 for f in frames)*.02,'stateAudio':states,'stateDurationsMs':stateTimes,'turns':turnstats(rows),'byTurnLength':{label:turnstats([t for t in rows if lo<=t['end']-t['start']<hi]) for label,lo,hi in [('2-5s',2000,5000),('5-15s',5000,15000),('15s+',15000,float('inf'))]},'groups':qg,'perTurn':rows},'playedTranscript':m['played'],'rawTranscript':m['raw'],'timing':{'lateActions':len(m['lags']),'maxLateMs':max(m['lags'],default=0)},'diagnostics':[e for e in events if any(s in e['message'] for s in ['dropped','Dropping','recovery','Session started'])]})
out.parent.mkdir(parents=True,exist_ok=True)
target=out/('summary.json' if metrics.exists() else 'human-baseline.json')
target.write_text(json.dumps(summary,indent=2))
compact={k:v for k,v in summary.items() if k not in ['rawTranscript','playedTranscript','configuration']}
if 'quartz' in compact:compact['quartz']={k:v for k,v in compact['quartz'].items() if k not in ['perTurn','groups']}
if 'loudness' in compact:compact['loudness']={k:v for k,v in compact['loudness'].items() if k!='events'}
print(json.dumps(compact,indent=2))
