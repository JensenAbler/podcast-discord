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
    assert.equal(t.socket.sent.at(-1).type, 'session.thinking.append');
    assert.equal(t.socket.sent.at(-1).delegation_id, 'd1');
    assert.ok(!t.socket.sent.some(e => e.type === 'response.create'));
    assert.match(BACKCHANNEL_PROMPT, /every substantial answer/);
    assert.match(BACKCHANNEL_PROMPT, /Prefer nonlexical sounds/);
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
function playback(options = {}) {
    const alpha = new Player(), quartz = new Player(), consumed = [];
    const connection = { subscribed: alpha, subscribe(p) { this.subscribed = p; } };
    let callbacks, closes = 0, pushed = 0;
    const p = new QuartzPlayback({
        ...options, connection, alphaPlayer: alpha, player: quartz,
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

test('handoff waits for accepted instructions and played silence, not packet gaps', async () => {
    const t = playback({ handoffTimeoutMs: 500 });
    t.p.client.started = true;
    t.p.client.requestHandoff = preview => { assert.equal(preview, 'Here is the answer.'); return 'handoff-1'; };
    const voice = Buffer.alloc(640); voice.fill(100);
    t.callbacks.onAudio(voice);
    let granted = false;
    const waiting = t.p.acquireAlpha('Here is the answer.').then(release => { granted = true; return release; });
    await new Promise(resolve => setImmediate(resolve));
    t.p.stream.read();
    await new Promise(resolve => setTimeout(resolve, 35));
    assert.equal(granted, false, 'network silence must not grant the floor');
    t.callbacks.onInstructionsAccepted('wrong-id');
    for (let i = 0; i < 50; i++) { t.callbacks.onAudio(Buffer.alloc(640)); t.p.stream.read(); }
    await new Promise(resolve => setTimeout(resolve, 35));
    assert.equal(granted, false, 'wrong acknowledgment must not grant the floor');
    t.callbacks.onInstructionsAccepted('handoff-1');
    for (let i = 0; i < 49; i++) { t.callbacks.onAudio(Buffer.alloc(640)); t.p.stream.read(); }
    await new Promise(resolve => setTimeout(resolve, 35));
    assert.equal(granted, false);
    t.callbacks.onAudio(Buffer.alloc(640)); t.p.stream.read();
    const release = await waiting;
    assert.equal(t.p.blocked, true);
    assert.equal(t.connection.subscribed, t.alpha);
    assert.equal(t.consumed.length, 101, 'all speech and silence played before handoff');
    release();
    assert.equal(t.p.blocked, false);
    await t.p.stop();
});
test('handoff deadline withholds Alpha and preserves Quartz output', async () => {
    const t = playback({ handoffTimeoutMs: 40 });
    t.p.client.started = true;
    t.p.client.requestHandoff = () => 'h';
    const pcm = Buffer.alloc(640, 100);
    t.callbacks.onAudio(pcm);
    const stream = t.p.stream;
    await assert.rejects(t.p.acquireAlpha(), /withheld/);
    assert.equal(stream.destroyed, false);
    assert.equal(t.p.blocked, false);
    assert.equal(t.alpha.plays, 0);
    assert.ok(stream.read());
    await t.p.stop();
});
test('shutdown cancels a pending handoff and queued Alpha requests', async () => {
    const t = playback();
    t.p.client.started = true;
    t.p.client.requestHandoff = () => 'h';
    const first = assert.rejects(t.p.acquireAlpha(), /stopped/);
    const second = assert.rejects(t.p.acquireAlpha(), /stopped/);
    await new Promise(resolve => setImmediate(resolve));
    await t.p.stop();
    await Promise.all([first, second]);
    assert.equal(t.alpha.plays, 0);
});
test('VoiceManager waits for handoff and holds the lease until Alpha finishes', async () => {
    let grant, playedOptions, releases = 0;
    const fake = {
        transmitters: new Map([['g', { play: async (_audio, options) => { playedOptions = options; } }]]),
        quartzBackchannels: new Map([['g', { acquireAlpha: () => new Promise(resolve => { grant = resolve; }) }]])
    };
    const speaking = VoiceManager.prototype.speak.call(fake, 'g', Buffer.from([1]));
    assert.equal(playedOptions, undefined);
    grant(() => { releases++; });
    await speaking;
    assert.equal(releases, 0);
    playedOptions.onFinish();
    assert.equal(releases, 1);
});
test('failed handoff never starts the transmitter', async () => {
    let plays = 0;
    const fake = {
        transmitters: new Map([['g', { play: async () => { plays++; } }]]),
        quartzBackchannels: new Map([['g', { acquireAlpha: async () => { throw new Error('withheld'); } }]])
    };
    await assert.rejects(VoiceManager.prototype.speak.call(fake, 'g', Buffer.from([1])), /withheld/);
    assert.equal(plays, 0);
});

test('cancelling playback also rejects Alpha requests waiting behind a lease', async () => {
    const t = playback();
    const release = await t.p.acquireAlpha();
    const pending = assert.rejects(t.p.acquireAlpha(), /cancelled/);
    t.p.cancelPendingAlpha();
    release();
    await pending;
    await t.p.stop();
});

test('a TTS stream error during handoff is handled and never reaches playback', async () => {
    const { PassThrough } = require('node:stream');
    const audio = new PassThrough();
    audio.write(Buffer.from([1, 2]));
    let grant, plays = 0, released = 0;
    const fake = {
        transmitters: new Map([['g', { play: async () => { plays++; } }]]),
        quartzBackchannels: new Map([['g', { acquireAlpha: () => new Promise(resolve => { grant = resolve; }) }]])
    };
    const speaking = VoiceManager.prototype.speak.call(fake, 'g', audio);
    const rejected = assert.rejects(speaking, /TTS failed/);
    audio.destroy(new Error('TTS failed'));
    await new Promise(resolve => setImmediate(resolve));
    grant(() => { released++; });
    await rejected;
    assert.equal(plays, 0);
    assert.equal(released, 1);
});

test('normal mode follows all four environments while Alpha alone controls turns', async () => {
    const t = transport(); await connected(t);
    assert.equal(t.client.environment, 'listening');
    assert.match(BACKCHANNEL_PROMPT, /Alpha has a separate existing pipeline/);
    for (const state of ['LISTENING', 'HOLDING', 'YIELDING', 'ASIDE']) assert.ok(BACKCHANNEL_PROMPT.includes(state));
    t.client.updateAlphaProgress('thinking');
    assert.equal(t.client.environment, 'listening');
    t.client.updateAlphaProgress('preparing voice');
    assert.equal(t.client.environment, 'holding');
    t.client.updateAlphaProgress('idle');
    assert.equal(t.client.environment, 'listening');
    assert.match(t.socket.sent.at(-1).content, /Alpha has decided not to take this turn/);
    assert.equal(t.socket.sent.at(-1).type, 'session.thinking.append');
    t.socket.event({ type: 'session.output_audio.delta', delta: Buffer.from([1, 2]).toString('base64') });
    assert.equal(t.audio.length, 1, 'declining must allow the vocalization to end');
    t.client.updateAlphaProgress('thinking');
    const id = t.client.requestHandoff('Upcoming answer');
    assert.equal(t.socket.sent.at(-1).event_id, id);
    assert.equal(t.client.environment, 'yielding');
    t.client.updateAlphaProgress('idle'); // late decision cannot undo handoff
    assert.equal(t.client.environment, 'yielding');
    t.client.setAlphaPlaying(true);
    assert.equal(t.client.environment, 'aside');
    t.client.updateAlphaProgress('response text available', 'Late text');
    t.client.updateAlphaProgress('finished');
    assert.equal(t.client.environment, 'aside');
    t.client.setAlphaPlaying(false);
    assert.equal(t.client.environment, 'listening');
    t.client.updateAlphaProgress('thinking');
    t.client.updateAlphaProgress('finished'); // failure/cancel without playback
    assert.equal(t.client.environment, 'listening');
    const stop = t.client.stop(); t.socket.event({ type: 'session.closed' }); await stop;
});

test('normal mode forwards complete delivered context without enabling delegation', async () => {
    const t = transport(); await connected(t);
    const full = 'An extended Alpha answer. '.repeat(100) + 'FINAL DETAIL';
    t.client.setAlphaPlaying(true);
    const before = t.socket.sent.length;
    t.client.appendConversation('Alpha delivered transcript', full);
    const chunks = t.socket.sent.slice(before);
    assert.equal(chunks.map(e => JSON.parse(e.content.slice(e.content.indexOf(': ') + 2))).join(''), full);
    assert.equal(t.client.environment, 'aside');
    assert.equal(t.client.turnControl, false);
    const stop = t.client.stop(); t.socket.event({ type: 'session.closed' }); await stop;
});

test('normal startup remains listening during a pending evaluation', async () => {
    const t = transport();
    t.client.updateAlphaProgress('thinking');
    await connected(t);
    assert.equal(t.client.environment, 'listening');
    t.client.updateAlphaProgress('idle');
    assert.equal(t.client.environment, 'listening');
    const stop = t.client.stop(); t.socket.event({ type: 'session.closed' }); await stop;
});

test('repeated decision checks preserve listening and never gate vocal contact', async () => {
    const t = transport(); await connected(t);
    const revision = t.client.environmentRevision;
    for (let i = 0; i < 3; i++) {
        t.client.updateAlphaProgress('thinking');
        t.client.updateAlphaProgress('idle');
        t.client.updateAlphaProgress('finished');
    }
    assert.equal(t.client.environmentRevision, revision);
    assert.equal(t.client.blocked, false);
    assert.ok(t.socket.sent.some(e => e.content?.includes('evaluating whether')));
    t.socket.event({ type: 'session.output_audio.delta', delta: Buffer.alloc(640, 20).toString('base64') });
    assert.equal(t.audio.length, 1);
    const stop = t.client.stop(); t.socket.event({ type: 'session.closed' }); await stop;
});

test('audio diagnostics distinguish provider silence, blocked signal, and consumed signal', async () => {
    const t = transport(); await connected(t);
    const reports = [];
    t.client.audioDiagnostics.report = e => reports.push(e);
    const voice = Buffer.alloc(640); voice.writeInt16LE(1000);
    t.socket.event({ type: 'session.output_audio.delta', delta: Buffer.alloc(640).toString('base64') });
    t.client.setAlphaPlaying(true);
    t.socket.event({ type: 'session.output_audio.delta', delta: voice.toString('base64') });
    t.client.audioDiagnostics.flush();
    assert.equal(reports[0].paths.outputReceived.chunks, 2);
    assert.equal(reports[0].paths.outputReceived.nonSilentSamples, 1);
    assert.equal(reports[0].paths.outputBlocked.nonSilentSamples, 1);
    assert.equal(t.audio.length, 1);
    t.client.audioDiagnostics.flush();
    assert.deepEqual(reports[1].paths, {});
    const stop = t.client.stop(); t.socket.event({ type: 'session.closed' }); await stop;
});

test('consumption diagnostics count packets only after the resource reads them', async () => {
    const t = playback(), records = [];
    t.p.client.audioDiagnostics = { record: (...args) => records.push(args) };
    t.callbacks.onAudio(Buffer.alloc(640, 20));
    assert.equal(records.length, 0);
    t.p.stream.read();
    assert.equal(records[0][0], 'outputConsumed');
    assert.equal(records[0][1].length, 3840);
    await t.p.stop();
});

test('Live uses session transcript timing even when offsets exceed microphone samples', async () => {
    const t = transport(); await connected(t);
    let observed;
    t.client.onInputTranscript = e => { observed = e; };
    t.client.inputAudioMs = 100; // deliberately unrelated to the provider timeline
    t.socket.event({ type: 'session.input_transcript.delta', delta: 'yes', start_ms: 920000, end_ms: 920200 });
    assert.ok(Number.isFinite(observed.audioStartedAt));
    assert.equal(observed.audioEndedAt - observed.audioStartedAt, 200);
    assert.equal(observed.timing.status, 'estimated');
    const stop = t.client.stop(); t.socket.event({ type: 'session.closed' }); await stop;
});

test('played transcript follows packet consumption through split buffers and Alpha preemption', async () => {
    const entries = [];
    const t = playback({ onPlayedTranscript: e => entries.push(e) });
    const voice = Buffer.alloc(640, 50);
    t.callbacks.onAudio(voice.subarray(0, 320), { startMs: 0, endMs: 10, sessionId: 's' });
    t.callbacks.onAudio(voice.subarray(320), { startMs: 10, endMs: 20, sessionId: 's' });
    t.callbacks.onTranscript({ text: ' Mm.', startMs: 0, endMs: 20, sessionId: 's' });
    t.p.stream.read();
    t.callbacks.onAudio(voice, { startMs: 1000, endMs: 1020, sessionId: 's' });
    t.callbacks.onTranscript({ text: ' Okay.', startMs: 1000, endMs: 1020, sessionId: 's' });
    t.alpha.transition('buffering'); // encoded packet never consumed
    await t.p.stop();
    assert.equal(entries[0].transcription, 'Mm.');
    assert.equal(entries[0].playbackStatus, 'completed');
    assert.equal(entries[1].transcription, '');
    assert.equal(entries[1].playbackStatus, 'not_started');
    assert.equal(t.alpha.plays, 0);
});
test('muted output advances the provider output clock independently of the input mixer', async () => {
    const t = transport();
    await connected(t);
    const spans = [];
    t.client.onAudio = (_pcm, span) => spans.push(span);
    const event = { type: 'session.output_audio.delta', delta: Buffer.alloc(3200).toString('base64') };
    t.socket.event(event);
    t.client.setAlphaPlaying(true);
    t.socket.event(event);
    t.client.setAlphaPlaying(false);
    t.socket.event(event);
    assert.deepEqual(spans.map(s => [s.startMs, s.endMs]), [[0,100], [200,300]]);
    const stop = t.client.stop(); t.socket.event({ type: 'session.closed' }); await stop;
});

test('receipt ledger accounts for prefetched packets discarded on mute', async () => {
    const entries = [];
    const t = playback({ onPlayedTranscript: e => entries.push(e) });
    const now = Date.now();
    const span = { startMs: 1000, endMs: 1040, sessionId: 's', receivedAt: now };
    const pcm = Buffer.alloc(1280, 50);
    t.callbacks.onOutputAudio(pcm, span);
    t.callbacks.onAudio(pcm, span);
    t.callbacks.onTranscript({ text: 'Okay.', startMs: 2000, endMs: 2040, sessionId: 's',
        correlation: 'receipt', audioStartedAt: now - 40, audioEndedAt: now });
    t.p.stream.read();
    t.alpha.transition('buffering');
    await t.p.stop();
    assert.equal(entries[0].transcription, '');
    assert.equal(entries[0].playbackStatus, 'incomplete');
    assert.equal(entries[0].backchannelEvidence.consumedVoicedFrames, 1);
    assert.equal(entries[0].backchannelEvidence.discardedVoicedFrames, 1);
});
