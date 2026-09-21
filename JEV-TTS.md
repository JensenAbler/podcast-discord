# Jev speech batching

Fish streaming speech uses Jev to judge uncertain phrase boundaries while incoming text continues to accumulate. Complete sentences are released immediately. Jev receives a bounded preceding context, candidate chunk and available lookahead, with two independent questions in one request: natural-pause probability (Noul) and disruption severity (Score). A candidate is released at natural >= 0.6 and disruption <= 1.1. Score confidence is diagnostic, not a probability of correctness.

## Configuration

Set TYPESAFE_API_KEY in the service environment, or put a single unquoted TYPESAFE_API_KEY=value line in .env.typesafe alongside the provider. Keep that file mode 0600; .env.* is excluded from git. No key is included in source. With a key, semantic batching defaults on. Set JEV_TTS_ENABLED=false and restart to disable.

Defaults:
- JEV_MODEL=jev-latest
- JEV_TTS_FIRST_WAIT_MS=400
- JEV_TTS_MAX_WAIT_MS=600
- JEV_TTS_TIMEOUT_MS=500
- JEV_TTS_TARGET_CHARS=100 (candidate selection preference; judgments can start at 48 characters)

The first/later wait budget follows the arrival time of the oldest remaining text. New tokens do not restart it. The usual chunk cap is 240 characters. Deadline or size limits override a negative judgment. Emergency flushes of stalled unbroken words/tags can exceed the cap or split a tag. These are latency bounds for text buffering, not a bound on end-to-end audio latency.

Fish receives each approved chunk with an explicit flush; its internal chunk_length is 300 to reduce premature re-splitting. Without semantic batching, the existing Fish event sequence and chunk length remain in use. API failure switches the current response to deterministic cuts, and the client cools down for 30 seconds. Cancellation discards stale judgments and aborts outstanding requests. Logs contain lengths, timing, reasons and numeric judgments, not the text sent to Jev.

## Validation

Run:
```sh
node --test test-jev-speech-batcher.js
npm test
```

On 2026-09-21 all 16 new tests and the existing suite passed. Coverage includes bounded waits, continued input during judgment, exact text preservation, abbreviations/tags, fallback, cancellation and Fish event integration.

Live synthetic tests exercised the real TypeSafe API and Fish WebSocket API. In the final paired sample semantic batching preserved “Martin Luther King” as a chunk boundary and completed audio streaming. First audio was 1306 ms with semantic batching versus 959 ms without; total generation was 5017 versus 5186 ms. This small sample is not a latency benchmark or a listening-quality evaluation. Hard deadlines can still produce awkward cuts. Playback-buffer-aware decisions are not implemented.

The official TypeSafe skill is installed under .agents/skills/typesafe-ai with its license and skills-lock.json.
