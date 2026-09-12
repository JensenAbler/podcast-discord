#!/usr/bin/env python3
"""Read-only episode evals. No provider calls, runtime imports, or deployment changes."""
import argparse
import collections
import datetime
import hashlib
import json
import math
from pathlib import Path
import statistics


def ms(value):
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return value
    return datetime.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000


def stats(values):
    values = sorted(v for v in values if v is not None and math.isfinite(v))
    if not values:
        return {"n": 0, "median": None, "p90": None, "max": None}
    return {"n": len(values), "median": round(statistics.median(values), 2),
            "p90": round(values[max(0, math.ceil(len(values) * .9) - 1)], 2),
            "max": round(values[-1], 2)}


def payload(event, prefix):
    message = event.get("message", "")
    return json.loads(message[len(prefix):]) if message.startswith(prefix) else None


def overlap(a, b, c, d):
    return max(0, min(b, d) - max(a, c))


def vocalizations(rows):
    """Group adjacent provider deltas; never interpret text as proof of audio delivery."""
    result = []
    for r in rows:
        if not r.get("text", "").strip():
            continue
        start, end = r.get("startMs"), r.get("endMs")
        if start is None or end is None:
            continue
        last = result[-1] if result else None
        if (last and last["session"] == r.get("sessionId") and
                0 <= start - last["end"] <= 400):
            last["end"] = end
            last["blocked"] |= bool(r.get("playbackBlocked"))
        else:
            result.append({"start": start, "end": end, "at": ms(r["observedAt"]),
                           "session": r.get("sessionId"),
                           "blocked": bool(r.get("playbackBlocked"))})
    return result


