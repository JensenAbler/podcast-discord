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

test('late timeline acknowledgment preserves backlog and measures send age separately', () => {
    let now = 0;
    const sent = [], warnings = [], accepted = [];
    const q = new LiveContextQueue({ maxAgeMs: 1000, maxPending: 1, now: () => now,
        send: e => { sent.push(e); return true; }, onLag: e => warnings.push(e), onAccepted: e => accepted.push(e) });
    try {
        q.enqueue({ event_id: 'a' }); q.enqueue({ event_id: 'b' });
        now = 5000;
        q.checkLag(); q.checkLag();
        assert.equal(warnings.length, 1, 'warn once, do not reset');
        assert.equal(q.pending.size, 1);
        q.accept('a', { start_ms: 0, end_ms: 5000 });
        assert.equal(q.pending.size, 1);
        assert.equal(q.checkLag(), false, 'queued time is not delivery time');
        now = 5500; q.accept('b');
        assert.equal(accepted[1].queueMs, 5000);
        assert.equal(accepted[1].deliveryMs, 500);
        assert.equal(q.timer, null);
    } finally { q.reset(); }
});
test('send failure resets bounded queue and invokes failure recovery', () => {
    const failures = [];
    const q = new LiveContextQueue({ send: () => false, onFailure: e => failures.push(e) });
    q.enqueue({ event_id: 'a' });
    assert.equal(failures[0].reason, 'context-send-failed');
    assert.equal(q.pending.size, 0);
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

test('slow context does not reconnect and guest transcripts never become live appends', async () => {
    const t = setup();
    try {
        await start(t);
        const before = t.sockets[0].sent.length;
        for (let i = 0; i < 391; i++) t.client.appendConversation('Guest transcript', 'speech ' + i);
        assert.equal(t.sockets[0].sent.length, before);
        t.client.contextQueue.now = () => Date.now() + 20000;
        t.client.contextQueue.checkLag();
        assert.equal(t.client.started, true);
        assert.equal(t.sockets.length, 1);
        assert.ok(t.client.recoveryHistory.length <= 64);
        const id = t.client.contextQueue.pending.keys().next().value;
        t.sockets[0].event({ type: 'session.instructions.appended', client_event_id: id });
        assert.equal(t.client.contextQueue.pending.size, 0);
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
