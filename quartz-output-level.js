// Calibrated against Alpha's normalized speech; process before Opus encoding
// so Discord playback and the recorded PCM receive exactly the same level.
class QuartzOutputLevel {
    constructor(gain = 8) {
        gain = Number(gain);
        this.gain = Number.isFinite(gain) && gain > 0 && gain <= 32 ? gain : 8;
        this.limiter = 1;
    }

    process(pcm) {
        let peak = 0;
        for (let i = 0; i + 1 < pcm.length; i += 2) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i)));
        const required = peak ? Math.min(1, 29204 / (peak * this.gain)) : 1; // -1 dBFS
        // Immediate attenuation, 100 ms release. Never amplify beyond the
        // calibrated gain or normalize each quiet breath independently.
        const release = Math.exp(-(pcm.length / 32) / 100);
        this.limiter = required < this.limiter ? required : required + (this.limiter - required) * release;
        const out = Buffer.alloc(pcm.length);
        for (let i = 0; i + 1 < pcm.length; i += 2) {
            out.writeInt16LE(Math.round(pcm.readInt16LE(i) * this.gain * this.limiter), i);
        }
        return out;
    }
}
module.exports = { QuartzOutputLevel };
