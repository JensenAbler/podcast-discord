const ENDPOINT_DEBOUNCE_VALUES_MS = [50, 75, 100, 125, 150, 200];

class EndpointStabilityProfile {
    constructor(options = {}) {
        const defaultDebounceMs = EndpointStabilityProfile.sanitizeDebounce(
            options.defaultDebounceMs,
            50
        );
        const values = Array.isArray(options.debounceValues) && options.debounceValues.length > 0
            ? options.debounceValues
                .map((value) => EndpointStabilityProfile.sanitizeDebounce(value, null))
                .filter((value) => value !== null)
            : ENDPOINT_DEBOUNCE_VALUES_MS;

        this.values = Array.from(new Set(values.concat(defaultDebounceMs)))
            .filter((value) => Number.isFinite(value) && value > 0)
            .sort((a, b) => a - b);
        this.defaultDebounceMs = defaultDebounceMs;
        this.currentDebounceMs = defaultDebounceMs;
        this.shortFragmentMs = Number.isFinite(options.shortFragmentMs) ? options.shortFragmentMs : 300;
        this.longChunkMs = Number.isFinite(options.longChunkMs) ? options.longChunkMs : 900;
        this.upRunThreshold = Number.isFinite(options.upRunThreshold) ? Math.max(1, Math.floor(options.upRunThreshold)) : 2;
        this.downChunkThreshold = Number.isFinite(options.downChunkThreshold) ? Math.max(1, Math.floor(options.downChunkThreshold)) : 5;
        this.fragmentRunWindowMs = Number.isFinite(options.fragmentRunWindowMs) ? Math.max(0, options.fragmentRunWindowMs) : 1500;
        this.rawWindowSize = Number.isFinite(options.rawWindowSize) ? Math.max(5, Math.floor(options.rawWindowSize)) : 50;
        this.evidenceWindowSize = Number.isFinite(options.evidenceWindowSize) ? Math.max(3, Math.floor(options.evidenceWindowSize)) : 8;
        this.downWindowSize = Number.isFinite(options.downWindowSize) ? Math.max(5, Math.floor(options.downWindowSize)) : 10;

        this.rawEventCounter = 0;
        this.chunkCounter = 0;
        this.lastRawStop = null;
        this.rawObservations = [];
        this.lastAcceptedChunk = null;
        this.fragmentRun = null;
        this.upEvidence = [];
        this.downEvidence = [];
        this.adjustments = [];
    }

    static sanitizeDebounce(value, fallback) {
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
        return Math.round(parsed);
    }

    getDebounceMs() {
        return this.currentDebounceMs;
    }

    getNextHigherDebounceMs(fromMs = this.currentDebounceMs) {
        return this.values.find((value) => value > fromMs) || null;
    }

    getNextLowerDebounceMs(fromMs = this.currentDebounceMs) {
        let lower = null;
        for (const value of this.values) {
            if (value < fromMs) lower = value;
        }
        return lower;
    }

    recordRawStop(metadata = {}) {
        const observation = {
            id: ++this.rawEventCounter,
            type: 'stop',
            atMs: Number.isFinite(metadata.atMs) ? metadata.atMs : Date.now(),
            activeDebounceMs: EndpointStabilityProfile.sanitizeDebounce(metadata.activeDebounceMs, this.currentDebounceMs),
            hasAsrCandidate: Boolean(metadata.hasAsrCandidate),
            speakingFrames: Number(metadata.speakingFrames || 0),
            silentFrames: Number(metadata.silentFrames || 0),
            totalFrames: Number(metadata.totalFrames || 0)
        };

        this.lastRawStop = observation;
        this.pushBounded(this.rawObservations, observation, this.rawWindowSize);
        return observation;
    }

    recordRawStart(metadata = {}) {
        const atMs = Number.isFinite(metadata.atMs) ? metadata.atMs : Date.now();
        const activeDebounceMs = EndpointStabilityProfile.sanitizeDebounce(metadata.activeDebounceMs, this.currentDebounceMs);
        const previousStop = this.lastRawStop;
        const noCrossSpeaker = metadata.noCrossSpeaker !== false;
        const observation = {
            id: ++this.rawEventCounter,
            type: 'start',
            atMs,
            activeDebounceMs,
            previousStopId: previousStop?.id || null,
            gapMs: previousStop ? Math.max(0, atMs - previousStop.atMs) : null,
            noCrossSpeaker
        };

        this.pushBounded(this.rawObservations, observation, this.rawWindowSize);

        if (!previousStop || !previousStop.hasAsrCandidate || !noCrossSpeaker || observation.gapMs === null) {
            return { observation, gap: null, resumeCandidate: null };
        }

        const gap = {
            stopId: previousStop.id,
            startId: observation.id,
            stoppedAtMs: previousStop.atMs,
            startedAtMs: atMs,
            gapMs: observation.gapMs,
            activeDebounceMs,
            noCrossSpeaker
        };

        if (observation.gapMs <= activeDebounceMs) {
            return { observation, gap, resumeCandidate: null };
        }

        const candidateDebounceMs = this.getNextHigherDebounceMs(activeDebounceMs);
        if (!candidateDebounceMs || observation.gapMs > candidateDebounceMs) {
            return { observation, gap: null, resumeCandidate: null };
        }

        return {
            observation,
            gap: null,
            resumeCandidate: {
                previousStopId: previousStop.id,
                startId: observation.id,
                gapMs: observation.gapMs,
                activeDebounceMs,
                candidateDebounceMs,
                noCrossSpeaker
            }
        };
    }

