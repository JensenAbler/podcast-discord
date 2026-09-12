# Normal-mode transcript admission

Alpha remains the substantive turn authority. Live remains the Quartz presence voice. Experimental Live delegation and the graceful playback handoff retain their existing policies.

## Evidence and authority
Fish text is initially a candidate. Admission combines per-utterance voiced duration, longest voiced run, density within the speech span, recent same-speaker continuation, script changes, possible overlap with Alpha's playback text, and time-aligned Live agreement. Fish's fixed 0.8 confidence is not used as measured confidence.

There is no language blacklist or mandatory two-recognizer vote. A substantial script change (at least four matching units) requires strong Live corroboration even with sustained audio. Short supported interjections retain their existing acoustic path. Brief supported acknowledgments remain valid despite endpoint silence. Live corroborates words in the audio, including group audio. Fish retains its original microphone attribution. Agreement does not infer who intended to address whom; Alpha interprets conversational relevance. Echo or background origin does not veto corroborated words.

Candidate text is saved as rawTranscription with admission reasons and acousticEvidence, while conversational text stays empty. It does not enter the receiver's speaker history, Alpha's buffer, side-agent context, or Live's injected guest transcript. Live still hears the original audio and makes its own perception judgments.

A candidate can be promoted once when matching Live words arrive within five seconds of ASR completion, provided no newer accepted speech from that participant has arrived and Alpha has not started a subsequent playback. Both records share an admission id. Consumers should treat the later accepted record as promotion of the same observation, not a second utterance. These five seconds are a retention window, never a playback delay.

## Pending answers
Acoustic evidence parks a ready answer while that segment's recognition completes; it does not permanently cancel the answer. Completed candidate, empty, or failed recognition releases only the matching segment's pause. These outcomes are not falsely labeled confirmed phantoms. Newer speech and other guests retain their independent authority.

Accepted acknowledgments, exact repeated requests, and a small set of non-substantive continuations preserve a pending direct answer. They remain in the saved transcript, Live context, and remembered conversation. They are also attached to the pending utterances so a later correction can requeue the full context. Corrections and other substantive additions invalidate the answer. State updates precede asynchronous debug/UI injection.

Raw VAD alone retains the existing single adaptive 150–250 ms evidence budget. No eight-second timer was added. A real acoustic segment can pause playback until its ASR outcome; a stopped session releases the wait. This depends on the receiver's existing completion/error lifecycle and provider timeouts.

## Presence prompt
A real direct invitation gets priority: one prompt, tiny nonlexical acknowledgment at the first natural opening, without waiting for Alpha's processing updates. Ordinary backchannels are sparse. Noise, uncertain speech, repeated progress updates, and quoted invitations should not trigger them. Prompt compliance and perceived latency require another live test; unit tests cannot establish either.

## Replay and limitations
Run:
```
node replay-conversation-admission.js
node replay-live-match.js
node --test test-conversation-admission.js test-phantom-activity.js test-quartz-backchannel.js test-live-turn-controller.js
npm test
```

The fixture replay compares the previous accept-every-nonempty-text behavior with the new policy. Controlled cases have explicit expected admission/turn effects. PCM fixture tests verify detector evidence plumbing using generated signal bursts; these are not human speech recordings or ASR accuracy tests.

Three suspected cases from the final response of episode-2026-09-12T00-51-07-382Z are retained as unscored archive cases. They lack the newly recorded acoustic fields and have not been audio-verified. The wider 60-episode audit found that old confidence values were placeholders and older short fragments often were legitimate speech. Accordingly, neither duration-only archive counts nor Fish/Live disagreement is treated as false-positive ground truth.

Thresholds and conservative continuation rules are initial heuristics, not a calibrated classifier. Loud background speech can still be admitted; quiet meaningful speech can remain a candidate. Echo matching is diagnostic only and uses available Alpha preview text. Live offset alignment uses the mixer send clock, so buffered audio can reduce alignment accuracy. Admission reasons and evidence are now persisted to make subsequent review measurable.

## Corroboration refinement

Recognition comparison retrieves Live fragments from 500 ms before Fish's speech start through 1500 ms after its speech end. These are evidence-window margins, not new waiting periods. Live evidence is retained for 90 seconds (up to 1500 fragments), covering the receiver's 60-second maximum utterance.

Comparison removes punctuation, normalizes apostrophes, ignores common nonlexical fillers, collapses adjacent repetitions, and uses ordered word edit distance. Chinese and Japanese unspaced text is compared at character granularity. Neighboring Live words outside the best matching span are ignored. Short phrases need exact normalized lexical agreement; five or more units require a score of at least 0.78. Input above 500 comparison units remains unmatched instead of silently validating only a prefix.

A substantial change of dominant writing script, or six or more units implausibly packed into the acoustic speech span (over 18 units/second), requires a corroboration score of at least 0.90. These are recognition plausibility signals, not topic/relevance classifiers. They cannot identify every language change or hallucination. If Live is unavailable, ordinary speech keeps its acoustic admission path; identified outliers remain uncertain. A strong recording amplitude alone cannot establish those outlier words.

The latest recorded episode is included as a deterministic timing fixture. Replay uses only Live fragments observed by each Fish completion. A separate retrospective metric shows matching with up to 1500 ms of later-arriving text; that future text never affects the initial admission metric. The fixture measures matching behavior on recorded recognizer outputs, not independently verified speech accuracy.

The normal Live prompt no longer singles out television speech for suppression. The companion still makes its own conversational judgment about when a tiny acknowledgment fits.
