const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { hash } = require('./content-assets');
const { PodcastGenerator } = require('./podcast-generator');
const { AlphaClawdVoiceBot } = require('./bot');
const { loadResumeSource, preflightResume, installResume, handleResumeCommand, buildResumeCommand } = require('./podcast-resume');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'podcast-resume-test-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const name = 'episode-2026-09-17T18-31-16-590Z';
    const dir = path.join(root, name); fs.mkdirSync(dir);
    const entries = [
        { speaker: 'Jensen', text: 'Where we left off', timestamp: '2026-09-17T19:00:00Z' },
        { speaker: 'Alpha', text: 'Unheard output', playbackStatus: 'failed' },
        { speaker: 'Jensen', text: 'Excluded candidate', admission: { status: 'candidate' } }
    ];
    const write = (name, value) => fs.writeFileSync(path.join(dir, name), JSON.stringify(value));
    write('resume-identity.json', { ownerId: 'u', guildId: 'g' });
    write('episode-complete.json', { guildId: 'g', stoppedAt: '2026-09-17T20:00:00Z' });
    write('episode-plan.json', { basename: 'retrospective', version: 'v001', backgroundBrief: 'Original background' });
    fs.writeFileSync(path.join(dir, 'transcript.jsonl'), entries.map(e => JSON.stringify(e)).join('\n') + '\n');
    fs.writeFileSync(path.join(dir, 'mixed-audio.mp3'), 'published audio sentinel');
    return { root, name, dir, write, source: () => loadResumeSource(root, null, 'u', 'g') };
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
    g.startSession(); installResume(g, source, dest);
    const content = JSON.stringify(g.buildMessages({}));
    assert.match(content, /Where we left off/);
    assert.doesNotMatch(content, /EVOLVE RETROSPECTIVE|new recorded episode|Jensen will guide|prior experience/);
    assert.equal(g.spokenTranscript.length, 1);
    assert.equal(fs.readFileSync(path.join(dest, 'transcript.jsonl'), 'utf8'), '');
    assert(!fs.existsSync(path.join(dest, 'mixed-audio.mp3')));
    g.observeSpokenTranscript({ speaker: 'Jensen', text: 'New episode speech', timestamp: '2026-09-18T01:00:00Z' });
    assert.equal(g.spokenTranscript.length, 2);
    assert.equal(source.entries.length, 1);
    assert.deepEqual(Object.fromEntries(fs.readdirSync(f.dir).map(n => [n, hash(fs.readFileSync(path.join(f.dir, n)))])), before);
    assert.throws(() => installResume(g, source, f.dir), /new recording/);
});
test('preflight leaves live generator unchanged', t => {
    const f = fixture(t), g = generator(), before = JSON.stringify(g);
    preflightResume(g, f.source());
    assert.equal(JSON.stringify(g), before);
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
    fs.writeFileSync(path.join(other, 'resume-identity.json'), JSON.stringify({ ownerId: 'other', guildId: 'g' }));
    assert.equal(f.source().recording, f.name);
    fs.writeFileSync(path.join(other, 'resume-identity.json'), JSON.stringify({ ownerId: 'u', guildId: 'g' }));
    assert.equal(f.source().recording, path.basename(other));
    fs.writeFileSync(path.join(other, 'transcript.jsonl'), 'corrupt');
    assert.throws(() => f.source(), SyntaxError);
});
test('snapshot is pinned and supports a later continuation without duplicating history', t => {
    const f = fixture(t), source = f.source(), g = generator();
    fs.writeFileSync(path.join(f.dir, 'transcript.jsonl'), 'changed after source was pinned');
    const dest = path.join(f.root, 'episode-2026-09-18T01-00-00-000Z'); fs.mkdirSync(dest);
    g.startSession(); installResume(g, source, dest);
    const fresh = { speaker: 'Jensen', text: 'Next chapter', timestamp: '2026-09-18T01:01:00Z' };
    g.observeSpokenTranscript(fresh);
    fs.writeFileSync(path.join(dest, 'transcript.jsonl'), JSON.stringify(fresh) + '\n');
    fs.writeFileSync(path.join(dest, 'episode-complete.json'), JSON.stringify({ guildId: 'g', stoppedAt: '2026-09-18T01:30:00Z' }));
    const next = loadResumeSource(f.root, path.basename(dest), 'u', 'g');
    assert.equal(next.entries.length, 2);
    assert.deepEqual(next.plan, source.plan);
    assert.equal(source.planTag, 'plan:retrospective');
    assert.equal(next.planTag, source.planTag);
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
            assert.equal(metadata.planTag, 'plan:retrospective');
            fs.writeFileSync(path.join(dest, 'transcript.jsonl'), '');
            return { recordingPath: dest };
        } },
        startInternalThoughtSession() {}, startEpisodePlanTracker(guild, plan) { assert.equal(plan, null); },
        podcastGenerator: g, async speakRecordingStart() { opener = true; },
        startIdleDecisionLoop() {
            assert.match(JSON.stringify(g.buildMessages({})), /Where we left off/);
            assert.equal(g.spokenTranscript.length, 1); idle = true;
        },
        wsClient: { isAuthenticated: false }
    });
    await bot.grantConsent('g', source.topic, 'current', null, { resume: source });
    assert(idle); assert(!opener); assert(!bot.consentWaiters.has('g'));
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
    assert(stopped); assert.equal(hash(fs.readFileSync(path.join(f.dir, 'transcript.jsonl'))), source.transcriptSha256);
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

