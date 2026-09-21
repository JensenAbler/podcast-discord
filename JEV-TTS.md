# Opportunistic Jev speech splitting

The original Fish fast path is the default. The first text chunk goes straight through, the configured Fish chunk length is preserved, and normal streaming has no Jev buffering timer.

Jev is used only when both conditions hold:
- At least 240 characters of text are already available, within a bounded 1600-character review window.
- At least 2000 ms of conservatively estimated audio is ahead of playback.

The sender drains immediately available text for at most one event-loop turn per read (maximum 64 chunks). It does not wait for future words to create a backlog. Oversized windows bypass optimization. Tiny or slow streams therefore behave as before.

## Audio and decision budget

The provider counts complete MP3 frames or Ogg Opus granule positions, including Opus pre-skip and chained streams. It subtracts all monotonic elapsed time since the first audio delivery. This assumes playback could have begun immediately and run continuously, so it underestimates the audio cushion when playback starts later or pauses. It is not a measurement of the Discord player queue. Unknown formats or invalid headers disable optimization.

Jev gets at most 500 ms, leaving a target reserve of 1500 ms for downstream synthesis/delivery. This reserve is a heuristic, not a guarantee against Fish or network stalls. Already-sent text cannot be revised.

A single TypeSafe request judges up to 24 candidate boundaries with independent Noul questions. Candidates are sampled from whitespace outside Fish tags, favoring nearby punctuation; punctuation is never automatically accepted as a sentence end. Jev sees the available text on both sides. Probability >= 0.7 approves a candidate; code copies exact source spans and emits explicit Fish flushes only at accepted boundaries. Minimum resulting prefix size is 60 characters. The remaining tail keeps the ordinary final-flush behavior.

No accepted cuts, unavailable Jev, low audio cushion, failure, or timeout preserves the original chunk sequence. A failed opportunity is not retried within that response. HTTP/API failures also trigger the client cooldown for 30 seconds. The unchanged Fish internal chunking can still split long spans without an accepted boundary; this is a best-effort improvement, not a prosody guarantee.

## Configuration and validation

TYPESAFE_API_KEY comes from the environment or the ignored, mode-0600 .env.typesafe file beside the provider. JEV_TTS_ENABLED=false disables the optimization. JEV_MODEL defaults to jev-latest. The former FIRST_WAIT/MAX_WAIT/TARGET_CHARS controls are no longer used.

Run:
    node --test test-jev-speech-batcher.js
    npm test

Tests cover unchanged startup and low-surplus behavior, ready backlog splitting, no wait for future text, timeouts, failure, cancellation, invalid boundaries, exact text preservation, MP3/Opus duration accounting, and Fish event integration.

Implementation follows the installed official TypeSafe skill and the API/structure-recovery cookbook: bounded boundary judgments in one request, with exact text slicing owned by code.
