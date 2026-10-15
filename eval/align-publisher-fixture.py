#!/usr/bin/env python3
"""Align fixture tokens to timestamped publisher ASR; retain uncertainty and provenance."""
import json,re,sys,difflib,hashlib,subprocess,math
from pathlib import Path
base=Path(sys.argv[1]);name=sys.argv[2];fixture=Path(sys.argv[3])
turns=json.loads(fixture.read_text())['turns']
def tokens(s):return re.findall(r"[a-z0-9]+",re.sub(r"\[[^]]*\]","",s.lower()).replace("’","'"))
words=[]
for p in sorted((base/(name+'-asr')).glob('*.json')):
 d=json.loads(p.read_text())
 for seg in d['result']['raw']['segments']:
  ts=tokens(seg['text'])
  for i,t in enumerate(ts):
   words.append({'text':t,'start':d['start']+seg['start']+(seg['end']-seg['start'])*i/len(ts),'end':d['start']+seg['start']+(seg['end']-seg['start'])*(i+1)/len(ts)})
ref=[];ranges=[]
for t in turns:
 a=len(ref);ref.extend(tokens(t['text']));ranges.append((a,len(ref)))
match={}
for block in difflib.SequenceMatcher(None,ref,[w['text'] for w in words],autojunk=False).get_matching_blocks():
 for j in range(block.size):match[block.a+j]=block.b+j
aligned=[]
for i,(t,(a,b)) in enumerate(zip(turns,ranges)):
 pairs=[(j,match[j]) for j in range(a,b) if j in match]
 coverage=len(pairs)/max(1,b-a);reasons=[]
 if not pairs:
  aligned.append({'index':i,'role':t['role'],'coverage':0,'accepted':False,'reasons':['no matched words']});continue
 first,last=pairs[0],pairs[-1]
 if coverage<.75:reasons.append('token coverage below 75%')
 if first[0]-a>2 or b-1-last[0]>2:reasons.append('uncertain edge exceeds two words')
 start=words[first[1]]['start'];end=words[last[1]]['end']
 # Long ASR insertions between anchors may be advertisements or missing fixture text.
 gaps=[{'start':words[x[1]]['end'],'end':words[y[1]]['start']} for x,y in zip(pairs,pairs[1:]) if words[y[1]]['start']-words[x[1]]['end']>10]
 if gaps:reasons.append('internal alignment gap above ten seconds')
 aligned.append({'index':i,'role':t['role'],'text':t['text'],'coverage':coverage,'start':start,'end':end,'edgeMissingWords':[first[0]-a,b-1-last[0]],'accepted':not reasons,'reasons':reasons,'gaps':gaps})
out=base/(name+'-aligned');out.mkdir(exist_ok=True)
report={'fixture':str(fixture),'fixtureSha256':hashlib.sha256(fixture.read_bytes()).hexdigest(),'sourceAudio':str(base/(name+'-podcast.mp3')),'sourceAudioSha256':hashlib.file_digest(open(base/(name+'-podcast.mp3'),'rb'),'sha256').hexdigest(),'method':'Monotonic exact normalized-token matching against Fish word timestamps. No fixture timestamps assumed. >=75% token coverage, <=2 missing words at either edge, no internal >10s alignment gap. Matched word boundaries only; missing edge words excluded. Not manually forced-aligned or speaker-separated.','tokenCoverage':len(match)/len(ref),'totalTurns':len(turns),'acceptedTurns':sum(t['accepted'] for t in aligned),'turns':aligned}
(out/'alignment.json').write_text(json.dumps(report,indent=2))
print(json.dumps({k:v for k,v in report.items() if k!='turns'},indent=2))
print('REJECTED',json.dumps([{k:v for k,v in t.items() if k!='text'} for t in aligned if not t['accepted']]))
