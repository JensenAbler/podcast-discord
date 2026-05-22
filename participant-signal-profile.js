const DEFAULT_WINDOW_SIZE = 30;

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function finiteNumber(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

class ParticipantSignalProfile {
    constructor(options = {}) {
        this.windowSize = Math.max(1, Math.floor(finiteNumber(options.windowSize, DEFAULT_WINDOW_SIZE)));
        this.frameDurationMs = Math.max(1, Math.floor(finiteNumber(options.frameDurationMs, 20)));
        this.clock = typeof options.clock === 'function' ? options.clock : () => Date.now();
        this.signals = [];
    }

    recordSignal(signal = {}) {
        const entry = this.normalizeSignal(signal);
        this.signals.push(entry);

        while (this.signals.length > this.windowSize) {
            this.signals.shift();
        }

        return this.getSnapshot();
    }

    normalizeSignal(signal = {}) {
        const at = finiteNumber(signal.at, this.clock());
        const type = String(signal.type || 'unknown');

        return {
            ...signal,
            type,
            at,
            duringHostPlayback: Boolean(signal.duringHostPlayback),
            nearHostPlaybackStart: Boolean(signal.nearHostPlaybackStart),
            speakingFrames: Math.max(0, finiteNumber(signal.speakingFrames, 0)),
            silentFrames: Math.max(0, finiteNumber(signal.silentFrames, 0))
        };
    }

    getSnapshot() {
        const counts = this.getCounts();
        const vadObservations = counts.vadNoiseObservations + counts.speechEvidenceObservations;
        const asrObservations = counts.realTranscriptCount + counts.phantomUtteranceCount + counts.emptyAsrCount;
        const hostPlaybackObservations = counts.hostPlaybackFalseSignalCount + counts.hostPlaybackRealSignalCount;

        const vadNoiseScore = vadObservations > 0
            ? counts.vadNoiseObservations / vadObservations
            : 0;
        const phantomScore = asrObservations > 0
            ? (counts.phantomUtteranceCount + (counts.emptyAsrCount * 0.5)) / asrObservations
            : 0;
        const echoScore = hostPlaybackObservations > 0
            ? counts.hostPlaybackFalseSignalCount / hostPlaybackObservations
            : 0;

        const snapshot = {
            windowSize: this.windowSize,
            signalCount: this.signals.length,
            ...counts,
            vadNoiseScore,
            cadNoiseScore: vadNoiseScore,
            phantomScore,
            echoScore
        };

        snapshot.strictnessLevel = this.getStrictnessLevel(snapshot);
        return snapshot;
    }

    getCounts() {
        const counts = {
            rawVadStartCount: 0,
            speechEvidenceCount: 0,
            discardedNoSpeechFlapCount: 0,
            emptyAsrCount: 0,
            phantomUtteranceCount: 0,
            realTranscriptCount: 0,
            hostPlaybackOverlapPhantomCount: 0,
            hostPlaybackFalseSignalCount: 0,
            hostPlaybackRealSignalCount: 0,
            vadNoiseObservations: 0,
            speechEvidenceObservations: 0
        };

        for (const signal of this.signals) {
            switch (signal.type) {
                case 'raw_vad_start':
                    counts.rawVadStartCount++;
                    break;
                case 'speech_evidence':
                    counts.speechEvidenceCount++;
                    counts.speechEvidenceObservations++;
                    if (signal.duringHostPlayback || signal.nearHostPlaybackStart) {
                        counts.hostPlaybackRealSignalCount++;
                    }
                    break;
                case 'vad_discarded':
                    counts.discardedNoSpeechFlapCount++;
                    counts.vadNoiseObservations++;
                    if (signal.duringHostPlayback || signal.nearHostPlaybackStart) {
                        counts.hostPlaybackFalseSignalCount++;
                    }
                    break;
                case 'empty_asr':
                    counts.emptyAsrCount++;
                    if (signal.duringHostPlayback || signal.nearHostPlaybackStart) {
                        counts.hostPlaybackFalseSignalCount++;
                    }
                    break;
                case 'phantom_utterance':
                    counts.phantomUtteranceCount++;
                    if (signal.duringHostPlayback || signal.nearHostPlaybackStart) {
                        counts.hostPlaybackOverlapPhantomCount++;
                        counts.hostPlaybackFalseSignalCount++;
                    }
                    break;
                case 'real_transcript':
                    counts.realTranscriptCount++;
                    counts.speechEvidenceObservations++;
                    if (signal.duringHostPlayback || signal.nearHostPlaybackStart) {
                        counts.hostPlaybackRealSignalCount++;
                    }
                    break;
                default:
                    break;
            }
        }

        return counts;
    }

    getStrictnessLevel(snapshot = this.getSnapshot()) {
        const enoughVadEvidence =
            snapshot.vadNoiseObservations + snapshot.speechEvidenceObservations >= 4;
        const enoughAsrEvidence =
            snapshot.realTranscriptCount + snapshot.phantomUtteranceCount + snapshot.emptyAsrCount >= 3;
        const enoughEchoEvidence =
            snapshot.hostPlaybackFalseSignalCount + snapshot.hostPlaybackRealSignalCount >= 3;

        let level = 0;

        if (
            enoughVadEvidence &&
            snapshot.discardedNoSpeechFlapCount >= 3 &&
            snapshot.vadNoiseScore >= 0.6
        ) {
            level = Math.max(level, 3);
        } else if (enoughVadEvidence && snapshot.vadNoiseScore >= 0.4) {
            level = Math.max(level, 2);
        } else if (enoughVadEvidence && snapshot.vadNoiseScore >= 0.25) {
            level = Math.max(level, 1);
        }

        if (
            enoughAsrEvidence &&
            snapshot.phantomUtteranceCount + snapshot.emptyAsrCount >= 2 &&
            snapshot.phantomScore >= 0.5
        ) {
            level = Math.max(level, 2);
        } else if (enoughAsrEvidence && snapshot.phantomScore >= 0.3) {
            level = Math.max(level, 1);
        }

        if (enoughEchoEvidence && snapshot.echoScore >= 0.6) {
            level = Math.max(level, 3);
        } else if (enoughEchoEvidence && snapshot.echoScore >= 0.4) {
            level = Math.max(level, 2);
        }

        return clamp(level, 0, 3);
    }

    getSpeechEvidenceFrameThreshold(context = {}) {
        const snapshot = this.getSnapshot();
        let threshold = 1 + snapshot.strictnessLevel;

        if (context.nearHostPlaybackStart) {
            threshold += 2;
        }

        if (context.duringHostPlayback) {
            threshold += 3;
        }

        if (snapshot.echoScore >= 0.4 && (context.nearHostPlaybackStart || context.duringHostPlayback)) {
            threshold += 1;
        }

        return clamp(Math.round(threshold), 1, 8);
    }

    getAsrCandidateFrameThreshold(context = {}) {
        const snapshot = this.getSnapshot();
        let threshold = 1;

        if (
            snapshot.phantomUtteranceCount + snapshot.emptyAsrCount >= 2 &&
            snapshot.phantomScore >= 0.35
        ) {
            threshold += 1;
        }

        if (snapshot.strictnessLevel >= 3 && snapshot.phantomScore >= 0.5) {
            threshold += 1;
        }

        if ((context.nearHostPlaybackStart || context.duringHostPlayback) && snapshot.echoScore >= 0.5) {
            threshold += 1;
        }

        return clamp(Math.round(threshold), 1, 3);
    }

    getPrePlaybackEvidenceWaitMs(context = {}) {
        const pendingCount = Math.max(0, Math.floor(finiteNumber(context.pendingUnconfirmedCount, 0)));
        if (pendingCount === 0) {
            return 0;
        }

        const snapshot = this.getSnapshot();
        let waitMs = 150 + (snapshot.strictnessLevel * 25);

        if (snapshot.echoScore >= 0.4) {
            waitMs += 25;
        }

        return clamp(waitMs, 150, 250);
    }
}

module.exports = { ParticipantSignalProfile };
