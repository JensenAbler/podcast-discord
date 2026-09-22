'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { EpisodeMemoryBuilder, EpisodeMemoryGenerator, PassageStore, validateMemories, collectPassages, searchOpenClaw, seedEpisodeMemory } = require('./episode-background-memory');
const { EpisodePlanStore } = require('./episode-plan-store');
const { AwarenessShelf } = require('./awareness-shelf');
const { AlphaClawdVoiceBot } = require('./bot');
function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'episode-memory-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}
const plan = { basename: 'test-memory', version: 'v001', guests: [{ name: 'Jensen' }], backgroundBrief: 'Improvisation and creative relationships' };

function decision(action, fields = {}) {
    return { action, queries: [], expansions: [], memories: [], ...fields };
}
function scripted(steps) {
    return { calls: [], async decide(stage, messages) {
        this.calls.push({ stage, messages: JSON.parse(JSON.stringify(messages)) });
        const step = steps.shift();
        assert(step, 'Unexpected model call');
        assert.equal(stage, step.stage);
        return { decision: await step.run(messages), usage: { prompt_tokens: 123, completion_tokens: 45 } };
    } };
}
function sourceFixture(t) {
    const root = fixture(t);
    const lines = ['# Test episode', 'Episode: 9', '## CONVERSATION — original recording',
        ...Array.from({ length: 100 }, (_, i) => '00:01:' + String(i % 60).padStart(2, '0') + ' Jensen: Unique line ' + (i + 4))];
    const filename = path.join(root, 'episode-one.md');
    fs.writeFileSync(filename, lines.join('\n'));
    return { root, lines, filename };
}
test('focused model queries replace per-field searches; overlaps merge before review; only requested context expands', async t => {
    const { root, lines, filename } = sourceFixture(t);
    const ids = [];
    const generator = scripted([
        { stage: 'search', run: messages => {
            assert(!JSON.stringify(messages).includes('OLD MEMORY'));
            assert(JSON.stringify(messages).includes(plan.backgroundBrief));
            return decision('search', { queries: ['Jensen embodied judgment', 'jensen   embodied judgment'] });
        } },
        { stage: 'review', run: messages => {
            const input = JSON.parse(messages.at(-1).content);
            assert.equal(input.excerpts.length, 1);
            const source = input.excerpts[0];
            assert.equal(source.text, lines.slice(19, 35).join('\n'));
            assert.equal(input.searches[0].results[0].score, 0.7);
            ids.push(source.id);
            return decision('expand', { expansions: [
                { sourceId: source.id, beforeLines: 3, afterLines: 4 },
                { sourceId: source.id, beforeLines: 1, afterLines: 2 }
            ] });
        } },
        { stage: 'review', run: messages => {
            const excerpts = JSON.parse(messages.at(-1).content).excerpts;
            assert.deepEqual(excerpts.map(x => [x.startLine, x.endLine]), [[17, 19], [36, 39]]);
            assert.equal(excerpts[0].text, lines.slice(16, 19).join('\n'));
            assert.equal(excerpts[1].text, lines.slice(35, 39).join('\n'));
            ids.push(...excerpts.map(x => x.id));
            // Continue from the new boundary without repeating any prior text.
            return decision('expand', { expansions: [{ sourceId: excerpts[1].id, beforeLines: 20, afterLines: 2 }] });
        } },
        { stage: 'review', run: messages => {
            const excerpts = JSON.parse(messages.at(-1).content).excerpts;
            assert.deepEqual(excerpts.map(x => [x.startLine, x.endLine]), [[16, 16], [40, 41]]);
            ids.push(...excerpts.map(x => x.id));
            return decision('select', { memories: [{ text: 'A meaningful connection.', sourceIds: ids }] });
        } },
        { stage: 'consolidate', run: messages => {
            assert(!JSON.stringify(messages).includes('Unique line'));
            return decision('consolidate', { memories: [{ text: 'A meaningful connection.', sourceIds: ids }] });
        } }
    ]);
    const queries = [];
    const result = await new EpisodeMemoryBuilder({ root, workspace: root, generator, search: async query => {
        queries.push(query);
        return [
            { path: filename, startLine: 20, endLine: 30, score: 0.7, vectorScore: 0.6, textScore: 0.8 },
            { path: filename, startLine: 25, endLine: 35, score: 0.65 },
            { path: '/private/memory.md', startLine: 1, endLine: 5 }
        ];
    } }).build({ ...plan, backgroundMemory: { text: 'OLD MEMORY' } });
    assert.deepEqual(queries, ['jensen embodied judgment']);
    assert.equal(result.schemaVersion, 4);
    assert.equal(result.audit.excerpts.map(x => x.text).join('\n').split('\n').length, 26);
    assert.equal(new Set(result.audit.excerpts.flatMap(x => x.text.split('\n'))).size, 26);
    assert.equal(result.audit.calls.length, 5);
    assert.equal(result.audit.searches[0].results[0].vectorScore, 0.6);
    assert.equal(result.audit.metrics.uniqueCharacters,
        result.audit.excerpts.reduce((sum, x) => sum + x.text.length, 0));
    assert.equal(result.sources.length, 5);
    assert.equal(result.memories[0].text, 'A meaningful connection.');
    const shelf = new AwarenessShelf({ enabled: true }); shelf.startSession('g');
    const item = seedEpisodeMemory({ addAwarenessShelfItem: (...args) => shelf.addItem(...args) }, 'g',
        { backgroundMemory: result });
    assert.match(item.text, /Episode 9 —/);
    assert.doesNotMatch(item.text, /\.md|Unique line/);
});
test('model can choose no searches or no memories without filling a quota', async t => {
    const { root, filename } = sourceFixture(t);
    const generator = scripted([{ stage: 'search', run: () => decision('search') }]);
    const result = await new EpisodeMemoryBuilder({ root, workspace: root, generator,
        search: async () => assert.fail('No search requested') }).build(plan);
    assert.deepEqual(result.memories, []);
    const emptySearch = scripted([{ stage: 'search', run: () => decision('search', { queries: ['useful context'] }) }]);
    assert.deepEqual((await new EpisodeMemoryBuilder({ root, workspace: root, generator: emptySearch,
        search: async () => [] }).build(plan)).memories, []);
    const noRelevant = scripted([
        { stage: 'search', run: () => decision('search', { queries: ['useful context'] }) },
        { stage: 'review', run: () => decision('select') }
    ]);
    assert.deepEqual((await new EpisodeMemoryBuilder({ root, workspace: root, generator: noRelevant,
        search: async () => [{ path: filename, startLine: 20, endLine: 21 }] }).build(plan)).memories, []);
});
test('memory count and length are not capped during selection or consolidation', async t => {
    const { root, filename } = sourceFixture(t);
    let memories;
    const generator = scripted([
        { stage: 'search', run: () => decision('search', { queries: ['creative context'] }) },
        { stage: 'review', run: messages => {
            const source = JSON.parse(messages.at(-1).content).excerpts[0];
            memories = Array.from({ length: 9 }, (_, i) => ({ text: i + ' detailed context'.repeat(150), sourceIds: [source.id] }));
            return decision('select', { memories });
        } },
        { stage: 'consolidate', run: () => decision('consolidate', { memories }) }
    ]);
    const result = await new EpisodeMemoryBuilder({ root, workspace: root, generator,
        search: async () => [{ path: filename, startLine: 20, endLine: 21 }] }).build(plan);
    assert.equal(result.memories.length, 9);
    assert(result.audit.metrics.finalCharacters > 7000);
});
test('source boundaries clamp; repeated/overlapping expansion does not duplicate text; snapshots stay stable', t => {
    const { root, filename, lines } = sourceFixture(t);
    const store = new PassageStore({ root, workspace: root });
    const source = store.add([store.acceptHit({ path: filename, startLine: 2, endLine: 3 })])[0];
    fs.writeFileSync(filename, 'Changed after initial retrieval');
    const expanded = store.expand([{ sourceId: source.id, beforeLines: 1000, afterLines: 1000 }]);
    assert.deepEqual(expanded.map(s => [s.startLine, s.endLine]), [[1, 1], [4, lines.length]]);
    assert.equal(expanded[1].text, lines.slice(3).join('\n'));
    assert.deepEqual(store.expand([{ sourceId: source.id, beforeLines: 1000, afterLines: 1000 }]), []);
    assert.throws(() => store.expand([{ sourceId: 'invented', beforeLines: 1, afterLines: 1 }]), /Unknown/);
});
test('private sources and symlinks outside the corpus are excluded; stale ranges fail', t => {
    const { root, filename } = sourceFixture(t);
    fs.symlinkSync('/etc/passwd', path.join(root, 'episode-link.md'));
    const store = new PassageStore({ root, workspace: root });
    assert.equal(store.acceptHit({ path: 'episode-link.md', startLine: 1, endLine: 2 }), null);
    assert.equal(store.acceptHit({ path: 'MEMORY.md', startLine: 1, endLine: 2 }), null);
    assert.throws(() => store.acceptHit({ path: filename, startLine: 1, endLine: 1000 }), /stale/);
    assert.throws(() => store.acceptHit({ path: filename, startLine: 0, endLine: 2 }), /Invalid/);
});
test('invalid citations, invalid expansions, and repeated no-progress requests fail explicitly', async t => {
    const { root, filename } = sourceFixture(t);
    for (const kind of ['citation', 'negative', 'unknown', 'no-progress']) {
        const generator = scripted([
            { stage: 'search', run: () => decision('search', { queries: ['context'] }) },
            { stage: 'review', run: messages => {
                const sourceId = JSON.parse(messages.at(-1).content).excerpts[0].id;
                if (kind === 'citation') return decision('select', { memories: [{ text: 'Invented', sourceIds: ['bad'] }] });
                return decision('expand', { expansions: [{ sourceId: kind === 'unknown' ? 'bad' : sourceId,
                    beforeLines: kind === 'negative' ? -1 : 1, afterLines: 1 }] });
            } }
        ]);
        await assert.rejects(new EpisodeMemoryBuilder({ root, workspace: root, generator,
            search: async () => [{ path: filename, startLine: 1, endLine: 103 }] }).build(plan),
            /invalid|Invalid|Unknown|no progress/);
    }
    assert.throws(() => validateMemories([{ text: 'x', sourceIds: [] }], new Set()), /invalid/);
});
test('search failures do not fall back to a raw archive dump', async t => {
    const root = fixture(t);
    const generator = scripted([{ stage: 'search', run: () => decision('search', { queries: ['context'] }) }]);
    await assert.rejects(new EpisodeMemoryBuilder({ root, workspace: root, generator,
        search: async () => { throw Error('search unavailable'); } }).build(plan), /search unavailable/);
});
test('memory model uses provider-native output maximum and retries truncated output without partial actions', async () => {
    const generator = new EpisodeMemoryGenerator({ apiKey: 'test', baseUrl: 'https://api.anthropic.com/v1', model: 'test' });
    generator.fetchModelOutputLimit = async () => 128000;
    const requests = [];
    generator.fetchCompletion = async messages => {
        requests.push(JSON.stringify(messages));
        const body = generator.buildRequestBody(messages);
        assert.equal(body.max_completion_tokens, 128000);
        const expansion = body.response_format.json_schema.schema.properties.expansions.items.properties;
        assert.deepEqual(expansion.beforeLines, { type: 'integer' });
        assert.deepEqual(expansion.afterLines, { type: 'integer' });
        return { choices: [{ finish_reason: requests.length === 1 ? 'max_tokens' : 'end_turn',
            message: { content: JSON.stringify(decision('search', { queries: ['focused query'] })) } }] };
    };
    const result = await generator.decide('search', [{ role: 'user', content: 'Plan' }]);
    assert.equal(result.decision.queries[0], 'focused query');
    assert.equal(requests.length, 2);
    assert.equal(requests[0], requests[1]);
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
