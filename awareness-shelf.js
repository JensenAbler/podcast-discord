const fs = require('fs');
const path = require('path');

class AwarenessShelf {
    constructor(options = {}) {
        this.enabled = options.enabled !== undefined
            ? Boolean(options.enabled)
            : process.env.PODCAST_AWARENESS_SHELF_ENABLED === 'true';
        this.maxItems = this.parsePositiveInt(
            options.maxItems ?? process.env.PODCAST_AWARENESS_SHELF_MAX_ITEMS,
            7
        );
        this.expireAfterTurns = this.parsePositiveInt(
            options.expireAfterTurns ?? process.env.PODCAST_AWARENESS_SHELF_EXPIRE_AFTER_TURNS,
            4
        );
        this.outputFilename = options.outputFilename || 'awareness-shelf.jsonl';
        this.now = options.now || (() => new Date().toISOString());
        this.sessions = new Map();
    }

    startSession(guildId, options = {}) {
        if (!guildId) {
            throw new Error('AwarenessShelf.startSession requires guildId');
        }

        const recordingPath = options.recordingPath || null;
        const outputPath = options.outputPath || (recordingPath ? path.join(recordingPath, this.outputFilename) : null);
        if (this.enabled && outputPath) {
            fs.mkdirSync(path.dirname(outputPath), { recursive: true });
            fs.writeFileSync(outputPath, '');
        }

        const session = {
            guildId,
            recordingPath,
            outputPath: this.enabled ? outputPath : null,
            startedAt: this.normalizeTimestamp(options.startedAt) || this.now(),
            itemSeq: 0,
            items: []
        };

        this.sessions.set(guildId, session);
        return session;
    }

    endSession(guildId) {
        const session = this.sessions.get(guildId);
        if (!session) {
            return null;
        }

        this.sessions.delete(guildId);
        return {
            outputPath: session.outputPath,
            itemCount: session.items.length,
            activeItemCount: session.items.filter((item) => item.status === 'active').length
        };
    }

    addItem(guildId, input = {}) {
        const session = this.sessions.get(guildId);
        if (!this.enabled || !session) {
            return null;
        }

        const text = String(input.text || input.awareness || input.awarenessInjection || '').trim();
        if (!text) {
            return null;
        }

        session.itemSeq += 1;
        const now = this.now();
        const originTimestamp = this.resolveOriginTimestamp(session, input);
        const item = {
            id: String(input.id || `shelf-${session.itemSeq}`).trim(),
            status: 'active',
            text,
            reason: String(input.reason || '').trim(),
            topicAnchors: this.normalizeTopicAnchors(input.topicAnchors),
            createdAt: now,
            updatedAt: now,
            originTimestamp,
            originEpisodeTimestamp: this.formatEpisodeTimestamp(session, originTimestamp),
            originEpisodeOffsetMs: this.getEpisodeOffsetMs(session, originTimestamp),
            originTurnIdIntent: input.originTurnIdIntent || input.turnIdIntent || null,
            expiresAfterTurns: this.parsePositiveInt(input.expiresAfterTurns ?? input.lifespanTurns, this.expireAfterTurns),
            presentedCount: 0,
            remainingTurns: this.parsePositiveInt(input.expiresAfterTurns ?? input.lifespanTurns, this.expireAfterTurns),
            lastPresentedAt: null,
            lastPresentedTurnId: null,
            removedAt: null,
            removedReason: ''
        };

        session.items.push(item);
        this.enforceMaxActiveItems(session, item.id);
        this.appendEvent(session, 'added', item, {
            reason: item.reason,
            originTimestamp: item.originTimestamp,
            originEpisodeTimestamp: item.originEpisodeTimestamp
        });
        return this.copyItem(item);
    }

