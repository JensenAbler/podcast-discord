#!/usr/bin/env python3
"""Offline, descriptive GPT Live mirroring eval. Standard library only."""
import argparse, collections, hashlib, importlib.util, json, math, re, statistics
from pathlib import Path

spec = importlib.util.spec_from_file_location("state_eval", Path(__file__).with_name("live-state-eval.py"))
state = importlib.util.module_from_spec(spec)
spec.loader.exec_module(state)

def normalize(text):
    return " ".join(re.findall(r"[a-z]+(?:'[a-z]+)?", text.lower()))

def summary(xs):
    xs = sorted(x for x in xs if x is not None and math.isfinite(x))
    return {"n":len(xs), "median":statistics.median(xs) if xs else None,
            "p90":xs[max(0, math.ceil(.9*len(xs))-1)] if xs else None}

def correlation(pairs):
    if len(pairs)<3: return None
    x,y=zip(*pairs); a=statistics.mean(x); b=statistics.mean(y)
    denom=math.sqrt(sum((v-a)**2 for v in x)*sum((v-b)**2 for v in y))
    return sum((v-a)*(w-b) for v,w in pairs)/denom if denom else None

def lexical(texts):
    labels=[normalize(t) for t in texts if normalize(t)]
    c=collections.Counter(labels); n=len(labels)
    return {"n":n,"unique":len(c),"counts":dict(c.most_common()),
            "topTwoShare":sum(v for _,v in c.most_common(2))/n if n else None,
            "samePhrasePairProbability":sum(v*(v-1) for v in c.values())/(n*(n-1)) if n>1 else None,
            "adjacentRepeatShare":sum(a==b for a,b in zip(labels,labels[1:]))/(n-1) if n>1 else None,
            "entropyBits":-sum((v/n)*math.log2(v/n) for v in c.values()) if n else None}

def merge(rows, gap=400):
    result=[]
    for r in sorted(rows,key=lambda r:state.ms(r["playbackStartedAt"])):
        a,b=state.ms(r["playbackStartedAt"]),state.ms(r["playbackEndedAt"])
        session=(r.get("backchannelEvidence") or {}).get("sessionId")
        if result and session==result[-1]["session"] and 0<=a-result[-1]["end"]<=gap:
            result[-1]["end"]=max(b,result[-1]["end"]); result[-1]["text"]+=" "+r["text"]
        else: result.append({"start":a,"end":b,"text":r["text"],"session":session})
    return result

