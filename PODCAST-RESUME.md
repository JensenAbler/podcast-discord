# Continue the retrospective in a new episode

Join a voice channel, run `/podcast-resume`, then provide fresh recording consent with `YES`. The command requires Manage Server and the original retrospective operator. It selects that operator's latest completed retrospective in the current server. To choose a specific source:

```
/podcast-resume recording:episode-2026-09-17T18-31-16-590Z
```

This starts a separate recording. It never appends to, republishes, or edits the source episode. The old opening is not replayed. Alpha waits for the continuing conversation through the normal host loop.

The saved retrospective state is copied intact, including the full embedded historical transcripts, disclosure position, recorded events, and audible timeline. Transcript hashes and the configured context budget are checked before joining. The snapshot stays pinned while consent is pending.

Prior audible speech is stored in `resume-history.json`, separate from the new episode's `transcript.jsonl` and audio. Alpha and Quartz receive that speech as prior context. New speech extends the copied retrospective state and is recorded only in the new episode. `resume-source.json` records provenance and hashes; `resume-background.json` retains the original plan as background without restarting its agenda. A later continuation can inherit both earlier history and the new conversation.

This one-off command supports saved retrospective sessions using the direct generator. It does not restore volatile model decisions, pending requests, unsaved thought state, or an identical full API request. The retrospective context block itself is restored exactly; a separate continuation note explains the new episode boundary.

Validation:
```sh
npm test
node --test test-podcast-resume.js test-recording-startup.js
```

## Hang up and resume

When the last human leaves the channel, the bot stops its host loop, checkpoints the episode plan, and finalizes the recording. Other humans remaining in the channel keep the session running. A concurrent leave command or shutdown shares the same finalization.

Audio finalization may outlast a process shutdown. Startup recovery finishes interrupted audio journals and reconstructs missing episode-completion metadata from durable session/identity, consent, plan, tags, and journal records. It also handles audio recovered by an older bot that never wrote episode-completion metadata. Existing completion records and plan checkpoints are not overwritten.

Resume waits for startup recovery. A newer owned recording that is still incomplete blocks default selection with an explicit error instead of silently falling back to an older episode. During normal finalization, wait for it to finish, then resume with fresh consent.

Run the offline regression suite with `bash test-offline.sh`. Its preload blocks external Node sockets, TLS, and fetch while allowing local HTTP test servers. No provider credentials are required.
