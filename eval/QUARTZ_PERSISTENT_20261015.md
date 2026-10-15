# Persistent audio-only Quartz — 2026-10-15

Normal Quartz now keeps its session through Alpha playback, receives no live duplicate transcript appends, and uses a shorter prompt emphasizing rare nonlexical backchannels. The existing guest-end holding state and five-/ten-second duration/intonation escalations remain. Alpha playback still clears and gates local output; suppressed phrase tails cannot reappear.

Context acknowledgment age is diagnostic, not a reason to terminate a healthy connection. Queue wait and sent-to-ack durations are measured separately; an arriving acknowledgment is removed before more work is sent. Actual send failures, provider errors, and excessive socket backlog still recover. Recent delivered guest/Alpha text is held locally and used only as bounded startup history on a new session. Undelivered Alpha proposals are excluded. Normal state updates default to instructions.append; experimental turn control retains its existing prompt and text transport.

## Evaluation

Two real-time continuous ten-minute source slices, one attempt each, using the same prepared interviewer-muted audio and provisional references as the earlier baseline:
- Jozak: source 300–900 seconds.
- Horn: source 1380–1980 seconds.

No in-slice transcript text was sent. Startup history used only guest text completed before the slice; host reference labels were excluded. Runs use a local Discord playback sink, without publishing audio to Discord.

| Fixture | Previous isolated-turn sounds | Persistent sounds | Host references | Matches ±0.5 s | Matches ±1 s |
| --- | ---: | ---: | ---: | ---: | ---: |
| Jozak | 27 | 17 | 6 | 0 | 1 |
| Horn | 9 | 4 | 6 | 0 | 1 |

Both runs completed with one session, zero recoveries, zero provider errors, and zero input loss. Maximum replay scheduling lateness: Jozak 73.0 ms; Horn 22.7 ms (100 ms gate). Maximum context acknowledgment duration: 1,274 ms and 1,097 ms. Maximum observed socket buffered bytes: 3,648 in both runs; no context backlog warnings.

Jozak sound counts by source minute: 1,3,1,2,2,1,1,1,2,3. Human references cluster four of six in minutes seven/eight; Quartz produced only two there. Horn counts: 1,0,0,0,2,0,0,0,0,1. The host has all six references in the final minute; Quartz produced one there and three earlier. Rarity improved descriptively; human timing/clustering did not.

Played transcript observations contain nonlexical sounds (plus ASR noise labels), without the earlier substantive “what I hear you saying” drift. This is one trial, not a consistency guarantee or manual listening judgment.

Input minus received-output sample duration grew to 10.84 seconds for Jozak and 5.12 seconds for Horn at the last periodic sample. These are stream-duration differences, NOT measured response latency: output audio has no source timestamps or documented one-to-one correspondence with input duration. Preserve this unresolved signal; successful transport does not prove all perceptual lag is solved.

Prior isolated-turn runs had additional boundary exclusions and different startup conditions. The changes also combine prompt, context, channel, and lifecycle adjustments. Counts are descriptive, not a controlled causal estimate. ASR-derived host references and overlap muting remain limitations.

## Validation and provenance

- Targeted Quartz/context/controller/replay tests: 85 passed, zero failed/cancelled.
- Standard npm test: 27 node tests, 96 custom tests, and 3 journal tests passed; exit 0 and all final summaries observed.
- An additional standalone test-live-timing-admission.js check failed in unchanged VoiceManager.addParticipantTag because the test instance lacks a map. It is outside the registered npm suite; no unrelated production change was made to hide it.
- Runtime dependency lock matches the workspace. The stale registered dependency-bundle path was unavailable; tests used the deployed matching node_modules.
- Machine-readable summary: eval/results/quartz-persistent-20261015.json.
- Full durable artifacts: /var/lib/praxis-root/home/quartz-youtube-evals-20261015/persistent-audio-only-v1.
- Batch job: 1ce54369-50d8-4eca-a4cc-21cd1d09c163, completed exit 0.
- Tested implementation SHA-256 (client + playback + context queue): 113d9f553416370b7a6cb37074678ba8583d08ea0aa1a063f9fd30bbbfb911c2.

API guidance: https://developers.openai.com/api/docs/guides/live-conversations and https://developers.openai.com/api/docs/guides/live-prompting .
