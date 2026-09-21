'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { batchSpeech, JevSpeechJudge } = require('./jev-speech-batcher');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function collect(stream) { const out = []; for await (const text of stream) out.push(text); return out; }
function channel() {
    const items = []; let waiting; let ended = false;
    return {
        push(value) { if (waiting) { const w = waiting; waiting = null; w({ value, done: false }); } else items.push(value); },
        end() { ended = true; if (waiting) { waiting({ done: true }); waiting = null; } },
        [Symbol.asyncIterator]() { return this; },
        next() { return items.length ? Promise.resolve({ value: items.shift(), done: false }) :
            ended ? Promise.resolve({ done: true }) : new Promise(resolve => { waiting = resolve; }); },
        return() { this.end(); return Promise.resolve({ done: true }); }
    };
}
const allow = async () => ({ natural: 0.99, cost: 0, confidence: 0.99 });
const hold = async () => ({ natural: 0.05, cost: 2.8, confidence: 0.99 });

test('Jev can hold an unfinished clause while the source keeps streaming', async () => {
    const input = channel(); const seen = [];
    const out = collect(batchSpeech(input, { targetChars: 20, firstWaitMs: 150, judge: async state => {
        seen.push(state); await delay(20); return hold();
    }}));
    input.push('I would have said yes because ');
    await delay(30);
    input.push('it mattered to me. ');
    input.end();
    assert.deepEqual(await out, ['I would have said yes because it mattered to me. ']);
    assert.equal(seen.length, 1);
});

test('a natural short clause is released before generation completes', async () => {
    const input = channel();
    const stream = batchSpeech(input, { targetChars: 20, judge: allow });
    const first = stream.next();
    input.push('That sounds fine to me, ');
    assert.equal((await first).value, 'That sounds fine to me, ');
    input.push('and here is why.');
    input.end();
    assert.equal((await collect(stream)).join(''), 'and here is why.');
});

test('a hanging judge and stalled source cannot exceed the buffer deadline', async () => {
    const input = channel();
    const stream = batchSpeech(input, { targetChars: 20, firstWaitMs: 35, judge: () => new Promise(() => {}) });
    const begin = Date.now();
    const first = stream.next();
    input.push('This is an unfinished clause because ');
    assert.ok((await first).value);
    assert.ok(Date.now() - begin < 180);
    input.end();
    await collect(stream);
});

test('stream completion discards late judgments and emits exactly once', async () => {
    const input = channel(); let resolveJudge;
    const out = collect(batchSpeech(input, { targetChars: 20,
        judge: () => new Promise(resolve => { resolveJudge = resolve; }) }));
    input.push('A phrase that continues ');
    await delay(5);
    input.push('to its end.');
    input.end();
    assert.equal((await out).join(''), 'A phrase that continues to its end.');
    resolveJudge?.(await allow());
});

test('errors fall back, preserve every character, and do not retry per batch', async () => {
    const input = channel(); let calls = 0;
    const out = collect(batchSpeech(input, { targetChars: 20, judge: async () => { calls++; throw Error('offline'); }}));
    input.push('This is a reasonably long beginning ');
    await delay(10);
    input.push('and this is the rest with café and 🙂.');
    input.end();
    assert.equal((await out).join(''), 'This is a reasonably long beginning and this is the rest with café and 🙂.');
    assert.equal(calls, 1);
});

test('new tokens do not reset the maximum wait', async () => {
    const input = channel();
    const stream = batchSpeech(input, { targetChars: 20, firstWaitMs: 40, judge: hold });
    const begin = Date.now(); const first = stream.next();
    input.push('because we were waiting ');
    const interval = setInterval(() => input.push('and '), 5);
    try {
        assert.ok((await first).value);
        assert.ok(Date.now() - begin < 170);
    } finally { clearInterval(interval); input.end(); await collect(stream); }
});

test('abbreviations and inline tags survive fragmented input', async () => {
    const input = channel();
    const out = collect(batchSpeech(input, { targetChars: 200, judge: hold }));
    input.push('[soft');
    input.push('ly] Dr. ');
    await delay(5);
    input.push('Smith met J. R. Jones. ');
    input.end();
    assert.deepEqual(await out, ['[softly] Dr. Smith met J. R. Jones. ']);
});

test('cancellation aborts the in-flight judge and returns promptly', async () => {
    const input = channel(); const controller = new AbortController(); let judgeSignal;
    const stream = batchSpeech(input, { targetChars: 20, signal: controller.signal,
        judge: (_, signal) => { judgeSignal = signal; return new Promise(() => {}); } });
    const first = stream.next();
    input.push('A reasonably long pending phrase ');
    await delay(5);
    controller.abort();
    assert.equal((await first).done, true);
    assert.equal(judgeSignal.aborted, true);
});

