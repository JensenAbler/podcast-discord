# podcast-discord

Live Discord capture and playback for Alpha-Clawd.

Writes recordings and transcript metadata to the shared ClawCast content root. By default that is `../clawcast-network/content`; override with `CLAWCAST_CONTENT_ROOT` or `PODCAST_ROOT`.

Recording output belongs under `$CLAWCAST_CONTENT_ROOT/recordings/episode-<timestamp>/`.
The durable mixed recording is stored as `mixed-audio.mp3`; the raw PCM journal
is only for in-progress recording and crash recovery.
If `RECORDING_DIR` is accidentally set to the old `$CLAWCAST_CONTENT_ROOT/episodes/recordings`
path, the bot corrects it back to the contract path unless `ALLOW_LEGACY_RECORDING_DIR=true`
is set for an intentional legacy recovery run.

Production operators can run `/podcast-production` to render a recording through
`/opt/podcast-production`, then `/podcast-publish` to ask the production
codebase to update the podcast feed and sync outputs. Set
`PODCAST_PUBLISH_SYNC_TARGET` in the bot environment when publish should also
copy files to the public web root. The `/podcast-production` `episode` option
uses autocomplete to suggest the next episode, latest produced episode, and
latest published episode when those are distinct; `/podcast-publish` uses the
same episode suggestions and also offers a `version` option with autocomplete
that lists available produced versions for the selected episode. Use
`/podcast-production` option `intro-outro-creative-direction` to regenerate AI
intro/outro copy with creative guidance. `/podcast-production` posts the rendered
MP3 as a Discord attachment
only when it is below `PODCAST_DISCORD_ATTACHMENT_LIMIT_MB` (default `8`);
larger renders are reported with the hosted download URL.

```bash
npm install
npm start
```

## Standalone shutdown

On `SIGTERM` or `SIGINT`, the standalone bot awaits its existing recording and
voice cleanup once, even if more signals arrive. Successful cleanup exits with
code 0; a cleanup error or the 25-second deadline logs a diagnostic and exits
with code 1, leaving five seconds before the service's 30-second stop timeout.
A startup failure during shutdown also retains exit code 1.

Run the deterministic shutdown tests with `node --test test-shutdown.js`.
They also run in `npm test` and use mocks without connecting to Discord
or providers.

## Quartz acknowledgment experiment

During a normal recorded podcast session, GPT-Live can listen alongside the
existing generator and speak brief acknowledgments or hold conversational contact.
It uses the Australian-influenced Quartz voice. Its role is explained in
gpt-live-backchannel.js; there is no content classifier, acknowledgment cooldown,
or extra turn-taking decision. Alpha's existing generator and state machine still
own substantial responses.

Normal-mode Quartz uses a compact prompt. After Alpha finishes, WAITING_FOR_GUEST
blocks and discards Quartz output until confirmed guest speech resumes. Input
audio keeps running. A guest already speaking at playback completion can receive
backchannels immediately. The experimental Live turn controller is unchanged.

Only an actual response-generation or voice-preparation wait can request a verbal
lag acknowledgment: one session.commentary.append after five seconds, provided
the guest is quiet and Alpha has not started speaking or handing off. Guest pauses
and background idle evaluations do not trigger it. Guest speech, Alpha playback,
handoff, completion, cancellation, disconnect, and shutdown cancel the timer and
remove any unsent cue. Sent context cannot be retracted; the current environment
and playback gate still take precedence. Alpha's own Big Brain speech is unchanged.

Run the deterministic Quartz checks with node --test test-quartz-backchannel.js
test-live-turn-controller.js test-live-context-queue.js. Real-session listening is
still needed to judge the wording and naturalness of a commentary cue.

Set PODCAST_LIVE_API_KEY to an OpenAI project API key in the service environment,
then restart the service. This is deliberately separate from OPENAI_API_KEY,
which this deployment also uses for OpenAI-compatible providers such as Groq.
Quartz starts after recording begins, only in the normal host mode. Without its
dedicated key it remains inactive. Set PODCAST_LIVE_BACKCHANNEL_ENABLED=false
to disable the experiment.

Alpha waits for a cooperative Quartz handoff before entering its player.
Quartz receives factual thinking/voice-preparation updates and available upcoming
spoken text (never private reasoning). When audio is ready, it is asked to finish
its current thought, optionally bridge into that text, and stay silent.
The implementation waits for instruction acceptance and one second of actual
near-silent PCM consumed by Discord, with no queued voiced frames. Missing
network packets and transcript gaps do not qualify as silence. A 20-second
deadline rejects Alpha playback instead of interrupting Quartz; it never forces
a handoff. Guest turn-taking checks still run at Alpha playback start.
Once yielded, Quartz stays gated through Alpha playback and waits for guest speech afterward.
Late muted audio is discarded, never replayed. Quartz does not change the guest
buffer or the generator's turn-taking authority.