def evaluate(events, transcript, quartz, metadata, annotation=None):
    annotation = annotation or {}
    events = sorted(events, key=lambda e: ms(e["observedAt"]))
    start = ms(metadata.get("startedAt"))
    end = ms(metadata.get("stoppedAt"))
    if start is None or end is None or end < start:
        raise ValueError("Episode needs valid startedAt/stoppedAt")
    # Prefer the actual Live session span over finalization time.
    begin = next((ms(e["observedAt"]) for e in events
                  if e.get("message", "").startswith("Session started:")), start)
    finish = next((ms(e["observedAt"]) for e in events
                   if e.get("event") == "disconnected"), end)
    finish = min(finish, end)
    states, handoffs, diagnostics, waits = [], [], [], []
    violations, pending = [], None

    def close_wait(at, reason):
        nonlocal pending
        if pending is not None:
            waits.append({"start": pending, "end": at, "reason": reason,
                          "censored": reason in ("reevaluation", "session_end")})
            pending = None

    for e in events:
        at = ms(e["observedAt"])
        state = payload(e, "Environment: ")
        if state:
            if state["state"] not in ("listening", "holding", "yielding", "aside"):
                violations.append({"at": at, "kind": "unknown_state"})
            if states and state["revision"] <= states[-1]["revision"]:
                violations.append({"at": at, "kind": "non_increasing_revision"})
            states.append({**state, "at": at})
            if state["state"] in ("yielding", "aside"):
                close_wait(at, state["state"])
        progress = payload(e, "Alpha progress: ")
        if progress:
            stage = progress["stage"]
            if stage == "thinking":
                close_wait(at, "reevaluation")
                pending = at
            elif stage in ("idle", "finished"):
                close_wait(at, stage)
        handoff = payload(e, "Handoff completed: ")
        if handoff:
            handoffs.append({**handoff, "at": at})
        diagnostic = payload(e, "Audio diagnostics: ")
        if diagnostic:
            diagnostics.append(diagnostic)
    close_wait(finish, "session_end")
    spans = [(max(begin, s["at"]),
              min(finish, states[i + 1]["at"] if i + 1 < len(states) else finish),
              s["state"]) for i, s in enumerate(states)]
    spans = [s for s in spans if s[1] > s[0]]
    duration = collections.Counter()
    for a, b, state in spans:
        duration[state] += b - a
    groups = vocalizations(quartz)

    def state_at(at):
        return next((state for a, b, state in spans if a <= at < b), "unknown")

    by_state = collections.Counter(state_at(g["at"]) for g in groups)
    excluded = [(start + x["startMs"], start + x["endMs"])
                for x in annotation.get("excludePresenceIntervals", [])]
    for w in waits:
        w["durationMs"] = round(w["end"] - w["start"], 2)
        w["excluded"] = any(overlap(w["start"], w["end"], a, b) > 0 for a, b in excluded)
        found = [g for g in groups if not g["blocked"] and w["start"] <= g["at"] < w["end"]]
        w["unblockedTextVocalizations"] = len(found)
        w["firstContactProxyMs"] = round(found[0]["at"] - w["start"], 2) if found else None
        # Diagnostic windows crossing an opportunity boundary are ambiguous.
        inside = [d for d in diagnostics if w["start"] <= d["since"] and d["until"] <= w["end"]]
        w["fullyContainedDiagnosticWindows"] = len(inside)
        w["confirmedConsumedActivityInContainedWindows"] = any(
            d.get("paths", {}).get("outputConsumed", {}).get("nonSilentSamples", 0) > 0 for d in inside)
        w["startOffsetMs"] = round(w.pop("start") - start, 2)
        w["endOffsetMs"] = round(w.pop("end") - start, 2)
    eligible = [w for w in waits if not w["censored"] and not w["excluded"] and w["durationMs"] >= 3000]
    host_rows = [r for r in transcript if r.get("speakerRole") == "host" and r.get("playbackStartedAt") and r.get("playbackEndedAt")]
    hosts, recovery = [], []
    for r in host_rows:
        a, b = ms(r["playbackStartedAt"]), ms(r["playbackEndedAt"])
        observed_a, observed_b = max(a, begin), min(b, finish)
        observed_duration = max(0, observed_b - observed_a)
        covered = sum(overlap(observed_a, observed_b, x, y) for x, y, state in spans if state == "aside")
        hosts.append({"startOffsetMs": a - start, "durationMs": b - a,
                      "observedDuringLiveMs": observed_duration,
                      "outsideAsideMs": round(max(0, observed_duration - covered), 2)})
        if not observed_duration:
            continue
        candidates = [s for s in states if s["at"] >= b and s["state"] == "listening"]
        next_host = min((ms(h["playbackStartedAt"]) for h in host_rows if ms(h["playbackStartedAt"]) > b), default=finish)
        resumed = next((s["at"] for s in candidates if s["at"] <= next_host), None)
        recovery.append({"hostEndOffsetMs": b - start,
                         "listeningResumeMs": round(resumed - b, 2) if resumed is not None else None,
                         "censored": resumed is None,
                         "laterUnblockedVocalizationsBeforeNextHost": sum(
                             not g["blocked"] and b <= g["at"] < next_host for g in groups)})
    paths = collections.defaultdict(collections.Counter)
    peaks = []
    for d in diagnostics:
        for name, p in d.get("paths", {}).items():
            for field in ("samples", "nonSilentSamples", "durationMs"):
                paths[name][field] += p.get(field, 0)
        peak = d.get("paths", {}).get("outputReceived", {}).get("peak", 0)
        if peak > 8:
            peaks.append(20 * math.log10(peak / 32768))
    supported = bool(diagnostics) and "outputConsumed" in paths
    received = paths["outputReceived"]["nonSilentSamples"]
    blocked = paths["outputBlocked"]["nonSilentSamples"]
    consumed = paths["outputConsumed"]["nonSilentSamples"]
    context = [payload(e, "Conversation context sent: ") for e in events]
    context = [c for c in context if c and c.get("label") == "Alpha delivered transcript"]
    accepted_ids = {e.get("message", "").split("Context accepted: ", 1)[1]
                    for e in events if e.get("message", "").startswith("Context accepted: ")}
    sent = [payload(e, "Context sent: ") for e in events]
    sent = [s for s in sent if s]
    return {
        "condition": annotation.get("condition", "unlabeled"),
        "mode": sorted(set(e.get("mode", "unknown") for e in events)),
        "liveSessionSeconds": round((finish - begin) / 1000, 2),
        "stateSeconds": {k: round(v / 1000, 2) for k, v in duration.items()},
        "stateRevisionViolations": violations,
        "presence": {"generatedVocalizations": len(groups),
                     "unblockedTranscriptVocalizations": sum(not g["blocked"] for g in groups),
                     "generatedByObservedState": dict(by_state),
                     "eligibleWaitsAtLeast3s": len(eligible),
                     "waitsWithUnblockedTextProxy": sum(w["unblockedTextVocalizations"] > 0 for w in eligible),
                     "contactLatencyProxyMs": stats(w["firstContactProxyMs"] for w in eligible),
                     "waits": waits},
        "handoff": {"elapsedMs": stats(h.get("elapsedMs") for h in handoffs),
                    "failed": sum(bool(h.get("failed")) for h in handoffs),
                    "withoutAcknowledgment": sum(not h.get("accepted") for h in handoffs),
                    "review": [{"offsetMs": h["at"] - start, "elapsedMs": h.get("elapsedMs"),
                                "failed": h.get("failed", False)} for h in handoffs]},
        "playback": {"hostRowsWithTiming": len(hosts), "hostIntervals": hosts,
                     "asideCoverageAvailable": bool(states),
                     "hostMsOutsideAside": sum(h["outsideAsideMs"] for h in hosts) if states else None,
                     "recovery": recovery,
                     "listeningResumeMs": stats(r["listeningResumeMs"] for r in recovery),
                     "audioAccountingAvailable": supported,
                     "blockedNonSilentFraction": blocked / received if received else None,
                     "unaccountedSourceSamples": received - blocked - consumed / 6 if supported else None,
                     "generatedActivitySeconds": received / 16000 if diagnostics else None,
                     "consumedActivitySeconds": consumed / 96000 if supported else None,
                     "medianActiveWindowPeakDbFS": stats(peaks)["median"],
                     "paths": dict(paths)},
        "context": {"hostTranscriptRows": len(host_rows), "deliveredTranscriptMessages": len(context),
                    "sent": len(sent), "sendFailures": sum(s.get("sent") is False for s in sent),
                    "sentWithoutLoggedAcceptance": sum(s.get("sent") and s.get("eventId") not in accepted_ids for s in sent)},
        "coverage": {"diagnosticWindows": len(diagnostics), "stateUpdates": len(states),
                     "transcriptDeltas": len(quartz), "annotations": annotation},
        "limits": [
            "Observational comparison, not causal evidence that states help.",
            "Text timing uses arrival timestamps; it is not exact audio onset or guest-address latency.",
            "Non-silent sample occupancy is not speaking duration, loudness, or proof of reception by a guest.",
            "Six output samples correspond to one source sample in the current 16k mono to 48k stereo conversion.",
            "Aggregate accounting cannot prove absence of individual cuts or overlap. Aside coverage uses transcript playback intervals.",
            "Missing playback rows hide host intervals; missing telemetry must not be interpreted as successful behavior.",
            "Prompt compliance, naturalness and substantive overreach require human ratings or a separately validated judge."
        ]
    }


