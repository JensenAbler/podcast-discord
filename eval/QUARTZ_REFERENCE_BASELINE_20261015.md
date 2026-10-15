# Interviewer-muted Quartz timing baseline — 2026-10-15

Jensen clarified that Quartz replaces the interviewer for backchannel timing evaluation. Recorded interviewer audio is reference-only and must not be supplied as guest input. A perfect imitation benchmark matches the reference acknowledgment onsets without missed or additional events.

## Superseded runs

The first `jacob-quartz-full` and `horn-quartz-full` jobs were cancelled. They used a mixed source restricted by fixture turns and blocked Quartz at all recorded host turns, including target acknowledgments. They are not valid for the clarified timing benchmark. Raw partial artifacts are retained with `job-result.json` marking them cancelled/superseded.

## Source and alignment

- Jordan Jozak / Jesse Michels: https://www.youtube.com/watch?v=PiFbeWfA3LM ; publisher audio https://traffic.megaphone.fm/HPL5809636355.mp3 .
- Michael Horn / Chris Ramsay, DEBRIEFED 92: https://www.youtube.com/watch?v=5Vk8V-clYLU ; publisher audio https://traffic.megaphone.fm/CYSRR8928937613.mp3 .
- YouTube direct downloads were blocked; published podcast enclosures were downloaded instead and aligned independently. Do not assume YouTube and podcast timestamps match.
- Fish timestamped ASR aligned 229/240 Jozak and 243/277 Horn fixture turns with >=75% normalized-token matches, <=2 missing edge words, and no >10-second internal anchor gap. Other intervals are excluded.
- Data root: `/var/lib/praxis-root/home/quartz-youtube-evals-20261015`.
- Speaker detection is an offline `transcribe-1-pro` pass, not a production ASR change. Speaker IDs are mapped separately per request and locally within +/-180 seconds, using long high-confidence fixture turns. Ambiguous identity is excluded. Long-turn direct fixture agreement can override drifting speaker IDs.

## Input and output separation

`prepare-guest-only.py` writes an actual sanitized PCM journal in `{jacob,horn}-guest-only`. Known fixture interviewer intervals and detected interviewer/unknown intervals are muted with 150ms padding. Overlapping guest audio is necessarily removed too. Five-millisecond fades on adjacent retained frames reduce boundary clicks. Quiet gaps up to four seconds are bridged uniformly where no substantive/uncertain block intervenes; reference target timestamps do not directly create guest-start activity events.

Quartz receives no interviewer transcript text. Guest fixture text arrives at aligned turn end (not real-time ASR completion). Recorded substantive interviewer turns still stand in for Alpha playback and block/reset Quartz. Short reference acknowledgments do NOT block Quartz. The production model, voice, thinking channel, turnControl=false, prompt, gain 4, player, and local consumed-audio sink are unchanged.

## Reference and scoring

`reference.json` retains automatic acknowledgment candidates, speaker mapping evidence, input mute intervals, and output block intervals. The conservative lexical whitelist plus <=3-second limit excludes substantive questions. Candidates within one second of blocked/uncertain intervals are not scored.

`score-reference-timing.py` compares consumed-audio vocalization groups (RMS >80, 180ms grouping gap) with reference onsets. One-to-one dynamic programming maximizes match count, then minimizes total absolute onset error. It reports precision, recall, F1, misses, extras, and signed/absolute onset errors at +/-0.25, +/-0.5 (primary), and +/-1 seconds. Repeated Quartz events cannot all match one reference.

These are PROVISIONAL reference-agreement metrics, not verified ground-truth pass rates. Speaker detection and ASR onset estimates can be wrong; nonlexical references can be missed; muting overlapping speech removes guest information and can cue timing via silence. Human listening-fit, appropriateness, and complete manually checked labels remain separate.

## Execution and checks

Corrected long runs wrote `{jacob,horn}-quartz-guest-only`. Horn finished at 14:05 UTC but reached 56,934ms action lateness. Jozak stopped at 12:32 UTC on a provider content_filter rejection and reached 90,310ms lateness. Both are invalid timing baselines; artifacts are retained, with explicit invalid validity.json. Earlier descriptive/reference summaries must not be used as baseline scores.

Eight synthetic matching/reference checks passed (duplicates, timing tolerance, minimum-error assignment, empty events, and rejection of substantive/long turns). Jozak's 252,196 frames were checked; 1,868 mute-flagged frames were silent, and an independent interval-based audit also found no nonzero known-interviewer frames. No interviewer text is delivered. Jozak currently has 28 provisional candidates, 17 scorable after uncertainty exclusions.

Prior source validation: npm test completed successfully after using installed dependencies matching the identical package-lock; 71 targeted Node tests and 13 Python evaluator tests passed. The separate git diff --check command failed because managed workspaces do not contain a .git checkout; it was not a test failure. No production deployment occurred.

## Hardened replay and scoring

