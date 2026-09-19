// Live streams PCM continuously and exposes no output-utterance-done event.
// A conservative acoustic boundary is therefore an approximation, not a
// semantic end-of-turn guarantee. Network time and guest activity never clear it.
class MutedSpeechGate {
    constructor() { this.reset(); }

    reset() {
        this.quietSamples = 16000;
        this.suppressed = false;
    }

    mute() {
        if (this.quietSamples < 16000) this.suppressed = true;
    }

    process(pcm, blocked) {
        let voiced = false;
        for (let i = 0; i + 1 < pcm.length; i += 2) {
            if (Math.abs(pcm.readInt16LE(i)) > 8) { voiced = true; break; }
        }
        if (voiced) {
            this.quietSamples = 0;
            if (blocked) this.suppressed = true;
        } else {
            this.quietSamples += Math.floor(pcm.length / 2);
        }
        const discard = blocked || this.suppressed;
        // Discard the boundary frame too. Only subsequent audio can be heard.
        if (this.quietSamples >= 16000) this.suppressed = false;
        return discard;
    }
}

module.exports = { MutedSpeechGate };
