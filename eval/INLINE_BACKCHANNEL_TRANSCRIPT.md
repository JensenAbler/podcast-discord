# Inline backchannel transcript

Played Live vocalizations are recorded as Alpha-Clawd host speech and rendered chronologically alongside guests and substantive Alpha playback. No Quartz explanation or source metadata is added to the generator prompt.

Output PCM offsets identify received audio, including muted output. Queue segments and encoded packets retain those offsets until Discord consumes them. Text offsets are **not** assumed equal to PCM offsets: the latest historical episode shows drift between them. A dedicated output-transcript clock maps text intervals to estimated receipt-time windows (250 ms margin), and the ledger requires nearby voiced output plus consumption of every matched voiced frame. Raw output text logs its current PCM frontier for future alignment diagnosis.

Neighboring text fragments are coalesced after 750 ms without new text. This is transcript assembly time; it does not delay audio or Alpha's handoff. Ambiguous partial playback keeps the generated text and coverage in diagnostics without quoting a guessed prefix. Consumption means server-side Discord resource consumption, not proof of guest-device reception. Text-to-audio association is explicitly estimated, not exact word alignment; the next live session should be reviewed against the recording. Exact offset correlation is also supported for sources/tests that supply a known shared timebase.

Saved, admitted guest and host entries feed a passive episode transcript. Once backchannels appear, the generator renders this single timeline instead of duplicating older turn-history messages. Current turn decision inputs, ASR admission, buffer flushes, cooldowns, pending-answer rules, and silence decisions are unchanged. No generated-but-unplayed substantive answer is substituted for spoken history. An already submitted request remains an immutable snapshot; later requests see newly available entries. Existing prompt-budget trimming retains the newest context. Session boundaries clear the passive timeline.

The raw JSONL journal remains append-only in observation order, with playback timestamps; generator and existing transcript processing sort by speech/playback time. Live does not receive its own saved output again.

Validation: test-inline-backchannels.js is included in npm test. test-quartz-backchannel.js also exercises packet lineage and muted-clock advancement. The latest-episode regression verifies that a guest's question about “hmm, okay” follows that Alpha vocalization in the actual built prompt without architecture labels.
