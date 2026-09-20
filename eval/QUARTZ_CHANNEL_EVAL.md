# Quartz full-pipeline channel evaluation — 2026-09-20

## Scope and reproduction

User authorized the full harness, including extensive provider submissions. The harness runs the real AlphaClawdVoiceBot, resume restoration, AudioReceiver, Fish ASR, conversation admission/buffering, streaming podcast generator, Fish TTS, GPT Live, QuartzPlayback, @discordjs/voice audio players, recorder, idle decisions, and authenticated memory gateway. It substitutes a local Opus transport for Discord. It never logs into Discord or pauses production cron jobs. Gateway runs use distinct diagnostic session keys. The configured generator was claude-opus-4-7.

Fixture: episode-2026-09-20T01-52-17-146Z, resuming episode-2026-09-17T18-31-16-590Z (391 inherited entries). The source guest PCM was pruned at finalization. The harness therefore cropped the mixed MP3 using guest journal timestamps; original overlapping Quartz sounds may remain. This limitation is identical across arms. Alpha's newly generated speech is not fed into Quartz's text context.

All channels received the same prompt and state labels:
- 0 seconds: `Um, uh, hmm, ah`
- 5 seconds: `LONGER um, uh, hmm, ah`
- 10 seconds: `EVEN LONGER RISING INTONATION  um, uh, hmm, ah`

The first three runs used original absolute guest timing. A second round kept intra-turn timing but scheduled each new guest turn after freshly generated Alpha playback finished. Each channel's model output and response latency are stochastic; these are exploratory comparisons, not controlled statistical proof.

With production provider configuration already loaded, run:
```sh
QUARTZ_FULL_EVAL=1 node eval/podcast-quartz-eval.js /absolute/source/episode /absolute/unique/output thinking response-relative
python3 eval/analyze-quartz-channels.py /absolute/parent-of-run-directories
```
Replace thinking with instructions or commentary. An optional final argument (0–25000 ms) delays actual Alpha audio readiness for a latency stress test while retaining real generation and synthesis. This is induced latency, not an organic production measurement. Each output directory must be unique. The full resume is large and idle decisions make additional provider calls; review available provider credit before extensive repetition.

## Results

Consumed audio was measured after the real player consumed Opus packets. Active audio uses RMS >80 on decoded 48 kHz PCM; adjacent active frames within 180 ms form an approximate vocalization. This is an energy proxy, not a phonetic recognizer. Raw generated text is not proof that words played. Both generated and consumed audio are retained in each run.

| Channel | Original-timing median sound duration, stages 1 / 2 / 3 | Observations in turn-aligned round |
|---|---|---|
| thinking | 0.42 / 0.70 / 1.66 s | Longer sounds occurred, but one late-state gap was about 15.9 s before provider failure. |
| instructions | 0.70 / 0.72 / 0.62 s | No measured vocal activity during 8.39 s in stage 2 or 2.76 s in stage 3. |
| commentary | 0.70 / 0.86 / 1.23 s | Stage-2 median about 1.91 s; stage 3 lasted only 0.15 s, insufficient to judge. |

Commentary is a candidate for further evaluation, not an established winner. Thinking sometimes lengthened more, but faded in another run. Instructions did not reliably sustain holding. No state-label recitation was observed in the completed primary runs. Thinking and commentary also generated substantive speech during blocked Alpha playback; the playback gate suppressed it. Successful handoffs remain evidence for application floor protection, not perfect model instruction adherence. Rising intonation has not been reliably validated acoustically.

All three original-timing runs completed without generator provider errors. The turn-aligned instructions run also completed cleanly. Thinking and commentary encountered Anthropic credit failures near the ends of their turn-aligned runs. The analyzer censors audio metrics at each run's first provider failure. Three subsequent long-wait stress runs had zero successful generator completions and must be excluded from channel ranking, despite orderly harness shutdown. The harness now fails fast on generator errors instead of treating the bot's spoken service fallback as a successful model run.

Generator logs estimated $52.2589 across the completed requests, excluding GPT Live and Fish charges. These are application estimates, not a billing statement. No further provider calls were made after the credit failure was identified.

## Shipped behavior and limits

The three state labels and guest-silence clock are implemented. Guest speech resets the clock; confirmed guest endpoints start it. Alpha generation stages, retries, silent decisions, and text completion do not restart or cancel it. Playback handoff and Alpha speech end holding; waiting-for-guest remains quiet. Startup/reconnect catch up to elapsed guest silence. Brief listening backchannels may finish naturally over guest speech; muted-tail protection remains.

The production default remains thinking because the comparison did not establish a robust replacement. `PODCAST_QUARTZ_STATE_CHANNEL` or a constructor stateChannel option can select another channel for further testing; experimental turn control continues using its existing thinking channel.

The state transitions are deterministic; sustained vocal duration and pitch remain probabilistic. The tests establish transitions, stale-context cancellation, replay suppression, and handoff behavior, not guaranteed continuous vocal coverage.
