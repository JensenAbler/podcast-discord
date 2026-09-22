# Resume the conversation

Join a voice channel, run `/podcast-resume`, then provide recording consent with YES. The command requires Manage Server and the original recording operator. It selects that operator's latest completed recording in the current server. An explicit recording folder can select an older source.

Resume restores the audible conversation and saved showrunner plan progress, including phase, angles, opening and closing progress. It skips the opening and adds no instructions about a new episode or continuation. The host uses its normal showrunner guidance.

Recordings remain separate files. Resume never edits, appends to, or republishes the source recording. Prior speech lives in resume-history.json; only new speech goes into the new transcript and audio. Later resumes inherit both. The source snapshot is pinned while consent is pending.

The retired retrospective runtime, reveal state machine, and special prompt path have been removed. Existing archival files remain untouched; resume uses resume-identity.json for ownership and does not read retrospective state.

## Hang up and resume

When the last human leaves, new host turns are blocked immediately. Any host response already underway finishes generation and playback, and its transcript and showrunner updates are saved before recording finalizes. No additional idle monologue starts. Other humans remaining keep the session running. Concurrent leave requests share one finalization.

Startup recovers interrupted audio journals and missing completion metadata. Existing completion records and plan checkpoints are not overwritten. Resume waits for recovery; a newer owned incomplete recording blocks selection rather than silently falling back.

Run `bash test-offline.sh` for regression coverage. Its preload blocks external Node sockets, TLS, and fetch while allowing local test servers. No paid provider calls are used.
