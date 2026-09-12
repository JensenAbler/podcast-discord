// Live transcript offsets belong to the provider's session timeline, not the
// number of microphone PCM samples sent. Estimate its wall-clock relation from
// advancing transcript observations. A rolling lower envelope resists delayed
// delivery while following long-session drift. These are approximate intervals,
// never exact acoustic word boundaries or proof of playback.
class LiveTranscriptClock {
    constructor() { this.samples = []; this.anchors = []; this.frontier = -1; }
    map(startMs, endMs, observedAt = Date.now()) {
        const unavailable = { audioStartedAt: null, audioEndedAt: null,
            timing: { status: 'unavailable', method: 'session-transcript-clock' } };
        if (![startMs, endMs, observedAt].every(Number.isFinite) ||
            startMs < 0 || endMs <= startMs) return unavailable;
        if (endMs > this.frontier) {
            this.samples = this.samples.filter(s => s.endMs >= endMs - 10000);
            this.samples.push({ endMs, offset: observedAt - endMs });
            const offset = Math.min(...this.samples.map(s => s.offset));
            const previous = this.anchors.at(-1);
            // A burst delivered after a stall must not establish a new 'now'.
            // Allow gradual clock drift, but decline discontinuous estimates.
            if (previous && Math.abs(offset - previous.offset) >
                Math.max(1000, (endMs - previous.endMs) * 0.1)) {
                this.samples = this.samples.filter(s => s.endMs !== endMs);
                return unavailable;
            }
            this.anchors.push({ endMs, offset });
            this.anchors = this.anchors.filter(a => a.endMs >= endMs - 90000).slice(-5000);
            this.frontier = endMs;
        }
        const anchor = this.anchors.find(a => a.endMs >= endMs);
        if (!anchor || startMs < this.frontier - 90000) return unavailable;
        const audioStartedAt = startMs + anchor.offset;
        const audioEndedAt = endMs + anchor.offset;
        const deliveryLagMs = observedAt - audioEndedAt;
        // Don't use stale/batched observations as evidence for a current turn.
        if (deliveryLagMs > 5000 || deliveryLagMs < -250) return unavailable;
        return { audioStartedAt, audioEndedAt,
            timing: { status: 'estimated', method: 'session-transcript-clock',
                offsetMs: anchor.offset, deliveryLagMs } };
    }
}
module.exports = { LiveTranscriptClock };
