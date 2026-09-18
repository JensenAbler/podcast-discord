const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { LiveContextQueue } = require('./live-context-queue');
const { GptLiveBackchannel } = require('./gpt-live-backchannel');

test('full resume-sized context survives while acknowledgments keep up', () => {
    let now = 0;
    const sent = [], lag = [];
    const q = new LiveContextQueue({ maxAgeMs: 1000, now: () => now, send: e => { sent.push(e); return true; }, onLag: e => lag.push(e) });
    try {
        for (let i = 0; i < 469; i++) q.enqueue({ event_id: String(i), content: 'complete item ' + i });
        assert.equal(sent.length, 4, 'never flood the provider');
        assert.equal(q.waiting.length, 465, 'keep every item before lag');
        while (q.pending.size) {
            now += 1;
            q.accept(q.pending.keys().next().value);
            assert.ok(q.pending.size <= 4);
        }
        assert.deepEqual(sent.map(x => x.content), Array.from({ length: 469 }, (_, i) => 'complete item ' + i));
        assert.equal(lag.length, 0);
        assert.equal(q.timer, null);
    } finally { q.reset(); }
});

test('no trimming before deadline, and a late acknowledgment cannot revive the backlog', () => {
    let now = 0;
    const sent = [], lag = [];
    const q = new LiveContextQueue({ maxAgeMs: 1000, now: () => now, send: e => { sent.push(e); return true; }, onLag: e => lag.push(e) });
    for (let i = 0; i < 469; i++) q.enqueue({ event_id: String(i) });
    now = 999;
    assert.equal(q.checkLag(), false);
    assert.equal(q.waiting.length, 465);
    now = 1000;
    q.accept('0');
    assert.equal(lag.length, 1);
    assert.equal(lag[0].reason, 'context-delivery-lag');
    assert.equal(q.pending.size + q.waiting.length, 0);
    q.accept('1');
    assert.equal(sent.length, 4);
    assert.equal(q.timer, null);
});

class Socket extends EventEmitter {
    constructor() { super(); this.readyState = 0; this.sent = []; }
    send(s) { this.sent.push(JSON.parse(s)); }
    open() { this.readyState = 1; this.emit('open'); }
    event(e) { this.emit('message', Buffer.from(JSON.stringify(e))); }
    terminate() { if (this.readyState === 3) return; this.readyState = 3; this.emit('close'); }
    close() { this.terminate(); }
}
const tick = () => new Promise(r => setTimeout(r, 5));
async function waitFor(f) {
    for (let i = 0; i < 100; i++) { if (f()) return; await tick(); }
    assert.fail('condition did not arrive');
}
function setup() {
    const sockets = [], audio = [], logs = [];
    const client = new GptLiveBackchannel({
        apiKey: 'fake', reconnectDelayMs: 1, closeTimeoutMs: 1, contextMaxAgeMs: 1000,
        socketFactory: () => { const s = new Socket(); sockets.push(s); return s; },
        mixer: { start() {}, stop() {}, push() {} },
        onAudio: x => audio.push(x), onLog: x => logs.push(x), onError() {}
    });
    return { client, sockets, audio, logs };
}
async function start(t) {
    const ready = t.client.start();
    t.sockets[0].open();
    t.sockets[0].event({ type: 'session.started', session: { id: 'original' } });
    await ready;
}

test('slow context resets session, uses freshest text, resumes live audio, and rejects old socket events', async () => {
    const t = setup();
    try {
        await start(t);
        const first = t.sockets[0];
        for (let i = 0; i < 391; i++) t.client.appendConversation('Previous episode', 'old speech ' + i);
        assert.equal(first.sent.filter(e => e.type === 'session.thinking.append').length, 4);
        // Advance the scheduler's measured age without waiting on wall-clock time.
        t.client.contextQueue.now = () => Date.now() + 1001;
        t.client.contextQueue.checkLag();
        assert.equal(first.readyState, 3);
        t.client.appendConversation('Latest guest', 'CURRENT QUESTION');
        await waitFor(() => t.sockets.length === 2);
        const second = t.sockets[1];
        second.open();
        second.event({ type: 'session.started', session: { id: 'fresh' } });
        const context = second.sent.filter(e => e.type === 'session.thinking.append');
        assert.ok(context.some(e => e.content.includes('CURRENT QUESTION')));
        assert.ok(!context.some(e => e.content.includes('old speech')));
        const audio = { type: 'session.output_audio.delta', delta: Buffer.alloc(640, 10).toString('base64') };
        first.event(audio);
        assert.equal(t.audio.length, 0);
        second.event(audio);
        assert.equal(t.audio.length, 1);
        assert.ok(t.logs.some(x => x.startsWith('Context recovery:')));
        assert.equal(t.client.contextQueue.waiting.length, 0);
        // Once recovered, new healthy turns are complete, not permanently windowed.
        for (const e of [...second.sent]) {
            if (e.event_id) second.event({ type: 'session.thinking.appended', client_event_id: e.event_id });
        }
        const full = 'A detailed new answer. '.repeat(100) + 'FINAL DETAIL';
        const before = second.sent.length;
        t.client.appendConversation('Alpha delivered transcript', full);
        while (t.client.contextQueue.pending.size) {
            second.event({ type: 'session.thinking.appended',
                client_event_id: t.client.contextQueue.pending.keys().next().value });
        }
        const delivered = second.sent.slice(before).filter(e => e.content?.startsWith('Conversation data'));
        assert.equal(delivered.map(e => JSON.parse(e.content.slice(e.content.indexOf(': ') + 2))).join(''), full);
    } finally { await t.client.stop(); }
});

test('provider overload recovers without transcript replay; shutdown cancels retries', async () => {
    const t = setup();
    await start(t);
    t.client.appendConversation('Latest', 'latest only');
    t.sockets[0].event({ type: 'error', error: { code: 'too_many_pending_appends' } });
    assert.equal(t.sockets[0].readyState, 3);
    assert.ok(t.client.reconnectTimer);
    await t.client.stop();
    await tick();
    assert.equal(t.sockets.length, 1);
    assert.equal(t.client.contextQueue.timer, null);
});

test('ordinary vocal silence with acknowledged context never triggers a reset', async () => {
    const t = setup();
    try {
        await start(t);
        const event = t.sockets[0].sent.find(e => e.event_id);
        t.sockets[0].event({ type: 'session.thinking.appended', client_event_id: event.event_id });
        t.client.contextQueue.now = () => Date.now() + 100000;
        assert.equal(t.client.contextQueue.checkLag(), false);
        assert.equal(t.client.started, true);
        assert.equal(t.sockets.length, 1);
    } finally { await t.client.stop(); }
});