GPT-Live has no output-audio-done event. This acoustic boundary is experimental,
not proof of semantic sentence completion; the model must follow the handoff
prompt. If the provider does not emit enough near-silent PCM, the handoff will
withhold Alpha rather than infer silence from a stalled connection. Validate
this with real Live audio before deployment, including quiet starts, pauses
inside sentences, delayed packets, and the transition wording.
Its consumed PCM packets are included in the durable recording as source quartz;
generated transcript fragments go to quartz-transcript.jsonl, with
playbackBlocked metadata. These fragments are not a verified transcript of
everything heard. Recording stop, reset, disconnect, and shutdown close its session.
A connection failure leaves the normal pipeline running; the next recording
attempts a new session.

Run node --test test-quartz-backchannel.js for transport, playback priority,
and lifecycle tests. Run npm test for the existing regression suite.
Live voice quality and acknowledgment timing require an actual Discord session.
GPT-Live session time incurs OpenAI API charges while connected, even when muted.

## Response generator

The live spoken reply generator defaults to `PODCAST_GENERATOR=direct`, which calls the configured model provider with a strict JSON schema for turn-taking:

- `shouldRespond`: speak or stay quiet
- `speech`: exact TTS text
- `bigBrain`: whether to hand the turn to the deeper Open Claw agent

Set `PODCAST_GENERATOR=gateway` to use the legacy Gateway/OpenClaw agent path. The sample Fish-host configuration uses Anthropic `claude-opus-4-7`; OpenAI-compatible providers remain supported through `PODCAST_GENERATOR_BASE_URL` and their corresponding API key.

For Groq, prefer `PODCAST_GENERATOR_KEY_ROUTING=free-first-paid-fallback` with `PODCAST_GENERATOR_API_KEY_GROQ_FREE` and `PODCAST_GENERATOR_API_KEY_GROQ_PAID`. The generator tries the free key first, uses the paid key only for live participant-triggered turns while the free key is rate-limited, and switches back after the free key cooldown expires. Idle checks stay free-only.

Legacy active aliases still work: set `PODCAST_GENERATOR_API_KEY_ACTIVE` to an alias and define `PODCAST_GENERATOR_API_KEY_<ALIAS>`. For example, `PODCAST_GENERATOR_API_KEY_ACTIVE=GROQ_PRIMARY` makes the generator use `PODCAST_GENERATOR_API_KEY_GROQ_PRIMARY`; switching to another key is just changing the active alias and restarting the bot. `OPENAI_API_KEY` remains the legacy fallback.

The generator asks for strict `json_schema` output by default. If a model rejects that response format but supports JSON mode, the bot automatically retries with `json_object` and `reasoning_format=hidden`.

When Fish Audio is the active TTS mode, the live `speech` field may include sparse
performance controls. Fish S2 models use bracket controls such as `[short pause]`,
`[pause]`, `[long pause]`, `[soft voice]`, `[emphasis]`, and `[sigh]`; S1-family
models use `(break)` and `(long-break)`. Other voice modes should use punctuation
and wording for pacing instead of Fish tags.

Contract files live in `../clawcast-network/contracts`.

## Image comprehension with Astra

The existing Discord attachment interpreter can use `gpt-6-astra` through a
ChatGPT-authenticated Codex session. Its result enters the same awareness shelf
used by the podcast response generator. There is no extra Discord command or
separate podcast generator.

Each image request includes all 30 pages of *A Read Her* as reference images.
These are the original JPEGs extracted from the supplied PDF, without resizing
or recompression; `assets/xenolex/manifest.json` records the source PDF hash and
each page's hash. Astra is instructed to consult this material only when a
target contains Xenolex or the participant explicitly requests Xenolex decoding.
Ordinary images receive an ordinary interpretation. Uncertain readings belong
in the existing confidence and caveats fields.

On the bot host, run the setup helper **as the same Unix user that runs the bot**:

```bash
cd /opt/podcast-discord
node codex-context-setup.js login
```

Complete the displayed ChatGPT device sign-in in your own browser. Credentials
stay in the bot's private `.podcast-context-codex` directory, which is excluded
from Git. The helper verifies the setup before writing its activation marker.
The running bot reads that marker for each request; activation does not require
a restart. Use `node codex-context-setup.js status` to check configuration and
`node codex-context-setup.js disable` to return images to the configured API
interpreter. Disabling image use does not log the account out.

This uses the signed-in account's Codex allowance and requires that account to
have access to `gpt-6-astra`. It does not inherit this ChatGPT conversation or
its memory. An enabled Codex request fails explicitly if authentication, model
access, limits, or interpretation fails; it does not retry against a paid API.
Text-only attachments and messages containing PDFs retain the existing API
interpreter, including mixed PDF/image messages.

Optional service settings:

- `PODCAST_DISCORD_CONTEXT_CODEX_HOME`: an absolute private credential directory
  shared by the bot and setup helper; defaults to `.podcast-context-codex` here.
