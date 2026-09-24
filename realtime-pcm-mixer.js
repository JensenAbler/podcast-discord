class RealtimePcmMixer {
    constructor(options = {}) {
        this.inputSampleRate = Number(options.inputSampleRate || 48000);
        this.outputSampleRate = Number(options.outputSampleRate || 16000);
        this.inputChannels = Number(options.inputChannels || 2);
        this.frameDurationMs = Number(options.frameDurationMs || 20);
        this.maxBufferedMs = Number(options.maxBufferedMs || 2000);
        this.onFrame = options.onFrame || (() => {});
        this.onDrop = options.onDrop || (() => {});
        this.maxCatchUpFrames = Math.max(1, Number(options.maxCatchUpFrames || 5));
        this.now = typeof options.now === 'function' ? options.now : () => performance.now();
        this.sources = new Map();
        this.timer = null;
        this.nextFrameAt = null;

        if (
            this.inputSampleRate !== 48000 ||
            this.outputSampleRate !== 16000 ||
            this.inputChannels !== 2
        ) {
            throw new Error('RealtimePcmMixer currently supports 48 kHz stereo to 16 kHz mono PCM');
        }

        this.inputFrameBytes = Math.round(
            this.inputSampleRate * this.inputChannels * 2 * this.frameDurationMs / 1000
        );
        this.outputFrameBytes = Math.round(
            this.outputSampleRate * 2 * this.frameDurationMs / 1000
        );
        this.maxBufferedBytes = Math.max(
            this.inputFrameBytes,
            Math.round(this.inputSampleRate * this.inputChannels * 2 * this.maxBufferedMs / 1000)
        );
    }

    start() {
        if (this.timer) return;

        this.nextFrameAt = this.now();
        this.timer = setInterval(() => this.tick(), this.frameDurationMs);
        if (typeof this.timer.unref === 'function') {
            this.timer.unref();
        }
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        this.nextFrameAt = null;
        this.sources.clear();
    }

    // Emit every frame that wall-clock time says is due. setInterval ticks are
    // lost (not queued) when the event loop is busy, so emitting one frame per
    // tick lets buffered audio fall behind real time until push() starts
    // discarding it. Catch up a few frames per tick instead; if we are more
    // than the buffer window behind, resynchronize rather than burst.
    tick() {
        const now = this.now();
        if (this.nextFrameAt === null) this.nextFrameAt = now;
        let emitted = 0;
        while (now >= this.nextFrameAt && emitted < this.maxCatchUpFrames) {
            this.emitFrame();
            this.nextFrameAt += this.frameDurationMs;
            emitted += 1;
        }
        if (now - this.nextFrameAt > this.maxBufferedMs) {
            this.nextFrameAt = now;
        }
        return emitted;
    }

    push(sourceId, chunk) {
        if (!sourceId || !Buffer.isBuffer(chunk) || chunk.length === 0) {
            return;
        }

        const existing = this.sources.get(sourceId) || Buffer.alloc(0);
        let buffered = existing.length === 0
            ? Buffer.from(chunk)
            : Buffer.concat([existing, chunk], existing.length + chunk.length);

        if (buffered.length > this.maxBufferedBytes) {
            const excess = buffered.length - this.maxBufferedBytes;
            const alignedDrop = Math.ceil(excess / this.inputFrameBytes) * this.inputFrameBytes;
            const droppedBytes = Math.min(alignedDrop, buffered.length);
            buffered = buffered.subarray(droppedBytes);
            this.onDrop({ sourceId, droppedBytes });
        }

        this.sources.set(sourceId, buffered);
    }

    emitFrame() {
        const sourceFrames = [];

        for (const [sourceId, buffered] of this.sources.entries()) {
            if (buffered.length < this.inputFrameBytes) {
                continue;
            }

            sourceFrames.push(buffered.subarray(0, this.inputFrameBytes));
            const remaining = buffered.subarray(this.inputFrameBytes);
            if (remaining.length === 0) {
                this.sources.delete(sourceId);
            } else {
                this.sources.set(sourceId, remaining);
            }
        }

        const output = Buffer.alloc(this.outputFrameBytes);
        if (sourceFrames.length === 0) {
            this.onFrame(output);
            return output;
        }

        const outputSamples = this.outputFrameBytes / 2;
        for (let sampleIndex = 0; sampleIndex < outputSamples; sampleIndex += 1) {
            let mixedSample = 0;

            for (const sourceFrame of sourceFrames) {
                let sourceSample = 0;
                const baseOffset = sampleIndex * 12;

                for (let inputFrame = 0; inputFrame < 3; inputFrame += 1) {
                    const frameOffset = baseOffset + (inputFrame * 4);
                    sourceSample += sourceFrame.readInt16LE(frameOffset);
                    sourceSample += sourceFrame.readInt16LE(frameOffset + 2);
                }

                mixedSample += sourceSample / 6;
            }

            mixedSample /= sourceFrames.length;
            output.writeInt16LE(
                Math.max(-32768, Math.min(32767, Math.round(mixedSample))),
                sampleIndex * 2
            );
        }

        this.onFrame(output);
        return output;
    }
}

module.exports = { RealtimePcmMixer };
