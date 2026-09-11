# Experimental Live turn-taking

Two separately selectable episode engines preserve the existing controller:

- `/podcast-join engine:current` (default): the existing buffer/state-machine and generator decide turns; Quartz uses the shared four-state backchannel environment. Alpha alone decides whether to speak; Live delegation cannot trigger backend work.
- `/podcast-join engine:live-alpha`: Quartz listens continuously and requests Alpha through GPT-Live client delegation. Only this request initiates conversational Alpha turns. Buffer/ASR collection continues, but buffered flushes and idle ticks do not initiate answers.

This is a per-episode alternative, not two simultaneous bots or two concurrent voice channels in one guild. The existing consent, opening announcement, direct generator, tools, Fish voice, recording, and leave flows remain. Requires the direct generator and `PODCAST_LIVE_API_KEY`; no additional key or dependency is needed. Explicit engine selection enables Live even if the default companion is disabled. No production setting is changed by this commit.

## Environments and handoff

Both startup prompts share LISTENING, HOLDING, YIELDING, and ASIDE. Normal mode follows Alpha processing and playback updates; experimental mode follows Live delegation and playback. Increasing environment revisions identify the current state. State facts use quiet `session.thinking.append` updates so an instruction append does not itself redirect an in-progress phrase. These are appended updates, not API-level replacement of the original instructions.

A native `session.delegation.created` event supplies an opaque delegation ID and timing, not task text. We build the Alpha request from retained conversation context, deduplicate IDs, reject overlapping/repeated requests, and bind results to the originating controller. Missing transcript context gets a short bounded wait; it never causes an empty request. Alpha is prompted to compose the requested answer, while preserving explicit requests to wait/stop and its existing tool rules.

When audio is ready, YIELDING asks Quartz to finish its phrase. Alpha still waits for update acknowledgment and one second of consumed near-silent PCM, with no queued voiced frames. The existing handoff timeout withholds Alpha rather than cutting Quartz off. ASIDE blocks Quartz output only. Guest input continues. Playback and turn completion restore LISTENING.

The existing current-speaker and unresolved-VAD checks remain before Alpha playback. Late Fish transcription of the same audio does not invalidate a Live request solely by advancing the legacy activity counter. This first version does not add model-driven cancellation of a generation already underway.

## Conversation context

The application retains native Live input fragments, named guest transcripts, Alpha's recorded delivered text, and Quartz output observations for the episode. Native and named guest transcripts can overlap; backend context labels that explicitly. Output transcript fragments are observations, not proof of audibility.

In both modes, guest audio continues during ASIDE. Named guest text and complete delivered Alpha text are also appended as quiet context in bounded chunks, with no 600-character cutoff. Canceled responses are not added as delivered speech. Playback underruns contribute the recorded underrun notice rather than falsely claiming the full generated answer was heard. Planned opening words are marked as not delivered.

The episode's existing transcript seeds context after Live startup. Context grows incrementally instead of resending the entire episode on every state change. OpenAI manages Live context compaction; neither full verbatim retention forever nor immediate consumption of every append is guaranteed. Alpha's existing prompt budget may trim older context. There is no new custom summarizer or audio loopback of Alpha's voice.

## Diagnostics and failure behavior

`live-turn-events.jsonl` records input transcript fragments, environment revisions, append acknowledgments, delegation decisions, context sizes, completion outcomes, and disconnection. Normal `quartz-transcript.jsonl` and the audio journal remain.

On runtime disconnection the Live controller closes, rejects future work, and suppresses late response playback. It does not silently switch authority mid-episode. Stop and restart using the current engine if needed. Startup failure is logged and surfaced to the episode command; no second controller is launched.

## Validation

Run inside the project workspace with installed matching dependencies:

```sh
node --test test-live-turn-controller.js test-quartz-backchannel.js test-shutdown.js
npm test
```

Tests use simulated transports and generators. Real delegation timing, state following, context injection delay, and naturalness of handoffs still require an explicitly selected live test episode.

API references checked 2026-09-11:
- https://developers.openai.com/api/docs/guides/live-delegation
- https://developers.openai.com/api/docs/guides/live-conversations
