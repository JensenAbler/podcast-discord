const DEFAULT_USER_ID = '__default_user__';
const DEFAULT_PACKET_GRACE_MS = 2500;
const DEFAULT_MAX_AGE_MS = 45000;
const DEFAULT_MAX_ENTRIES = 12;
const DEFAULT_MAX_CHARS = 2500;
const DEFAULT_MIN_ALTERNATIONS = 0;
const DEFAULT_LOW_TOKEN_MIN_ALTERNATIONS = 4;
const DEFAULT_SPEAKER_TOKEN_THRESHOLD = 40;
const DEFAULT_PENDING_ASR_TIMEOUT = 8000;

function parseFiniteEnv(raw) {
    if (raw == null || raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
}

function positiveNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(value, fallback) {
    if (value === undefined || value === null || value === '') {
        return fallback;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

class PacketizationBuffer {
    constructor(config = {}) {
        this.config = {
            graceMs: positiveNumber(
                config.graceMs ?? parseFiniteEnv(process.env.PODCAST_PACKETIZATION_GRACE_MS),
                DEFAULT_PACKET_GRACE_MS
            ),
            maxAgeMs: positiveNumber(
                config.maxAgeMs ?? parseFiniteEnv(process.env.PODCAST_PACKETIZATION_MAX_AGE_MS),
                DEFAULT_MAX_AGE_MS
            ),
            maxEntries: positiveNumber(
                config.maxEntries ?? parseFiniteEnv(process.env.PODCAST_PACKETIZATION_MAX_ENTRIES),
                DEFAULT_MAX_ENTRIES
            ),
            maxChars: positiveNumber(
                config.maxChars ?? parseFiniteEnv(process.env.PODCAST_PACKETIZATION_MAX_CHARS),
                DEFAULT_MAX_CHARS
            ),
            minAlternations: nonNegativeInteger(
                config.minAlternations ?? parseFiniteEnv(process.env.PODCAST_PACKETIZATION_MIN_ALTERNATIONS),
                DEFAULT_MIN_ALTERNATIONS
            ),
            lowTokenMinAlternations: nonNegativeInteger(
                config.lowTokenMinAlternations ?? parseFiniteEnv(process.env.PODCAST_PACKETIZATION_LOW_TOKEN_MIN_ALTERNATIONS),
                DEFAULT_LOW_TOKEN_MIN_ALTERNATIONS
            ),
            speakerTokenThreshold: positiveNumber(
                config.speakerTokenThreshold ?? parseFiniteEnv(process.env.PODCAST_PACKETIZATION_SPEAKER_TOKEN_THRESHOLD),
                DEFAULT_SPEAKER_TOKEN_THRESHOLD
            ),
            pendingAsrTimeout: positiveNumber(
                config.pendingAsrTimeout ?? parseFiniteEnv(process.env.PODCAST_PACKETIZATION_PENDING_ASR_TIMEOUT_MS),
                DEFAULT_PENDING_ASR_TIMEOUT
            )
        };

        this.buffer = [];
        this.flushCallback = null;
        this.activeSpeakers = new Set();
        this.endpointingSpeakers = new Set();
        this.pendingASR = new Set();
        this.pendingAsrCounts = new Map();
        this.pendingAsrTimers = new Map();
        this.graceTimer = null;
        this.maxAgeTimer = null;
        this.maxAgeExpired = false;
        this.nextInsertionOrder = 0;
    }

    onFlush(callback) {
        this.flushCallback = callback;
    }

    addEntry(entry = {}) {
        this.markAsrComplete(entry.userId || entry.speakerId);
        const normalized = {
            ...entry,
            insertionOrder: this.nextInsertionOrder++
        };

        this.buffer.push(normalized);
        this.armMaxAgeTimer();
        return this.evaluate('entry added');
    }

    setUserSpeaking(userIdOrSpeaking, speaking) {
        const legacySignature = typeof speaking === 'undefined';
        const userId = legacySignature
            ? DEFAULT_USER_ID
            : (this.normalizeUserId(userIdOrSpeaking) || DEFAULT_USER_ID);
        const isSpeaking = legacySignature ? Boolean(userIdOrSpeaking) : Boolean(speaking);

        if (isSpeaking) {
            this.activeSpeakers.add(userId);
            this.clearGraceTimer();
        } else {
            this.activeSpeakers.delete(userId);
        }

        return this.evaluate(isSpeaking ? 'speaker started' : 'speaker stopped');
    }

    markEndpointing(userId, isEndpointing) {
        const normalizedUserId = this.normalizeUserId(userId);
        if (!normalizedUserId) return null;

        if (isEndpointing) {
            this.endpointingSpeakers.add(normalizedUserId);
            this.clearGraceTimer();
        } else {
            this.endpointingSpeakers.delete(normalizedUserId);
        }

        return this.evaluate(isEndpointing ? 'endpointing started' : 'endpointing ended');
    }

    markAsrPending(userId) {
        const normalizedUserId = this.normalizeUserId(userId);
        if (!normalizedUserId) return null;

        const nextCount = (this.pendingAsrCounts.get(normalizedUserId) || 0) + 1;
        this.pendingAsrCounts.set(normalizedUserId, nextCount);
        this.pendingASR.add(normalizedUserId);
        this.clearGraceTimer();
        this.armPendingAsrTimer(normalizedUserId);
        return this.evaluate('ASR pending');
    }

    markAsrComplete(userId) {
        const normalizedUserId = this.normalizeUserId(userId);

        if (normalizedUserId && this.pendingASR.has(normalizedUserId)) {
            const nextCount = Math.max(0, (this.pendingAsrCounts.get(normalizedUserId) || 1) - 1);
            if (nextCount > 0) {
                this.pendingAsrCounts.set(normalizedUserId, nextCount);
                this.armPendingAsrTimer(normalizedUserId);
                return;
            }

            this.pendingASR.delete(normalizedUserId);
            this.pendingAsrCounts.delete(normalizedUserId);
            this.clearPendingAsrTimer(normalizedUserId);
            return;
        }

        if (!normalizedUserId && this.pendingASR.size === 1) {
            const [pendingUserId] = Array.from(this.pendingASR);
            this.pendingASR.delete(pendingUserId);
            this.pendingAsrCounts.delete(pendingUserId);
            this.clearPendingAsrTimer(pendingUserId);
        }
    }

    evaluate(reason = 'evaluate') {
        if (this.buffer.length === 0) {
            this.clearGraceTimer();
            this.clearMaxAgeTimer();
            this.maxAgeExpired = false;
            return null;
        }

        if (!this.isFloorSettled()) {
            this.clearGraceTimer();
            return null;
        }

        if (this.hasHardCap()) {
            return this.flush(`packet-hard-cap:${reason}`);
        }

        if (!this.hasMeaningfulSpeakerAlternation()) {
            this.clearGraceTimer();
            return null;
        }

        this.startGraceTimer();
        return null;
    }

    startGraceTimer() {
        if (this.graceTimer || this.buffer.length === 0) {
            return;
        }

        this.graceTimer = setTimeout(() => {
            this.graceTimer = null;
            if (!this.isFloorSettled()) {
                return;
            }
            if (this.hasMeaningfulSpeakerAlternation() || this.hasHardCap()) {
                this.flush('packet-grace');
            }
        }, this.config.graceMs);
    }

    armMaxAgeTimer() {
        if (this.maxAgeTimer || this.buffer.length === 0 || !this.config.maxAgeMs) {
            return;
        }

        this.maxAgeTimer = setTimeout(() => {
            this.maxAgeTimer = null;
            this.maxAgeExpired = true;
            this.evaluate('max age expired');
        }, this.config.maxAgeMs);
    }

    armPendingAsrTimer(userId) {
        const timeoutMs = this.config.pendingAsrTimeout;
        if (!timeoutMs || timeoutMs <= 0) {
            return;
        }

        this.clearPendingAsrTimer(userId);
        const timer = setTimeout(() => {
            this.pendingAsrTimers.delete(userId);
            if (this.pendingASR.delete(userId)) {
                this.pendingAsrCounts.delete(userId);
                this.evaluate('pending ASR timeout');
            }
        }, timeoutMs);
        this.pendingAsrTimers.set(userId, timer);
    }

    hasHardCap() {
        return this.maxAgeExpired ||
            this.buffer.length >= this.config.maxEntries ||
            this.getBufferedCharCount() >= this.config.maxChars;
    }

    hasMeaningfulSpeakerAlternation() {
        return this.getSpeakerAlternationCount() >= this.getRequiredAlternationCount();
    }

    getRequiredAlternationCount() {
        if (this.hasContentfulParticipantRun()) {
            return this.config.minAlternations;
        }

        return Math.max(this.config.minAlternations, this.config.lowTokenMinAlternations);
    }

    getSpeakerAlternationCount() {
        const runs = this.getSpeakerRuns();
        return Math.max(0, runs.length - 1);
    }

    getSpeakerRuns() {
        const runs = [];
        for (const entry of this.getOrderedEntries()) {
            const speaker = this.getSpeakerKey(entry);
            if (!speaker) continue;
            if (runs[runs.length - 1] !== speaker) {
                runs.push(speaker);
            }
        }
        return runs;
    }

    hasContentfulParticipantRun() {
        return this.getSpeakerRunStats().some((run) => {
            return run.hasParticipant && run.tokenCount >= this.config.speakerTokenThreshold;
        });
    }

    getSpeakerRunStats() {
        const runs = [];
        for (const entry of this.getOrderedEntries()) {
            const speaker = this.getSpeakerKey(entry);
            if (!speaker) continue;

            const last = runs[runs.length - 1];
            const tokenCount = this.countEntryTokens(entry);
            if (last && last.speaker === speaker) {
                last.tokenCount += tokenCount;
                last.hasParticipant = last.hasParticipant || this.isParticipantEntry(entry);
            } else {
                runs.push({
                    speaker,
                    tokenCount,
                    hasParticipant: this.isParticipantEntry(entry)
                });
            }
        }
        return runs;
    }

    isParticipantEntry(entry = {}) {
        return entry.speakerRole !== 'host';
    }

    countEntryTokens(entry = {}) {
        const text = String(entry.text || entry.transcription || '').trim();
        if (!text) return 0;
        const matches = text.match(/[A-Za-z0-9]+(?:['.-][A-Za-z0-9]+)*/g);
        return matches ? matches.length : text.split(/\s+/).filter(Boolean).length;
    }

    getSpeakerKey(entry = {}) {
        return String(entry.speaker || entry.userId || entry.speakerId || 'Unknown').trim();
    }

    getBufferedCharCount() {
        return this.buffer.reduce((sum, entry) => {
            return sum + String(entry.text || entry.transcription || '').length;
        }, 0);
    }

    isFloorSettled() {
        return this.activeSpeakers.size === 0 &&
            this.endpointingSpeakers.size === 0 &&
            this.pendingASR.size === 0;
    }

    forceFlush(reason = 'manual') {
        if (this.buffer.length === 0) {
            return null;
        }

        return this.flush(reason);
    }

    flush(reason = 'packetization') {
        if (this.buffer.length === 0) {
            return null;
        }

        const entries = this.getOrderedEntries();
        this.buffer = [];
        this.maxAgeExpired = false;
        this.clearGraceTimer();
        this.clearMaxAgeTimer();

        if (this.flushCallback) {
            return this.flushCallback(entries, { reason });
        }

        return entries;
    }

    getOrderedEntries() {
        return [...this.buffer].sort((a, b) => {
            const aTime = this.getEntrySortTime(a);
            const bTime = this.getEntrySortTime(b);
            const timeDiff = aTime - bTime;
            if (Number.isFinite(timeDiff) && timeDiff !== 0) {
                return timeDiff;
            }
            return (a.insertionOrder ?? 0) - (b.insertionOrder ?? 0);
        });
    }

    getEntrySortTime(entry = {}) {
        for (const field of [entry.speechStartedAt, entry.timestamp, entry.generatedAt, entry.asrCompletedAt]) {
            const parsed = this.parseTimestamp(field);
            if (Number.isFinite(parsed)) {
                return parsed;
            }
        }
        return Number.MAX_SAFE_INTEGER;
    }

    clear() {
        this.buffer = [];
        this.activeSpeakers.clear();
        this.endpointingSpeakers.clear();
        this.pendingASR.clear();
        this.pendingAsrCounts.clear();
        this.maxAgeExpired = false;
        this.clearGraceTimer();
        this.clearMaxAgeTimer();
        this.clearPendingAsrTimers();
    }

    clearGraceTimer() {
        if (this.graceTimer) {
            clearTimeout(this.graceTimer);
            this.graceTimer = null;
        }
    }

    clearMaxAgeTimer() {
        if (this.maxAgeTimer) {
            clearTimeout(this.maxAgeTimer);
            this.maxAgeTimer = null;
        }
    }

    clearPendingAsrTimer(userId) {
        const timer = this.pendingAsrTimers.get(userId);
        if (timer) {
            clearTimeout(timer);
            this.pendingAsrTimers.delete(userId);
        }
    }

    clearPendingAsrTimers() {
        for (const timer of this.pendingAsrTimers.values()) {
            clearTimeout(timer);
        }
        this.pendingAsrTimers.clear();
    }

    normalizeUserId(userId) {
        if (userId === undefined || userId === null || userId === '') {
            return null;
        }
        return String(userId);
    }

    parseTimestamp(value) {
        if (typeof value === 'number' && Number.isFinite(value)) {
            return value;
        }
        if (value === undefined || value === null || value === '') {
            return null;
        }
        const parsed = Date.parse(value);
        return Number.isNaN(parsed) ? null : parsed;
    }
}

module.exports = { PacketizationBuffer };
