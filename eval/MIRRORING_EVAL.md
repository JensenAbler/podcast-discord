# GPT Live mirroring: first before/after evaluation

The clearest change is more frequent contact, not demonstrated improvement in variety.
There is a suggestive change in coarse volume tracking, but the retained evidence cannot establish tone or pitch mirroring.

## Comparison

- Before: `episode-2026-09-12T21-54-01-077Z`, phantom-limb-returns v001.
- After: `episode-2026-09-14T23-36-36-715Z`, wiki-coordination v002.
- Intervention: `daed1f97013e61590297c3a230d7520d378c986a`, deployed September 14 at 23:15 UTC.
- Both observed Live sessions use current mode, gpt-live-1, Quartz, and one guest (Jensen).
- Live-session denominators: 18.14 versus 20.29 minutes. Audio recording durations: 18.41 versus 20.63 minutes; finalization time is not conversation time.

No additional source commit after mirroring was present at inspection. “New harness” is interpreted here as the deployed setup; episode files do not store exact prompt hashes. The earlier episode also predates the current-turn-context-order intervention (`43e3cbc`). Different topics, delivery, noise, waits, and episode plans prevent causal attribution to mirroring alone.

## Results

Primary units are Quartz transcript rows with consumed-PCM evidence, merged within 400 ms in the same session. Times are estimated client playback timings.

| Measure | Before | After | Interpretation |
|---|---:|---:|---|
| Acknowledgment groups | 74 | 103 | Different episode lengths |
| Groups per Live minute | 4.08 | 5.08 | +24.4% |
| Groups per minute in LISTENING/HOLDING | 4.72 | 8.05 | +70.6%; counts and time both restricted to these states |
| Median interval between onsets | 12.32 s | 7.30 s | More frequent contact |
| Median estimated contact span | 141 ms | 161 ms | +20 ms; not a precise acoustic utterance duration |
| p90 estimated contact span | 380 ms | 540 ms | Longer upper tail |
| Top two normalized forms' share | 89.2% | 91.3% | Still dominated by “mm” and “mm hmm” |
| Probability two distinct groups have identical text | 41.0% | 42.3% | No clear diversity gain |
| Adjacent identical-text repetition | 35.6% | 31.4% | Some improvement in immediate repetition |
| Text entropy | 1.60 bits | 1.49 bits | Slightly narrower distribution |
| Median consumed-output diagnostic peak | -25.91 dBFS | -26.62 dBFS | 0.71 dB lower; peak proxy, not perceived loudness |
| Same-window input/output peak correlation | -0.12 (65 windows) | +0.31 (128 windows) | Suggestive tracking signal only |
| Guest segment WPM / acknowledgment span correlation | +0.23 (58 pairs) | +0.21 (69 pairs) | No evident change in this weak pacing proxy |
| Median handoff duration | 1.668 s | 1.801 s | +133 ms; not necessarily wasted time |
| Generated non-silent samples blocked | 3.2% | 15.8% | More generated activity fell under playback blocking |

At 0 ms grouping, the two dominant forms account for 89.2% before and 96.3% after; at 800 ms, 87.3% and 86.9%. Thus the precise direction of a small diversity difference is segmentation-sensitive. No setting demonstrates a substantial expansion beyond the two habitual sounds.

Consumed non-silent sample activity increased from 45.34 to 114.06 seconds (2.50 to 5.62 seconds per Live minute). This is sample occupancy above a low threshold, not exact speech duration. The aggregate accounting residual was zero in both episodes; that does not prove absence of individual cuts.

The state evaluator found unblocked generated text in 19/19 versus 53/54 completed waits of at least three seconds. This measures generated-text presence, not confirmed guest reception. It is intentionally separate from the consumed-text measures above.

## Role compliance and coverage

The four before-condition verbal groups were “I'm with you.” (00:43.83), “Gotcha” (01:15.93), “Mm, yeah.” (11:30.11), and “I'm with you.” (14:50.93).
The after-condition verbal group was “I'm with you.” (14:15.77).
These retained texts contain no substantive answer. This is a text review, not a complete audio judgment of appropriateness or agreement.

Before: 95 Quartz rows, 74 with consumed text, 21 not started.
After: 198 Quartz rows, 108 with consumed text, 90 not started.
Do not count empty-text/not-started rows as heard acknowledgments or assume they all represent harmful drops. They include unmapped output. All retained playback timing statuses are estimated.

Both recordings have mixed MP3s, but no isolated stems or retained source PCM.
Pitch matching, emotional tone, and exact prosodic adaptation are **unscored**, not zero.
The five-second diagnostic peaks can include unrelated sounds, capture different parts of the exchange, and are autocorrelated. No significance test or causal “mirroring improved” verdict is justified.

## Reproduce

Run in a managed Praxis workspace:

```sh
python3 -m unittest discover -s eval -p 'test_*eval.py'
python3 eval/mirroring-eval.py \
  /opt/clawcast-network/content/recordings/episode-2026-09-12T21-54-01-077Z \
  /opt/clawcast-network/content/recordings/episode-2026-09-14T23-36-36-715Z \
  --out eval/results/mirroring-before-after-20260915.json
```

The evaluator is offline, uses Python's standard library, reads completed episodes, hashes all analyzed source files, records metric denominators and grouping sensitivity, and reuses the existing state evaluator. It does not call providers, alter the bot, or restart a session. JSON includes per-window review evidence and all limitations.

Validation: 19 Python evaluator tests passed (six new metric tests); npm test completed with 46 + 26 + 95 + 3 passing tests and no failures. The old registered environment baseline mentioned two failures, but neither occurred with the installed locked dependencies in this workspace.

For a causal follow-up, replay identical guest audio and application updates through both prompt versions, holding model/voice and the rest of the harness fixed, with repeated randomized trials. Preserve isolated audio and exact prompt hashes, then blind-rate tone, pacing, volume fit, repetition, and substantive overreach separately. This eval has not run that provider experiment.
