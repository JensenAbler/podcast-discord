const fs = require('fs');
const path = require('path');
const { ShowRunnerGenerator } = require('./showrunner-generator');

class ShowRunnerManager {
    constructor(options = {}) {
        this.enabled = options.enabled !== undefined
            ? Boolean(options.enabled)
            : process.env.PODCAST_SHOW_RUNNER_ENABLED === 'true';
        this.outputFilename = options.outputFilename || 'showrunner-state.jsonl';
        this.generator = options.generator || new ShowRunnerGenerator(options.generatorOptions || {});
        this.updateIntervalParticipantTurns = this.parsePositiveInt(
            options.updateIntervalParticipantTurns ?? process.env.PODCAST_SHOW_RUNNER_INTERVAL_TURNS,
            2
        );
        this.maxTranscriptChars = this.parsePositiveInt(
            options.maxTranscriptChars ?? process.env.PODCAST_SHOW_RUNNER_TRANSCRIPT_MAX_CHARS,
            12000
        );
        this.maxDurationMinutes = this.parsePositiveInt(
            options.maxDurationMinutes ?? process.env.PODCAST_SHOW_RUNNER_MAX_MINUTES,
            0
        );
        this.topicBrief = options.topicBrief || process.env.PODCAST_SHOW_RUNNER_TOPIC_BRIEF || this.readOptionalFile(process.env.PODCAST_SHOW_RUNNER_BRIEF_PATH);
        this.questionBank = options.questionBank || this.readOptionalFile(process.env.PODCAST_SHOW_RUNNER_QUESTION_BANK_PATH);
        this.now = options.now || (() => new Date().toISOString());
        this.sessions = new Map();
    }

    startSession(guildId, options = {}) {
        if (!guildId) {
            throw new Error('ShowRunnerManager.startSession requires guildId');
        }

        const recordingPath = options.recordingPath || null;
        const outputPath = options.outputPath || (recordingPath ? path.join(recordingPath, this.outputFilename) : null);
        if (outputPath) {
            fs.mkdirSync(path.dirname(outputPath), { recursive: true });
            fs.writeFileSync(outputPath, '');
        }

        const startedAt = options.startedAt || this.now();
        const session = {
            guildId,
            recordingPath,
            outputPath,
            topic: options.topic || 'general discussion',
            topicBrief: options.topicBrief || this.topicBrief || '',
            questionBank: options.questionBank || this.questionBank || '',
            maxDurationMinutes: this.parsePositiveInt(options.maxDurationMinutes, this.maxDurationMinutes),
            startedAt,
            participantTurnCount: 0,
            hostTurnCount: 0,
            turnsSinceUpdate: 0,
            updateSeq: 0,
            entries: [],
            latestGuidance: null,
            processing: Promise.resolve()
        };

        this.sessions.set(guildId, session);
        console.log(`[ShowRunnerManager] Session started for guild ${guildId}${outputPath ? `, output=${outputPath}` : ''}`);
        return session;
    }

    async endSession(guildId) {
        const session = this.sessions.get(guildId);
        if (!session) {
            return null;
        }

        await session.processing;
        this.sessions.delete(guildId);
        console.log(`[ShowRunnerManager] Session ended for guild ${guildId}`);
        return {
            outputPath: session.outputPath,
            updateCount: session.updateSeq,
            latestGuidance: session.latestGuidance ? { ...session.latestGuidance } : null
        };
    }

    handleTranscriptEntry(guildId, entry = {}) {
        if (!this.enabled) {
            return Promise.resolve(null);
        }

        const session = this.sessions.get(guildId);
        if (!session) {
            return Promise.resolve(null);
        }

        const normalized = this.normalizeTranscriptEntry(entry);
        if (!normalized) {
            return Promise.resolve(null);
        }

        session.entries.push(normalized);
        if (normalized.speakerRole === 'host') {
            session.hostTurnCount += 1;
        } else {
            session.participantTurnCount += 1;
            session.turnsSinceUpdate += 1;
        }

        if (!this.shouldUpdate(session, normalized)) {
            return Promise.resolve(null);
        }

        return this.enqueueUpdate(session, `transcript-${normalized.speakerRole || 'participant'}`);
    }

    forceUpdate(guildId, reason = 'manual') {
        if (!this.enabled) {
            return Promise.resolve(null);
        }
        const session = this.sessions.get(guildId);
        if (!session || session.entries.length === 0) {
            return Promise.resolve(null);
        }
        return this.enqueueUpdate(session, reason);
    }

    getGuidance(guildId) {
        const session = this.sessions.get(guildId);
        if (!this.enabled || !session) {
            return null;
        }

        const latest = session.latestGuidance ? { ...session.latestGuidance } : null;
        if (this.isOverTimeLimit(session) && !latest?.wrapNow) {
            return {
                ...(latest || {}),
                phase: latest?.phase || 'wrap-up',
                currentLane: latest?.currentLane || 'closing',
                wrapNow: true,
                wrapReason: 'The configured episode time limit has been reached.',
                nextHostMove: 'wrap',
                suggestedQuestion: '',
                avoid: [
                    ...this.cloneArray(latest?.avoid),
                    'Do not open a new topic or ask a broad follow-up.'
                ],
                generatorInstruction: 'Wrap the episode now. Briefly synthesize what has been covered, thank the guest, and do not open a new topic.'
            };
        }

        return latest;
    }

