"""Amplitude diagnostics, not perceptual or conversational-quality scores."""
import math, statistics
def dbfs(v):
    return 20*math.log10(v/32768) if v > 0 else None
def describe(v):
    v=sorted(x for x in v if x is not None and math.isfinite(x))
    return {"n":len(v),"median":statistics.median(v) if v else None,
            "p90":v[max(0,math.ceil(.9*len(v))-1)] if v else None}
def energy(frames):
    pairs=[(f["rms"],f.get("duration",20)) for f in frames if f.get("duration",20)>0 and math.isfinite(f["rms"])]
    total=sum(w for _,w in pairs)
    return math.sqrt(sum(v*v*w for v,w in pairs)/total) if total else 0
def replay_loudness(frames, guest_frames):
    by={}
    for state in sorted({f["state"] for f in frames}):
        ff=[f for f in frames if f["state"]==state]
        active=[f for f in ff if f["rms"]>80]
        by[state]={"frames":len(ff),"activeFrames":len(active),"allFrameRmsDbFS":dbfs(energy(ff)),
                   "activeFrameRmsDbFS":dbfs(energy(active)),"frameRmsDbFS":describe([dbfs(f["rms"]) for f in ff])}
    groups=[]
    for f in sorted(frames,key=lambda f:f["t"]):
        if f["rms"]<=80: continue
        if groups and f["state"]==groups[-1][-1]["state"] and f["t"]-groups[-1][-1]["t"]<=200:
            groups[-1].append(f)
        else: groups.append([f])
    events=[]
    guests=sorted(guest_frames,key=lambda f:f["t"])
    for g in groups:
        a,b=g[0]["t"],g[-1]["t"]+20
        overlap=[]
        for f in guests:
            if f["t"]>=b: break
            duration=min(b,f["t"]+f.get("duration",20))-max(a,f["t"])
            if duration>0: overlap.append({**f,"duration":duration})
        q=dbfs(energy(g)); h=dbfs(energy(overlap)) if overlap else None
        events.append({"startMs":a,"endMs":b,"state":g[0]["state"],"activeFrameRmsDbFS":q,
                       "guestInputRmsDbFS":h,"outputMinusGuestInputDb":q-h if q is not None and h is not None else None})
    return {"measurement":"decoded-consumed-left-channel-RMS-amplitude","byState":by,"events":events,
            "limitations":["RMS is not LUFS or perceived loudness. Guest input and consumed output are different signal paths.",
            "Active RMS uses threshold >80; all-frame RMS also retained. Gain changes can change event detection.",
            "Application state is not human-verified conversational role.",
            "Simultaneous guest tracks are summarized by frame energies, not reconstructed final mix levels."]}
