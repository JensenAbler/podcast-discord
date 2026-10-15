#!/usr/bin/env python3
"""Adapt aligned mixed publisher audio to the existing listener replay journal."""
import json,sys,subprocess,math,datetime
from pathlib import Path
out=Path(sys.argv[1]);a=json.loads((out/'alignment.json').read_text());turns=a['turns'];j=out/'audio-journal';j.mkdir(exist_ok=True)
pcm=j/'publisher-mixed.pcm'
if not pcm.exists():subprocess.run(['ffmpeg','-v','error','-i',a['sourceAudio'],'-ac','2','-ar','48000','-f','s16le',str(pcm)],check=True)
duration=pcm.stat().st_size/192000
origin=1767225600000
def iso(s):return datetime.datetime.fromtimestamp((origin+s*1000)/1000,datetime.timezone.utc).isoformat()
transcript=[];excluded=[];guest=[]
for t in turns:
 if 'start' not in t:continue
 if t['accepted'] and t['role']=='guest':
  guest.append(t)
  transcript.append({'speakerRole':'guest','text':t['text'],'asrCompletedAt':iso(t['end']),'fixtureTurn':t['index'],'source':'aligned-fixture-at-turn-end'})
 else:
  transcript.append({'speakerRole':'host','text':t.get('text','') if t['accepted'] else '', 'playbackStartedAt':iso(t['start']),'playbackEndedAt':iso(t['end']),'source':'recorded-interviewer' if t['accepted'] else 'alignment-excluded','fixtureTurn':t['index']})
  if not t['accepted']:excluded.append({'start':t['start'],'end':t['end'],'reason':t['reasons']})
known=sorted([t for t in turns if 'start' in t],key=lambda t:t['start'])
for l,r in zip(known,known[1:]):
 if r['start']-l['end']>10:
  excluded.append({'start':l['end'],'end':r['start'],'reason':['unmatched audio gap >10s']})
  transcript.append({'speakerRole':'host','playbackStartedAt':iso(l['end']),'playbackEndedAt':iso(r['start']),'source':'alignment-excluded'})
# Eliminate nested/overlapping block toggles: the original runner expects disjoint intervals.
blocks=sorted((datetime.datetime.fromisoformat(t['playbackStartedAt']).timestamp()*1000-origin,datetime.datetime.fromisoformat(t['playbackEndedAt']).timestamp()*1000-origin) for t in transcript if 'playbackStartedAt' in t)
merged=[]
for s,e in blocks:
 if merged and s<=merged[-1][1]:merged[-1][1]=max(e,merged[-1][1])
 else:merged.append([s,e])
textrows=[{k:v for k,v in t.items() if k not in ('playbackStartedAt','playbackEndedAt')} for t in transcript if t.get('text')]
for s,e in merged:textrows.append({'speakerRole':'host','playbackStartedAt':iso(s/1000),'playbackEndedAt':iso(e/1000),'source':'publisher-mask'})
(out/'transcript.jsonl').write_text(''.join(json.dumps(t)+'\n' for t in textrows))
count=0
with (j/'chunks.jsonl').open('w') as f:
 for t in guest:
  for frame in range(math.ceil(t['start']*50),math.floor(t['end']*50)):
   ms=frame*20
   if any(s<=ms<e for s,e in merged):continue
   f.write(json.dumps({'type':'pcm','sourceType':'participant','sourceId':'fixture-guest','file':pcm.name,'byteOffset':frame*3840,'byteLength':3840,'timelineOffsetMs':ms,'durationMs':20})+'\n');count+=1
start=known[0]['start'];end=max(t['end'] for t in known)
meta={'startedAtMs':origin,'sourceType':'aligned-publisher-mix','alignmentFile':str(out/'alignment.json'),'startSec':start,'endSec':end,'durationSec':end-start,'guestAudioSec':count*.02,'excludedIntervals':excluded,'sourceAudioSha256':a['sourceAudioSha256'],'scope':'Publisher mixed audio restricted to accepted fixture guest intervals; recorded interviewer and uncertain intervals block output. Fixture text delivered at aligned turn end, not live ASR latency. Word ASR alignment is estimated; original host overlaps may remain. No new Alpha generation.'}
(j/'manifest.json').write_text(json.dumps(meta,indent=2));print(json.dumps(meta,indent=2))
