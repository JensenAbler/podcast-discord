const crypto = require('crypto');

function cleanText(value) {
    return String(value || '')
        .replace(/\s+/g, ' ')
        .trim();
}

function getEntryText(entry = {}) {
    return cleanText(entry.text || entry.transcription || entry.rawTranscription || '');
}

function getEntrySpeakerRole(entry = {}) {
    return cleanText(entry.speakerRole || 'guest').toLowerCase();
}

function getEntrySpeakerId(entry = {}) {
    return cleanText(entry.userId || entry.speakerId || entry.speaker || 'unknown');
}

function getEntryTimestamp(entry = {}) {
    const raw = entry.asrCompletedAt ||
        entry.speechEndedAt ||
        entry.timestamp ||
        entry.generatedAt ||
        entry.speechStartedAt ||
        '';
    return cleanText(raw);
}

function isParticipantEntry(entry = {}) {
    return getEntrySpeakerRole(entry) !== 'host';
}

function hashText(value, length = 12) {
    return crypto
        .createHash('sha1')
        .update(String(value || ''))
        .digest('hex')
        .slice(0, length);
}

function turnSegment(value) {
    return cleanText(value)
        .replace(/[^A-Za-z0-9._:-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 96) || 'unknown';
}

function buildTurnIdIntent(entries = [], options = {}) {
    const list = Array.isArray(entries) ? entries : [entries];
    const participantEntries = list
        .filter((entry) => entry && isParticipantEntry(entry) && getEntryText(entry));
    const target = participantEntries[participantEntries.length - 1];
    if (!target) {
        return null;
    }

    const text = getEntryText(target);
    const speakerId = getEntrySpeakerId(target);
    const speaker = cleanText(target.speaker || speakerId);
    const timestamp = getEntryTimestamp(target);
    const timestampSegment = timestamp || `entry-${participantEntries.length}`;
    const textHash = hashText(`${speakerId}\n${text}`);
    const packetHash = hashText(participantEntries
        .map((entry) => [
            getEntrySpeakerId(entry),
            getEntryTimestamp(entry),
            getEntryText(entry)
        ].join('\t'))
        .join('\n'));
    const source = cleanText(options.source || options.kind || 'participant-turn');

    return {
        turnId: [
            'participant-turn',
            turnSegment(speakerId),
            turnSegment(timestampSegment),
            textHash
        ].join(':'),
        source,
        speaker,
        speakerId,
        timestamp,
        textHash,
        packetHash,
        textPreview: text.slice(0, 180)
    };
}

function normalizeTurnIdIntent(intent) {
    if (!intent) {
        return null;
    }

    if (typeof intent === 'string') {
        const turnId = cleanText(intent);
        return turnId ? { turnId } : null;
    }

    const turnId = cleanText(intent.turnId || intent.id || '');
    if (!turnId) {
        return null;
    }

    return {
        ...intent,
        turnId
    };
}

module.exports = {
    buildTurnIdIntent,
    normalizeTurnIdIntent
};