    shouldUpdate(session, entry) {
        if (!entry || entry.speakerRole === 'host') {
            return false;
        }
        if (!session.latestGuidance) {
            return true;
        }
        if (this.isOverTimeLimit(session) && !session.latestGuidance.wrapNow) {
            return true;
        }
        return session.turnsSinceUpdate >= this.updateIntervalParticipantTurns;
    }

    enqueueUpdate(session, reason = 'transcript') {
        if (!session || session.entries.length === 0) {
            return Promise.resolve(null);
        }

        const input = this.buildGeneratorInput(session, reason);
        const work = session.processing.then(() => this.processUpdate(session, input));
        session.processing = work.catch(() => {});
        return work;
    }

    async processUpdate(session, input) {
        const baseRecord = {
            type: 'showrunner_guidance',
            guildId: session.guildId,
            updateSeq: session.updateSeq + 1,
            reason: input.reason,
            createdAt: this.now()
        };

        try {
            const guidance = await this.generator.generate(input);
            session.updateSeq += 1;
            session.turnsSinceUpdate = 0;
            session.latestGuidance = {
                ...guidance,
                id: `showrunner-${session.updateSeq}`,
                updatedAt: baseRecord.createdAt
            };

            const record = {
                ...baseRecord,
                updateSeq: session.updateSeq,
                guidance: session.latestGuidance
            };
            this.appendRecord(session, record);
            console.log(`[ShowRunnerManager] Updated ${record.guidance.id}; phase=${record.guidance.phase}, wrap=${record.guidance.wrapNow}`);
            return record;
        } catch (error) {
            const record = {
                ...baseRecord,
                type: 'showrunner_error',
                error: error.message
            };
            this.appendRecord(session, record);
            console.warn(`[ShowRunnerManager] Failed update for guild ${session.guildId}: ${error.message}`);
            return record;
        }
    }

    buildGeneratorInput(session, reason) {
        return {
            reason,
            topic: session.topic,
            topicBrief: session.topicBrief,
            questionBank: session.questionBank,
            transcript: this.formatTranscriptTail(session),
            previousGuidance: session.latestGuidance,
            elapsedMinutes: this.elapsedMinutes(session),
            maxDurationMinutes: session.maxDurationMinutes,
            participantTurnCount: session.participantTurnCount,
            hostTurnCount: session.hostTurnCount,
            generatedAt: this.now()
        };
    }

    formatTranscriptTail(session) {
        const transcript = this.formatTranscript(session.entries);
        if (transcript.length <= this.maxTranscriptChars) {
            return transcript;
        }
        return `[older transcript omitted]\n${transcript.slice(-this.maxTranscriptChars).trim()}`;
    }

    formatTranscript(entries = []) {
        return entries
            .map((entry) => `${entry.speaker}: ${entry.text}`)
            .join('\n');
    }

    appendRecord(session, record) {
        if (!session.outputPath) {
            return;
        }
        fs.appendFileSync(session.outputPath, `${JSON.stringify(record)}\n`);
    }

    normalizeTranscriptEntry(entry = {}) {
        const text = String(entry.transcription || entry.text || '').replace(/\s+/g, ' ').trim();
        if (!text) {
            return null;
        }

        const speaker = String(entry.speaker || 'Unknown').replace(/\s+/g, ' ').trim() || 'Unknown';
        const role = String(entry.speakerRole || entry.role || '').toLowerCase() === 'host'
            ? 'host'
            : 'participant';
        return {
            speaker,
            speakerRole: role,
            text,
            source: entry.source || null,
            timestamp: entry.timestamp || entry.generatedAt || this.now()
        };
    }

    elapsedMinutes(session) {
        const start = Date.parse(session.startedAt);
        const now = Date.parse(this.now());
        if (Number.isNaN(start) || Number.isNaN(now)) {
            return 0;
        }
        return Math.max(0, (now - start) / 60000);
    }

    isOverTimeLimit(session) {
        const limit = Number(session.maxDurationMinutes);
        return Number.isFinite(limit) && limit > 0 && this.elapsedMinutes(session) >= limit;
    }

    cloneArray(value) {
        return (Array.isArray(value) ? value : []).filter(Boolean);
    }

    readOptionalFile(filePath) {
        const resolved = String(filePath || '').trim();
        if (!resolved) {
            return '';
        }
        try {
            return fs.readFileSync(resolved, 'utf8').trim();
        } catch (error) {
            console.warn(`[ShowRunnerManager] Could not read configured file ${resolved}: ${error.message}`);
            return '';
        }
    }

    parsePositiveInt(value, fallback = 0) {
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed < 0) {
            return fallback;
        }
        return Math.round(parsed);
    }
}

module.exports = { ShowRunnerManager };
