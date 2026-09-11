// Signal energy, not speech recognition. Counts samples above the conservative
// handoff threshold; never records raw audio or interprets silence as missing data.
class LiveAudioDiagnostics {
    constructor(report, now = () => Date.now()) {
        this.report = report;
        this.now = now;
        this.since = now();
        this.paths = {};
    }
    record(path, pcm, rate, channels) {
        const stat = this.paths[path] ||= { chunks: 0, bytes: 0, samples: 0, nonSilentSamples: 0, peak: 0, durationMs: 0 };
        stat.chunks++;
        stat.bytes += pcm.length;
        const samples = Math.floor(pcm.length / 2);
        stat.samples += samples;
        stat.durationMs += samples * 1000 / (rate * channels);
        for (let i = 0; i + 1 < pcm.length; i += 2) {
            const amplitude = Math.abs(pcm.readInt16LE(i));
            if (amplitude > 8) stat.nonSilentSamples++;
            stat.peak = Math.max(stat.peak, amplitude);
        }
    }
    flush() {
        const until = this.now();
        this.report({ since: this.since, until, threshold: 8, paths: this.paths });
        this.paths = {};
        this.since = until;
    }
}
module.exports = { LiveAudioDiagnostics };
