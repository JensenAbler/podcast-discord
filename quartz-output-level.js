// Calibrated against Alpha's normalized speech; process before Opus encoding
// so Discord playback and the recorded PCM receive exactly the same level.
class QuartzOutputLevel {
    constructor(gain = 4, options = {}) {
        gain = Number(gain);
        this.gain = Number.isFinite(gain) && gain > 0 && gain <= 32 ? gain : 4;
        this.limiter = 1;
        this.now = options.now || (() => performance.now());
        this.risingSince = null;
    }

    setEnvironment(state) {
        // Reannouncing the state (including reconnects) must not restart the ramp.
        if (state === 'holding_rising') this.risingSince ??= this.now();
        else this.risingSince = null;
    }

    process(pcm) {
        const progress = this.risingSince === null ? 0
            : Math.max(0, Math.min(1, (this.now() - this.risingSince) / 5000));
        const volume = 0.25 + 0.75 * progress;
        let peak = 0;
        for (let i = 0; i + 1 < pcm.length; i += 2) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i)));
        const required = peak ? Math.min(1, 29204 / (peak * this.gain)) : 1; // -1 dBFS
        // Immediate attenuation, 100 ms release. Never amplify beyond the
        // calibrated gain or normalize each quiet breath independently.
        const release = Math.exp(-(pcm.length / 32) / 100);
        this.limiter = required < this.limiter ? required : required + (this.limiter - required) * release;
        // Attenuate after the existing limiter so even loud/limited speech is
        // 75% quieter at baseline. Evaluate at playback, not provider receipt.
        const out = Buffer.alloc(pcm.length);
        for (let i = 0; i + 1 < pcm.length; i += 2) {
            out.writeInt16LE(Math.round(pcm.readInt16LE(i) * this.gain * this.limiter * volume), i);
        }
        return out;
    }
}
module.exports = { QuartzOutputLevel };
