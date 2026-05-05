# podcast-discord

Live Discord capture and playback for Alpha-Clawd.

Writes recordings and transcript metadata to the shared ClawCast content root. By default that is `../clawcast-network/content`; override with `CLAWCAST_CONTENT_ROOT` or `PODCAST_ROOT`.

```bash
npm install
npm start
```

## Response generator

The live spoken reply generator defaults to `PODCAST_GENERATOR=direct`, which calls OpenAI directly with a strict JSON schema for turn-taking:

- `shouldRespond`: speak or stay quiet
- `speech`: exact TTS text
- `mode`: `chatty`, `buffered`, or `unchanged`

Set `PODCAST_GENERATOR=gateway` to use the legacy Gateway/OpenClaw agent path. Direct mode uses `OPENAI_API_KEY` and defaults to `PODCAST_GENERATOR_MODEL=gpt-4.1-mini`.

To keep multiple direct-generator keys ready, set `PODCAST_GENERATOR_API_KEY_ACTIVE` to an alias and define `PODCAST_GENERATOR_API_KEY_<ALIAS>`. For example, `PODCAST_GENERATOR_API_KEY_ACTIVE=GROQ_PRIMARY` makes the generator use `PODCAST_GENERATOR_API_KEY_GROQ_PRIMARY`; switching to another key is just changing the active alias and restarting the bot. `OPENAI_API_KEY` remains the legacy fallback.

Contract files live in `../clawcast-network/contracts`.