const { EpisodePlanTracker } = require('./episode-plan-tracker');
const { savePlanProgress, resumePlanOptions } = require('./episode-plan-progress');

function plannedFixture(t) {
    const f = fixture(t);
    const plan = { basename: 'retrospective', version: 'v001', guests: ['Jensen'],
        phases: { expanding: { angles: ['First'] }, developing: { angles: ['Second', 'Third'] } } };
    const tracker = new EpisodePlanTracker(plan, {
        startedAt: '2026-09-17T18:00:00Z', currentPhase: 'developing',
        phaseStartedAt: '2026-09-17T19:00:00Z', lastChosenAngle: 'second',
        currentAngleStartedAt: '2026-09-17T19:50:00Z', currentAngleHostTurns: 3,
        completedAngles: ['first'], activeAngles: ['second'], openingHostSpoken: true,
        openingGuestSpeakers: ['jensen'], recentTurns: [{ role: 'guest', speaker: 'Jensen', durationMs: 1200 }]
    });
    f.write('episode-plan.json', tracker.plan);
    const checkpoint = savePlanProgress(tracker, f.dir, '2026-09-17T20:00:00Z');
    return { ...f, tracker, checkpoint };
}

test('plan checkpoint restores every field and excludes the overnight pause from timers', t => {
    const f = plannedFixture(t), source = f.source();
    const options = resumePlanOptions(source.planProgress, source.plan, '2026-09-18T20:00:00Z');
    const resumed = new EpisodePlanTracker(source.plan, options);
    assert.equal(resumed.currentPhase, 'developing');
    assert.equal(resumed.currentAngleHostTurns, 3);
    assert.deepEqual([...resumed.completedAngles], ['first']);
    assert.deepEqual([...resumed.activeAngles], ['second']);
    assert(resumed.isOpeningRoundComplete());
    assert.equal(resumed.phaseStartedAt, '2026-09-18T19:00:00.000Z');
    assert.equal(resumed.currentAngleStartedAt, '2026-09-18T19:50:00.000Z');
    assert.equal(resumed.getStructureBlock('2026-09-18T20:00:00Z'),
        f.tracker.getStructureBlock('2026-09-17T20:00:00Z'));
    assert.deepEqual(source.planProgress, f.checkpoint);
    resumed.completedAngles.add('third');
    assert(!source.planProgress.state.completedAngles.includes('third'));
});

test('saved closing progress survives resume and corrupt or mismatched state fails', t => {
    const f = plannedFixture(t);
    f.tracker.closingThoughtsQueued = true;
    f.tracker.closingThoughtsRequested = true;
    f.tracker.closingThoughtSpeakers.add('jensen');
    savePlanProgress(f.tracker, f.dir);
    const source = f.source();
    const resumed = new EpisodePlanTracker(source.plan, resumePlanOptions(source.planProgress, source.plan));
    assert(resumed.closingThoughtsRequested);
    assert(resumed.closingThoughtSpeakers.has('jensen'));
    f.write('episode-plan-state.json', { ...source.planProgress,
        state: { ...source.planProgress.state, version: 'v999' } });
    assert.throws(() => f.source(), /mismatched/);
    f.write('episode-plan-state.json', { ...source.planProgress,
        state: { ...source.planProgress.state, completedAngles: 'bad' } });
    assert.throws(() => f.source(), /Invalid/);
});

test('ordinary planned recordings resume with identity checks and preserve progress across generations', t => {
    const f = plannedFixture(t);
    f.write('resume-identity.json', { ownerId: 'u', guildId: 'g' });
    const source = f.source();
    assert.throws(() => loadResumeSource(f.root, f.name, 'other', 'g'), /operator/);
    const g = generator();
    preflightResume(g, source);
    const dest = path.join(f.root, 'episode-2026-09-19T01-00-00-000Z'); fs.mkdirSync(dest);
    g.startSession(); installResume(g, source, dest);
    const bot = Object.create(AlphaClawdVoiceBot.prototype);
    bot.episodePlanTrackers = new Map();
    bot.startEpisodePlanTracker('g', { plan: source.plan }, {
        recordingPath: dest, startedAt: '2026-09-18T20:00:00Z'
    }, source.planProgress);
    assert.equal(bot.episodePlanTrackers.get('g').currentAngleHostTurns, 3);
    bot.applyEpisodePlanResponse('g', { shouldRespond: true, speech: 'Continue', chosenAngle: 'second' },
        { playbackEndedAt: '2026-09-18T20:01:00Z' });
    fs.writeFileSync(path.join(dest, 'transcript.jsonl'), '');
    fs.writeFileSync(path.join(dest, 'episode-complete.json'), JSON.stringify({ guildId: 'g', stoppedAt: new Date().toISOString() }));
    const next = loadResumeSource(f.root, path.basename(dest), 'u', 'g');
    assert.equal(next.planProgress.state.currentAngleHostTurns, 4);
    assert.equal(next.entries.length, source.entries.length);
    assert.deepEqual(next.plan, source.plan);
    assert.equal(loadResumeSource(f.root, f.name, 'u', 'g').planProgress.state.currentAngleHostTurns, 3);
});

