'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { EpisodeMemoryBuilder, buildQueries, collectPassages, searchOpenClaw, seedEpisodeMemory } = require('./episode-background-memory');
const { EpisodePlanStore } = require('./episode-plan-store');
const { AwarenessShelf } = require('./awareness-shelf');
const { AlphaClawdVoiceBot } = require('./bot');
function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'episode-memory-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}
const plan = { basename: 'test-memory', version: 'v001', guests: [{ name: 'Jensen' }], backgroundBrief: 'Improvisation and creative relationships' };
test('plan queries cover guests and every angle, without including old memory', () => {
    const queries = buildQueries({ ...plan, backgroundMemory: { text: 'OLD MEMORY' },
        phases: { opening: { angles: [{ title: 'Giving Tree', description: 'Embodied judgment' },
            { title: 'giving tree', description: 'Mutual blessing' }] } } });
    assert(queries.includes('Jensen'));
    assert(queries.includes('Giving Tree'));
    assert(queries.includes('Embodied judgment'));
    assert(queries.includes('Mutual blessing'));
    assert.equal(queries.filter(q => /giving tree/i.test(q)).length, 1);
    assert(!queries.some(q => q.includes('OLD MEMORY')));
});
test('retrieval merges overlaps and retains exact full source text beyond former budgets', async t => {
    const root = fixture(t);
    const lines = ['# Test episode', ...Array.from({ length: 100 }, (_, i) => 'Jensen: ' + i + ' ' + 'speech '.repeat(100))];
    const filename = path.join(root, 'episode-one.md');
    fs.writeFileSync(filename, lines.join('\n'));
    const builder = new EpisodeMemoryBuilder({ root, workspace: root, search: async () => [
        { path: filename, startLine: 20, endLine: 50 },
        { path: filename, startLine: 40, endLine: 80 },
        { path: '/private/memory.md', startLine: 1, endLine: 10 }
    ] });
    const result = await builder.build(plan);
    assert.equal(result.memories.length, 1);
    assert.equal(result.memories[0].text, lines.slice(7, 92).join('\n'));
    assert(result.memories[0].text.length > 45000);
    assert.equal(result.sources[0].startLine, 8);
    assert.equal(result.sources[0].endLine, 92);
    assert.equal(result.sources[0].title, 'Test episode');
    assert.equal(result.sources[0].sha256.length, 64);
    const shelf = new AwarenessShelf({ enabled: true }); shelf.startSession('g');
    seedEpisodeMemory({ addAwarenessShelfItem: (...args) => shelf.addItem(...args) }, 'g', { ...plan, backgroundMemory: result });
    assert(shelf.presentItemsForGenerator('g')[0].text.includes(result.memories[0].text));
});
test('disjoint passages stay separate and sources outside podcast root are excluded', t => {
    const root = fixture(t);
    fs.writeFileSync(path.join(root, 'episode-one.md'), Array.from({ length: 100 }, (_, i) => 'Alpha: ' + i).join('\n'));
    fs.symlinkSync('/etc/passwd', path.join(root, 'episode-link.md'));
    const output = collectPassages([
        { path: 'episode-one.md', startLine: 2, endLine: 3 },
        { path: 'episode-one.md', startLine: 70, endLine: 72 },
        { path: 'episode-link.md', startLine: 1, endLine: 2 },
        { path: 'MEMORY.md', startLine: 1, endLine: 2 }
    ], { root, workspace: root, contextLines: 0 });
    assert.equal(output.memories.length, 2);
    assert.equal(output.memories[0].text, 'Alpha: 1\nAlpha: 2');
    assert.equal(output.memories[1].text, 'Alpha: 69\nAlpha: 70\nAlpha: 71');
});
test('empty retrieval succeeds; search failures and stale source ranges are surfaced', async t => {
    const root = fixture(t);
    const builder = new EpisodeMemoryBuilder({ root, workspace: root, search: async () => [] });
    assert.deepEqual((await builder.build(plan)).memories, []);
    builder.search = async () => { throw Error('search unavailable'); };
    await assert.rejects(builder.build(plan), /search unavailable/);
    fs.writeFileSync(path.join(root, 'episode-one.md'), 'Short source');
    assert.throws(() => collectPassages([{ path: 'episode-one.md', startLine: 2, endLine: 5 }],
        { root, workspace: root }), /stale/);
});
test('OpenClaw adapter passes query as one argument and reads JSON without a model call', async t => {
    const root = fixture(t), command = path.join(root, 'openclaw');
    fs.writeFileSync(command, '#!/usr/bin/env node\n' +
        'const a = process.argv.slice(2);\n' +
        'if (a[0] !== "memory" || a[1] !== "search" || a[3] !== "literal ; query") process.exit(2);\n' +
        'console.log(JSON.stringify({results: [{path: "episode-one.md", startLine: 1, endLine: 2}]}));\n',
        { mode: 0o755 });
    assert.equal((await searchOpenClaw('literal ; query', { command, workspace: root }))[0].startLine, 1);
    await assert.rejects(searchOpenClaw('wrong', { command, workspace: root }), /failed/);
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
    assert.match(memory.text, /Sources: Past podcast episode — timestamp unavailable/);
    assert.doesNotMatch(memory.text, /episode-1#part-1/);
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

test('generator compact context preserves full episode memory under transient shelf pressure', () => {
    const { PodcastGenerator } = require('./podcast-generator');
    const generator = Object.create(PodcastGenerator.prototype);
    const memory = { id: 'episode-background-memory', scope: 'episode', text: 'source '.repeat(10000) };
    const transient = Array.from({ length: 9 }, (_, i) => ({ id: 't' + i, text: 'Transient ' + i }));
    const compact = generator.compactAwarenessShelfItems([memory, ...transient]);
    assert.equal(compact.length, 8);
    assert.equal(compact[0], memory);
    assert(generator.formatAwarenessShelfItems(compact).includes(memory.text.trim()));
});

test('shelf replaces internal file and line IDs with episode and timestamp citations', t => {
    const root = fixture(t), filename = path.join(root, 'episode-citation.md');
    fs.writeFileSync(filename, ['# Giving Tree', 'Episode: 9', '## CONVERSATION — original recording',
        '00:01:37 Jensen: I was wrapping up with the Giving Tree.',
        '00:02:04 Jensen: I did the job.'].join('\n'));
    const memory = collectPassages([{ path: filename, startLine: 4, endLine: 5 }],
        { root, workspace: root, contextLines: 0 });
    const shelf = new AwarenessShelf({ enabled: true }); shelf.startSession('g');
    const item = seedEpisodeMemory({ addAwarenessShelfItem: (...args) => shelf.addItem(...args) }, 'g',
        { backgroundMemory: { status: 'ready', ...memory } });
    assert.match(item.text, /Sources: Episode 9 — 00:01:37–00:02:04 \(conversation recording\)/);
    assert.doesNotMatch(item.text, /episode-citation|\.md|:L4-5/);
    assert.equal(memory.sources[0].id, 'episode-citation.md:L4-5');
    assert(item.text.includes(memory.memories[0].text));
});
test('untimed scripts and untimed outros do not acquire invented timestamps', () => {
    const { describeSource, formatSourceCitation } = require('./episode-background-memory');
    const lines = ['Episode: 0', '## Original production script', 'HOST: Hello'];
    assert.equal(formatSourceCitation(describeSource(lines, 2, 3)), 'Episode 0 — timestamp unavailable');
    const outro = ['Episode: 9', '## CONVERSATION — original recording', '00:01:00 Jensen: Hello',
        '## OUTRO', 'Alpha: Goodbye'];
    assert.equal(formatSourceCitation(describeSource(outro, 4, 5)), 'Episode 9 — timestamp unavailable');
    assert.equal(formatSourceCitation(describeSource(outro, 3, 3)), 'Episode 9 — 00:01:00 (conversation recording)');
});