    recordFinalizedTranscript(metadata = {}) {
        const text = String(metadata.transcription || '').trim();
        const audioEvents = Array.isArray(metadata.audioEvents) ? metadata.audioEvents : [];
        const accepted = Boolean(text) && !audioEvents.includes('phantom') && !metadata.providerError;
        const raw = metadata.endpointStabilityRaw || {};
        const speechMs = this.normalizeSpeechMs(metadata);
        const chunk = {
            id: ++this.chunkCounter,
            accepted,
            text,
            speechMs,
            short: accepted && speechMs > 0 && speechMs < this.shortFragmentMs,
            long: accepted && speechMs >= this.longChunkMs,
            stopId: raw.lastStopId || null,
            finalizedAtMs: Number.isFinite(metadata.finalizedAtMs) ? metadata.finalizedAtMs : Date.now()
        };

        const events = [];

        if (accepted) {
            const upEvent = this.maybeRecordUpEvidence(chunk, raw);
            if (upEvent) events.push(upEvent);

            const downEvent = this.maybeRecordDownEvidence(chunk, raw);
            if (downEvent) events.push(downEvent);
        } else {
            this.fragmentRun = null;
        }

        this.lastAcceptedChunk = chunk;
        return events;
    }

    normalizeSpeechMs(metadata = {}) {
        const detectorStats = metadata.detectorStats || {};
        const frameSpeechMs = Number(detectorStats.speakingFrames || 0) * 20;
        if (Number.isFinite(frameSpeechMs) && frameSpeechMs > 0) return frameSpeechMs;

        const speechDuration = Number(metadata.speechDuration);
        if (Number.isFinite(speechDuration) && speechDuration > 0) return speechDuration;

        const duration = Number(metadata.duration);
        return Number.isFinite(duration) && duration > 0 ? duration : 0;
    }

    maybeRecordUpEvidence(chunk, raw = {}) {
        const candidate = raw.resumeCandidate;
        const previous = this.lastAcceptedChunk;

        if (
            !candidate ||
            !candidate.noCrossSpeaker ||
            !previous?.accepted ||
            previous.stopId !== candidate.previousStopId ||
            !previous.short ||
            !chunk.short
        ) {
            if (!candidate) this.fragmentRun = null;
            return null;
        }

        const nowMs = chunk.finalizedAtMs;
        const shouldExtend = this.fragmentRun &&
            this.fragmentRun.lastChunkId === previous.id &&
            nowMs - this.fragmentRun.lastAtMs <= this.fragmentRunWindowMs;

        if (shouldExtend) {
            this.fragmentRun.fragmentCount += 1;
            this.fragmentRun.totalSpeechMs += chunk.speechMs;
            this.fragmentRun.texts.push(chunk.text);
            this.fragmentRun.lastChunkId = chunk.id;
            this.fragmentRun.lastAtMs = nowMs;
            this.fragmentRun.lastStopId = chunk.stopId;
            this.fragmentRun.maxGapMs = Math.max(this.fragmentRun.maxGapMs, candidate.gapMs);
        } else {
            this.fragmentRun = {
                fragmentCount: 2,
                totalSpeechMs: previous.speechMs + chunk.speechMs,
                texts: [previous.text, chunk.text],
                firstChunkId: previous.id,
                lastChunkId: chunk.id,
                lastStopId: chunk.stopId,
                startedAtMs: nowMs,
                lastAtMs: nowMs,
                maxGapMs: candidate.gapMs,
                activeDebounceMs: candidate.activeDebounceMs,
                candidateDebounceMs: candidate.candidateDebounceMs,
                voted: false
            };
        }

        if (this.fragmentRun.voted || !this.isSubstantiveFragmentRun(this.fragmentRun)) {
            return null;
        }

        this.fragmentRun.voted = true;
        const evidence = {
            type: 'fragmentation_run',
            atMs: nowMs,
            fragmentCount: this.fragmentRun.fragmentCount,
            totalSpeechMs: this.fragmentRun.totalSpeechMs,
            maxGapMs: this.fragmentRun.maxGapMs,
            activeDebounceMs: this.fragmentRun.activeDebounceMs,
            candidateDebounceMs: this.fragmentRun.candidateDebounceMs
        };
        this.pushBounded(this.upEvidence, evidence, this.evidenceWindowSize);

        const adjustment = this.maybeAdjustUp(nowMs);
        return {
            kind: adjustment ? 'adjustment' : 'up_evidence',
            direction: adjustment ? 'up' : null,
            evidence,
            adjustment,
            snapshot: this.getSnapshot()
        };
    }

