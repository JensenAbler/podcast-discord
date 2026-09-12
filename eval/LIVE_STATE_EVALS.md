# Live state-machine evals

These evals measure observable costs and benefits. Correct transitions alone do not establish a better conversation.

## Run in the managed workspace

    python3 -m unittest discover -s eval -p 'test_live_state_eval.py'
    node --test test-quartz-backchannel.js test-live-turn-controller.js
    python3 eval/live-state-eval.py /path/to/completed/episode-a /path/to/completed/episode-b --out eval/results/live-state-baseline.json

The Python runner uses only the standard library, reads completed recordings, never calls providers or touches the running bot, and records source SHA-256 hashes. Incomplete/missing recordings are listed as skipped. Do not restart a live session to run it.

Existing Node suites exercise actual transport/state/playback classes with controlled audio: gating without losing input, no replay of muted speech, handoff completion, timeout, cancellation, stale updates and turn authority. Python fixtures validate the metrics against planted silence, muted output, loss, stuck states and missing evidence.

## Measurements and limits

- Presence starts at Alpha thinking, before HOLDING. End at yielding/aside or idle/finished. Re-evaluations and unfinished final windows are censored. Report completed waits >=3 seconds with unblocked output-text observations and first-contact latency. Three seconds is an analysis threshold, not a production timer. All windows remain available for review.
- Handoff: median/p90/max elapsed time, failures and missing acknowledgment. This measures cost, not automatically wasted time; some protects ongoing speech.
- Aside: host playback time outside ASIDE, revision regressions and time to return to LISTENING. Missing host transcript rows hide intervals; inspect coverage.
- Audio: received minus blocked minus consumed non-silent samples, using the current sixfold channel/rate conversion. Missing telemetry is unknown. Signed residuals can reflect snapshot boundaries; aggregate equality cannot prove no cuts or that a guest heard the output.
- Volume proxy: median peak in active diagnostic windows, not RMS or perceptual loudness.
- Context: delivered-transcript message counts and logged acknowledgments. Count agreement is not content equality.
- Review timestamps: processing opportunities, handoffs and host intervals. Use the mixed recording to rate appropriateness, audible presence, naturalness, interruption and substantive overreach. Transcript arrival is not exact audio onset or direct-address latency.

Do not combine these dimensions into one score. Frequent acknowledgments can be annoying; silence can be appropriate.

Optional --annotations file.json is an object keyed by episode basename:

    {
      "episode-example": {
        "condition": "normal-current-prompt",
        "excludePresenceIntervals": [
          {"startMs": 180000, "endMs": 210000, "reason": "Guest requested silence"}
        ]
      }
    }

Intervals are relative to recording start and supplied by a reviewer. No automatic silence-intent or language-based labeling.

## Does the state machine actually help?

Historical comparisons are descriptive, not causal: speech, context, duration and prompt differ. Keep experimental Live-led turn taking out of the normal-mode cohort.

For a causal next round, replay matched prerecorded guest/context sequences through fresh Live sessions under:
1. Current four-state guidance.
2. Minimal guidance with identical Alpha decisions, delivered context and hard mute, but no listening/holding/yielding prompt updates.

Keep model, voice, other prompt wording, guest audio, Alpha-ready times, playback duration and replay pacing identical. Repeat each condition at least five times, randomize order, and save exact configuration hashes, seeds where supported, audio and events. Recorded Live output cannot stand in for a counterfactual; each condition must generate separately.

First ablate prompt states while retaining the same playback policy. Test handoff waiting separately; removing both confounds two interventions. A no-handoff variant belongs in an offline audio comparison before production.

Cases: direct address before commitment; 2/8/20-second delays; Alpha chooses silence; long guest monologue; uncertain audio/VAD flaps; guest resumes; recovery after long Alpha playback; context during ASIDE; delayed instructions and disconnect.

Blindly rate paired audio for presence, timing, repetition, disruption and role compliance. Report paired differences and variation alongside cost and evidence coverage. Do not reward words over nonlexical sounds automatically.

This implementation provides offline measurement and scenario checks, not paid provider A/B execution or a production mode switch. Controlled provider replay needs retained source input audio. Finalized journals currently discard source PCM; future matched recordings must explicitly retain it.
