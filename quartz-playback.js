const { Readable } = require('stream');
const OpusScript = require('opusscript');
const { createAudioPlayer, createAudioResource, AudioPlayerStatus, StreamType } = require('@discordjs/voice');
const { GptLiveBackchannel } = require('./gpt-live-backchannel');
const { PlayedBackchannelTranscript } = require('./played-backchannel-transcript');
const { QuartzOutputLevel } = require('./quartz-output-level');

// A separate player keeps acknowledgments out of Alpha's transmitter queue and
// its onStart/onFinish callbacks. The existing player always wins.
class QuartzPlayback {
    constructor(options) {
        this.connection = options.connection;
        this.alphaPlayer = options.alphaPlayer;
        this.onPcm = options.onPcm || (() => {});
        this.onLog = options.onLog || (() => {});
        this.onError = options.onError || (() => {});
        this.player = options.player || createAudioPlayer({ behaviors: { maxMissedFrames: 1500 } });
        this.resourceFactory = options.resourceFactory || (stream => createAudioResource(stream, { inputType: StreamType.Opus }));
        this.encoderFactory = options.encoderFactory || (() => new OpusScript(48000, 2, OpusScript.Application.AUDIO));
        this.stream = null;
        this.outputLevel = new QuartzOutputLevel(options.outputGain ?? process.env.PODCAST_QUARTZ_OUTPUT_GAIN ?? 8);
        this.queue = Buffer.alloc(0);
        this.queueSpans = [];
        this.playedTranscript = new PlayedBackchannelTranscript(options.onPlayedTranscript || (() => {}));
        this.closed = false;
        this.alphaLease = false;
        this.alphaQueue = Promise.resolve();
        this.cancelEpoch = 0;
        this.handoff = null;
        this.quietFrames = 0;
        this.pendingVoicedFrames = 0;
        this.lastConsumedAt = 0;
        this.handoffTimeoutMs = options.handoffTimeoutMs || 20000;
        this.blocked = this.alphaPlayer.state.status !== AudioPlayerStatus.Idle;
        const clientOptions = {
            apiKey: options.apiKey,
            voice: options.voice || 'quartz',
            turnControl: options.turnControl,
            onDelegation: options.onDelegation,
            onInputTranscript: options.onInputTranscript,
            onOutputAudio: (pcm, span) => this.playedTranscript.receive(pcm, span),
            onAudio: (pcm, span) => this.enqueue(pcm, span),
            onOutputBlocked: () => this.clearOutput(),
            onTranscript: event => {
                options.onTranscript?.(event);
                this.playedTranscript.transcript(event);
            },
            onLog: this.onLog,
            onError: this.onError,
            onInstructionsAccepted: id => {
                if (this.handoff?.eventId === id) {
                    this.handoff.accepted = true;
                    this.quietFrames = 0;
                }
            },
            onClose: () => {
                // A failed companion must not retain the floor or block Alpha.
                this.clearOutput();
                this.handoff?.finish();
                options.onClose?.();
            }
        };
        this.client = options.clientFactory ? options.clientFactory(clientOptions) : new GptLiveBackchannel(clientOptions);
        this.onAlphaState = (_old, next) => this.setBlocked(next.status !== AudioPlayerStatus.Idle);
        this.alphaPlayer.on('stateChange', this.onAlphaState);
        this.onPlayerIdle = () => this.clearOutput();
        this.onPlayerError = () => {
            this.onError(new Error('Quartz audio playback failed'));
            this.clearOutput();
        };
        this.player.on(AudioPlayerStatus.Idle, this.onPlayerIdle);
        this.player.on('error', this.onPlayerError);
    }

    setEnvironment(state) { return this.client.setEnvironment?.(state); }
    appendConversation(label, text) { return this.client.appendConversation?.(label, text); }
    reportDelegation(id, text) { return this.client.reportDelegation?.(id, text); }

    async start() {
        this.client.setAlphaPlaying(this.blocked);
        try { await this.client.start(); }
        catch (error) { await this.stop(); throw error; }
    }

    pushAudio(userId, pcm) { this.client.pushAudio(userId, pcm); }

    updateAlphaProgress(stage, preview) { this.client.updateAlphaProgress?.(stage, preview); }

