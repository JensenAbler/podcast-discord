const fs = require('fs');
const path = require('path');
const { InternalThoughtGenerator } = require('./internal-thought-generator');
const { DiscernmentGenerator } = require('./discernment-generator');

class InternalThoughtManager {
    constructor(options = {}) {
        this.enabled = options.enabled !== undefined
            ? Boolean(options.enabled)
            : process.env.PODCAST_INTERNAL_THOUGHTS_ENABLED !== 'false';
        this.packetTurnCount = this.parsePositiveInt(
            options.packetTurnCount ?? process.env.PODCAST_INTERNAL_THOUGHT_PACKET_TURNS,
            6
        );
        this.maxRecentThoughts = this.parsePositiveInt(
            options.maxRecentThoughts ?? process.env.PODCAST_INTERNAL_THOUGHT_RECENT_COUNT,
            4
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
            thoughts: [],
            activeAwarenessInjections: [],
            processing: Promise.resolve()
        };

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

        this.advanceAwarenessExpirations(session, normalized);
        session.packetBuffer.push(normalized);

        if (session.packetBuffer.length >= this.packetTurnCount) {
            return this.flushPacket(guildId, 'turn-count');
        }

        return Promise.resolve(null);
    }

    async flushPacket(guildId, reason = 'manual') {
        const session = this.sessions.get(guildId);
        if (!this.enabled || !session || session.packetBuffer.length === 0) {
            return null;
        }

        const entries = session.packetBuffer.splice(0, session.packetBuffer.length);
        const packet = this.buildPacket(session, entries, reason);
        const work = session.processing.then(() => this.processPacket(session, packet));
        session.processing = work.catch(() => {});
        return work;
    }

    buildPacket(session, entries, reason) {
        session.packetSeq += 1;
        const packetId = `internal-packet-${session.packetSeq}`;
        return {
            packetId,
            reason,
            createdAt: this.now(),
            entries,
            transcript: this.formatTranscript(entries)
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
            entries: packet.entries
        };

        try {
            const thought = await this.thoughtGenerator.generate({
                packetId: packet.packetId,
                transcript: packet.transcript,
                utterances: packet.entries,
                recentInternalThoughts: session.thoughts.slice(-this.maxRecentThoughts),
                activeAwarenessInjections: session.activeAwarenessInjections
            });

            const record = {
                ...baseRecord,
                thought,
                discernment: null,
                awarenessInjection: null
            };

            session.thoughts.push({
                packetId: packet.packetId,
                internalThought: thought.internalThought,
                hostAwareness: thought.hostAwareness,
                candidateAwarenessNote: thought.candidateAwarenessNote,
                createdAt: record.processedAt
            });

            if (thought.candidateAwarenessNote) {
                const discernment = await this.discernmentGenerator.generate({
                    candidateAwarenessNote: thought.candidateAwarenessNote,
                    internalThought: thought.internalThought,
                    transcript: packet.transcript,
                    activeAwarenessInjections: session.activeAwarenessInjections
                });
                record.discernment = discernment;
                if (discernment.injectIntoPodcastGenerator) {
                    record.awarenessInjection = this.activateAwarenessInjection(session, packet, discernment);
                }
            }

            this.appendRecord(session, record);
            console.log(`[InternalThoughtManager] Processed ${packet.packetId}; injection=${Boolean(record.awarenessInjection)}`);
            return record;
        } catch (error) {
            const errorRecord = {
                ...baseRecord,
                type: 'internal_thought_error',
                error: error.message
            };
            this.appendRecord(session, errorRecord);
            console.warn(`[InternalThoughtManager] Failed ${packet.packetId}: ${error.message}`);
            return errorRecord;
        }
    }

    activateAwarenessInjection(session, packet, discernment) {
        const injection = {
            id: `awareness-${packet.packetId}`,
            packetId: packet.packetId,
            createdAt: this.now(),
            awarenessInjection: discernment.awarenessInjection,
            reason: discernment.reason,
            expiresAfterTurns: discernment.expiresAfterTurns,
            remainingTurns: discernment.expiresAfterTurns
        };

        session.activeAwarenessInjections.push(injection);
        session.activeAwarenessInjections = session.activeAwarenessInjections.slice(-this.maxActiveAwarenessInjections);
        return injection;
    }

    advanceAwarenessExpirations(session, entry) {
        if (entry.speakerRole === 'host' || session.activeAwarenessInjections.length === 0) {
            return;
        }

        session.activeAwarenessInjections = session.activeAwarenessInjections
            .map((item) => ({
                ...item,
                remainingTurns: Math.max(0, Number(item.remainingTurns || 0) - 1)
            }))
            .filter((item) => item.remainingTurns > 0);
    }

    getActiveAwarenessInjections(guildId) {
        const session = this.sessions.get(guildId);
        if (!session) {
            return [];
        }

        return session.activeAwarenessInjections.map((item) => ({ ...item }));
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
            text,
            timestamp: entry.timestamp || entry.generatedAt || entry.speechStartedAt || this.now(),
            speechStartedAt: entry.speechStartedAt || null,
            speechEndedAt: entry.speechEndedAt || null,
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
}

module.exports = { InternalThoughtManager };
