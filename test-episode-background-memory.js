'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { EpisodeMemoryBuilder, EpisodeMemoryGenerator, readArchive, seedEpisodeMemory } = require('./episode-background-memory');
const { EpisodePlanStore } = require('./episode-plan-store');
const { AwarenessShelf } = require('./awareness-shelf');
const { AlphaClawdVoiceBot } = require('./bot');
function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'episode-memory-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}
function recording(root, name, entries, guildId = 'g', complete = true) {
    const dir = path.join(root, name); fs.mkdirSync(dir, { recursive: true });
    if (complete) fs.writeFileSync(path.join(dir, 'episode-complete.json'), JSON.stringify({
        guildId, startedAt: '2026-01-01T00:00:00Z', stoppedAt: '2026-01-01T01:00:00Z'
    }));
    fs.writeFileSync(path.join(dir, 'transcript.jsonl'), entries.map(e => JSON.stringify(e)).join('\n'));
}
const plan = { basename: 'test-memory', version: 'v001', guests: [{ name: 'Jensen' }], backgroundBrief: 'Improvisation and creative relationships' };
test('archive scopes completed history, preserves attribution, and excludes unplayed/candidate speech', t => {
    const root = fixture(t);
    recording(root, 'episode-1', [
        { speaker: 'Jensen', text: 'Dance feels like listening.', timestamp: '2026-01-01T00:01:00Z' },
        { speaker: 'Alpha', text: 'NEVER HEARD', playbackStatus: 'not_started' },
        { text: 'PHANTOM', admission: { status: 'candidate' } }
    ]);
    recording(root, 'episode-2', [{ text: 'OTHER SERVER' }], 'other');
    recording(root, 'episode-3', [{ text: 'IN PROGRESS' }], 'g', false);
    const { chunks } = readArchive(root, 'g');
    assert.equal(chunks.length, 1);
    assert.match(chunks[0].text, /Jensen: Dance feels like listening/);
    assert.doesNotMatch(chunks[0].text, /NEVER HEARD|PHANTOM|OTHER SERVER|IN PROGRESS/);
    assert.equal(readArchive(root).chunks.length, 0);
});
test('all archive batches reach semantic selection, then sourced memories are collated', async t => {
    const root = fixture(t);
    for (let i = 0; i < 9; i++) recording(root, 'episode-' + i, [{ speaker: 'Guest' + i, text: 'dance '.repeat(3000) }]);
    const seen = new Set(), stages = [];
    const builder = new EpisodeMemoryBuilder({ root, generator: { model: 'fake',
        async select(p, sources, stage) {
            assert.equal(p.backgroundMemory, undefined); stages.push(stage);
            if (stage === 'extract') {
                sources.forEach(s => seen.add(s.recording));
                return [{ text: 'Guest described embodied improvisation.', sourceIds: [sources[0].id] }];
            }
            return sources.slice(0, 6);
        }
    } });
    const result = await builder.build({ ...plan, backgroundMemory: { status: 'old' } }, { guildId: 'g' });
    assert.equal(seen.size, 9); assert.equal(result.recordingsConsidered, 9);
    assert(stages.filter(s => s === 'extract').length > 1);
    assert.equal(stages.at(-1), 'collate'); assert.equal(result.status, 'ready');
    assert(result.sources.every(s => s.sha256.length === 64));
});
test('empty history avoids provider calls; corrupt archives are surfaced', async t => {
    const root = fixture(t);
    const builder = new EpisodeMemoryBuilder({ root, generator: { select() { throw Error('unexpected'); } } });
    assert.deepEqual((await builder.build(plan, { guildId: 'g' })).memories, []);
    recording(root, 'episode-broken', []);
    fs.writeFileSync(path.join(root, 'episode-broken', 'transcript.jsonl'), '{bad');
    await assert.rejects(builder.build(plan, { guildId: 'g' }), /No readable/);
});
test('provider output must cite actual supplied sources', async () => {
    const generator = new EpisodeMemoryGenerator({ apiKey: 'fake' });
    generator.fetchCompletion = async messages => {
        assert.match(messages[0].content, /aesthetic resonances/);
        return { choices: [{ message: { content: JSON.stringify({ memories: [{ text: 'Invented', sourceIds: ['missing'] }] }) } }] };
    };
    await assert.rejects(generator.select(plan, [{ id: 'real', text: 'Archive' }], 'extract'), /source references/);
});
test('episode memory survives expiry and capacity pressure while normal shelf behavior remains', () => {
    const shelf = new AwarenessShelf({ enabled: true, maxItems: 2, expireAfterTurns: 2 });
    shelf.startSession('g');
    const memoryPlan = { ...plan, backgroundMemory: { status: 'ready', memories: [{ text: 'Jensen discussed dance.', sourceIds: ['episode-1#part-1'] }] } };
    seedEpisodeMemory({ addAwarenessShelfItem: (...args) => shelf.addItem(...args) }, 'g', memoryPlan);
    for (let i = 0; i < 8; i++) {
        shelf.addItem('g', { text: 'Transient ' + i });
        const items = shelf.presentItemsForGenerator('g');
        assert(items.some(item => item.id === 'episode-background-memory'));
    }
    const memory = shelf.getAvailableItems('g').find(i => i.id === 'episode-background-memory');
    assert.match(memory.text, /Sources: episode-1/);
    assert.doesNotMatch(memory.text, /should|must|agenda/);
    shelf.removeItem('g', memory.id);
    assert(!shelf.getAvailableItems('g').some(i => i.id === memory.id));
});
function botFixture(t, builder) {
    const root = fixture(t), bot = Object.create(AlphaClawdVoiceBot.prototype);
    bot.episodePlanStore = new EpisodePlanStore({ rootDir: root });
    const saved = bot.episodePlanStore.savePlan(plan);
    bot.episodeMemoryBuilder = builder;
    const session = { guildId: 'g', channelId: 'c', basename: plan.basename, latestPlan: saved.plan, latestVersion: 'v001' };
    return { bot, session };
}
test('preparation persists exact-version memory and pending selection waits', async t => {
    let resolve;
    const pending = new Promise(r => { resolve = r; });
    const { bot, session } = botFixture(t, { build: async (p, options) => {
        assert.equal(options.guildId, 'g'); await pending;
        return { status: 'ready', memories: [{ text: 'Memory', sourceIds: ['episode-1#part-1'] }], sources: [], skipped: [], recordingsConsidered: 1 };
    } });
    const messages = [];
    const work = bot.prepareEpisodeBackgroundMemory(session, { send: async m => messages.push(m) });
    assert.throws(() => bot.loadEpisodePlanSelection('test-memory@v001'), /still being prepared/);
    resolve(); await work;
    const loaded = bot.loadEpisodePlanSelection('test-memory@v001').plan;
    assert.equal(loaded.backgroundMemory.memories[0].text, 'Memory');
    assert.equal(loaded.version, 'v001'); assert.equal(messages.length, 2);
    const resumed = JSON.parse(JSON.stringify(loaded));
    const shelf = new AwarenessShelf({ enabled: true }); shelf.startSession('resume');
    seedEpisodeMemory({ addAwarenessShelfItem: (...args) => shelf.addItem(...args) }, 'resume', resumed);
    assert.equal(shelf.getAvailableItems('resume').length, 1);
});
test('provider failures preserve a launchable plan and notify the planner', async t => {
    const { bot, session } = botFixture(t, { build: async () => { throw Error('provider unavailable'); } });
    const messages = [];
    await bot.prepareEpisodeBackgroundMemory(session, { send: async m => messages.push(m) });
    assert.equal(bot.loadEpisodePlanSelection('test-memory@v001').plan.backgroundMemory.status, 'failed');
    assert.match(messages.at(-1), /can still start/);
});
test('new revisions discard old payloads', t => {
    const { bot, session } = botFixture(t, {});
    session.messages = []; session.loggedMessageCount = 0;
    const saved = bot.savePlanningOutput(session, { action: 'revise_plan', plan: { ...plan, backgroundMemory: { status: 'ready' } } });
    assert.equal(saved.plan.version, 'v002');
    assert.equal(saved.plan.backgroundMemory, undefined);
});
test('approved planning invokes memory post-process but drafts do not', async t => {
    const { bot, session } = botFixture(t, {});
    session.messages = []; session.messageSequence = 1;
    bot.planningControllerEnabled = true; bot.showRunnerEnabled = true;
    bot.planningSessions = new Map([['c', session]]);
    bot.showRunnerGenerator = { generate: async () => ({ action: 'approve_plan', approved: true, messageToChannel: 'Approved' }) };
    let calls = 0;
    bot.prepareEpisodeBackgroundMemory = async s => { assert.equal(s, session); calls++; };
    await bot.processPlanningSession(session, { sequence: 1, text: 'Approved' }, { send: async () => {}, sendTyping: async () => {} });
    assert.equal(calls, 1); assert.equal(bot.planningSessions.has('c'), false);
    bot.planningSessions.set('c', session);
    bot.showRunnerGenerator.generate = async () => ({ action: 'listen', approved: false, messageToChannel: '' });
    await bot.processPlanningSession(session, { sequence: 1, text: 'Thinking' }, {});
    assert.equal(calls, 1);
});

test('interrupted pending memory does not block launch after restart', t => {
    const { bot, session } = botFixture(t, {});
    bot.episodePlanStore.savePlan({ ...session.latestPlan, backgroundMemory: { status: 'pending' } });
    assert.equal(bot.loadEpisodePlanSelection('test-memory@v001').plan.backgroundMemory.status, 'failed');
});
