import pathlib,json,statistics,collections,math
import sys,re,datetime
root=pathlib.Path(sys.argv[1])
reports=[]
for p in sorted(root.glob('*/metrics.json')):
 d=json.loads(p.read_text()); run=p.parent.name
 stateEvents=[]
 for e in d['events']:
  if e['message'].startswith('Environment: '):stateEvents.append((e['t'],json.loads(e['message'][13:])['state']))
 end=max([x['t'] for x in d['consumed']]+[0])
 spans=[(t,stateEvents[i+1][0] if i+1<len(stateEvents) else end,s) for i,(t,s) in enumerate(stateEvents)]
 manifest=json.loads((p.parent/'manifest.json').read_text())
 failures=[line for line in (p.parent/'runtime.log').read_text().splitlines() if 'credit balance' in line or 'Direct generator failed:' in line]
 cutoff=None
 if failures:
  stamp=re.search(r'^\[([^\]]+)\]',failures[0])
  if stamp:
   cutoff=datetime.datetime.fromisoformat(stamp[1].replace('Z','+00:00')).timestamp()*1000-manifest['startedAt']
   end=min(end,cutoff)
 spans=[(a,min(b,end),s) for a,b,s in spans if a<end]
 d['consumed']=[f for f in d['consumed'] if f['t']<end]
 active=[f for f in d['consumed'] if f['source']=='quartz' and f['rms']>80]
 groups=[]
 for f in active:
  if groups and f['t']-groups[-1][-1]['t']<=180:groups[-1].append(f)
  else:groups.append([f])
 sounds=[]
 for g in groups:
  a,b=g[0],g[-1];duration=b['t']-a['t']+20
  sounds.append({'t':a['t'],'duration':duration,'state':a['state']})
 by={}
 for state in ['holding','holding_longer','holding_rising']:
  intervals=[(a,b) for a,b,s in spans if s==state and b>a]
  dur=sum(b-a for a,b in intervals)
  voiced=sum(20 for f in active if any(a<=f['t']<b for a,b in intervals))
  gaps=[]
  for a,b in intervals:
   ts=[max(a,min(b,f['t'])) for f in active if a<=f['t']<b]
   gaps.extend([max(0,y-x-20) for x,y in zip([a]+ts,ts+[b])])
  ss=[s for s in sounds if s['state']==state]
  by[state]={'seconds':round(dur/1000,2),'voicedSeconds':round(voiced/1000,2),'coveragePct':round(100*voiced/dur,1) if dur else None,'maxGapSeconds':round(max(gaps,default=0)/1000,2),
   'soundCount':len(ss),'medianSoundMs':round(statistics.median(s['duration'] for s in ss)) if ss else None,
   'longestSoundMs':max((s['duration'] for s in ss),default=0)}
 transcript=pathlib.Path(d['recordingPath'])/'transcript.jsonl'
 tr=[json.loads(l) for l in transcript.read_text().splitlines()] if transcript.exists() else []
 qt=pathlib.Path(d['recordingPath'])/'quartz-transcript.jsonl'
 texts=[json.loads(l) for l in qt.read_text().splitlines()] if qt.exists() else []
 report={'run':run,'failure':d['failure'],'providerFailure':failures[0] if failures else None,'validUntilMs':cutoff,'stages':by,'sounds':sounds,
 'alphaReplies':[{'text':e.get('text'), 'status':e.get('playbackStatus')} for e in tr if e.get('speakerRole')=='host' and e.get('source')!='quartz'],
 'guestTexts':[e.get('text') for e in tr if e.get('speakerRole')=='guest'],
 'quartzText':''.join(e.get('text','') for e in texts),
 'unblockedText':''.join(e.get('text','') for e in texts if not e.get('playbackBlocked')),
 'recoveries':sum(e['message'].startswith('Context recovery:') for e in d['events']),
 'handoffs':[json.loads(e['message'].split(': ',1)[1]) for e in [json.loads(l) for l in (pathlib.Path(d['recordingPath'])/'live-turn-events.jsonl').read_text().splitlines()] if e.get('message','').startswith('Handoff completed:')]}
 reports.append(report)
 print(json.dumps({k:v for k,v in report.items() if k not in ['sounds','alphaReplies']},ensure_ascii=False))
(root/'analysis.json').write_text(json.dumps(reports,indent=2))