    updateItem(guildId, itemId, patch = {}) {
        const session = this.sessions.get(guildId);
        const item = this.findItem(session, itemId);
        if (!this.enabled || !session || !item) {
            return null;
        }

        if (patch.text !== undefined || patch.awareness !== undefined || patch.awarenessInjection !== undefined) {
            const text = String(patch.text ?? patch.awareness ?? patch.awarenessInjection ?? '').trim();
            if (text) item.text = text;
        }
        if (patch.reason !== undefined) {
            item.reason = String(patch.reason || '').trim();
        }
        if (patch.topicAnchors !== undefined) {
            item.topicAnchors = this.normalizeTopicAnchors(patch.topicAnchors);
        }
        if (patch.originTimestamp !== undefined || patch.originTurnIdIntent !== undefined || patch.turnIdIntent !== undefined) {
            item.originTurnIdIntent = patch.originTurnIdIntent || patch.turnIdIntent || item.originTurnIdIntent;
            item.originTimestamp = this.resolveOriginTimestamp(session, {
                originTimestamp: patch.originTimestamp,
                originTurnIdIntent: item.originTurnIdIntent
            });
            item.originEpisodeTimestamp = this.formatEpisodeTimestamp(session, item.originTimestamp);
            item.originEpisodeOffsetMs = this.getEpisodeOffsetMs(session, item.originTimestamp);
        }
        if (patch.expiresAfterTurns !== undefined || patch.lifespanTurns !== undefined) {
            item.expiresAfterTurns = this.parsePositiveInt(patch.expiresAfterTurns ?? patch.lifespanTurns, this.expireAfterTurns);
            item.remainingTurns = Math.max(0, item.expiresAfterTurns - item.presentedCount);
        }

        item.updatedAt = this.now();
        this.appendEvent(session, 'updated', item);
        return this.copyItem(item);
    }

    removeItem(guildId, itemId, reason = '') {
        const session = this.sessions.get(guildId);
        const item = this.findItem(session, itemId);
        if (!this.enabled || !session || !item) {
            return null;
        }

        item.status = 'removed';
        item.removedAt = this.now();
        item.removedReason = String(reason || '').trim();
        item.updatedAt = item.removedAt;
        this.appendEvent(session, 'removed', item, { reason: item.removedReason });
        return this.copyItem(item);
    }

    reactivateItem(guildId, itemId, patch = {}) {
        const session = this.sessions.get(guildId);
        const item = this.findItem(session, itemId);
        if (!this.enabled || !session || !item) {
            return null;
        }

        item.status = 'active';
        item.removedAt = null;
        item.removedReason = '';
        item.presentedCount = 0;
        item.expiresAfterTurns = this.parsePositiveInt(patch.expiresAfterTurns ?? patch.lifespanTurns, item.expiresAfterTurns || this.expireAfterTurns);
        item.remainingTurns = item.expiresAfterTurns;
        item.updatedAt = this.now();
        if (Object.keys(patch).length > 0) {
            this.updateItem(guildId, itemId, patch);
        }
        this.enforceMaxActiveItems(session, item.id);
        this.appendEvent(session, 'reactivated', item);
        return this.copyItem(item);
    }

    getAvailableItems(guildId) {
        const session = this.sessions.get(guildId);
        if (!this.enabled || !session) {
            return [];
        }

        return session.items
            .filter((item) => item.status === 'active' && item.remainingTurns > 0)
            .map((item) => this.copyItem(item));
    }

    presentItemsForGenerator(guildId, options = {}) {
        const session = this.sessions.get(guildId);
        if (!this.enabled || !session) {
            return [];
        }

        const generatorCalledAt = this.normalizeTimestamp(options.generatorCalledAt || options.currentTime) || this.now();
        const turnId = options.turnIdIntent?.turnId || null;
        const available = session.items
            .filter((item) => item.status === 'active' && item.remainingTurns > 0);
        const presented = available.map((item) => this.copyItem(item));

        for (const item of available) {
            item.presentedCount += 1;
            item.remainingTurns = Math.max(0, item.expiresAfterTurns - item.presentedCount);
            item.lastPresentedAt = generatorCalledAt;
            item.lastPresentedTurnId = turnId;
            item.updatedAt = generatorCalledAt;
            this.appendEvent(session, 'presented_to_generator', item, {
                generatorCalledAt,
                generatorEpisodeTimestamp: this.formatEpisodeTimestamp(session, generatorCalledAt),
                turnId
            });
            if (item.remainingTurns <= 0) {
                item.status = 'expired';
                item.updatedAt = generatorCalledAt;
                this.appendEvent(session, 'expired', item, {
                    reason: 'presented_turn_limit'
                });
            }
        }

        return presented;
    }

