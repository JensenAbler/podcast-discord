const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { GptLiveBackchannel, BACKCHANNEL_PROMPT } = require('./gpt-live-backchannel');
const { QuartzPlayback } = require('./quartz-playback');
const { VoiceManager } = require('./voice-manager');

class Socket extends EventEmitter {
    constructor() { super(); this.readyState = 0; this.sent = []; }
    send(json) { this.sent.push(JSON.parse(json)); }
    close() { this.readyState = 3; this.emit('close'); }
    terminate() { this.close(); }
    open() { this.readyState = 1; this.emit('open'); }
    event(event) { this.emit('message', Buffer.from(JSON.stringify(event))); }
}
function transport() {
    const socket = new Socket();
    const audio = [], transcripts = [], errors = [];
    let mixerRunning = false;
    const client = new GptLiveBackchannel({
        apiKey: 'test-secret', socketFactory: (url, options) => {
            assert.equal(url, 'wss://api.openai.com/v1/live/sessions');
            assert.equal(options.headers.Authorization, 'Bearer test-secret');
            return socket;
        },
        mixer: { start() { mixerRunning = true; }, stop() { mixerRunning = false; }, push() {} },
        onAudio: x => audio.push(x), onTranscript: x => transcripts.push(x), onError: x => errors.push(x),
        closeTimeoutMs: 10
    });
    return { client, socket, audio, transcripts, errors, running: () => mixerRunning };
}
async function connected(t) {
    const started = t.client.start();
    t.socket.open();
    assert.equal(t.socket.sent[0].session.audio.output.voice, 'quartz');
    assert.equal(t.socket.sent[0].session.audio.format.rate, 16000);
    t.socket.event({ type: 'session.started', session: { id: 'test-session' } });
    await started;
}
test('Live receives continuously, gates output only, and preserves transcripts as observations', async () => {
    const t = transport();
    await connected(t);
    assert.equal(t.running(), true);
    const event = { type: 'session.output_audio.delta', delta: Buffer.from([1, 2]).toString('base64') };
    t.socket.event(event);
    t.client.setAlphaPlaying(true);
    t.socket.event(event);
    t.socket.event({ type: 'session.output_transcript.delta', delta: 'yeah', start_ms: 0, end_ms: 100 });
    assert.equal(t.audio.length, 1);
    assert.equal(t.transcripts[0].playbackBlocked, true);
    assert.equal(t.running(), true);
    t.client.setAlphaPlaying(false);
    assert.equal(t.audio.length, 1); // blocked audio was not replayed
    t.socket.event(event);
    assert.equal(t.audio.length, 2);
    const stop = t.client.stop();
    assert.equal(t.socket.sent.at(-1).type, 'session.close');
    t.socket.event({ type: 'session.closed', usage: { seconds: 1 } });
    await stop;
    assert.equal(t.running(), false);
});
test('delegation cannot trigger duplicate backend work; role prompt stays acknowledgment-only', async () => {
    const t = transport(); await connected(t);
    t.socket.event({ type: 'session.delegation.created', delegation: { id: 'd1' } });
    assert.equal(t.socket.sent.at(-1).type, 'session.instructions.append');
    assert.ok(!t.socket.sent.some(e => e.type === 'response.create'));
    assert.match(BACKCHANNEL_PROMPT, /every substantial answer/);
    assert.match(BACKCHANNEL_PROMPT, /Comfortable silence is welcome/);
    const stop = t.client.stop(); t.socket.event({ type: 'session.closed' }); await stop;
});
test('stop during pending startup settles and does not start a late session', async () => {
    const t = transport();
    const start = t.client.start();
    const rejected = assert.rejects(start, /closed before/);
    await t.client.stop();
    await rejected;
    t.socket.event({ type: 'session.started', session: { id: 'late' } });
    assert.equal(t.running(), false);
});
test('HTTP rejection is bounded and never logs raw provider errors or credentials', async () => {
    const t = transport();
    const start = t.client.start();
    const rejected = assert.rejects(start, /HTTP 401/);
    t.socket.emit('unexpected-response', {}, { statusCode: 401, resume() {} });
    await rejected;
    assert.ok(t.errors.every(e => !e.message.includes('test-secret')));
    await t.client.stop();
});
class Player extends EventEmitter {
    constructor() { super(); this.state = { status: 'idle' }; this.plays = 0; }
    transition(status) {
        const old = this.state; this.state = { status };
        this.emit('stateChange', old, this.state); this.emit(status);
    }
    play(resource) { this.resource = resource; this.plays++; this.transition('playing'); }
    stop() { this.transition('idle'); }
}
function playback() {
    const alpha = new Player(), quartz = new Player(), consumed = [];
    const connection = { subscribed: alpha, subscribe(p) { this.subscribed = p; } };
    let callbacks, closes = 0, pushed = 0;
    const p = new QuartzPlayback({
        connection, alphaPlayer: alpha, player: quartz,
        resourceFactory: stream => stream,
        encoderFactory: () => ({ encode(pcm) { return pcm; }, delete() {} }),
        onPcm: pcm => consumed.push(pcm),
        clientFactory: options => {
            callbacks = options;
            return { start: async () => {}, stop: async () => { closes++; },
                setAlphaPlaying() {}, pushAudio() { pushed++; } };
        }
    });
    return { p, alpha, quartz, connection, consumed, callbacks,
        closes: () => closes, pushed: () => pushed };
}
test('Alpha preempts Quartz before its first packet; no stale audio or host callbacks', async () => {
    const t = playback(); await t.p.start();
    const mono = Buffer.alloc(640); mono.writeInt16LE(1234);
    t.callbacks.onAudio(mono);
    assert.equal(t.connection.subscribed, t.quartz);
    const stream = t.p.stream;
    assert.equal(stream.read().length, 3840);
    assert.equal(t.consumed.length, 1);
    assert.equal(t.consumed[0].readInt16LE(0), 1234);
    assert.equal(t.consumed[0].readInt16LE(10), 1234);
    t.callbacks.onAudio(mono); // pending data must be discarded
    t.alpha.transition('buffering');
    assert.equal(t.connection.subscribed, t.alpha);
    assert.equal(stream.destroyed, true);
    assert.equal(t.p.queue.length, 0);
    assert.equal(t.p.stream, null);
    t.callbacks.onAudio(mono);
    t.alpha.transition('playing');
    assert.equal(t.p.stream, null);
    t.alpha.transition('idle');
    assert.equal(t.p.stream, null);
    t.callbacks.onAudio(mono);
    assert.equal(t.connection.subscribed, t.quartz);
    assert.equal(t.alpha.plays, 0); // companion never played on Alpha's player
    await t.p.stop(); await t.p.stop();
    assert.equal(t.closes(), 1);
    assert.equal(t.alpha.listenerCount('stateChange'), 0);
});
test('output handles split PCM samples and records only consumed packets', async () => {
    const t = playback(); await t.p.start();
    t.callbacks.onAudio(Buffer.alloc(639));
    assert.equal(t.p.stream.read(), null);
    assert.equal(t.consumed.length, 0);
    t.callbacks.onAudio(Buffer.alloc(1));
    assert.ok(t.p.stream.read());
    assert.equal(t.consumed.length, 1);
    t.callbacks.onAudio(Buffer.alloc(640));
    await t.p.stop();
    assert.equal(t.consumed.length, 1);
    t.callbacks.onAudio(Buffer.alloc(640));
    assert.equal(t.p.stream, null);
});
test('participant capture still reaches the journal and original receiver callback', () => {
    const seen = [];
    const fake = {
        isRecording: new Map([['g', true]]),
        recorders: new Map([['g', { addParticipantAudioChunk: () => seen.push('record') }]]),
        quartzBackchannels: new Map([['g', { pushAudio: () => seen.push('quartz') }]]),
        onAudioChunk: () => seen.push('original')
    };
    VoiceManager.prototype.handleAudioChunk.call(fake, 'g', 'guest', Buffer.alloc(4));
    assert.deepEqual(seen, ['record', 'quartz', 'original']);
});
test('no dedicated key means no Live connection or effect on the normal host', async () => {
    const fake = {};
    assert.equal(await VoiceManager.prototype.startQuartzBackchannel.call(fake, 'g'), false);
});
test('stop removes the companion before awaiting network closure', async () => {
    let finish;
    const fake = { quartzBackchannels: new Map([['g', {
        stop: () => new Promise(resolve => { finish = resolve; })
    }]]) };
    const stopping = VoiceManager.prototype.stopQuartzBackchannel.call(fake, 'g');
    assert.equal(fake.quartzBackchannels.size, 0);
    finish(); await stopping;
});
