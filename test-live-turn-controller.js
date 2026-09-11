const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { LiveTurnController, LIVE_ALPHA_PROMPT } = require('./live-turn-controller');
const { GptLiveBackchannel } = require('./gpt-live-backchannel');
const { AlphaClawdVoiceBot } = require('./bot');
const { PodcastGenerator } = require('./podcast-generator');
const { VoiceManager } = require('./voice-manager');

const delegation = id => ({ type: 'session.delegation.created', offset_ms: 100, delegation: { id, target: 'client' } });
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
function controller(runAlpha = async () => ({ played: true }), extra = {}) {
    const states = [], reports = [], logs = [];
    const c = new LiveTurnController({
        runAlpha, setState: s => states.push(s), report: (id, text) => reports.push({ id, text }),
        isActive: () => true, log: e => logs.push(e), ...extra
    });
    return { c, states, reports, logs };
}

test('delegation is the sole trigger; duplicate and overlapping requests never invoke Alpha twice', async () => {
    const work = deferred(), requests = [];
    const t = controller(request => { requests.push(request); return work.promise; });
    t.c.observe({ kind: 'guest-live', text: 'Can you explain that?' });
    assert.equal(requests.length, 0);
    const pending = t.c.request(delegation('one'));
    assert.equal(requests.length, 1);
    assert.equal(await t.c.request(delegation('one')), false);
    assert.equal(await t.c.request(delegation('two')), false);
    work.resolve({ played: true });
    assert.equal(await pending, true);
    assert.deepEqual(t.states, ['holding', 'listening']);
    assert.equal(await t.c.request(delegation('three')), false);
    t.c.observe({ kind: 'guest-live', text: 'And the next part?' });
    assert.equal(await t.c.request(delegation('four')), true);
    assert.equal(requests.length, 2);
});

test('delegation waits for late context, never invents an empty request', async () => {
    const seen = [];
    const t = controller(async r => { seen.push(r.transcript); return { played: true }; });
    const pending = t.c.request(delegation('late'));
    t.c.observe({ kind: 'guest-live', text: 'What about tomorrow?' });
    assert.equal(await pending, true);
    assert.match(seen[0], /tomorrow/);
    const empty = controller(undefined, { contextWaitMs: 5 });
    assert.equal(await empty.c.request(delegation('empty')), false);
    assert.equal(empty.logs.at(-1).reason, 'missing-context');
});

test('closing while waiting or processing prevents late state changes and stale playback eligibility', async () => {
    const work = deferred();
    const t = controller(() => work.promise);
    t.c.observe({ kind: 'guest', text: 'Question' });
    const pending = t.c.request(delegation('one'));
    t.c.close();
    work.resolve({ played: true });
    assert.equal(await pending, false);
    assert.deepEqual(t.states, ['holding']);
    const waiting = controller();
    const wait = waiting.c.request(delegation('waiting'));
    waiting.c.close();
    assert.equal(await wait, false);
    assert.equal(await waiting.c.request(delegation('after')), false);
});

test('failed or declined Alpha work releases the controller without speaking a fabricated result', async () => {
    for (const run of [async () => ({ played: false }), async () => { throw new Error('failed'); }]) {
        const t = controller(run);
        t.c.observe({ kind: 'guest', text: 'Question' });
        assert.equal(await t.c.request(delegation('one')), false);
        assert.equal(t.c.busy, false);
        assert.equal(t.states.at(-1), 'listening');
        assert.ok(t.reports.every(r => r.id === 'one'));
    }
});

test('history retains full Alpha turns and exact Live fragments across muted intervals', () => {
    const t = controller();
    t.c.observe({ kind: 'guest-live', text: 'What ' });
    t.c.observe({ kind: 'guest-live', text: 'happens?' });
    t.c.observe({ kind: 'alpha', text: 'answer '.repeat(1000) + 'TAIL' });
    t.c.observe({ kind: 'guest-live', text: 'I see.' });
    assert.match(t.c.transcript(), /What happens\?/);
    assert.ok(t.c.transcript().includes('answer '.repeat(1000) + 'TAIL'));
    assert.match(t.c.transcript(), /I see/);
});

