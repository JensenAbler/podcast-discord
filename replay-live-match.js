'use strict';
const fs = require('node:fs');
const { ConversationAdmission } = require('./conversation-admission');
function replayEpisode(fixture) {
    const policy = new ConversationAdmission();
    let cursor = 0;
    const events = [...fixture.live].sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
    return [...fixture.utterances].sort((a, b) => Date.parse(a.asrCompletedAt) - Date.parse(b.asrCompletedAt)).map(u => {
        // Replay only evidence that had arrived by Fish completion, never future text.
        while (cursor < events.length && Date.parse(events[cursor].observedAt) <= Date.parse(u.asrCompletedAt))
            policy.observeLive(events[cursor++]);
        const result = policy.evaluate(u, {});
        // Separate retrospective metric; never used in the admission above.
        const later = new ConversationAdmission();
        events.filter(e => Date.parse(e.observedAt) <= Date.parse(u.asrCompletedAt) + 1500)
            .forEach(e => later.observeLive(e));
        const eventual = later.context(u);
        return { text: u.transcription, originalLiveMatch: u.originalLiveMatch,
            liveMatch: result.evidence.liveMatch, eventualLiveMatch: eventual.liveMatch, score: result.evidence.liveMatchScore,
            status: result.status, expectedStatus: u.expectedStatus };
    });
}
if (require.main === module) {
    const rows = replayEpisode(JSON.parse(fs.readFileSync(process.argv[2] || 'conversation-admission-episode-case.json', 'utf8')));
    console.log(JSON.stringify({ rows,
        originalMatches: rows.filter(r => r.originalLiveMatch).length,
        newMatches: rows.filter(r => r.liveMatch).length,
        eventualMatches: rows.filter(r => r.eventualLiveMatch).length,
        changedAdmission: rows.filter(r => r.status !== r.expectedStatus).length }, null, 2));
    if (rows.some(r => r.status !== r.expectedStatus)) process.exitCode = 1;
}
module.exports = { replayEpisode };
