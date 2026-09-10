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
