const fs = require('fs');
const path = require('path');
const { InternalThoughtGenerator } = require('./internal-thought-generator');
const { DiscernmentGenerator } = require('./discernment-generator');
const { PacketizationBuffer } = require('./packetization-buffer');
const { buildTurnIdIntent, normalizeTurnIdIntent } = require('./turn-intent');

class InternalThoughtManager {
    constructor(options = {}) {
        this.enabled = options.enabled !== undefined
            ? Boolean(options.enabled)
            : process.env.PODCAST_INTERNAL_THOUGHTS_ENABLED !== 'false';
        this.packetTurnCount = this.parsePositiveInt(
            options.packetTurnCount ?? process.env.PODCAST_INTERNAL_THOUGHT_PACKET_TURNS,
            6
        );
        const explicitPacketMode = options.packetMode ?? process.env.PODCAST_INTERNAL_THOUGHT_PACKET_MODE;
        const legacyCountOverride = options.packetTurnCount !== undefined ||
            Boolean(process.env.PODCAST_INTERNAL_THOUGHT_PACKET_TURNS);
        this.packetMode = this.normalizePacketMode(
            explicitPacketMode ?? (legacyCountOverride ? 'count' : 'packetization-buffer')
        );
        this.packetizationOptions = {
            graceMs: options.packetGraceMs ?? options.packetizationOptions?.graceMs,
            maxAgeMs: options.packetMaxAgeMs ?? options.packetizationOptions?.maxAgeMs,
            maxEntries: options.packetMaxEntries ?? options.packetizationOptions?.maxEntries,
            maxChars: options.packetMaxChars ?? options.packetizationOptions?.maxChars,
            minAlternations: options.packetMinAlternations ?? options.packetizationOptions?.minAlternations,
            lowTokenMinAlternations: options.packetLowTokenMinAlternations ?? options.packetizationOptions?.lowTokenMinAlternations,
            speakerTokenThreshold: options.packetSpeakerTokenThreshold ?? options.packetizationOptions?.speakerTokenThreshold,
            pendingAsrTimeout: options.packetPendingAsrTimeout ?? options.packetizationOptions?.pendingAsrTimeout
        };
        this.maxRecentThoughts = this.parsePositiveInt(
            options.maxRecentThoughts ?? process.env.PODCAST_INTERNAL_THOUGHT_RECENT_COUNT,
            5
        );
        this.maxActiveAwarenessInjections = this.parsePositiveInt(
            options.maxActiveAwarenessInjections ?? process.env.PODCAST_AWARENESS_MAX_ACTIVE,
            3
        );
        this.outputFilename = options.outputFilename || 'internal-thoughts.jsonl';
        this.thoughtGenerator = options.thoughtGenerator || new InternalThoughtGenerator(options.thoughtGeneratorOptions || {});
        this.discernmentGenerator = options.discernmentGenerator || new DiscernmentGenerator(options.discernmentGeneratorOptions || {});
        this.now = options.now || (() => new Date().toISOString());
        this.sessions = new Map();
    }

    startSession(guildId, options = {}) {
        if (!guildId) {
            throw new Error('InternalThoughtManager.startSession requires guildId');
        }

        const recordingPath = options.recordingPath || null;
        const outputPath = options.outputPath || (recordingPath ? path.join(recordingPath, this.outputFilename) : null);
        if (outputPath) {
            fs.mkdirSync(path.dirname(outputPath), { recursive: true });
            fs.writeFileSync(outputPath, '');
        }

        const session = {
            guildId,
            recordingPath,
            outputPath,
            startedAt: options.startedAt || this.now(),
            packetSeq: 0,
            packetBuffer: [],
            packetizationBuffer: null,
            transcriptEntries: [],
            thoughts: [],
            activeAwarenessInjections: [],
            pendingAwarenessTurnIds: new Set(),
            closedAwarenessTurnIds: new Map(),
            processing: Promise.resolve()
        };

        if (this.packetMode === 'packetization-buffer') {
            session.packetizationBuffer = new PacketizationBuffer(this.packetizationOptions);
            session.packetizationBuffer.onFlush((entries, meta = {}) => {
                return this.enqueuePacketProcessing(session, entries, meta.reason || 'packetization-buffer');
            });
        }

        this.sessions.set(guildId, session);
        console.log(`[InternalThoughtManager] Session started for guild ${guildId}${outputPath ? `, output=${outputPath}` : ''}`);
        return session;
    }