def read_episode(path, annotation):
    contents, provenance = {}, {}
    for name in ("episode-complete.json", "live-turn-events.jsonl", "transcript.jsonl", "quartz-transcript.jsonl"):
        f = path / name
        if not f.exists():
            raise ValueError("Missing " + name)
        before = f.stat()
        data = f.read_bytes()
        after = f.stat()
        if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
            raise ValueError("File changed during read: " + name)
        provenance[name] = {"sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}
        contents[name] = json.loads(data) if name.endswith(".json") else [
            json.loads(line) for line in data.decode().splitlines() if line.strip()]
    report = evaluate(contents["live-turn-events.jsonl"], contents["transcript.jsonl"],
                      contents["quartz-transcript.jsonl"], contents["episode-complete.json"], annotation)
    return {"episode": path.name, "sources": provenance, **report}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("episodes", nargs="+", type=Path, help="Completed episode directories")
    parser.add_argument("--annotations", type=Path, help="Optional object keyed by episode basename")
    parser.add_argument("--out", type=Path, help="Write JSON report; defaults to stdout")
    args = parser.parse_args()
    annotations = json.loads(args.annotations.read_text()) if args.annotations else {}
    reports, skipped = [], []
    for p in args.episodes:
        try:
            reports.append(read_episode(p, annotations.get(p.name)))
        except (ValueError, OSError, KeyError) as e:
            skipped.append({"episode": p.name, "reason": str(e)})
    result = {"schemaVersion": 1, "episodes": reports, "skipped": skipped}
    rendered = json.dumps(result, indent=2, ensure_ascii=False)
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(rendered + "\n")
    else:
        print(rendered)
    if not reports:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