- `PODCAST_DISCORD_CONTEXT_IMAGE_BACKEND=codex`: explicitly enable Codex;
  `api` explicitly selects the existing API route. Otherwise the activation
  marker decides. An explicit setting takes precedence over the setup marker.
- `PODCAST_DISCORD_CONTEXT_CODEX_TIMEOUT_MS`: request deadline, default `180000`,
  capped at `240000`.

Only one Astra interpretation runs at a time. A request accepts at most ten
target images and 24 MiB of target data, subject to the existing attachment
limits. Image text is untrusted source material. The Codex process receives
only its dedicated authentication configuration, with shell, browsing, apps,
and other execution tools disabled. Temporary inputs are removed after the
request. Shutdown cancels an active interpretation, and results from an ended
recording are discarded.

## Recording durability

Finalization renders to a pending file, decodes it to validate it, then flushes
and atomically installs the recording. The completion manifest is committed
before journal audio or stems are removed. Interrupted finalizations retain
their recovery inputs; completed recordings are not remixed during recovery.

### Voice receive diagnostics

While connected to voice, `[VoiceReceiveDiagnostics]` records cumulative
receive counters every 10 seconds, on connection/network/voice-state changes,
and at teardown. It reports incoming UDP datagrams, short datagrams, known
and unknown sender mappings, speaking starts, and decoded PCM chunk/byte
counts. Per-user statistics and channel mute/deafen/suppression state are
bounded to 64 entries. No packet contents, PCM samples, tokens, or keys are
logged. The observer follows replacement network sockets and removes its
listeners and timer when the audio receiver is destroyed.

Use `udpObserverAttached` and receive-handler attachment flags before
interpreting zero counts. Zero UDP suggests no observed incoming traffic;
unknown-sender counts suggest missing mappings; known-sender traffic without
PCM points further downstream. UDP counts include transport/control traffic,
so they are not by themselves proof of human speech. State snapshots are
observations, not proof that Discord or the user's microphone is healthy.

### Combine recordings into one produced episode

Produce the first recording with `/podcast-production`. To add another recording,
use `/podcast-production episode:18 recording:<recording> append:true`.
Append requires an explicit episode number and creates a new version from that
episode's latest completed production plus the selected recording. Repeat to
include more recordings, in order. Leave recording blank for the latest recording.
The result has one intro/outro and a continuous transcript with images.
Resume still creates separate recordings. Publish the combined version separately
with `/podcast-publish episode:18 version:<version>`.

### Participant and episode-plan tags

Recordings carry individual `person:<name>` tags (for example `person:jensen` and `person:alpha`), and an optional `plan:<basename>` tag shared across plan versions and resumes. Participant tags describe the current recording, not inherited conversation history. New recordings persist tags in `recording-tags.json` and final metadata; older recordings derive tags from their own transcripts and saved plan/background. Names are normalized; Alpha-Clawd maps to Alpha and Jensen Abler maps to Jensen.

Use `/podcast-production plan:<plan-name>` to combine all completed recordings for that plan in chronological order, with one intro and outro. Plan autocomplete shows recording counts and is scoped to the current server. An optional `episode` chooses the destination; otherwise the normal next episode is used. Each run creates a new version. Publishing remains a separate command. Don't combine `plan` with `recording` or `append`.

Recording autocomplete supports participant/plan text searches; multiple words must all match (for example `jensen alpha`). Production manifests retain the union of all source tags. CLI: `python3 tools/podcast-tool.py produce-recording --episode 20 --plan <basename> --dry-run` previews selected sources; omit `--dry-run` to produce. `--guild-id` optionally restricts selection to a server.


### Muted Quartz speech and Big Brain dispatch
Normal-mode Quartz retains the complete conversation context. It must not repeat
Alpha's planned or delivered speech. Speech received while muted remains
suppressed when a guest resumes; the gate releases only after one second of
received near-silent output PCM (amplitude at most 8), never from elapsed wall
time or a transcript gap. This acoustic boundary is an approximation: Live has no
output-utterance-done event. Experimental turn-control behavior is unchanged.

A Big Brain request attached to discarded host speech is not dispatched.
The guest utterances remain requeued for a fresh evaluation of the completed
question. Normal buffer and idle requests dispatch only after host playback.


Quartz playback uses a 4x gain (+12.0 dB), halved from the previous 8x boost,
with a -1 dBFS peak limiter and 100 ms release. The same adjusted PCM is
encoded for Discord and saved to the recording. Muting and speech detection
continue to use the original PCM. Set PODCAST_QUARTZ_OUTPUT_GAIN (linear, 0 < gain
<= 32) to recalibrate if a provider changes its output level; the default is 4.

Confirmed participant speech activates Quartz’s “RARELY hmm, mmhmm, ah” state.
Participant endpoints return to the existing progressive floor-holding states;
Alpha handoff and playback retain priority. Raw unconfirmed VAD does not activate it.
