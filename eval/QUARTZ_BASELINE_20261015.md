# Current Quartz backchannel baseline — 2026-10-14 PDT

Four fresh five-minute replays completed through the deployed Quartz client and playback path (20 minutes total). Production revision: `9539d6d291ed3bd31c32970c706420f52ceb758e`. Model gpt-live-1, Quartz voice, thinking state channel, turnControl=false, restored gain 4. No production behavior was changed.

## Results

| Andy8 source interval | Audible groups | Groups/minute |
|---|---:|---:|
| 00:00–05:00 | 22 | 4.4 |
| 05:00–10:00 | 27 | 5.4 |
| 15:00–20:00 | 56 | 11.2 |
| 30:00–35:00 | 26 | 5.2 |

131 energy-derived vocalization groups; 6.55/minute overall; median group duration 580 ms. This includes floor-holding sounds as well as listening backchannels. Rates alone are not a quality score.

Of 29 speech spans away from excerpt boundaries, 20 received an onset. Median first-onset latency among those 20 was 1.436 s; the nine spans without contact are not included in that median. There were 62 onsets within these spans. Longest measured inter-onset gap within a complete span: 19.979 s.

| Speech-span length | Spans | With contact | Onsets | Conditional median first onset |
|---|---:|---:|---:|---:|
| 2–5 seconds | 7 | 3 | 3 | 1.428 s |
| 5–15 seconds | 10 | 7 | 11 | 1.443 s |
| 15+ seconds | 12 | 10 | 48 | 1.347 s |

These are energy-derived speech spans, not manually verified conversational turns. Overlapping speakers can share an onset. Seven boundary-adjacent spans were excluded from pooled turn statistics. No causal turn-length effect is established by this small sample.

The 15:00–20:00 excerpt exercised holding_rising for 14.744 s, including 5.2 s of above-threshold consumed audio in that state. Pitch/rising-intonation correctness remains unscored.

## Quality and role checks

All four provider runs and analyses exited successfully with no recorded provider errors. Two excerpts had no scheduled actions >80 ms late; the other two had 2 (maximum 98 ms) and 8 (maximum 206 ms). Runs executed concurrently; these timing deviations are retained rather than hidden.

The consumed-text record flags a possible substantive utterance in the 30:00–35:00 excerpt: “Is that what I think it is?” at replay callback 205.924 s (source approximately 33:25). It has completed playback and matched consumed-PCM evidence, but its 639 ms estimated duration makes exact word/audio alignment uncertain. This is a role-compliance review flag, not a verified listening judgment. Other retained lexical acknowledgments include “Yeah,” “Okay,” and “Right.”

74 targeted backchannel/turn-control/output-level tests passed; 19 Python evaluator tests passed. The registered npm test suite also completed with exit 0 and final summaries. These checks establish implementation behavior, not conversational naturalness.

## What remains incomplete

- American Alchemy/Jordan Jozak and Area 52/Michael Horn voice replays: the existing fixtures contain transcripts, not runnable source audio. No corresponding clean audio was found in the inspected operational stores.
- Human-versus-Quartz comparison: human acknowledgments still need verified labels. Short overlaps are candidates, not ground truth.
- Subjective timing, appropriateness, interruption, and prosody ratings: retained audio needs review. No ratings were fabricated.
- Full fresh ASR/Alpha-generation delay stress: not established by this listener-only replay. Historical Alpha playback/reset timing is replayed; live Alpha and ASR are not regenerated.
- Historical Frog evals were executed and retained, but their state/rate outputs are not valid current-baseline measures. The older state evaluator omits rare/holding_longer/holding_rising/waiting_for_guest and uses the first disconnect as its session end despite later sessions. Frog lacks isolated source PCM, so a clean current-mode replay is unavailable. Its 85 consumed-text rows (82 grouped) remain historical evidence, not a current result.
- Alternative channel/mode comparisons were intentionally excluded under the current-mode-only policy.

## Reproducibility

Existing listener replay and analyzer were recovered from workspace `69c1f6bf-6e0d-4b43-9aa7-22be8850288d`. The analyzer now reads episode/window from the run manifest, writes one summary per run, excludes post-window consumed frames, and anchors the initial pre-replay state at zero. State durations were checked to sum to exactly 300,000 ms per run.

Each excerpt begins a fresh session without earlier conversational history. Inputs are original isolated Jensen/Catherine PCM, historical ASR updates, and recorded Alpha playback/reset intervals. The real mixer, gates, gain, Opus player and local sink run; Discord is not contacted. This is an exploratory single pass per excerpt, not a repeated-trial population estimate.

Raw audio, metrics, logs, source hashes, and historical eval outputs:
`/var/lib/praxis-root/home/backchannel-evals-20261015/`

Replay job: `818be2d8-4f3c-4e33-8602-d94daa0cceb1`.
Managed workspace: `6776716e-243e-49a2-8c66-1fd019bf20ae`.
Summary: `eval/results/quartz-baseline-20261015.json`.

The October 13 attenuated-volume pilot is not directly compared with these energy counts: changing gain changes threshold crossings.