    getEpisodeTimestampForTime(guildId, timestamp = null) {
        const session = this.sessions.get(guildId);
        if (!session) {
            return null;
        }
        return this.formatEpisodeTimestamp(session, timestamp || this.now());
    }

    enforceMaxActiveItems(session, preserveId = '') {
        const active = session.items
            .filter((item) => item.status === 'active')
            .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
        while (active.length > this.maxItems) {
            const candidateIndex = active.findIndex((item) => item.id !== preserveId);
            const item = active.splice(candidateIndex >= 0 ? candidateIndex : 0, 1)[0];
            if (!item) break;
            item.status = 'expired';
            item.remainingTurns = 0;
            item.updatedAt = this.now();
            this.appendEvent(session, 'expired', item, {
                reason: 'max_active_items'
            });
        }
    }

    findItem(session, itemId) {
        if (!session || !itemId) {
            return null;
        }
        return session.items.find((item) => item.id === itemId) || null;
    }

    resolveOriginTimestamp(session, input = {}) {
        return this.normalizeTimestamp(
            input.originTimestamp ||
            input.timestamp ||
            input.originTurnIdIntent?.timestamp ||
            input.turnIdIntent?.timestamp
        ) || this.now();
    }

    normalizeTimestamp(value) {
        if (value === undefined || value === null || value === '') {
            return null;
        }
        if (typeof value === 'number') {
            return new Date(value).toISOString();
        }
        const parsed = Date.parse(value);
        if (Number.isNaN(parsed)) {
            return null;
        }
        return new Date(parsed).toISOString();
    }

    getEpisodeOffsetMs(session, timestamp) {
        const startMs = Date.parse(session?.startedAt);
        const atMs = Date.parse(timestamp);
        if (Number.isNaN(startMs) || Number.isNaN(atMs)) {
            return null;
        }
        return Math.max(0, atMs - startMs);
    }

    formatEpisodeTimestamp(session, timestamp) {
        const offsetMs = this.getEpisodeOffsetMs(session, timestamp);
        if (!Number.isFinite(offsetMs)) {
            return null;
        }

        const totalMs = Math.floor(offsetMs);
        const ms = totalMs % 1000;
        const totalSeconds = Math.floor(totalMs / 1000);
        const seconds = totalSeconds % 60;
        const totalMinutes = Math.floor(totalSeconds / 60);
        const minutes = totalMinutes % 60;
        const hours = Math.floor(totalMinutes / 60);
        return [
            String(hours).padStart(2, '0'),
            String(minutes).padStart(2, '0'),
            String(seconds).padStart(2, '0')
        ].join(':') + `.${String(ms).padStart(3, '0')}`;
    }

    normalizeTopicAnchors(value) {
        return (Array.isArray(value) ? value : String(value || '').split(','))
            .map((item) => String(item || '').trim())
            .filter(Boolean);
    }

    copyItem(item = {}) {
        return {
            ...item,
            topicAnchors: Array.isArray(item.topicAnchors) ? [...item.topicAnchors] : []
        };
    }

    appendEvent(session, event, item, extra = {}) {
        if (!session?.outputPath) {
            return;
        }

        const record = {
            type: 'awareness_shelf_event',
            event,
            guildId: session.guildId,
            item: this.copyItem(item),
            timestamp: this.now(),
            ...extra
        };
        fs.appendFileSync(session.outputPath, `${JSON.stringify(record)}\n`);
    }

    parsePositiveInt(value, fallback) {
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed <= 0) {
            return fallback;
        }
        return Math.floor(parsed);
    }
}

module.exports = { AwarenessShelf };