class Socket extends EventEmitter {
    constructor() { super(); this.readyState = 1; this.sent = []; }
    send(s) { this.sent.push(JSON.parse(s)); }
    event(e) { this.emit('message', Buffer.from(JSON.stringify(e))); }
    close() { this.readyState = 3; this.emit('close'); }
    terminate() { this.close(); }
}
async function transport(turnControl) {
    const socket = new Socket(), inputs = [], requests = [], audio = [], accepted = [], pushed = [];
    const c = new GptLiveBackchannel({
        apiKey: 'fake', turnControl, socketFactory: () => socket,
        mixer: { start() {}, stop() {}, push(...args) { pushed.push(args); } },
        onInputTranscript: e => inputs.push(e), onDelegation: e => requests.push(e),
        onAudio: a => audio.push(a), onInstructionsAccepted: id => accepted.push(id)
    });
    const start = c.start();
    socket.emit('open');
    socket.event({ type: 'session.started', session: { id: 's' } });
    await start;
    return { c, socket, inputs, requests, audio, accepted, pushed, async close() {
        const stop = c.stop(); socket.event({ type: 'session.closed' }); await stop;
    } };
}

test('v2 has an independent prompt, native delegation, and explicit environment transitions', async () => {
    const t = await transport(true);
    assert.equal(t.socket.sent[0].session.instructions, LIVE_ALPHA_PROMPT);
    t.socket.event(delegation('one'));
    assert.equal(t.requests.length, 1);
    t.c.setEnvironment('holding');
    t.socket.event(delegation('busy'));
    assert.equal(t.requests.length, 1);
    const handoff = t.c.requestHandoff('planned words');
    assert.equal(t.socket.sent.at(-1).type, 'session.thinking.append');
    t.socket.event({ type: 'session.thinking.appended', client_event_id: handoff });
    assert.ok(t.accepted.includes(handoff));
    t.c.setAlphaPlaying(true);
    assert.equal(t.c.environment, 'aside');
    t.c.setAlphaPlaying(false);
    assert.equal(t.c.environment, 'listening');
    t.socket.event(delegation('two'));
    assert.equal(t.requests.length, 2);
    await t.close();
});

test('v2 mute preserves input and full delivered context, with bounded context events', async () => {
    const t = await transport(true);
    t.c.setAlphaPlaying(true);
    t.c.pushAudio('guest', Buffer.alloc(640));
    t.socket.event({ type: 'session.input_transcript.delta', delta: 'Still listening', start_ms: 1, end_ms: 2 });
    t.socket.event({ type: 'session.output_audio.delta', delta: 'AAAA' });
    t.socket.event(delegation('muted'));
    assert.equal(t.pushed.length, 1);
    assert.equal(t.inputs[0].text, 'Still listening');
    assert.equal(t.audio.length, 0);
    assert.equal(t.requests.length, 0);
    const full = 'Long answer 😀 中文\n'.repeat(300) + 'THE END';
    const before = t.socket.sent.length;
    t.c.appendConversation('Alpha delivered transcript', full);
    const sent = t.socket.sent.slice(before);
    assert.ok(sent.length > 1);
    assert.ok(sent.every(e => Buffer.byteLength(e.content) < 500));
    const restored = sent.map(e => JSON.parse(e.content.slice(e.content.indexOf(': ') + 2))).join('');
    assert.equal(restored, full);
    await t.close();
});

test('default companion keeps original no-delegation behavior', async () => {
    const t = await transport(false);
    t.socket.event(delegation('one'));
    assert.equal(t.requests.length, 0);
    assert.match(t.socket.sent.at(-1).content, /No additional task was started/);
    await t.close();
});

