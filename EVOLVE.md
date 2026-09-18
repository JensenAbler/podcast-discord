# Retrospective context

The one-off /reveal command has been retired. Its Discord command, confirmation handler, and menu-description refresh timer have been removed.

Existing recordings retain their saved evolve-state.json, transcript snapshots, and conversation history. /podcast-resume can continue from that context; removing the command does not remove previously revealed transcripts.

Prepared-clip playback and prompt/proposal helpers remain internal modules.

Validation: npm test and node --test test-evolve.js test-podcast-resume.js.