    async acquireAlpha(preview = '') {
        const epoch = this.cancelEpoch;
        let releaseQueue;
        const previous = this.alphaQueue;
        this.alphaQueue = new Promise(resolve => { releaseQueue = resolve; });
        await previous;
        if (this.closed || epoch !== this.cancelEpoch) { releaseQueue(); throw new Error('Quartz stopped or Alpha playback cancelled'); }
        let released = false;
        const release = () => {
            if (released) return;
            released = true;
            this.alphaLease = false;
            if (!this.closed) this.setBlocked(this.alphaPlayer.state.status !== AudioPlayerStatus.Idle);
            releaseQueue();
        };
        this.alphaLease = true;
        try {
            if (!this.client.started) this.clearOutput();
            if (this.client.started && !this.blocked && !this.client.outputBlocked) await this.waitForHandoff(preview);
            // Only silence is discarded here, after played audio reached a quiet boundary.
            this.setBlocked(true);
            return release;
        } catch (error) {
            release();
            if (!this.closed && !this.blocked) this.client.setEnvironment?.('listening');
            throw error;
        }
    }

    cancelPendingAlpha() {
        this.cancelEpoch++;
        this.handoff?.fail(new Error('Alpha playback cancelled during handoff'));
    }

    waitForHandoff(preview) {
        return new Promise((resolve, reject) => {
            let finished = false;
            const finish = error => {
                if (finished) return;
                finished = true;
                clearInterval(pending.timer);
                if (this.handoff === pending) this.handoff = null;
                this.onLog('Handoff completed: ' + JSON.stringify({ eventId: pending.eventId, accepted: pending.accepted, elapsedMs: Date.now() - pending.startedAt, quietFrames: this.quietFrames, failed: Boolean(error) }));
                error ? reject(error) : resolve();
            };
            const pending = { accepted: false, startedAt: Date.now(), fail: finish, finish: () => finish() };
            this.handoff = pending;
            this.quietFrames = 0;
            pending.eventId = this.client.requestHandoff(preview);
            if (!pending.eventId) return finish(new Error('Could not request Quartz handoff'));
            if (finished) return;
            pending.timer = setInterval(() => {
                // Count actual near-silent PCM that Discord consumed, not missing
                // network packets or transcript gaps. Acceptance is not completion.
                const quietBoundary = pending.accepted && this.quietFrames >= 50 &&
                    this.pendingVoicedFrames === 0 && !hasVoice(this.queue);
                if (quietBoundary) return finish();
                if (Date.now() - pending.startedAt >= this.handoffTimeoutMs) {
                    finish(new Error('Quartz handoff not observed; Alpha playback withheld to avoid interruption'));
                }
            }, 25);
        });
    }

    setBlocked(blocked) {
        if (this.closed) return;
        this.blocked = Boolean(blocked || (this.alphaLease && !this.handoff));
        if (this.blocked) {
            // This runs synchronously on Alpha's Buffering/Playing transition,
            // before Discord can consume its first packet. Discard Quartz's
            // encoded and raw queues as well as audio received while blocked.
            this.clearOutput();
            this.connection.subscribe(this.alphaPlayer);
        }
        this.client.setAlphaPlaying(this.blocked);
    }

    enqueue(pcm, span) {
        if (this.closed || this.blocked || this.client.outputBlocked || !Buffer.isBuffer(pcm) || !pcm.length) {
            this.playedTranscript.discard(span); return;
        }
        // Transport backpressure only; no content gate or acknowledgment timer.
        if (this.queue.length + pcm.length > 160000) {
            this.onLog('Dropping stale Quartz output after playback backlog');
            this.playedTranscript.discard(span);
            this.clearOutput();
            return;
        }
        this.queue = Buffer.concat([this.queue, pcm]);
        this.queueSpans.push({ ...span, bytes: pcm.length });
        if (!this.stream) this.createStream();
        this.fill();
    }