    async endSession(guildId, options = {}) {
        const session = this.sessions.get(guildId);
        if (!session) {
            return null;
        }

        if (options.flush !== false) {
            await this.flushPacket(guildId, 'session-end');
        }
        await session.processing;
        this.sessions.delete(guildId);
        console.log(`[InternalThoughtManager] Session ended for guild ${guildId}`);
        return {
            outputPath: session.outputPath,
            thoughtCount: session.thoughts.length,
            activeAwarenessInjectionCount: session.activeAwarenessInjections.length
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

        session.transcriptEntries.push(normalized);
        this.advanceAwarenessExpirations(session, normalized);

        if (this.packetMode === 'packetization-buffer' && session.packetizationBuffer) {
            const result = session.packetizationBuffer.addEntry(normalized);
            return result || Promise.resolve(null);
        }

        session.packetBuffer.push(normalized);

        if (session.packetBuffer.length >= this.packetTurnCount) {
            return this.flushPacket(guildId, 'turn-count');
        }

        return Promise.resolve(null);
    }

    async flushPacket(guildId, reason = 'manual') {
        const session = this.sessions.get(guildId);
        if (!this.enabled || !session) {
            return null;
        }

        if (this.packetMode === 'packetization-buffer' && session.packetizationBuffer) {
            return session.packetizationBuffer.forceFlush(reason);
        }

        if (session.packetBuffer.length === 0) {
            return null;
        }

        const entries = session.packetBuffer.splice(0, session.packetBuffer.length);
        return this.enqueuePacketProcessing(session, entries, reason);
    }

    enqueuePacketProcessing(session, entries, reason = 'manual') {
        if (!session || !Array.isArray(entries) || entries.length === 0) {
            return null;
        }

        const packet = this.buildPacket(session, entries, reason);
        this.trackPendingAwarenessTurn(session, packet.turnIdIntent);
        const work = session.processing
            .then(() => this.processPacket(session, packet))
            .finally(() => this.untrackPendingAwarenessTurn(session, packet.turnIdIntent));
        session.processing = work.catch(() => {});
        return work;
    }

    setUserSpeaking(guildId, userId, speaking) {
        const session = this.sessions.get(guildId);
        return session?.packetizationBuffer?.setUserSpeaking(userId, speaking) || null;
    }

    markEndpointing(guildId, userId, active) {
        const session = this.sessions.get(guildId);
        return session?.packetizationBuffer?.markEndpointing(userId, active) || null;
    }

    markAsrPending(guildId, userId, metadata = {}) {
        const session = this.sessions.get(guildId);
        return session?.packetizationBuffer?.markAsrPending(userId, metadata) || null;
    }

    buildPacket(session, entries, reason) {
        session.packetSeq += 1;
        const packetId = `internal-packet-${session.packetSeq}`;
        return {
            packetId,
            reason,
            createdAt: this.now(),
            entries,
            turnIdIntent: buildTurnIdIntent(entries, { source: 'internal-packet' }),
            transcript: this.formatTranscript(entries),
            completeTranscript: this.formatTranscript(session.transcriptEntries)
        };
    }

    async processPacket(session, packet) {
        const baseRecord = {
            type: 'internal_thought',
            guildId: session.guildId,
            packetId: packet.packetId,
            packetReason: packet.reason,
            createdAt: packet.createdAt,
            processedAt: this.now(),
            transcript: packet.transcript,
            turnIdIntent: packet.turnIdIntent,
            entries: packet.entries
        };
        const record = {
            ...baseRecord,
            thought: null,
            awarenessCandidate: null,
            discernment: null,
            awarenessInjection: null,
            droppedAwarenessInjection: null
        };
        let errorStage = 'internal_thought';

        try {
            const thought = await this.thoughtGenerator.generate({
                packetId: packet.packetId,
                transcript: packet.transcript,
                utterances: packet.entries
            });
            record.thought = thought;

            session.thoughts.push({
                packetId: packet.packetId,
                internalThought: thought.internalThought,
                createdAt: record.processedAt
            });

            const recentInternalThoughts = session.thoughts.slice(-this.maxRecentThoughts);
            errorStage = 'awareness_candidate';
            const awarenessCandidate = await this.generateAwarenessCandidate({
                recentInternalThoughts,
                completeTranscript: packet.completeTranscript,
                packetId: packet.packetId,
                targetTurnIdIntent: packet.turnIdIntent
            });
            record.awarenessCandidate = awarenessCandidate;

            if (awarenessCandidate.candidateAwarenessNote) {
                errorStage = 'discernment_judgment';
                const discernment = await this.judgeAwarenessCandidate({
                    candidateAwarenessNote: awarenessCandidate.candidateAwarenessNote,
                    candidateReason: awarenessCandidate.reason,
                    recentInternalThoughts,
                    completeTranscript: packet.completeTranscript,
                    targetTurnIdIntent: packet.turnIdIntent,
                    activeAwarenessInjections: session.activeAwarenessInjections
                });
                record.discernment = discernment;
                if (discernment.injectIntoPodcastGenerator) {
                    const activated = this.activateAwarenessInjection(session, packet, discernment);
                    if (activated?.droppedReason) {
                        record.droppedAwarenessInjection = activated;
                    } else {
                        record.awarenessInjection = activated;
                    }
                }
            }

            this.appendRecord(session, record);
            console.log(`[InternalThoughtManager] Processed ${packet.packetId}; injection=${Boolean(record.awarenessInjection)}`);
            return record;
        } catch (error) {
            const errorRecord = {
                ...record,
                type: 'internal_thought_error',
                errorStage,
                error: error.message
            };
            this.appendRecord(session, errorRecord);
            console.warn(`[InternalThoughtManager] Failed ${packet.packetId}: ${error.message}`);
            return errorRecord;
        }
    }

    async generateAwarenessCandidate(input) {
        if (typeof this.discernmentGenerator.generateCandidate === 'function') {
            return this.discernmentGenerator.generateCandidate(input);
        }
        return this.discernmentGenerator.generate({ ...input, mode: 'candidate' });
    }

    async judgeAwarenessCandidate(input) {
        if (typeof this.discernmentGenerator.judgeCandidate === 'function') {
            return this.discernmentGenerator.judgeCandidate(input);
        }
        return this.discernmentGenerator.generate({ ...input, mode: 'judgment' });
    }

    activateAwarenessInjection(session, packet, discernment) {
        const turnIdIntent = normalizeTurnIdIntent(packet.turnIdIntent);
        const injection = {
            id: `awareness-${packet.packetId}`,
            packetId: packet.packetId,
            createdAt: this.now(),
            awarenessInjection: discernment.awarenessInjection,
            reason: discernment.reason,
            turnIdIntent
        };

        if (!turnIdIntent?.turnId) {
            return {
                ...injection,
                droppedReason: 'missing_turn_id_intent'
            };
        }

        if (this.isAwarenessTurnClosed(session, turnIdIntent)) {
            return {
                ...injection,
                droppedReason: 'turn_already_closed'
            };
        }

        session.activeAwarenessInjections.push(injection);
        session.activeAwarenessInjections = session.activeAwarenessInjections.slice(-this.maxActiveAwarenessInjections);
        return injection;
    }

    claimAwarenessInjectionsForTurn(guildId, turnIdIntent) {
        const session = this.sessions.get(guildId);
        const normalizedTurn = normalizeTurnIdIntent(turnIdIntent);
        if (!session || !normalizedTurn?.turnId) {
            return [];
        }

        const claimed = [];
        const retained = [];
        for (const item of session.activeAwarenessInjections) {
            const itemTurn = normalizeTurnIdIntent(item.turnIdIntent);
            if (itemTurn?.turnId === normalizedTurn.turnId) {
                claimed.push({ ...item });
                continue;
            }

            if (!itemTurn?.turnId) {
                retained.push(item);
            }
        }

        session.activeAwarenessInjections = retained;
        if (claimed.length > 0) {
            this.markAwarenessTurnClosed(session, normalizedTurn);
        }
        return claimed;
    }

    async waitForAwarenessInjectionsForTurn(guildId, turnIdIntent, options = {}) {
        const session = this.sessions.get(guildId);
        const normalizedTurn = normalizeTurnIdIntent(turnIdIntent);
        if (!session || !normalizedTurn?.turnId) {
            return [];
        }

        const immediate = this.claimAwarenessInjectionsForTurn(guildId, normalizedTurn);
        if (immediate.length > 0) {
            return immediate;
        }

        const timeoutMs = Math.max(0, Number(options.timeoutMs ?? 200));
        if (!this.hasPendingAwarenessForTurn(session, normalizedTurn) || timeoutMs <= 0) {
            this.markAwarenessTurnClosed(session, normalizedTurn);
            return [];
        }

        console.log(`[InternalThoughtManager] Waiting up to ${timeoutMs}ms for awareness turn ${normalizedTurn.turnId}`);
        await Promise.race([
            session.processing.catch(() => {}),
            new Promise((resolve) => setTimeout(resolve, timeoutMs))
        ]);

        const claimed = this.claimAwarenessInjectionsForTurn(guildId, normalizedTurn);
        if (claimed.length === 0) {
            this.markAwarenessTurnClosed(session, normalizedTurn);
        }
        return claimed;
    }

    hasPendingAwarenessForTurn(session, turnIdIntent) {
        const normalizedTurn = normalizeTurnIdIntent(turnIdIntent);
        return Boolean(session?.pendingAwarenessTurnIds?.has(normalizedTurn?.turnId));
    }

    trackPendingAwarenessTurn(session, turnIdIntent) {
        const normalizedTurn = normalizeTurnIdIntent(turnIdIntent);
        if (session?.pendingAwarenessTurnIds && normalizedTurn?.turnId) {
            session.pendingAwarenessTurnIds.add(normalizedTurn.turnId);
        }
    }

    untrackPendingAwarenessTurn(session, turnIdIntent) {
        const normalizedTurn = normalizeTurnIdIntent(turnIdIntent);
        if (session?.pendingAwarenessTurnIds && normalizedTurn?.turnId) {
            session.pendingAwarenessTurnIds.delete(normalizedTurn.turnId);
        }
    }

    markAwarenessTurnClosed(session, turnIdIntent) {
        const normalizedTurn = normalizeTurnIdIntent(turnIdIntent);
        if (!session?.closedAwarenessTurnIds || !normalizedTurn?.turnId) {
            return;
        }

        session.closedAwarenessTurnIds.set(normalizedTurn.turnId, Date.now());
        const maxClosedTurns = 100;
        while (session.closedAwarenessTurnIds.size > maxClosedTurns) {
            const oldestKey = session.closedAwarenessTurnIds.keys().next().value;
            session.closedAwarenessTurnIds.delete(oldestKey);
        }
    }

    isAwarenessTurnClosed(session, turnIdIntent) {
        const normalizedTurn = normalizeTurnIdIntent(turnIdIntent);
        return Boolean(session?.closedAwarenessTurnIds?.has(normalizedTurn?.turnId));
    }

    advanceAwarenessExpirations(session, entry) {
        if (entry.speakerRole === 'host' || session.activeAwarenessInjections.length === 0) {
            return;
        }

        const entryTurn = buildTurnIdIntent([entry], { source: 'participant-entry' });
        session.activeAwarenessInjections = session.activeAwarenessInjections
            .filter((item) => !this.isAwarenessInvalidatedByEntry(item, entry))
            .filter((item) => {
                const itemTurn = normalizeTurnIdIntent(item.turnIdIntent);
                return itemTurn?.turnId && itemTurn.turnId === entryTurn?.turnId;
            });
    }

    isAwarenessInvalidatedByEntry(item = {}, entry = {}) {
        const text = String(entry.text || '').toLowerCase();
        const awareness = [
            item.awarenessInjection,
            item.reason
        ].filter(Boolean).join(' ').toLowerCase();
        if (!text || !awareness) {
            return false;
        }

        const topicPivot = /\b(?:not quite done|not done|we'?re not done|before i tell you|speaking of which|like i was saying|the reason i started|i started this podcast|new capabilities|new capability|i want to (?:check|test|try)|very specific question)\b/i.test(text);
        const closingAwareness = /\b(?:wrap[-\s]?up|winding down|good night|rest|sleep|bed|sign off|catch you|farewell|close the|closing)\b/i.test(awareness);
        if (topicPivot && closingAwareness) {
            return true;
        }

        const imminentQuestion = /\b(?:i'?m going to ask|i am going to ask|i will ask|i'?ll ask)\b.*\b(?:specific )?question\b/i.test(text);
        const solicitsQuestionObject = /\b(?:ask|prompt|invite)\b.*\b(?:which|what)\b.*\b(?:capability|feature|question|aspect)\b/i.test(awareness) ||
            /\bwhich\b.*\b(?:capability|feature|question|aspect)\b/i.test(awareness);
        return imminentQuestion && solicitsQuestionObject;
    }

    getActiveAwarenessInjections(guildId) {
        const session = this.sessions.get(guildId);
        if (!session) {
            return [];
        }

        return session.activeAwarenessInjections.map((item) => ({ ...item }));
    }

    getRecentInternalThoughts(guildId, limit = 7) {
        const session = this.sessions.get(guildId);
        if (!session) {
            return [];
        }

        const count = this.parsePositiveInt(limit, 7);
        return session.thoughts
            .slice(-count)
            .map((item) => ({ ...item }));
    }

    appendRecord(session, record) {
        if (!session.outputPath) {
            return;
        }

        fs.appendFileSync(session.outputPath, `${JSON.stringify(record)}\n`);
    }

    normalizeTranscriptEntry(entry = {}) {
        const text = String(entry.text || entry.transcription || '').trim();
        if (!text) {
            return null;
        }

        return {
            speaker: entry.speaker || 'Unknown',
            speakerRole: entry.speakerRole || 'guest',
            userId: entry.userId || entry.speakerId || null,
            speakerId: entry.speakerId || entry.userId || null,
            text,
            timestamp: entry.timestamp || entry.generatedAt || entry.speechStartedAt || this.now(),
            speechStartedAt: entry.speechStartedAt || null,
            speechEndedAt: entry.speechEndedAt || null,
            asrCompletedAt: entry.asrCompletedAt || null,
            generatedAt: entry.generatedAt || null,
            playbackStartedAt: entry.playbackStartedAt || null,
            playbackEndedAt: entry.playbackEndedAt || null,
            source: entry.source || null
        };
    }

    formatTranscript(entries = []) {
        return entries
            .map((entry) => `${entry.speaker || 'Unknown'}: ${entry.text || ''}`.trim())
            .filter(Boolean)
            .join('\n');
    }

    parsePositiveInt(value, fallback) {
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed <= 0) {
            return fallback;
        }
        return Math.floor(parsed);
    }

    normalizePacketMode(value) {
        const normalized = String(value || '')
            .trim()
            .toLowerCase()
            .replace(/_/g, '-');
        if (['count', 'turn-count', 'legacy-count'].includes(normalized)) {
            return 'count';
        }
        return 'packetization-buffer';
    }
}

module.exports = { InternalThoughtManager };
