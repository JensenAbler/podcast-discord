const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { hash, EvolveSession } = require('./evolve-session');
const { PodcastGenerator } = require('./podcast-generator');
const { AlphaClawdVoiceBot } = require('./bot');
const { loadResumeSource, preflightResume, installResume, handleResumeCommand, buildResumeCommand } = require('./podcast-resume');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'podcast-resume-test-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const name = 'episode-2026-09-17T18-31-16-590Z';
    const dir = path.join(root, name); fs.mkdirSync(dir);
    const state = {
        version: 1, ownerId: 'u', active: true, index: 0, phase: 'reflecting',
        events: [{ type: 'reveal', episodeId: '1' }], responseStart: 0,
        manifest: { version: 1, title: 'Retrospective', contextLimit: 200000,
            episodes: ['exact full text\nwith punctuation — and spaces  ', 'UNREVEALED TEXT'].map((text, i) =>
                ({ id: String(i + 1), title: 'Episode ' + (i + 1), transcript: text, sha256: hash(text) })) },
        timeline: [{ speaker: 'Jensen', text: 'Where we left off', at: '2026-09-17T19:00:00Z' }]
    };
    const entries = [
        { speaker: 'Jensen', text: 'Where we left off', timestamp: '2026-09-17T19:00:00Z' },
        { speaker: 'Alpha', text: 'Unheard output', playbackStatus: 'failed' },
        { speaker: 'Jensen', text: 'Excluded candidate', admission: { status: 'candidate' } }
    ];
    const write = (name, value) => fs.writeFileSync(path.join(dir, name), JSON.stringify(value));
    write('evolve-state.json', state);
    write('episode-complete.json', { guildId: 'g', stoppedAt: '2026-09-17T20:00:00Z' });
    write('episode-plan.json', { backgroundBrief: 'Original background' });
    fs.writeFileSync(path.join(dir, 'transcript.jsonl'), entries.map(e => JSON.stringify(e)).join('\n') + '\n');
    fs.writeFileSync(path.join(dir, 'mixed-audio.mp3'), 'published audio sentinel');
    return { root, name, dir, state, write, source: () => loadResumeSource(root, null, 'u', 'g') };
}
const generator = () => new PodcastGenerator({ apiKey: 'test', maxRequestTokens: 200000 });
test('command is registered with original operator permission', () => {
    const cmd = buildResumeCommand().toJSON();
    assert.equal(cmd.name, 'podcast-resume');
    assert.equal(cmd.default_member_permissions, '32');
    assert(AlphaClawdVoiceBot.prototype.buildSlashCommands.call({}).some(c => c.name === 'podcast-resume'));
});
test('new episode preserves exact context and never appends old speech/audio', t => {
    const f = fixture(t), source = f.source(), g = generator();
    const before = Object.fromEntries(fs.readdirSync(f.dir).map(n => [n, hash(fs.readFileSync(path.join(f.dir, n)))]));
    const dest = path.join(f.root, 'episode-new'); fs.mkdirSync(dest);
    fs.writeFileSync(path.join(dest, 'transcript.jsonl'), '');
    g.startSession(); const session = installResume(g, source, dest);
    assert.deepEqual(session.state, f.state);
    assert.equal(hash(session.context()), source.contextSha256);
    const messages = g.buildMessages({});
    assert.equal(messages[1].content, session.context());
    assert(messages[1].content.includes(f.state.manifest.episodes[0].transcript));
    assert(!messages[1].content.includes('UNREVEALED TEXT'));
    assert.equal(g.spokenTranscript.length, 1);
    assert.equal(fs.readFileSync(path.join(dest, 'transcript.jsonl'), 'utf8'), '');
    assert(!fs.existsSync(path.join(dest, 'mixed-audio.mp3')));
    g.observeSpokenTranscript({ speaker: 'Jensen', text: 'New episode speech', timestamp: '2026-09-18T01:00:00Z' });
    assert.equal(session.state.timeline.length, 2);
    assert.equal(source.state.timeline.length, 1);
    assert.deepEqual(Object.fromEntries(fs.readdirSync(f.dir).map(n => [n, hash(fs.readFileSync(path.join(f.dir, n)))])), before);
    assert.throws(() => installResume(g, source, f.dir), /new recording/);
});
test('preflight leaves live generator unchanged and rejects insufficient budget', t => {
    const f = fixture(t), g = generator(), before = JSON.stringify(g);
    preflightResume(g, f.source());
    assert.equal(JSON.stringify(g), before);
    g.maxRequestTokens = 100;
    assert.throws(() => preflightResume(g, f.source()), /exceeds/);
});
test('source requires matching operator, guild, completed recording and safe paths', t => {
    const f = fixture(t);
    for (const name of ['../' + f.name, f.dir, 'episode-x/../../secret']) {
        assert.throws(() => loadResumeSource(f.root, name, 'u', 'g'), /folder name/);
    }
    assert.throws(() => loadResumeSource(f.root, f.name, 'other', 'g'), /original operator/);
    assert.throws(() => loadResumeSource(f.root, f.name, 'u', 'other'), /server/);
    fs.unlinkSync(path.join(f.dir, 'episode-complete.json'));
    assert.throws(() => loadResumeSource(f.root, f.name, 'u', 'g'), /completed/);
});
test('latest selection skips other owners and rejects corrupt latest eligible snapshot', t => {
    const f = fixture(t);
    const other = path.join(f.root, 'episode-2026-09-18T01-00-00-000Z');
    fs.cpSync(f.dir, other, { recursive: true });
    fs.writeFileSync(path.join(other, 'evolve-state.json'), JSON.stringify({ ...f.state, ownerId: 'other' }));
    assert.equal(f.source().recording, f.name);
    fs.writeFileSync(path.join(other, 'evolve-state.json'), JSON.stringify(f.state));
    assert.equal(f.source().recording, path.basename(other));
    f.state.manifest.episodes[0].transcript = 'corrupt';
    fs.writeFileSync(path.join(other, 'evolve-state.json'), JSON.stringify(f.state));
    assert.throws(() => f.source(), /integrity/);
});
test('snapshot is pinned and supports a later continuation without duplicating history', t => {
    const f = fixture(t), source = f.source(), g = generator();
    f.write('evolve-state.json', { invalid: true });
    const dest = path.join(f.root, 'episode-2026-09-18T01-00-00-000Z'); fs.mkdirSync(dest);
    g.startSession(); installResume(g, source, dest);
    const fresh = { speaker: 'Jensen', text: 'Next chapter', timestamp: '2026-09-18T01:01:00Z' };
    g.observeSpokenTranscript(fresh);
    fs.writeFileSync(path.join(dest, 'transcript.jsonl'), JSON.stringify(fresh) + '\n');
    fs.writeFileSync(path.join(dest, 'episode-complete.json'), JSON.stringify({ guildId: 'g', stoppedAt: '2026-09-18T01:30:00Z' }));
    const next = loadResumeSource(f.root, path.basename(dest), 'u', 'g');
    assert.equal(next.entries.length, 2);
    assert.equal(next.state.timeline.length, 2);
    assert.deepEqual(next.plan, source.plan);
});
test('invalid permissions and occupied session fail before joining', async t => {
    const f = fixture(t); let joined = false, reply;
    const bot = {
        useGatewayGenerator: () => false, recordingState: new Map(), RecordingState: { IDLE: 'IDLE' },
        voiceManager: { options: { recordingDir: f.root }, isConnected: () => false },
        podcastGenerator: generator(), speakerMap: {}, handleJoinCommand: async () => { joined = true; }
    };
    const interaction = { memberPermissions: { has: () => false }, member: { voice: { channel: {} } },
        guildId: 'g', user: { id: 'u' }, options: { getString: () => null },
        reply: async payload => { reply = payload.content; } };
    await handleResumeCommand(bot, interaction); assert.match(reply, /permission/); assert(!joined);
    interaction.memberPermissions.has = () => true;
    bot.recordingState.set('g', 'STOPPING');
    await handleResumeCommand(bot, interaction); assert.match(reply, /Finish/); assert(!joined);
    bot.recordingState.clear();
    await handleResumeCommand(bot, interaction); assert(joined);
});
test('consent starts new recording, restores before idle loop and skips opener', async t => {
    const f = fixture(t), source = f.source(), g = generator();
    const dest = path.join(f.root, 'episode-new'); fs.mkdirSync(dest);
    const bot = Object.create(AlphaClawdVoiceBot.prototype);
    let opener = false, idle = false;
    Object.assign(bot, {
        normalizeSessionHostMode: x => x, recordingState: new Map(), RecordingState: { RECORDING: 'RECORDING' },
        sessionHostModes: new Map(), recordingTextChannels: new Map(), consentWaiters: new Map([['g', { resume: source }]]),
        speakerMap: {}, resetConsecutiveGeneratorSilences() {},
        gatewayBridge: { async disableAllCronJobs() { return []; } },
        voiceManager: { startRecording(guild, prefix, metadata) {
            assert.equal(prefix, 'episode'); assert.equal(metadata.consentGiven, true);
            fs.writeFileSync(path.join(dest, 'transcript.jsonl'), '');
            return { recordingPath: dest };
        } },
        startInternalThoughtSession() {}, startEpisodePlanTracker(guild, plan) { assert.equal(plan, null); },
        podcastGenerator: g, async speakRecordingStart() { opener = true; },
        startIdleDecisionLoop() {
            assert.equal(hash(g.evolveSession.context()), source.contextSha256);
            assert.equal(g.spokenTranscript.length, 1); idle = true;
        },
        wsClient: { isAuthenticated: false }
    });
    await bot.grantConsent('g', source.topic, 'current', null, { resume: source });
    assert(idle); assert(!opener); assert(!bot.consentWaiters.has('g'));
    assert.equal(bot.evolveSessions.get('g').file, path.join(dest, 'evolve-state.json'));
    assert.equal(fs.readFileSync(path.join(dest, 'transcript.jsonl'), 'utf8'), '');
});
test('failed restore stops new session without starting host or changing published source', async t => {
    const f = fixture(t), source = f.source(), bot = Object.create(AlphaClawdVoiceBot.prototype);
    let stopped = false;
    Object.assign(bot, {
        normalizeSessionHostMode: x => x, recordingState: new Map(), RecordingState: { RECORDING: 'RECORDING' },
        sessionHostModes: new Map(), recordingTextChannels: new Map(), consentWaiters: new Map(), speakerMap: {},
        resetConsecutiveGeneratorSilences() {}, gatewayBridge: { async disableAllCronJobs() { return []; } },
        voiceManager: { startRecording() { return { recordingPath: f.dir }; } },
        startInternalThoughtSession() {}, startEpisodePlanTracker() {}, podcastGenerator: generator(),
        startIdleDecisionLoop() { assert.fail('Host must not start'); },
        async leavePodcastSession() { stopped = true; }, wsClient: { isAuthenticated: false }
    });
    await assert.rejects(bot.grantConsent('g', source.topic, 'current', null, { resume: source }), /new recording/);
    assert(stopped); assert.equal(hash(fs.readFileSync(path.join(f.dir, 'evolve-state.json'))), source.stateSha256);
});