test('existing engine remains default; experimental engine is separately selectable', () => {
    const bot = Object.create(AlphaClawdVoiceBot.prototype);
    assert.equal(bot.normalizeSessionHostMode(), 'current');
    assert.equal(bot.normalizeSessionHostMode('bad'), 'current');
    assert.equal(bot.normalizeSessionHostMode('live-alpha'), 'live-alpha');
    const join = bot.buildSlashCommands().map(c => c.toJSON()).find(c => c.name === 'podcast-join');
    assert.ok(join.options.find(o => o.name === 'engine').choices.some(c => c.value === 'live-alpha'));
});

test('live mode cannot launch Alpha from buffer or idle loop', async () => {
    const bot = Object.create(AlphaClawdVoiceBot.prototype);
    Object.assign(bot, {
        sessionHostModes: new Map([['g', 'live-alpha']]),
        getActiveGuildId: () => 'g', useGatewayGenerator: () => false
    });
    assert.equal(bot.canRunIdleDecision('g'), false);
    await bot.handleBufferFlush([{ speaker: 'Guest', transcription: 'hi' }]);
    assert.deepEqual(await bot.handleDirectGeneratorFlush('g', [], 'hi'), { played: false });
    bot.startIdleDecisionLoop('g'); // must return before touching timers
});

test('late ASR does not invalidate a Live request, but current guest speech and closed episodes do', () => {
    const bot = Object.create(AlphaClawdVoiceBot.prototype);
    Object.assign(bot, {
        isRecordingActive: () => true, didParticipantResumeSince: () => true,
        hasCurrentParticipantFloor: () => false
    });
    assert.equal(bot.discardStaleDirectResponse('g', { liveDelegation: 'one' }), false);
    assert.equal(bot.discardStaleDirectResponse('g', {}), true);
    bot.hasCurrentParticipantFloor = () => true;
    assert.equal(bot.discardStaleDirectResponse('g', { liveDelegation: 'one' }), true);
    assert.equal(bot.discardStaleDirectResponse('g', { liveController: { closed: true } }), true);
});

test('generator timing instruction changes only for an explicit Live delegation', () => {
    const g = Object.create(PodcastGenerator.prototype);
    assert.match(g.buildDecisionPrompt(), /^Produce the host turn now/);
    assert.match(g.buildDecisionPrompt({ liveDelegation: 'one' }), /Live has explicitly requested/);
    assert.match(g.buildDecisionPrompt({ liveDelegation: 'one' }), /requests to wait or stop/);
});

test('recorded Alpha context uses delivered text, never generated text from an underrun', () => {
    const seen = [], history = [];
    const host = { client: { started: true }, turnController: { observe: e => history.push(e) },
        appendConversation: (label, text) => seen.push({ label, text }) };
    const vm = { quartzBackchannels: new Map([['g', host]]) };
    VoiceManager.prototype.observeQuartzTranscript.call(vm, 'g', {
        speakerRole: 'host', speaker: 'Alpha', transcription: '[Playback underrun]',
        generatedTranscription: 'This was never fully heard.'
    });
    assert.match(seen[0].text, /Playback underrun/);
    assert.ok(!seen[0].text.includes('never fully heard'));
    assert.equal(history[0].kind, 'alpha');
});

test('Live delegation reaches the existing generator and playback with explicit turn authority', async () => {
    const bot = Object.create(AlphaClawdVoiceBot.prototype), calls = [];
    const response = { shouldRespond: true, speech: 'The substantive answer.' };
    Object.assign(bot, {
        sessionHostModes: new Map([['g', 'live-alpha']]),
        isRecordingActive: () => true, directResponseInFlight: new Set(),
        voiceManager: { updateQuartzProgress() {} },
        conversationBuffer: { setFlushHold() {} },
        getParticipantActivityVersion: () => 1, buildGeneratorTurnIdIntent: () => null,
        getAwarenessInjectionsForGeneratorTurn: async () => [], getGeneratorCallTiming: () => ({}),
        getAwarenessShelfItemsForGenerator: () => [], getEpisodePlanStructureForGenerator: () => '',
        getStagedBigBrainForGenerator: () => [], getPendingBigBrainForGenerator: () => [],
        getStagedBigHeartForGenerator: () => [], getPendingBigHeartForGenerator: () => [],
        getRecentInternalThoughtsForGenerator: () => [], getConsecutiveGeneratorSilences: () => 0,
        hasPendingBigBrain: () => false, hasPendingBigHeart: () => false,
        shouldSuppressDuplicateBigBrainStall: () => false, shouldSuppressDuplicateBigHeartStall: () => false,
        async beginGeneratorTurn(input) { calls.push(input); return response; },
        async speakDirectGeneratorResponse(g, r, options) {
            calls.push(options); return { played: true, finalResponse: r };
        },
        consumeStagedBigBrainFromResponse() {}, consumeStagedBigHeartFromResponse() {}
    });
    const result = await bot.handleDirectGeneratorFlush('g', [], 'Full convo', null, { liveDelegation: 'request-1' });
    assert.equal(result.played, true);
    assert.equal(calls[0].liveDelegation, 'request-1');
    assert.equal(calls[0].transcript, 'Full convo');
    assert.equal(calls[1].source, 'live-delegation');
    assert.equal(calls[1].playFiller, false);
    assert.equal(bot.directResponseInFlight.size, 0);
});

