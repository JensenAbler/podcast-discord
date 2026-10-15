#!/usr/bin/env python3
"""Conservative interviewer removal. Keeps real time and an independent reference."""
import json,sys,re,math,datetime,os,hashlib
from pathlib import Path

ACK=re.compile(r"(?:(?:yeah|yes|yep|yup|right|okay|ok|sure|mhm|mmhmm|hmm|hm|mm|m|uhhuh|wow|oh|really|absolutely|exactly|interesting|indeed|totally|uh|huh|ah|of course|i see|that s interesting|that s right|that s something)\s*)+")
def norm(s):return ' '.join(re.findall(r"[a-z]+",re.sub(r"\[[^]]*\]","",s.lower()).replace('’',"'")))
def ack(t):return 0<t['end']-t['start']<=3 and bool(ACK.fullmatch(norm(t.get('text',''))))
def merge(rows):
 out=[]
 for s,e in sorted(rows):
  if e<=s:continue
  if out and s<=out[-1][1]:out[-1][1]=max(e,out[-1][1])
  else:out.append([s,e])
 return out
def overlap(s,e,a,b):return max(0,min(e,b)-max(s,a))
def main(base,name):
 base=Path(base);old=base/(name+'-aligned');a=json.loads((old/'alignment.json').read_text());om=json.loads((old/'audio-journal/manifest.json').read_text());turns=a['turns']
 diar=[];maps=[]
 for p in sorted((base/(name+'-diarization')).glob('*.json')):
  d=json.loads(p.read_text());scores={}
  for t in d['result']['speaker_turns']:
   s,e=t['start']+d['start'],t['end']+d['start'];sc=scores.setdefault(t['speaker'],{'host':0,'guest':0})
   for f in turns:
    if f['accepted'] and f['coverage']>=.9 and f['end']-f['start']>3:sc[f['role']]+=overlap(s,e,f['start'],f['end'])
  mapping={}
  for speaker,sc in scores.items():
   role=max(sc,key=sc.get);purity=sc[role]/max(.001,sum(sc.values()))
   mapping[speaker]=role if purity>=.8 and sum(sc.values())>=5 else 'unknown'
  maps.append({'file':str(p),'roles':mapping,'overlapSeconds':scores})
  for t in d['result']['speaker_turns']:
   s,e=t['start']+d['start'],t['end']+d['start'];local={'host':0,'guest':0}
   for u in d['result']['speaker_turns']:
    us,ue=u['start']+d['start'],u['end']+d['start']
    if u['speaker']!=t['speaker'] or ue<s-180 or us>e+180:continue
    for f in turns:
     if f['accepted'] and f['coverage']>=.9 and f['end']-f['start']>4:local[f['role']]+=overlap(us,ue,f['start'],f['end'])
   role=max(local,key=local.get);purity=local[role]/max(.001,sum(local.values()))
   if purity<.8 or sum(local.values())<5:role='unknown'
   # Long fixture turns give a stronger local anchor than a drifting diarizer ID.
   direct={'host':0,'guest':0}
   for f in turns:
    if f['accepted'] and f['coverage']>=.9:direct[f['role']]+=overlap(s,e,f['start'],f['end'])
   dr=max(direct,key=direct.get)
   if e-s>4 and sum(direct.values())>=.8*(e-s) and direct[dr]>=.85*sum(direct.values()):role=dr
   diar.append({**t,'start':s,'end':e,'role':role,'localSpeakerPurity':purity})

 if not diar:raise ValueError('Missing diarization')
 if max(t['end'] for t in diar)<om['endSec']-10:raise ValueError('Incomplete diarization')
 start,end=om['startSec'],om['endSec']
 # Acknowledgments are reference events, never host playback blocks.
 candidates=[{**t,'label':'automatic-acknowledgment-candidate','verified':False} for t in diar if t['role']=='host' and ack(t)]
 # Every identified host sound is removed from input, with 150 ms padding.
 mask=merge([(max(start,t['start']-.15),min(end,t['end']+.15)) for t in diar if t['role'] in ('host','unknown')]+
            [(max(start,t['start']-.15),min(end,t['end']+.15)) for t in turns if t['role']=='host' and 'start' in t])
 guest=merge([(t['start'],t['end']) for t in turns if t['role']=='guest' and t['accepted']])
 exclusions=[(x['start'],x['end']) for x in om['excludedIntervals']]
 # Extend the guest activity interval over reference acks, preserving the listener role.
 activity=guest
 substantive=[(t['start'],t['end']) for t in diar if t['role']=='unknown' or (t['role']=='host' and not ack(t))]
 blocks=merge(substantive+exclusions)
 # Bridge short pauses uniformly, not just reference events.
 bridged=[]
 for s,e in activity:
  if bridged and s-bridged[-1][1]<=4 and not any(overlap(bridged[-1][1],s,x,y)>0 for x,y in blocks):bridged[-1][1]=e
  else:bridged.append([s,e])
 activity=bridged
 for t in candidates:
  t['scorable']=not any(overlap(t['start']-1,t['end']+1,s,e)>0 for s,e in blocks)

 out=base/(name+'-guest-only');j=out/'audio-journal';j.mkdir(parents=True,exist_ok=True)
 ref={'schemaVersion':1,'status':'provisional-machine-labels','method':'Fish transcribe-1-pro speaker turns mapped per request using >=80% duration agreement with high-confidence fixture turns. Lexical acknowledgment whitelist and <=3s duration. Not manually verified; questions/substantive turns excluded.','speakerMapping':maps,'candidates':candidates,'inputMuteIntervals':mask,'outputBlockIntervals':blocks,'guestActivityIntervals':activity,'limitations':['Mono mixture: muting identified overlaps also removes simultaneous guest audio. Unrecognized interviewer sounds may remain. Silence at a removed acknowledgment may cue the model.','Reference onset is estimated from ASR timestamps, not manually annotated acoustic onset. Missing nonlexical sounds can bias recall and precision.']}
 (out/'reference.json').write_text(json.dumps(ref,indent=2))
 # Only write unmasked guest audio. Zero frames preserve activity without leaking host audio.
 original=open(old/'audio-journal/publisher-mixed.pcm','rb')
 zero=b'\0'*3840;origin=om['startedAtMs'];count=0;muted=0
 def inside(s,e,rows):return any(overlap(s,e,a,b)>0 for a,b in rows)
 with (j/'guest-only.pcm').open('wb') as pcm,(j/'chunks.jsonl').open('w') as journal:
  for s,e in activity:
   for frame in range(math.ceil(s*50),math.floor(e*50)):
    fs,fe=frame/50,(frame+1)/50
    if inside(fs,fe,blocks):continue
    blocked=inside(fs,fe,mask)
    original.seek(frame*3840);b=zero if blocked else original.read(3840)
    if len(b)!=3840:raise ValueError('Short PCM read')
    if not blocked:
     from array import array
     vals=array('h',b)
     if inside(fs-.02,fs,mask):
      for z in range(240):
       vals[2*z]=int(vals[2*z]*z/240);vals[2*z+1]=int(vals[2*z+1]*z/240)
     if inside(fe,fe+.02,mask):
      for z in range(240):
       vals[-2*z-2]=int(vals[-2*z-2]*z/240);vals[-2*z-1]=int(vals[-2*z-1]*z/240)
     b=vals.tobytes()
    offset=pcm.tell();pcm.write(b)
    journal.write(json.dumps({'type':'pcm','sourceType':'participant','sourceId':'fixture-guest','file':'guest-only.pcm','byteOffset':offset,'byteLength':3840,'timelineOffsetMs':frame*20,'durationMs':20,'interviewerMuted':blocked})+'\n')
    count+=1;muted+=blocked
 def iso(s):return datetime.datetime.fromtimestamp(origin/1000+s,datetime.timezone.utc).isoformat()
 rows=[{'speakerRole':'guest','text':t['text'],'asrCompletedAt':iso(t['end']),'source':'aligned-fixture-at-turn-end'} for t in turns if t['accepted'] and t['role']=='guest']
 rows.extend({'speakerRole':'host','playbackStartedAt':iso(s),'playbackEndedAt':iso(e),'source':'substantive-or-excluded-only'} for s,e in blocks)
 (out/'transcript.jsonl').write_text(''.join(json.dumps(t)+'\n' for t in rows))
 meta={**om,'sourceType':'aligned-publisher-mix','referenceFile':str(out/'reference.json'),'referenceSha256':hashlib.sha256((out/'reference.json').read_bytes()).hexdigest(),'guestAudioSec':(count-muted)*.02,'maskedInputSec':muted*.02,'scope':'Guest-only best-effort input: accepted guest intervals with all fixture/diarized interviewer intervals muted using 150ms padding. Reference backchannels do not block Quartz. Substantive interviewer turns and uncertain regions block output. No interviewer audio or text fed to Quartz; unknown overlaps may remain. Guest text at aligned turn end; no new Alpha generation.'}
 (j/'manifest.json').write_text(json.dumps(meta,indent=2))
 print(json.dumps({'name':name,'candidates':len(candidates),'guestAudioSec':meta['guestAudioSec'],'maskedInputSec':meta['maskedInputSec'],'speakerMapping':maps}))
if __name__=='__main__':main(*sys.argv[1:])
