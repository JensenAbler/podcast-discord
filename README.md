# podcast-discord

Live Discord capture and playback for Alpha-Clawd.

Writes recordings and transcript metadata to the shared ClawCast content root. By default that is `../clawcast-network/content`; override with `CLAWCAST_CONTENT_ROOT` or `PODCAST_ROOT`.

Recording output belongs under `$CLAWCAST_CONTENT_ROOT/recordings/episode-<timestamp>/`.
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
