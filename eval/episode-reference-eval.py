#!/usr/bin/env python3
"""Pinned historical listening reference; no provider calls."""
import argparse, hashlib, importlib.util, json
from pathlib import Path
from backchannel_loudness import dbfs, describe
spec=importlib.util.spec_from_file_location("mirroring",Path(__file__).with_name("mirroring-eval.py"))
mirroring=importlib.util.module_from_spec(spec); spec.loader.exec_module(mirroring)
state=mirroring.state
def evaluate(fixture,root):
    p=root/fixture["recording"]
    for name,digest in fixture["sourceHashes"].items():
        if hashlib.sha256((p/name).read_bytes()).hexdigest()!=digest:
            raise ValueError("Reference source changed: "+name)
    base=mirroring.evaluate(p)
    events=[json.loads(x) for x in (p/"live-turn-events.jsonl").read_text().splitlines()]
    transitions=sorted((state.ms(e["observedAt"]),s["state"]) for e in events if (s:=state.payload(e,"Environment: ")))
    origin=state.ms(base["startedAt"]); windows=[]
    for e in events:
        d=state.payload(e,"Audio diagnostics: ")
        if not d: continue
        a,b=d["since"],d["until"]
        s=next((s for t,s in reversed(transitions) if t<=a),"unknown")
        if any(a<t<b for t,_ in transitions): s="mixed-transition"
        paths=d.get("paths",{})
        q=dbfs(paths.get("outputConsumed",{}).get("peak",0))
        h=dbfs(paths.get("inputSent",{}).get("peak",0))
        windows.append({"startMs":a-origin,"endMs":b-origin,"state":s,"outputPeakDbFS":q,
                        "guestInputPeakDbFS":h,"outputMinusGuestInputPeakDb":q-h if q is not None and h is not None else None})
    by={}
    for s in sorted({w["state"] for w in windows}):
        ww=[w for w in windows if w["state"]==s]
        by[s]={"windows":len(ww),"outputPeakDbFS":describe([w["outputPeakDbFS"] for w in ww]),
               "outputMinusGuestInputPeakDb":describe([w["outputMinusGuestInputPeakDb"] for w in ww])}
    rows=[json.loads(x) for x in (p/"transcript.jsonl").read_text().splitlines()]
    usable=[r for r in rows if r.get("source")=="quartz" and r.get("text","").strip()
            and r.get("playbackStartedAt") and r.get("playbackEndedAt")
            and (r.get("backchannelEvidence") or {}).get("consumedVoicedFrames",0)>0]
    review=[{"startMs":g["start"]-origin,"endMs":g["end"]-origin,"text":g["text"],
             "timingLabel":None,"volumeFitLabel":None,"floorAudibilityLabel":None} for g in mirroring.merge(usable)]
    return {"schemaVersion":1,"reference":fixture,"historical":base,
            "loudness":{"measurement":"coarse-diagnostic-window-peaks-only","isolatedRmsDbFS":None,"isolatedLUFS":None,
                        "byState":by,"windows":windows},"reviewEvents":review,"timingGroundTruthComplete":False,
            "limitations":["User labels describe overall listening experience, not per-event timing approvals.",
            "No isolated stems/PCM remain. Exact overlapping Quartz RMS/LUFS and published-mix balance unavailable.",
            "Mixed-state diagnostic windows are segregated. Peaks do not locate individual vocalizations.",
            "Recording offsets are not published episode offsets; intro/outro/edit alignment is not assumed.",
            "Historical mixed audio is not clean guest-only replay input. Fade remains an untested hypothesis."]}
def main():
    ap=argparse.ArgumentParser(); ap.add_argument("fixture",type=Path)
    ap.add_argument("--recordings-root",type=Path,default=Path("/opt/clawcast-network/content/recordings"))
    ap.add_argument("--out",type=Path,required=True); a=ap.parse_args()
    r=evaluate(json.loads(a.fixture.read_text()),a.recordings_root)
    a.out.parent.mkdir(parents=True,exist_ok=True); a.out.write_text(json.dumps(r,indent=2)+"\n")
    print(json.dumps({"episode":r["reference"]["episode"],"groups":len(r["reviewEvents"]),"loudnessByState":r["loudness"]["byState"]},indent=2))
if __name__=="__main__": main()