    isSubstantiveFragmentRun(run) {
        if (!run || run.fragmentCount < 2) return false;
        const joined = run.texts.join(' ').replace(/\s+/g, ' ').trim();
        const compactChars = joined.replace(/[^A-Za-z0-9]/g, '');
        const words = joined.split(/\s+/).filter(Boolean);
        return compactChars.length >= 12 && words.length >= 4;
    }

    maybeAdjustUp(atMs) {
        if (this.upEvidence.length < this.upRunThreshold) return null;

        const next = this.getNextHigherDebounceMs();
        if (!next) return null;

        const previous = this.currentDebounceMs;
        this.currentDebounceMs = next;
        const adjustment = {
            atMs,
            direction: 'up',
            fromMs: previous,
            toMs: next,
            reason: 'repeated substantive fragmentation runs',
            upEvidenceCount: this.upEvidence.length,
            downEvidenceCount: this.downEvidence.length
        };
        this.pushBounded(this.adjustments, adjustment, 10);
        this.upEvidence = [];
        this.downEvidence = [];
        this.fragmentRun = null;
        return adjustment;
    }

    maybeRecordDownEvidence(chunk, raw = {}) {
        const nextLower = this.getNextLowerDebounceMs();
        const gaps = Array.isArray(raw.gaps) ? raw.gaps : [];

        if (!chunk.long || !nextLower || gaps.length === 0) {
            return null;
        }

        const wouldPreserve = gaps.every((gap) =>
            gap &&
            gap.noCrossSpeaker !== false &&
            Number.isFinite(gap.gapMs) &&
            gap.gapMs <= nextLower
        );
        if (!wouldPreserve) return null;

        const evidence = {
            type: 'stable_long_chunk',
            atMs: chunk.finalizedAtMs,
            speechMs: chunk.speechMs,
            gapCount: gaps.length,
            maxGapMs: Math.max(...gaps.map((gap) => gap.gapMs)),
            activeDebounceMs: this.currentDebounceMs,
            candidateDebounceMs: nextLower
        };
        this.pushBounded(this.downEvidence, evidence, this.downWindowSize);

        const adjustment = this.maybeAdjustDown(chunk.finalizedAtMs);
        return {
            kind: adjustment ? 'adjustment' : 'down_evidence',
            direction: adjustment ? 'down' : null,
            evidence,
            adjustment,
            snapshot: this.getSnapshot()
        };
    }

    maybeAdjustDown(atMs) {
        if (this.downEvidence.length < this.downChunkThreshold) return null;

        const next = this.getNextLowerDebounceMs();
        if (!next) return null;

        const previous = this.currentDebounceMs;
        this.currentDebounceMs = next;
        const adjustment = {
            atMs,
            direction: 'down',
            fromMs: previous,
            toMs: next,
            reason: 'repeated stable long chunks',
            upEvidenceCount: this.upEvidence.length,
            downEvidenceCount: this.downEvidence.length
        };
        this.pushBounded(this.adjustments, adjustment, 10);
        this.upEvidence = [];
        this.downEvidence = [];
        this.fragmentRun = null;
        return adjustment;
    }

    pushBounded(list, item, size) {
        list.push(item);
        while (list.length > size) list.shift();
    }

    getSnapshot() {
        return {
            activeDebounceMs: this.currentDebounceMs,
            defaultDebounceMs: this.defaultDebounceMs,
            values: this.values.slice(),
            upEvidenceCount: this.upEvidence.length,
            upEvidenceNeeded: this.upRunThreshold,
            downEvidenceCount: this.downEvidence.length,
            downEvidenceNeeded: this.downChunkThreshold,
            rawObservationCount: this.rawObservations.length,
            fragmentRun: this.fragmentRun ? {
                fragmentCount: this.fragmentRun.fragmentCount,
                totalSpeechMs: this.fragmentRun.totalSpeechMs,
                maxGapMs: this.fragmentRun.maxGapMs,
                substantive: this.isSubstantiveFragmentRun(this.fragmentRun),
                voted: Boolean(this.fragmentRun.voted)
            } : null,
            lastAdjustment: this.adjustments[this.adjustments.length - 1] || null
        };
    }
}

module.exports = { EndpointStabilityProfile, ENDPOINT_DEBOUNCE_VALUES_MS };