    createStream() {
        const owner = this;
        const encoder = this.encoderFactory();
        const packets = new WeakMap();
        const stream = new Readable({
            objectMode: true,
            highWaterMark: 1,
            read() { this.wantsPacket = true; owner.fill(); },
            destroy(error, callback) { encoder.delete(); callback(error); }
        });
        stream.encoder = encoder;
        stream.packets = packets;
        stream.pendingPackets = new Set();
        // Journal PCM when the corresponding Opus packet is consumed by the
        // Discord resource, not when it first arrives from the provider.
        const read = stream.read.bind(stream);
        stream.read = function(size) {
            const packet = read(size);
            const entry = packet && packets.get(packet);
            const pcm = entry?.pcm;
            if (entry?.voiced) owner.pendingVoicedFrames--;
            if (pcm && !owner.blocked && !owner.client.outputBlocked && !owner.closed) {
                packets.delete(packet);
                stream.pendingPackets.delete(entry);
                owner.lastConsumedAt = Date.now();
                owner.quietFrames = entry.voiced ? 0 : owner.quietFrames + 1;
                owner.client.audioDiagnostics?.record('outputConsumed', pcm, 48000, 2);
                owner.onPcm(pcm);
                for (const span of entry.spans) owner.playedTranscript.consume(span, owner.lastConsumedAt);
            }
            return packet;
        };
        stream.on('error', this.onError);
        this.stream = stream;
        const resource = this.resourceFactory(stream);
        this.connection.subscribe(this.player);
        this.player.play(resource);
    }

    fill() {
        const stream = this.stream;
        if (!stream || stream.destroyed || !stream.wantsPacket || this.blocked || this.client.outputBlocked || this.closed || this.queue.length < 640) return;
        const mono = this.queue.subarray(0, 640); // 20 ms, 16 kHz mono s16le
        this.queue = this.queue.subarray(640);
        const spans = [];
        let bytes = 640;
        while (bytes && this.queueSpans.length) {
            const span = this.queueSpans[0];
            const taken = Math.min(bytes, span.bytes);
            spans.push({ sessionId: span.sessionId, startMs: span.startMs, endMs: span.startMs + taken / 32 });
            span.startMs += taken / 32;
            span.bytes -= taken;
            bytes -= taken;
            if (!span.bytes) this.queueSpans.shift();
        }
        const leveled = this.outputLevel.process(mono);
        const stereo = Buffer.alloc(3840); // 20 ms, 48 kHz stereo s16le
        for (let i = 0; i < 320; i++) {
            const sample = leveled.readInt16LE(i * 2);
            for (let j = 0; j < 6; j++) stereo.writeInt16LE(sample, i * 12 + j * 2);
        }
        try {
            const packet = Buffer.from(stream.encoder.encode(stereo, 960));
            const voiced = hasVoice(mono);
            if (voiced) this.pendingVoicedFrames++;
            const entry = { pcm: stereo, voiced, spans };
            stream.packets.set(packet, entry);
            stream.pendingPackets.add(entry);
            stream.wantsPacket = false;
            stream.push(packet);
        } catch (error) {
            for (const span of spans) this.playedTranscript.discard(span);
            this.onError(error);
            this.clearOutput();
        }
    }

    clearOutput() {
        const stream = this.stream;
        this.stream = null;
        for (const span of [...this.queueSpans, ...Array.from(stream?.pendingPackets || []).flatMap(entry => entry.spans)]) this.playedTranscript.discard(span);
        this.queue = Buffer.alloc(0);
        this.queueSpans = [];
        this.pendingVoicedFrames = 0;
        // Set stream=null before stop(), whose Idle event can reenter here.
        if (stream) {
            this.player.stop(true);
            stream.destroy();
        }
        if (!this.closed && this.alphaPlayer.state.status === AudioPlayerStatus.Idle) {
            this.connection.subscribe(this.alphaPlayer);
        }
    }

    async stop() {
        if (this.stopPromise) return this.stopPromise;
        this.closed = true;
        this.turnController?.close();
        this.handoff?.fail(new Error('Quartz stopped during handoff'));
        this.alphaPlayer.off('stateChange', this.onAlphaState);
        this.player.off(AudioPlayerStatus.Idle, this.onPlayerIdle);
        this.clearOutput();
        this.connection.subscribe(this.alphaPlayer);
        this.stopPromise = Promise.resolve(this.client.stop()).finally(() => this.playedTranscript.close());
        return this.stopPromise;
    }
}

// Deliberately conservative: only near-digital silence qualifies. This is an
// acoustic boundary, not a claim that Live has semantically completed a turn.
function hasVoice(pcm) {
    for (let i = 0; i + 1 < pcm.length; i += 2) {
        if (Math.abs(pcm.readInt16LE(i)) > 8) return true;
    }
    return false;
}

module.exports = { QuartzPlayback };
