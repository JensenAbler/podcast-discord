#!/usr/bin/env python3
"""Partition fixed evaluation windows at output blocks; start a fresh session per span."""
import hashlib,json,sys
from pathlib import Path

def spans(start,end,blocks):
    cursor=start
    for a,b in sorted(blocks):
        if b<=cursor or a>=end:continue
        if a>cursor:yield cursor,min(a,end)
        cursor=max(cursor,b)
        if cursor>=end:return
    if cursor<end:yield cursor,end

def main(source,target):
    original=json.loads(Path(source).read_text())
    result={'mode':'turn-isolated','purpose':'Fresh Quartz session ready before each listening span. Measures within-turn timing, not continuous handoff reliability. All spans in fixed source windows retained or explicitly excluded.','sourcePlanSha256':hashlib.sha256(Path(source).read_bytes()).hexdigest(),'cases':[],'excluded':[]}
    for case in original['cases']:
        episode=Path(case['episode'])
        ref=json.loads((episode/'reference.json').read_text())
        rows=[json.loads(x) for x in (episode/'audio-journal/chunks.jsonl').read_text().splitlines()]
        start=case['startSec'];end=start+case['durationSec']
        for i,(a,b) in enumerate(spans(start,end,ref['outputBlockIntervals'])):
            if b-a>600:raise ValueError('Listening span exceeds 600s; explicitly choose shorter fixed source windows')
            has_pcm=any(r.get('type')=='pcm' and a*1000<=r['timelineOffsetMs']<b*1000 for r in rows)
            if not has_pcm:
                result['excluded'].append({'sourceCase':case['id'],'startSec':a,'endSec':b,'reason':'no guest PCM'})
                continue
            result['cases'].append({**case,'id':case['id']+'-turn-'+str(i+1),'startSec':round(a,3),'durationSec':round(b-a,3),'warmupSec':0})
    Path(target).write_text(json.dumps(result,indent=2))
    print(json.dumps({'cases':len(result['cases']),'replaySeconds':sum(c['durationSec'] for c in result['cases']),'excluded':result['excluded']}))
if __name__=='__main__':main(*sys.argv[1:])