test('Live episode startup installs exactly one controller and no idle loop', async () => {
    const bot = Object.create(AlphaClawdVoiceBot.prototype), calls = [];
    const previous = process.env.PODCAST_LIVE_API_KEY;
    process.env.PODCAST_LIVE_API_KEY = 'fake-test-key';
    try {
        Object.assign(bot, {
            useGatewayGenerator: () => false,
            recordingState: new Map(), RecordingState: { RECORDING: 'RECORDING' },
            sessionHostModes: new Map(), recordingTextChannels: new Map(),
            consentWaiters: new Map(), speakerMap: {}, resetConsecutiveGeneratorSilences() {},
            gatewayBridge: { async disableAllCronJobs() { return []; } },
            voiceManager: {
                startRecording(g, prefix, metadata) { assert.equal(metadata.hostEngine, 'live-alpha'); return {}; },
                async startQuartzBackchannel(g, options) {
                    assert.equal(options.turnControl, true);
                    assert.equal(options.voice, 'quartz');
                    assert.equal(typeof options.runAlpha, 'function');
                    calls.push('live'); return true;
                }
            },
            startInternalThoughtSession() {}, startEpisodePlanTracker() {},
            podcastGenerator: { startSession() {} }, async speakRecordingStart() {},
            startIdleDecisionLoop() { calls.push('legacy'); },
            wsClient: { isAuthenticated: false }
        });
        await bot.grantConsent('g', 'topic', 'live-alpha');
        assert.deepEqual(calls, ['live']);
        assert.equal(bot.sessionHostModes.get('g'), 'live-alpha');
    } finally {
        if (previous === undefined) delete process.env.PODCAST_LIVE_API_KEY;
        else process.env.PODCAST_LIVE_API_KEY = previous;
    }
});

test('new backend results allow a fresh Live decision without starting Alpha themselves', async () => {
    let calls = 0;
    const t = controller(async () => { calls++; return { played: true }; });
    t.c.observe({ kind: 'guest', text: 'Please research this.' });
    await t.c.request(delegation('one'));
    t.c.backendReady('brain:1', 'Research is ready.');
    assert.equal(calls, 1);
    assert.equal(await t.c.request(delegation('two')), true);
    t.c.backendReady('brain:1', 'Research is ready.');
    assert.equal(await t.c.request(delegation('three')), false);
    assert.equal(calls, 2);
});

test('normal mode receives delivered transcript context with no Live turn controller', () => {
    const seen = [];
    const host = { client: { started: true }, appendConversation: (...args) => seen.push(args) };
    const vm = { quartzBackchannels: new Map([['g', host]]) };
    VoiceManager.prototype.observeQuartzTranscript.call(vm, 'g', {
        speakerRole: 'host', speaker: 'Alpha', transcription: 'full response '.repeat(100)
    });
    assert.equal(seen[0][0], 'Alpha delivered transcript');
    assert.equal(seen[0][1], 'Alpha: ' + 'full response '.repeat(100));
    assert.equal(host.turnController, undefined);
});
