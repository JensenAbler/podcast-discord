const { Readable } = require('stream');
const OpusScript = require('opusscript');
const { createAudioPlayer, createAudioResource, AudioPlayerStatus, StreamType } = require('@discordjs/voice');
const { GptLiveBackchannel } = require('./gpt-live-backchannel');

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
        this.queue = Buffer.alloc(0);
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
            onAudio: pcm => this.enqueue(pcm),
            onTranscript: options.onTranscript,
            onLog: this.onLog,
            onError: this.onError,
            onInstructionsAccepted: id => {
                if (this.handoff?.eventId === id) {
                    this.handoff.accepted = true;
                    this.quietFrames = 0;
                }
            },
            onClose: () => {
                // A network failure is not permission to cut off buffered audio.
                this.handoff?.fail(new Error('Quartz disconnected during handoff'));
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
            if (!this.client.started && this.stream) throw new Error('Quartz audio still pending after disconnection');
            if (this.client.started && !this.blocked) await this.waitForHandoff(preview);
            // Only silence is discarded here, after played audio reached a quiet boundary.
            this.setBlocked(true);
            return release;
        } catch (error) {
            release();
            throw error;
        }
    }

    cancelPendingAlpha() {
        this.cancelEpoch++;
        this.handoff?.fail(new Error('Alpha playback cancelled during handoff'));
    }

    waitForHandoff(preview) {
        return new Promise((resolve, reject) => {
            const finish = error => {
                clearInterval(pending.timer);
                if (this.handoff === pending) this.handoff = null;
                error ? reject(error) : resolve();
            };
            const pending = { accepted: false, startedAt: Date.now(), fail: finish };
            this.handoff = pending;
            this.quietFrames = 0;
            pending.eventId = this.client.requestHandoff(preview);
            if (!pending.eventId) return finish(new Error('Could not request Quartz handoff'));
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

    enqueue(pcm) {
        if (this.closed || this.blocked || !Buffer.isBuffer(pcm) || !pcm.length) return;
        // Transport backpressure only; no content gate or acknowledgment timer.
        if (this.queue.length + pcm.length > 160000) {
            this.onLog('Dropping stale Quartz output after playback backlog');
            this.clearOutput();
            return;
        }
        this.queue = Buffer.concat([this.queue, pcm]);
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
        // Journal PCM when the corresponding Opus packet is consumed by the
        // Discord resource, not when it first arrives from the provider.
        const read = stream.read.bind(stream);
        stream.read = function(size) {
            const packet = read(size);
            const entry = packet && packets.get(packet);
            const pcm = entry?.pcm;
            if (entry?.voiced) owner.pendingVoicedFrames--;
            if (pcm && !owner.blocked && !owner.closed) {
                packets.delete(packet);
                owner.lastConsumedAt = Date.now();
                owner.quietFrames = entry.voiced ? 0 : owner.quietFrames + 1;
                owner.onPcm(pcm);
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
        if (!stream || stream.destroyed || !stream.wantsPacket || this.blocked || this.closed || this.queue.length < 640) return;
        const mono = this.queue.subarray(0, 640); // 20 ms, 16 kHz mono s16le
        this.queue = this.queue.subarray(640);
        const stereo = Buffer.alloc(3840); // 20 ms, 48 kHz stereo s16le
        for (let i = 0; i < 320; i++) {
            const sample = mono.readInt16LE(i * 2);
            for (let j = 0; j < 6; j++) stereo.writeInt16LE(sample, i * 12 + j * 2);
        }
        try {
            const packet = Buffer.from(stream.encoder.encode(stereo, 960));
            const voiced = hasVoice(mono);
            if (voiced) this.pendingVoicedFrames++;
            stream.packets.set(packet, { pcm: stereo, voiced });
            stream.wantsPacket = false;
            stream.push(packet);
        } catch (error) {
            this.onError(error);
            this.clearOutput();
        }
    }

    clearOutput() {
        const stream = this.stream;
        this.stream = null;
        this.queue = Buffer.alloc(0);
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
        this.stopPromise = this.client.stop();
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
