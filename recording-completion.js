'use strict';
const fs = require('fs');
const path = require('path');

function writeJsonAtomic(file, value) {
    const temp = file + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    const fd = fs.openSync(temp, 'r+');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
    if (process.platform !== 'win32') {
        const directory = fs.openSync(path.dirname(file), 'r');
        try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    }
}
function readJson(directory, name) {
    const file = path.join(directory, name);
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

// Audio recovery can finish before episode metadata is committed. Reconcile both
// newly recovered journals and already-complete journals on every startup.
function recoverEpisodeCompletions(root) {
    const completed = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith('episode-')) continue;
        const directory = path.join(root, entry.name);
        if (fs.existsSync(path.join(directory, 'episode-complete.json'))) continue;
        try {
            const journal = readJson(directory, 'audio-journal/manifest.json');
            if (!journal || !['complete', 'recovered'].includes(journal.status)) continue;
            const session = readJson(directory, 'recording-session.json');
            const identity = readJson(directory, 'resume-identity.json');
            const guildId = session?.guildId || identity?.guildId;
            if (!guildId || !journal.consentGiven || !Number.isFinite(Date.parse(journal.stoppedAt))) continue;
            const audio = journal.mixedAudio;
            if (!audio || path.basename(audio) !== audio || !fs.statSync(path.join(directory, audio)).size) continue;
            const plan = readJson(directory, 'episode-plan.json');
            const tags = readJson(directory, 'recording-tags.json') || {};
            const recording = {
                guildId, recordingPath: directory, transcriptPath: path.join(directory, 'transcript.jsonl'),
                startedAt: journal.startedAt, stoppedAt: journal.stoppedAt,
                mixedAudio: audio, duration: journal.durationMs / 1000,
                consent: { given: true, timestamp: journal.consentTimestamp },
                episodePlan: session?.episodePlan || (plan ? {
                    basename: plan.basename, version: plan.version, path: 'episode-plan.json'
                } : null),
                tags: tags.tags || [], planTag: tags.planTag || session?.planTag || null,
                recovered: true, recoveredAt: new Date().toISOString(),
                files: [...new Set([...fs.readdirSync(directory), 'episode-complete.json'])].sort()
            };
            if (!fs.existsSync(recording.transcriptPath)) throw new Error('Transcript missing');
            writeJsonAtomic(path.join(directory, 'episode-complete.json'), recording);
            completed.push(recording);
        } catch (error) {
            console.error('[RecordingCompletion] Cannot complete ' + entry.name + ': ' + error.message);
        }
    }
    return completed;
}
module.exports = { writeJsonAtomic, recoverEpisodeCompletions };
