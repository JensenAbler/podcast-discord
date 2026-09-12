// Correlate provider output offsets with PCM actually consumed by Discord.
// All timing/provenance stays outside the generator's text.
class PlayedBackchannelTranscript {
    constructor(onEntry, options = {}) {
        this.onEntry = onEntry;
        this.now = options.now || Date.now;
        this.frames = [];
        this.receivedFrames = [];
        this.dropped = [];
        this.pending = [];
        this.seen = new Set();
        this.frontier = 0;
        this.timer = null;
        this.closed = false;
    }
    receive(pcm, span) {
        // Receipt clock is independent of provider text time and source PCM time.
        // Split into the same 20 ms units used by playback; retain muted frames too.
        const duration = pcm.length / 32;
        if (span.blocked) this.discard(span);
        for (let offset = 0; offset < pcm.length; offset += 640) {
            const chunk = pcm.subarray(offset, offset + 640);
            let voiced = false;
            for (let i = 0; i + 1 < chunk.length; i += 2) {
                if (Math.abs(chunk.readInt16LE(i)) > 8) { voiced = true; break; }
            }
            this.receivedFrames.push({ sessionId: span.sessionId,
                startMs: span.startMs + offset / 32,
                endMs: span.startMs + (offset + chunk.length) / 32,
                wallStart: span.receivedAt - duration + offset / 32,
                wallEnd: span.receivedAt - duration + (offset + chunk.length) / 32,
                voiced });
        }
        this.receivedFrames = this.receivedFrames.filter(f => f.wallEnd >= span.receivedAt - 90000);
        this.flush(false);
    }
    discard(span) {
        if (!span || !Number.isFinite(span.startMs)) return;
        this.dropped.push(span);
        this.dropped = this.dropped.filter(f => f.endMs >= span.endMs - 90000);
    }
    correlateReceipt(group, force = false) {
        // Provider output text intervals are approximate, not PCM sample indices.
        // Require voiced output near the estimated interval and consumption of
        // all of it. Near mute/drop boundaries, omit words rather than invent
        // which part of a vocalization was heard.
        const valid = group.every(p => Number.isFinite(p.audioStartedAt) && Number.isFinite(p.audioEndedAt));
        const start = valid ? Math.min(...group.map(p => p.audioStartedAt)) - 250 : NaN;
        const end = valid ? Math.max(...group.map(p => p.audioEndedAt)) + 250 : NaN;
        const candidates = this.receivedFrames.filter(f => f.sessionId === group[0].sessionId &&
            f.voiced && f.wallEnd > start && f.wallStart < end);
        const matched = candidates.map(f => {
            const frames = this.frames.filter(p => p.sessionId === f.sessionId &&
                p.endMs > f.startMs && p.startMs < f.endMs).sort((a,b) => a.startMs-b.startMs);
            let cursor = f.startMs;
            for (const p of frames) {
                if (p.startMs > cursor + 0.01) break;
                cursor = Math.max(cursor, p.endMs);
            }
            return { complete: cursor >= f.endMs - 0.01, frames,
                discarded: this.dropped.some(p => p.sessionId === f.sessionId &&
                    p.endMs > f.startMs && p.startMs < f.endMs) };
        });
        if (!force && matched.some(m => !m.complete && !m.discarded)) return false;
        const complete = candidates.length > 0 && matched.every(m => m.complete);
        const played = matched.flatMap(m => m.frames);
        const startAt = played.length ? Math.min(...played.map(f => f.at)) : null;
        const endAt = played.length ? Math.max(...played.map(f => f.at + f.endMs - f.startMs)) : null;
        const text = group.map(p => p.text).join('').trim();
        this.onEntry({
            speaker: 'Alpha-Clawd', speakerRole: 'host', source: 'quartz',
            transcription: complete ? text : '', generatedTranscription: text,
            timestamp: new Date(startAt ?? this.now()).toISOString(),
            speechStartedAt: startAt === null ? null : new Date(startAt).toISOString(),
            speechEndedAt: endAt === null ? null : new Date(endAt).toISOString(),
            playbackStartedAt: startAt === null ? null : new Date(startAt).toISOString(),
            playbackEndedAt: endAt === null ? null : new Date(endAt).toISOString(),
            duration: startAt === null ? 0 : endAt - startAt,
            playbackStatus: complete ? 'completed' : played.length ? 'incomplete' : 'not_started',
            playbackInterrupted: !complete,
            backchannelEvidence: { sessionId: group[0].sessionId,
                startMs: group[0].startMs, endMs: group.at(-1).endMs,
                method: 'estimated-text-receipt-with-pcm-consumption', timingStatus: 'estimated',
                marginMs: 250, matchedVoicedFrames: candidates.length,
                consumedVoicedFrames: matched.filter(m => m.complete).length,
                discardedVoicedFrames: matched.filter(m => m.discarded).length,
                outputAudioFrontierMs: group.at(-1).outputAudioFrontierMs ?? null }
        });
        return true;
    }
    consume(span, at = this.now()) {
        if (!span || !Number.isFinite(span.startMs)) return;
        this.frames.push({ ...span, at });
        this.frontier = Math.max(this.frontier, span.endMs);
        this.frames = this.frames.filter(f => f.endMs >= this.frontier - 90000);
        this.flush(false);
    }
    transcript(event) {
        if (this.closed || !String(event.text || '').trim()) return;
        if (![event.startMs, event.endMs].every(Number.isFinite) || event.endMs <= event.startMs) return;
        const key = JSON.stringify([event.sessionId, event.startMs, event.endMs, event.text]);
        if (this.seen.has(key)) return;
        this.seen.add(key);
        this.pending.push({ ...event, receivedAt: this.now() });
        this.pending.sort((a, b) => a.startMs - b.startMs);
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.flush(false), 800);
        this.timer.unref?.();
    }
    flush(force = false) {
        const groups = [];
        for (const part of this.pending) {
            const last = groups.at(-1);
            if (last && last.at(-1).sessionId === part.sessionId &&
                part.startMs >= last.at(-1).endMs && part.startMs - last.at(-1).endMs <= 400) last.push(part);
            else groups.push([part]);
        }
        const remaining = [];
        for (const group of groups) {
            const end = group.at(-1).endMs;
            const receipt = group.some(p => p.correlation === 'receipt');
            const settled = this.now() - Math.max(...group.map(p => p.receivedAt)) >= (receipt ? 750 : 450);
            if (receipt) {
                if (!force && !settled) { remaining.push(...group); continue; }
                if (!this.correlateReceipt(group, force)) remaining.push(...group);
                continue;
            }
            if (!force && (!settled || this.frontier < end)) { remaining.push(...group); continue; }
            const matches = group.map(part => {
                const frames = this.frames.filter(f => f.sessionId === part.sessionId &&
                    f.endMs > part.startMs && f.startMs < part.endMs).sort((a,b) => a.startMs-b.startMs);
                let cursor = part.startMs;
                for (const f of frames) {
                    if (f.startMs > cursor + 0.01) break;
                    cursor = Math.max(cursor, f.endMs);
                }
                return { part, frames, complete: cursor >= part.endMs - 0.01 };
            });
            const complete = matches.every(m => m.complete);
            const played = matches.flatMap(m => m.frames);
            // Only a contiguous, fully delivered prefix is safe to quote.
            const prefix = [];
            for (const m of matches) { if (!m.complete) break; prefix.push(m.part.text); }
            const text = prefix.join('').trim();
            const generated = group.map(p => p.text).join('').trim();
            const startAt = played.length ? Math.min(...played.map(f => f.at)) : null;
            const endAt = played.length ? Math.max(...played.map(f => f.at + f.endMs - f.startMs)) : null;
            this.onEntry({
                speaker: 'Alpha-Clawd', speakerRole: 'host',
                transcription: text && !complete ? text + '…' : text,
                generatedTranscription: generated,
                source: 'quartz', timestamp: startAt === null ? new Date(this.now()).toISOString() : new Date(startAt).toISOString(),
                speechStartedAt: startAt === null ? null : new Date(startAt).toISOString(),
                speechEndedAt: endAt === null ? null : new Date(endAt).toISOString(),
                playbackStartedAt: startAt === null ? null : new Date(startAt).toISOString(),
                playbackEndedAt: endAt === null ? null : new Date(endAt).toISOString(),
                duration: startAt === null ? 0 : endAt - startAt,
                playbackStatus: complete ? 'completed' : played.length ? 'incomplete' : 'not_started',
                playbackInterrupted: !complete,
                backchannelEvidence: { sessionId: group[0].sessionId, startMs: group[0].startMs, endMs: end,
                    method: 'output-pcm-consumption', fragmentCoverage: matches.map(m => m.complete) }
            });
        }
        this.pending = remaining;
    }
    close() { clearTimeout(this.timer); this.flush(true); this.closed = true; }
}
module.exports = { PlayedBackchannelTranscript };
