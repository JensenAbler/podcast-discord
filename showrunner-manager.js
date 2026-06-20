class ShowRunnerManager {
    constructor(options = {}) {
        this.enabled = options.enabled !== undefined
            ? Boolean(options.enabled)
            : process.env.PODCAST_SHOW_RUNNER_ENABLED !== 'false';
        this.sessions = new Map();
    }

    startSession(guildId, options = {}) {
        const session = {
            guildId,
            startedAt: options.startedAt || new Date().toISOString(),
            recordingPath: options.recordingPath || null
        };
        this.sessions.set(guildId, session);
        return session;
    }

    async endSession(guildId) {
        const session = this.sessions.get(guildId) || null;
        this.sessions.delete(guildId);
        return session;
    }

    handleTranscriptEntry() {
        return Promise.resolve(null);
    }

    forceUpdate() {
        return Promise.resolve(null);
    }

    getGuidance() {
        return null;
    }
}

module.exports = { ShowRunnerManager };
