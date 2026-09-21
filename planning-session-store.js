'use strict';
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

class PlanningSessionStore {
    constructor(rootDir) {
        this.filename = path.join(rootDir, 'active-planning-sessions.json');
    }
    load() {
        if (!fs.existsSync(this.filename)) return new Map();
        const saved = JSON.parse(fs.readFileSync(this.filename, 'utf8'));
        if (saved.schemaVersion !== 1 || !Array.isArray(saved.sessions)) {
            throw new Error('Invalid saved planning sessions');
        }
        return new Map(saved.sessions.filter(s => !s.closed).map(session => {
            if (!session.channelId || !session.guildId || !Array.isArray(session.messages)) {
                throw new Error('Invalid saved planning session');
            }
            return [session.channelId, { ...session, processing: Promise.resolve(), processingActive: false }];
        }));
    }
    save(sessions) {
        const saved = [...sessions.values()].filter(s => !s.closed).map(session => {
            const { processing, processingActive, ...data } = session;
            return data;
        });
        fs.mkdirSync(path.dirname(this.filename), { recursive: true });
        const temporary = this.filename + '.' + randomUUID() + '.tmp';
        fs.writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, sessions: saved }, null, 2) + '\n', { mode: 0o600 });
        fs.renameSync(temporary, this.filename);
    }
}
module.exports = { PlanningSessionStore };