test('upstream errors remain errors, not successful completed speech', async () => {
    const input = (async function* () { yield 'Partial'; throw Error('generation failed'); })();
    await assert.rejects(collect(batchSpeech(input, { judge: allow })), /generation failed/);
});

test('client sends documented API shape and validates numeric results', async () => {
    let payload;
    const client = new JevSpeechJudge({ apiKey: 'test-only', fetch: async (url, options) => {
        assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
        payload = JSON.parse(options.body);
        return { ok: true, json: async () => ({ answers: {
            natural_boundary: { type: 'noul', noul: 0.94 },
            split_cost: { type: 'score', score: 0.2, confidence: 0.8 }
        } }) };
    } });
    assert.deepEqual(await client.evaluate({ candidate: 'Hello, ' }), { natural: 0.94, cost: 0.2, confidence: 0.8 });
    assert.equal(payload.questions.natural_boundary.type, 'noul');
    assert.equal(payload.questions.split_cost.criteria.length, 4);
    client.fetch = async () => ({ ok: true, json: async () => ({ answers: {} }) });
    await assert.rejects(client.evaluate({}), /Invalid Jev answer/);
    assert.equal(client.available, false);
});

test('client timeout works even if transport ignores abort', async () => {
    const client = new JevSpeechJudge({ apiKey: 'test-only', timeoutMs: 15, fetch: () => new Promise(() => {}) });
    await assert.rejects(client.evaluate({}), /deadline/);
    assert.equal(client.available, false);
});

test('the existing Fish path remains unchanged before activation', async () => {
    const { FishAudioProvider } = require('./fish-audio-provider');
    const provider = new FishAudioProvider({ apiKey: 'test-only' });
    const events = [];
    provider.sendWebSocketEvent = (_, event) => events.push(event);
    await provider.sendStreamingText({}, {}, ['Hello. ', 'Another thought.']);
    assert.deepEqual(events.map(e => e.event), ['start', 'text', 'text', 'flush', 'stop']);
});

test('remaining text keeps its own arrival time after an earlier sentence is released', async () => {
    const input = channel(); const events = [];
    const stream = batchSpeech(input, { targetChars: 200, firstWaitMs: 150, maxWaitMs: 80,
        judge: hold, onEvent: event => events.push(event) });
    const first = stream.next();
    input.push('First ');
    await delay(60);
    input.push('sentence. Another unfinished clause ');
    assert.equal((await first).value, 'First sentence. ');
    const start = Date.now();
    const second = await stream.next();
    assert.ok(Date.now() - start >= 55, 'remainder must not inherit the first sentence age');
    assert.ok(second.value);
    input.end(); await collect(stream);
});

test('semantic Fish mode flushes each batch, preserving the legacy event sequence when disabled', async () => {
    const { FishAudioProvider } = require('./fish-audio-provider');
    const p = new FishAudioProvider({ apiKey: 'test-only', semanticBatching: false });
    const events = [];
    p.sendWebSocketEvent = (_, event) => events.push(event);
    await p.sendStreamingText({}, {}, ['One. ', 'Two.'], { flushEachText: true });
    assert.deepEqual(events.map(e => e.event), ['start','text','flush','text','flush','stop']);
});

test('provider enables batching only with a key and preserves text into Fish', async () => {
    const { FishAudioProvider } = require('./fish-audio-provider');
    const { EventEmitter } = require('events');
    const p = new FishAudioProvider({ apiKey: 'test-only', semanticBatching: true,
        jevJudge: { apiKey: 'synthetic', available: true, evaluate: allow } });
    const ws = new EventEmitter(); ws.close = () => {};
    p.createWebSocketAudioConnection = () => ({ ws });
    let request, sent = '';
    p.streamWebSocketAudio = async function* (r, stream, connection, options) {
        request = r; assert.equal(options.flushEachText, true);
        for await (const text of stream) sent += text;
        yield Buffer.from('fake audio');
    };
    await collect(p.createStreamingAudio(['[softly] Hello. ', 'The rest.']));
    assert.equal(request.chunk_length, 300);
    assert.equal(sent, '[softly] Hello. The rest.');
});

test('closing Fish while waiting for the first text cancels semantic buffering', async () => {
    const { FishAudioProvider } = require('./fish-audio-provider');
    const { EventEmitter } = require('events');
    const p = new FishAudioProvider({ apiKey: 'test-only', semanticBatching: true,
        jevJudge: { apiKey: 'synthetic', available: true, evaluate: allow } });
    const ws = new EventEmitter(); ws.close = () => {};
    p.createWebSocketAudioConnection = () => ({ ws });
    const input = channel(); const stream = p.createStreamingAudio(input);
    const pending = stream.next();
    setTimeout(() => ws.emit('close'), 5);
    await assert.rejects(pending, /at least one non-empty/);
});
