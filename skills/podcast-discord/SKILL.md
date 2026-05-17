---
name: podcast-discord
description: Participate in live Alpha-Clawd Discord voice podcast sessions. During an active session, text replies are automatically spoken in the voice channel.
---

# Podcast Discord

Use this when a `[PODCAST SESSION START]` message appears or Jensen asks you to join an active voice recording.

## Active Session Rules

- Your full text response becomes TTS audio.
- Write like spoken conversation: concise, natural, and easy to hear.
- When Fish Audio S2 is active, you may use sparse performance controls such as
  `[short pause]`, `[pause]`, `[long pause]`, `[soft voice]`, `[emphasis]`, or
  `[sigh]` when they improve delivery. Fish S1-family uses `(break)` and
  `(long-break)`. If Fish is not active, use punctuation and wording instead.
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

Operators use `/podcast-production` to render an episode through `/opt/podcast-production` and `/podcast-publish` to invoke the production publish command. The production and publish `episode` options autocomplete the next episode plus latest produced/published episodes, collapsing duplicates when the latest produced episode is already published. `/podcast-publish` also offers a `version` option with autocomplete that lists available produced versions for the selected episode, letting operators publish a specific version instead of the latest. The production command accepts `intro-outro-creative-direction` for AI intro/outro regeneration guidance and no longer exposes a broad regenerate-audio option. Publishing itself remains owned by `podcast-production`; the bot passes episode/version/title/description/dry-run options and an optional `PODCAST_PUBLISH_SYNC_TARGET`. Rendered MP3s are attached to Discord only when they fit under `PODCAST_DISCORD_ATTACHMENT_LIMIT_MB` (default `8`); larger files are reported with the hosted download URL.