- Monotonic scheduling; no zero-delay timer for an already-due action. Reject an action before dispatch when it is over 100ms late instead of draining stale audio.
- Offline Opus codec warmup before the measured clock; no warmup audio goes to the provider.
- At most six minutes per case, one serial batch at a time, shared exclusive replay lock. Plan windows before observing output; report unrun/invalid coverage, never silently drop failed cases.
- Stop when the client is unavailable for guest PCM, the mixer reports input loss, the provider rejects input, configuration changes, or cancellation is requested. No automatic provider/content-filter retry.
- Stream trace and consumed PCM; atomically save final metrics and batch checkpoints. Preserve action scheduled/actual/dispatch times, event-loop diagnostics, input loss, source and code identities.
- Score only schema-v2 timing-valid runs. Sort reference onsets before one-to-one matching; exclude declared warmup and boundary collars. Invalid/legacy runs receive no timing score. Existing analysis summaries are diagnostic-only for invalid runs.
- Client availability and local dispatch checks do not establish provider receipt timing. Label accuracy, unknown overlaps, and subjective backchannel suitability still require human review.

## Verification and remaining blocker

Six scheduler/integrity tests and two reference regression tests passed, including CPU stalls, gradual drift, cancellation, provider rejection, unsorted references, duplicate predictions, warmup, and score refusal. Full npm test completed with zero failures.

Fixed pilot plan: Jozak source 360–540s followed by Horn 1880–2060s, each with 30s warmup. Plan SHA256: 281047ae95e050e6fc5dc334462a597b5c727cc393b49d044f4d76f01b67b45b.

- integrity-pilot-v2 stopped at the first 102.676ms deadline violation. Trace suggested cold local codec work; offline codec warmup was added before a separately reviewed attempt.
- integrity-pilot-v3 stopped at 149.161s of the Jozak window with input-loss. Maximum action lag was 83.837ms; event-loop maximum 93.716ms. At 148.551s the recorded substantive/uncertain host block reset the session; guest audio resumed only 610ms later, before the client was ready. The evaluator correctly refused to feed that frame or award a timing score. Shutdown then logged a closed-before-startup error.
- The batch is blocked and Horn remains unrun in this pilot. This is verification of failure detection, not a successful live timing baseline. Do not claim the historical long-run drift is fully explained or solved.
- Reconnect readiness at short host blocks remains a production-path limitation exposed by the eval. Waiting for reconnection would shift the source timeline; skipping input or moving the window after seeing failure would hide the issue. Neither is done here.

Run a reviewed plan from the repository root:

```sh
python3 eval/run-listener-batch.py /absolute/path/plan.json /absolute/path/new-batch
node --test eval/test-replay-timing.js
python3 -m unittest discover -s eval -p test_reference_integrity.py
```

Plan format is an object with a cases array; each case supplies id, episode directory, startSec, durationSec (<=360), warmupSec, journalSha256, transcriptSha256, and referenceSha256. The exact pilot plan and all attempts are under the data root above. An interrupted batch may resume only if identities match and no incomplete/blocked case exists. Review failures before creating a new attempt; do not erase checkpoints or remove a live lock.

These changes are eval-only. No production deployment or runtime behavior change was made.

## Turn-isolated pilot (user-requested per-turn restart)

The continuous replay already called the production per-turn reset. Short recorded host blocks could end before reconnection. The new plan-turn-replays.py partitions fixed source windows at substantive/uncertain output blocks and launches a fresh deployed Quartz instance for each listening span. Reference backchannels remain inside spans. Session setup happens outside the source clock; guest input retains real-time timing within each span. Startup guest-speaking context must be acknowledged before replay starts. No guest audio or future reference label is supplied during setup.

This is a separate turn-isolated benchmark, not evidence that continuous production handoff is fixed. Context across spans is intentionally discarded; startup waits and host intervals are outside scored time. The scorer retains one-second boundary exclusions; there is no additional turn warmup exclusion. Long spans above 360s are rejected rather than silently split. No production code was changed or deployed.

The first attempt exposed sub-millisecond floating-point overlap with a previous host interval; replay boundaries now use the same integer millisecond precision as transcript timestamps. The second attempt exposed context-delivery-lag during startup. Both failed attempts remain recorded. The third attempt waits for startup context acceptance and completed all seven spans (237.52s) from the original fixed pilot windows. Two spans had no guest PCM and are explicitly excluded.

Result: all 7 cases timing-valid, maximum action lag 73.782ms. At +/-0.5s: 1 matched reference, 6 missed references, 11 extra vocalizations (precision 8.3%, recall 14.3%, F1 10.5%). These seven automatic reference labels are too small and uncertain a sample for a full baseline or subjective quality conclusion. See QUARTZ_TURN_PILOT_20261015.json for per-case results. Durable raw artifacts: turn-pilot-v3 under the data root above.

Usage: first run python3 eval/plan-turn-replays.py SOURCE_PLAN NEW_PLAN, then python3 eval/run-listener-batch.py NEW_PLAN NEW_OUTPUT. Each case gets its own process/session; mode is recorded in batch and replay manifests. Failures still stop the batch and receive no timing score.
