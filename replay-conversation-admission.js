'use strict';
const { assess } = require('./conversation-admission');
const fs = require('node:fs');
function replay(cases) {
    return cases.map(row => {
        if (row.provenance !== 'controlled' && !row.utterance.acousticEvidence) {
            return { id: row.id, provenance: row.provenance, scored: false,
                reason: 'missing acoustic evidence; no verified audio label' };
        }
        const result = assess(row.utterance, row.context);
        const passed = row.expected ? result.status === row.expected.status && result.effect === row.expected.effect : null;
        return { id: row.id, provenance: row.provenance, scored: !!row.expected, passed,
            previousTextOnlyPolicy: row.utterance.transcription ? 'accepted-and-invalidates' : 'empty',
            status: result.status, effect: result.effect, reasons: result.reasons };
    });
}
if (require.main === module) {
    const rows = replay(JSON.parse(fs.readFileSync(process.argv[2] || 'conversation-admission-cases.json', 'utf8')));
    console.log(JSON.stringify({ results: rows, scored: rows.filter(r => r.scored).length,
        failed: rows.filter(r => r.passed === false).length,
        unscored: rows.filter(r => !r.scored).length }, null, 2));
    if (rows.some(r => r.passed === false)) process.exitCode = 1;
}
module.exports = { replay };