test('join stores pinned context for fresh consent without starting a recording', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture(t), source = f.source(), bot = Object.create(AlphaClawdVoiceBot.prototype);
    let disclosure = false, reply = '';
    Object.assign(bot, {
        recordingState: new Map(), RecordingState: { IDLE: 'IDLE', RECORDING: 'RECORDING', AWAITING_CONSENT: 'AWAITING_CONSENT' },
        consentWaiters: new Map(), speakerMap: {}, cachedAudio: { consentDisclosure: Buffer.from('cached') },
        voiceManager: { async joinChannel() {}, async speak() { disclosure = true; } }
    });
    const interaction = {
        member: { voice: { channel: { name: 'Studio' } } }, guildId: 'g', user: { id: 'u' }, channelId: 'text',
        options: { getString() { assert.fail('Resume must not read join-only options'); } },
        async deferReply() {}, async editReply(text) { reply = text; }
    };
    await bot.handleJoinCommand(interaction, source);
    assert(disclosure); assert.match(reply, /New episode/); assert.match(reply, /YES/);
    assert.equal(bot.recordingState.get('g'), 'AWAITING_CONSENT');
    assert.equal(bot.consentWaiters.get('g').resume, source);
    assert.equal(bot.podcastJoinPending, false);
});
test('source symlinks cannot escape recording root', t => {
    const f = fixture(t);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'podcast-outside-'));
    t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
    fs.cpSync(f.dir, outside, { recursive: true });
    const link = 'episode-external'; fs.symlinkSync(outside, path.join(f.root, link));
    assert.throws(() => loadResumeSource(f.root, link, 'u', 'g'), /escapes/);
});
