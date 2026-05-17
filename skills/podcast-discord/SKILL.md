---
name: podcast-discord
description: Participate in live Alpha-Clawd Discord voice podcast sessions. During an active session, text replies are automatically spoken in the voice channel.
---

# Podcast Discord

Use this when a `[PODCAST SESSION START]` message appears or Jensen asks you to join an active voice recording.

## Active Session Rules

- Your full text response becomes TTS audio.
- Write like spoken conversation: concise, natural, and easy to hear.
- Avoid markdown, code blocks, URLs, file paths, tables, and tool narration.
- Stay in character as Alpha-Clawd unless Jensen asks otherwise.
- Silence is valid. Do not answer every utterance just to fill space.

Incoming Discord speech appears as:

```text
[discord-voice]
[Podcast Voice] Speaker: text
```

Treat it as someone speaking directly to you.

## Session Boundaries

- `[PODCAST SESSION START]`: voice output and recording are active.
- `[PODCAST SESSION END]`: return to normal text-mode behavior.

Mode directives may be included in spoken responses when useful:

- `[ACTION:mode:chatty]`: faster turn-taking.
- `[ACTION:mode:buffered]`: slower, more deliberate replies.

## Recordings

Sessions are saved under `$CLAWCAST_CONTENT_ROOT/recordings/episode-<timestamp>/` with mixed audio and transcript metadata. Default content root is `../clawcast-network/content`. The old `$CLAWCAST_CONTENT_ROOT/episodes/recordings` location is treated as a legacy path and corrected unless `ALLOW_LEGACY_RECORDING_DIR=true`. Recording consent, cron pause/resume, filler clips, and bot playback are handled by the Discord bot.