def evaluate(path):
    path=Path(path)
    if not (path/"episode-complete.json").exists(): raise ValueError("Incomplete episode: "+str(path))
    hashes={}
    def read(name,lines=False):
        data=(path/name).read_bytes(); hashes[name]=hashlib.sha256(data).hexdigest()
        return [json.loads(l) for l in data.splitlines() if l.strip()] if lines else json.loads(data)
    meta=read("episode-metadata.json"); manifest=read("audio-journal/manifest.json")
    rows=read("transcript.jsonl",True); events=read("live-turn-events.jsonl",True)
    quartz=read("quartz-transcript.jsonl",True); audio=read("audio-recording-metadata.json")
    baseline=state.evaluate(events,rows,quartz,meta)
    all_q=[r for r in rows if r.get("source")=="quartz"]
    usable=[r for r in all_q if r.get("text","").strip() and r.get("playbackStartedAt") and r.get("playbackEndedAt") and (r.get("backchannelEvidence") or {}).get("consumedVoicedFrames",0)>0]
    groups=merge(usable)
    states=[]
    for e in events:
        s=state.payload(e,"Environment: ")
        if s: states.append((state.ms(e["observedAt"]),s["state"]))
    def at(t):
        return next((s for ts,s in reversed(states) if ts<=t),"unknown")
    secs=baseline["liveSessionSeconds"]
    available=sum(baseline["stateSeconds"].get(k,0) for k in ("listening","holding"))
    guests=[r for r in rows if r.get("speakerRole")=="guest" and r.get("text","").strip() and r.get("speechStartedAt") and r.get("speechEndedAt") and (r.get("admission") or {}).get("status")=="accepted"]
    # One latest guest segment per Quartz group, <=10s after speech or during speech.
    pacing=[]
    for g in groups:
        candidates=[r for r in guests if state.ms(r["speechStartedAt"])<=g["start"] and g["start"]-state.ms(r["speechEndedAt"])<=10000]
        if candidates:
            r=max(candidates,key=lambda r:state.ms(r["speechStartedAt"]))
            duration=state.ms(r["speechEndedAt"])-state.ms(r["speechStartedAt"])
            if duration>=1000: pacing.append((len(normalize(r["text"]).split())*60000/duration,g["end"]-g["start"]))
    diagnostics=[state.payload(e,"Audio diagnostics: ") for e in events]
    diagnostics=[d for d in diagnostics if d]
    peaks=[]; pairs=[]
    for d in diagnostics:
        inp=d.get("paths",{}).get("inputSent",{})
        out=d.get("paths",{}).get("outputConsumed",{})
        if out.get("peak",0)>8:
            y=20*math.log10(out["peak"]/32768); peaks.append(y)
            if inp.get("peak",0)>8: pairs.append((20*math.log10(inp["peak"]/32768),y))
    words=[]
    for g in groups:
        tokens=normalize(g["text"]).split()
        if any(t not in {"mm","m","hmm","hm","h","ah","uh","huh","mhm"} for t in tokens):
            words.append({"offsetSeconds":round((g["start"]-state.ms(meta["startedAt"]))/1000,2),"text":g["text"]})
    return {"episode":path.name,"startedAt":meta["startedAt"],"plan":meta.get("episodePlan"),
        "sourceHashes":hashes,"mode":baseline["mode"],"sessionSeconds":secs,
        "recordedAudioSeconds":manifest.get("durationMs",0)/1000,
        "coverage":{"quartzRows":len(all_q),"consumedTextRows":len(usable),"excludedRows":len(all_q)-len(usable),
                    "playbackStatuses":dict(collections.Counter(r.get("playbackStatus") for r in all_q)),
                    "timingStatuses":dict(collections.Counter((r.get("backchannelEvidence") or {}).get("timingStatus") for r in usable)),
                    "guestAcceptedSegments":len(guests),"stems":audio.get("audio",{}).get("stems"),
                    "preserveJournalAudio":manifest.get("preserveJournalAudio")},
        "lexical":lexical([g["text"] for g in groups]),
        "groupingSensitivity":{str(gap):lexical([g["text"] for g in merge(usable,gap)]) for gap in (0,800)},
        "pacing":{"groupsPerMinute":len(groups)*60/secs if secs else None,
                  "groupsPerAvailableMinute":sum(at(g["start"]) in ("listening","holding") for g in groups)*60/available if available else None,
                  "durationMs":summary([g["end"]-g["start"] for g in groups]),
                  "interOnsetMs":summary([b["start"]-a["start"] for a,b in zip(groups,groups[1:])]),
                  "byState":dict(collections.Counter(at(g["start"]) for g in groups)),
                  "guestWpmVsAcknowledgmentDurationPearson":correlation(pacing),"guestPacingPairs":len(pacing)},
        "volumeProxy":{"consumedWindowPeakDbFS":summary(peaks),
                       "inputOutputPeakPearson":correlation(pairs),"pairedWindows":len(pairs),
                       "medianOutputMinusInputDb":summary([y-x for x,y in pairs])["median"]},
        "verbalReview":words,"stateEval":baseline}

LIMITS=[
"Observational comparison of two different episodes; no causal attribution or significance claim.",
"Both use current mode and gpt-live-1 / quartz; different topics, guest delivery, background noise, processing waits, and episode plans remain confounds.",
"The earlier episode predates the current-turn-context-order change as well as mirroring; deployed source is inferred from deployment chronology, not an episode-stored prompt hash.",
"Only text with consumed-PCM evidence is counted. Excluded rows include not-started/unmapped output, not necessarily audible failures. Client consumption is not proof of reception by the guest.",
"Utterances merge within 400ms in the same Live session. 0/800ms sensitivity results are included. All playback timing is estimated.",
"5-second peak telemetry is neither RMS nor perceived loudness. Same-window input/output correlation is an exploratory proxy, not an exact stimulus-response mirroring score; windows are autocorrelated.",
"Pitch, emotional tone, and prosodic matching are unscored: isolated stems and source PCM were not retained. Pacing correlation uses guest segment WPM versus acknowledgment duration, not Quartz speaking rate.",
"Nonlexical spelling and segmentation come from ASR. Phrase diversity does not establish vocal diversity. More acknowledgments are not automatically better.",
"Review every verbal phrase for substantive overreach in context; do not infer role compliance from a word-count heuristic."
]

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("before"); parser.add_argument("after"); parser.add_argument("--out",required=True)
    args=parser.parse_args()
    before,after=evaluate(args.before),evaluate(args.after)
    result={"schemaVersion":1,"interventionCommit":"daed1f97013e61590297c3a230d7520d378c986a",
            "deploymentUtc":"2026-09-14T23:15:03Z","before":before,"after":after,"limits":LIMITS}
    out=Path(args.out); out.parent.mkdir(parents=True,exist_ok=True)
    out.write_text(json.dumps(result,indent=2,ensure_ascii=False)+"\n")
    print(json.dumps({k:{f:r[f] for f in ("episode","coverage","lexical","pacing","volumeProxy","verbalReview")} for k,r in (("before",before),("after",after))},indent=2))
if __name__=="__main__": main()
