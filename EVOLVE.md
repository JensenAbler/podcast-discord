# Alpha-Clawd Evolve

Evolve adds a chronological retrospective and prepared audio to the existing bot.
Use the **Claude + Fish** engine, including its normal Quartz backchannels if enabled.
Gemini Live and experimental Live-controlled Alpha are not supported by these controls.

## Start a rehearsal

1. Join with /podcast-join and complete the existing recording-consent flow.
2. /podcast-evolve action:load asset:published-evolve-rehearsal
3. action:next gives Alpha only the next episode title and asks for a prediction.
4. Let Alpha finish. action:reveal preserves the audible prediction and supplies the entire transcript.
5. Discuss the comparison. action:reflect saves Alpha's audible reflections verbatim.
6. action:next advances. action:ask repeats the current stage's invitation if a request failed or was interrupted.

All previous revealed transcripts and the full captured live conversation remain in every
Evolve generator request. Reflections supplement source transcripts; they never replace them.
Future titles/transcripts in the loaded bundle are not sent to Alpha before their stage.
Prior knowledge or separate memories may still inform a prediction; this is not a claim of
experimental blindness.

Controls require Manage Server and the operator to be in the bot's voice channel.
The operator who loads the retrospective owns subsequent state transitions.
Replies are private to the operator. Status and stop remain available while a clip runs.

## Corpus preparation

From the deployed checkout (or a managed Praxis workspace for development):

    node evolve-prepare.js /opt/clawcast-network/content published-evolve

This creates content/evolve/published-evolve.json, a two-episode -rehearsal.json,
and an -inventory.json report. It does not overwrite existing bundles.
The feed's actual versioned full-text transcript links are selected chronologically.
Missing early transcripts are reported; scripts/narration are not silently substituted.
Published live-STT text is complete as stored, not a guarantee of transcription accuracy.
Audit missing speech, speaker attribution, relevant images, and nonverbal material.

To use a custom selection, attach a JSON manifest to action:load:

    {
      "version": 1,
      "title": "Evolve rehearsal",
      "contextLimit": 200000,
      "episodes": [
        {
          "id": "5",
          "title": "The actual episode title",
          "transcriptFile": "episodes/episode-05-v009_transcript.txt",
          "complete": true
        }
      ]
    }

transcript may contain inline full text instead of transcriptFile.
Paths are relative to the content directory and cannot escape it through symlinks.
complete:true is the preparer's assertion that the selected source is the full transcript.
A copied snapshot and SHA-256 for each transcript are preserved in the recording's state.

The default 200,000-token ceiling is conservative. Context checks use estimates, not the
provider tokenizer; they reserve additional headroom and fail rather than trim source text.
A larger ceiling must be verified against the actual model/provider route first.
Provider limits can still reject a request. There is no context-compaction fallback.

## Prepared clips

Use /podcast-evolve action:clip-import asset:mars-speech audio:<attachment> cues:<attachment>.
The cues attachment is JSON:

    {
      "title": "Ideas Week opening",
      "cues": [
        {"startMs": 0, "endMs": 2100, "speaker": "Jensen (recorded)", "text": "Exact words in the clip."},
        {"startMs": 2300, "endMs": 5400, "speaker": "Jensen (recorded)", "text": "The next complete sentence."}
      ]
    }

Review text and cue boundaries before import. Cues are ordered, non-overlapping, and relative
to the clip start. Use short clauses or word cues for precise interruption behavior.
Import validates audio by decoding it with FFmpeg. Maximum: 100 MB uploaded, ten minutes decoded.
Use multiple ordered clips for a longer reading. Existing IDs cannot be overwritten.

action:clip asset:mars-speech plays directly into Discord and the audio journal.
It holds normal generation, uses the existing Quartz mute/handoff, and bypasses STT for the
prepared transcript. Text is delivered once per completed cue, using the audio resource's
consumed playback duration, not a wall-clock guess. action:stop interrupts playback.
Only consumed PCM is journaled; an interrupted partial cue is not represented as fully heard.
The omitted partial cue is visible in the prepared-clips.jsonl receipt.

Clips work during an ordinary Claude + Fish recording too; a retrospective is not required.
An intentional replay is a new audible event and has its own receipt.

## Prompt and proposal

After the last reflection, action:prompt reproduces the exact current application system
prompt in the retrospective and invites Alpha to retain it, change it, or suggest another
direction. The prompt text is also attached to the private reply and saved with the recording.
The prompt is already present as an instruction; this stage explicitly examines it.
Earlier episodes may have used different prompts/models.

Use a prepared clip for an audible reading. action:prompt-export privately exports the exact
application prompt without advancing the stage or telling Alpha about the planned ending.
Prepare its audio/cues before the session or while paused between responses; play it after
the final reflection and then use action:prompt.
Do not expose the future ending through an episode plan or the brainstorming memos.

action:proposal exports Alpha's statements verbatim, tied to the prompt hash.
This is a proposal artifact, not an automatic code change. Implement the chosen change through
the normal Praxis workspace, checks, commit/push, and fast-forward deployment workflow.
action:end ends Evolve mode but keeps recording.

## Recovery and evidence

evolve-state.json in the recording contains the full source snapshots, stage, audible
timeline, original operator, current model/prompt at load, and prediction/reflection events.
It is atomically replaced after updates. evolve-system-prompt.txt,
evolve-proposal.json, and prepared-clips.jsonl preserve additional evidence.
Audio remains in the existing recording journal.

action:resume resumes saved state in the current recording.
To continue after a restart/new recording, first join and consent, then use
action:resume asset:episode-2026-... with the previous recording directory basename.
The original state is retained, and the continued state is saved with the new recording.
An explicitly ended retrospective cannot be resumed.

## Validation

    npm test
    node --test test-evolve.js

Tests cover hidden future material, audible prediction/reflection gates, verbatim persistence,
budget failure, Quartz-mode context retention, clip completion/interruption/cancellation,
real FFmpeg decode, and Discord command schema. These do not claim a live Discord listening
test or a successful long-context provider call.
