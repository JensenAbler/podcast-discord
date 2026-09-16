# Reveal

Start a normal consented podcast recording with the Claude + Fish engine. Use **/reveal** whenever you want Alpha to receive the next full transcript. There are no options or setup commands.

The first invocation snapshots the full published transcripts linked from the podcast feed, in episode-number order, and reveals the first. Each later invocation reveals the next. Its private reply identifies the revealed episode and the next title so you can introduce that title aloud and ask for a prediction. Predictions and reflection discussions are conducted by voice; they are not required command stages.

Alpha receives the transcript as text and is invited to reflect aloud. All revealed transcripts and the full captured conversation remain in each subsequent model request. Future transcript text and titles are hidden from Alpha until you introduce or reveal them. The sequence stops after the last available transcript; it never loops or automatically exposes the system prompt.

Missing published transcripts are skipped and identified in the first private reply. Scripts are not substituted. The corpus is frozen for the recording, so later feed changes cannot reorder it. Progress is saved in the recording's evolve-state.json and automatically recovered if reloaded within that recording. A new recording starts a new sequence.

Busy or concurrent commands do not advance. Context-budget rejection rolls the reveal back without trimming prior transcripts. Once a reveal is committed, it remains available even if voice generation fails; continue the conversation by voice. A subsequent /reveal advances, rather than retrying the voice response.

Only a member with Manage Server permission in the bot's voice channel can reveal. The operator who begins the retrospective owns its subsequent reveals.

Prepared-clip playback and prompt/proposal helpers remain internal modules, with no additional Discord controls exposed.

Validation: npm test and node --test test-evolve.js. Automated tests use mocked provider/Discord interactions plus real FFmpeg decoding. Live provider and Discord voice rehearsal remains a separate check.