test('fresh tracker persists guest observations and successful host plan updates', t => {
    const f = plannedFixture(t), bot = Object.create(AlphaClawdVoiceBot.prototype);
    bot.episodePlanTrackers = new Map();
    bot.recordingState = new Map([['g', 'recording']]);
    bot.RecordingState = { RECORDING: 'recording' };
    bot.startEpisodePlanTracker('g', { plan: f.tracker.plan }, { recordingPath: f.dir });
    bot.observeShowRunnerTranscriptEntry('g', { speakerRole: 'host', speaker: 'Alpha', text: 'Hello' });
    bot.observeShowRunnerTranscriptEntry('g', { speakerRole: 'guest', speaker: 'Jensen', text: 'Hi' });
    bot.applyEpisodePlanResponse('g', { shouldRespond: true, speech: 'First topic', chosenAngle: 'first' });
    const checkpoint = JSON.parse(fs.readFileSync(path.join(f.dir, 'episode-plan-state.json')));
    assert(checkpoint.state.openingHostSpoken);
    assert.deepEqual(checkpoint.state.openingGuestSpeakers, ['jensen']);
    assert.equal(checkpoint.state.lastChosenAngle, 'first');
});
test('consent restores the active plan before starting the resumed host', async t => {
    const f = plannedFixture(t), source = f.source(), g = generator();
    const dest = path.join(f.root, 'episode-new'); fs.mkdirSync(dest);
    const bot = Object.create(AlphaClawdVoiceBot.prototype);
    let opener = false, idle = false;
    Object.assign(bot, {
        normalizeSessionHostMode: x => x, recordingState: new Map(), RecordingState: { RECORDING: 'RECORDING' },
        sessionHostModes: new Map(), recordingTextChannels: new Map(), consentWaiters: new Map([['g', { resume: source }]]),
        speakerMap: {}, resetConsecutiveGeneratorSilences() {},
        gatewayBridge: { async disableAllCronJobs() { return []; } },
        voiceManager: { startRecording(guild, prefix, metadata) {
            assert.equal(metadata.episodePlan.plan.basename, source.plan.basename); assert.equal(prefix, 'episode'); assert.equal(metadata.consentGiven, true);
            assert.equal(metadata.planTag, 'plan:retrospective');
            fs.writeFileSync(path.join(dest, 'transcript.jsonl'), '');
            return { recordingPath: dest };
        } },
        startInternalThoughtSession() {}, episodePlanTrackers: new Map(),
        podcastGenerator: g, async speakRecordingStart() { opener = true; },
        startIdleDecisionLoop() {
            assert.match(JSON.stringify(g.buildMessages({})), /Where we left off/);
            assert.equal(g.spokenTranscript.length, 1); assert.equal(bot.episodePlanTrackers.get('g').currentAngleHostTurns, 3); idle = true;
        },
        wsClient: { isAuthenticated: false }
    });
    await bot.grantConsent('g', source.topic, 'current', null, { resume: source });
    assert(idle); assert(!opener); assert(!bot.consentWaiters.has('g'));
    assert.equal(fs.readFileSync(path.join(dest, 'transcript.jsonl'), 'utf8'), '');
});

test('resumed and uninterrupted conversations build the same prompt', t => {
    const f = plannedFixture(t), source = f.source();
    const resumed = generator(), uninterrupted = generator();
    const options = { topic: source.topic, recording: true, speakers: ['Jensen'] };
    resumed.startSession(options); uninterrupted.startSession(options);
    require('./podcast-resume').restoreGenerator(resumed, source);
    uninterrupted.hasBackchannels = true;
    for (const row of source.entries) uninterrupted.observeSpokenTranscript(row);
    const input = { transcript: 'What happened next?', currentTime: '2026-09-18T20:00:00Z',
        episodePlanStructure: f.tracker.getStructureBlock('2026-09-17T20:00:00Z') };
    assert.deepEqual(resumed.buildMessages(input), uninterrupted.buildMessages(input));
});
test('archival retrospective state is neither read nor copied', t => {
    const f = plannedFixture(t);
    f.write('evolve-state.json', { unsupported: 'ARCHIVAL_ONLY_SECRET' });
    const source = f.source(), g = generator(), dest = path.join(f.root, 'episode-new');
    fs.mkdirSync(dest); g.startSession(); installResume(g, source, dest);
    assert(!fs.existsSync(path.join(dest, 'evolve-state.json')));
    assert.doesNotMatch(JSON.stringify(g.buildMessages({})), /ARCHIVAL_ONLY_SECRET|EVOLVE RETROSPECTIVE/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, 'evolve-state.json'))).unsupported, 'ARCHIVAL_ONLY_SECRET');
});
