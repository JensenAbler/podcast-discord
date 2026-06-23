const fs = require('fs');
const path = require('path');
const { AudioJournal } = require('./audio-journal');

class AudioRecorder {
    constructor(options = {}) {
        this.options = {
            outputFormat: options.outputFormat || 'wav',
            sampleRate: Number(options.sampleRate || 48000),
            channels: Number(options.channels || 2),
            bitDepth: Number(options.bitDepth || 16),
            onError: options.onError || console.error,
            onStart: options.onStart || (() => {}),
            onStop: options.onStop || (() => {}),
            ...options
        };
        this.isRecording = false;
        this.isPaused = false;
        this.outputPath = null;
        this.audioFilePath = null;
        this.startTime = null;
        this.stopTime = null;
        this.consentTimestamp = null;
        this.consentGiven = false;
        this.metadata = {};
        this.journal = null;
        this.speakers = new Set();
        this.stats = this.createEmptyStats();
    }

    createEmptyStats() {
        return {
            totalBytesWritten: 0,
            duration: 0,
            speakerCount: 0,
            speakerAudioChunks: 0,
            botAudioChunks: 0
        };
    }

    startRecording(outputPath, metadata = {}) {
        if (this.isRecording) throw new Error('Already recording');

        this.outputPath = outputPath;
        this.audioFilePath = path.join(outputPath, 'mixed-audio.wav');
        this.startTime = Date.now();
        this.consentTimestamp = metadata.consentTimestamp || new Date(this.startTime).toISOString();
        this.consentGiven = Boolean(metadata.consentGiven);
        this.metadata = { ...metadata };
        this.speakers.clear();
        this.stats = this.createEmptyStats();
        fs.mkdirSync(outputPath, { recursive: true });

        this.journal = new AudioJournal(outputPath, this.options);
        this.journal.start({
            ...metadata,
            startedAt: this.startTime,
            consentGiven: this.consentGiven,
            consentTimestamp: this.consentTimestamp
        });
        this.isRecording = true;
        this.isPaused = false;

        const info = {
            outputPath,
            audioFilePath: this.audioFilePath,
            startTime: new Date(this.startTime).toISOString(),
            consentTimestamp: this.consentTimestamp
        };
        console.log(`[AudioRecorder] Started durable recording journal in ${outputPath}`);
        this.options.onStart(info);
        return info;
    }

    addParticipantAudioChunk(userId, pcmBuffer, options = {}) {
        if (!this.isRecording || this.isPaused) return null;
        if (!Buffer.isBuffer(pcmBuffer) || pcmBuffer.length === 0) return null;

        let event;
        try {
            event = this.journal.appendPcm('participant', userId, pcmBuffer, {
                sampleRate: options.sampleRate || this.options.sampleRate,
                channels: options.channels || this.options.channels,
                capturedAt: options.capturedAt || Date.now(),
                timelineOffsetMs: options.timelineOffsetMs,
                volume: options.volume ?? 1
            });
        } catch (error) {
            this.options.onError(error);
            return null;
        }
        if (!event) return null;

        this.speakers.add(String(userId));
        this.stats.speakerCount = this.speakers.size;
        this.stats.speakerAudioChunks++;
        this.stats.totalBytesWritten += pcmBuffer.length;
        return event;
    }

    // Compatibility entry point for callers with an already-segmented PCM clip.
    addSpeakerAudio(userId, pcmBuffer, options = {}) {
        const startTime = Number(options.startTime);
        return this.addParticipantAudioChunk(userId, pcmBuffer, {
            ...options,
            capturedAt: Number.isFinite(startTime) ? startTime : Date.now(),
            timelineOffsetMs: Number.isFinite(startTime)
                ? Math.max(0, startTime - this.startTime)
                : undefined
        });
    }

    addBotPcmChunk(pcmBuffer, options = {}) {
        if (!this.isRecording || this.isPaused) return null;
        let event;
        try {
            event = this.journal.appendPcm('host', options.sourceId || 'alpha-clawd', pcmBuffer, {
                sampleRate: options.sampleRate || this.options.sampleRate,
                channels: options.channels || this.options.channels,
                capturedAt: options.capturedAt || Date.now(),
                timelineOffsetMs: options.timelineOffsetMs,
                groupId: options.groupId,
                groupOffsetMs: options.groupOffsetMs,
                volume: options.volume ?? 1
            });
        } catch (error) {
            this.options.onError(error);
            return null;
        }
        if (!event) return null;
        this.stats.botAudioChunks++;
        this.stats.totalBytesWritten += pcmBuffer.length;
        return event;
    }

    anchorBotAudioGroup(groupId, startTime) {
        if (!this.isRecording) return null;
        try {
            return this.journal.anchorGroup(groupId, startTime);
        } catch (error) {
            this.options.onError(error);
            return null;
        }
    }

    addBotAudio(audioBuffer, options = {}) {
        if (!this.isRecording || this.isPaused) return null;
        if (!Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) return null;

        if (options.format === 'pcm_s16le') {
            const startTime = Number(options.startTime);
            return this.addBotPcmChunk(audioBuffer, {
                ...options,
                capturedAt: Number.isFinite(startTime) ? startTime : Date.now(),
                timelineOffsetMs: Number.isFinite(startTime)
                    ? Math.max(0, startTime - this.startTime)
                    : undefined
            });
        }

        let event;
        try {
            event = this.journal.appendEncoded('host', options.sourceId || 'alpha-clawd', audioBuffer, {
                ...options,
                capturedAt: Date.now(),
                volume: options.volume ?? 0.9
            });
        } catch (error) {
            this.options.onError(error);
            return null;
        }
        if (!event) return null;
        this.stats.botAudioChunks++;
        this.stats.totalBytesWritten += audioBuffer.length;
        return event;
    }

    pauseRecording() {
        if (!this.isRecording) throw new Error('Not recording');
        this.isPaused = true;
        this.journal.forceSync();
    }

    resumeRecording() {
        if (!this.isRecording) throw new Error('Not recording');
        this.isPaused = false;
    }

    async stopRecording() {
        if (!this.isRecording) throw new Error('Not recording');

        this.stopTime = Date.now();
        this.isRecording = false;
        this.isPaused = false;
        this.stats.duration = (this.stopTime - this.startTime) / 1000;

        const finalized = await this.journal.finalize({ stoppedAt: this.stopTime });
        this.audioFilePath = finalized.outputPath;
        const fileStats = this.getFileStats();
        await this.saveMetadata(finalized);
        await this.saveConsentAcknowledgment();

        const result = {
            outputPath: this.outputPath,
            audioFilePath: this.audioFilePath,
            startTime: new Date(this.startTime).toISOString(),
            stopTime: new Date(this.stopTime).toISOString(),
            duration: finalized.duration,
            consentTimestamp: this.consentTimestamp,
            consentGiven: this.consentGiven,
            botAudioChunks: this.stats.botAudioChunks,
            stems: finalized.stems,
            ...fileStats
        };
        console.log(
            `[AudioRecorder] Finalized ${finalized.events} journal events into ` +
            `${finalized.stems.length} stems and ${this.audioFilePath}`
        );
        this.options.onStop(result);
        return result;
    }

    getFileStats() {
        try {
            const stats = fs.statSync(this.audioFilePath);
            return {
                size: stats.size,
                sizeMB: (stats.size / (1024 * 1024)).toFixed(2)
            };
        } catch {
            return { size: 0, sizeMB: '0.00' };
        }
    }

    async saveMetadata(finalized = {}) {
        const metadata = {
            episode: {
                recordedAt: new Date(this.startTime).toISOString(),
                duration: finalized.duration ?? this.stats.duration,
                format: this.options.outputFormat,
                sampleRate: this.options.sampleRate,
                channels: this.options.channels
            },
            consent: {
                given: this.consentGiven,
                timestamp: this.consentTimestamp,
                method: 'explicit_verbal_acknowledgment'
            },
            participants: {
                speakers: Array.from(this.speakers).map((userId) => ({ userId })),
                speakerCount: this.stats.speakerCount
            },
            audio: {
                participantPcmChunks: this.stats.speakerAudioChunks,
                hostAudioChunks: this.stats.botAudioChunks,
                journaledBytes: this.stats.totalBytesWritten,
                stems: finalized.stems || []
            },
            files: {
                mixedAudio: path.basename(this.audioFilePath),
                transcript: 'transcript.jsonl',
                journal: 'audio-journal/chunks.jsonl'
            },
            episodePlan: this.metadata.episodePlan || null
        };
        fs.writeFileSync(
            path.join(this.outputPath, 'audio-recording-metadata.json'),
            JSON.stringify(metadata, null, 2)
        );
        return metadata;
    }

    async saveConsentAcknowledgment() {
        const content = `RECORDING CONSENT ACKNOWLEDGMENT
================================

Podcast: Alpha-Clawd
Episode Recording Started: ${new Date(this.startTime).toISOString()}
Consent Timestamp: ${this.consentTimestamp}
Consent Method: Explicit verbal acknowledgment via text

CONSENT GIVEN: ${this.consentGiven ? 'YES' : 'NO'}

Generated: ${new Date().toISOString()}
`;
        fs.writeFileSync(path.join(this.outputPath, 'consent-acknowledgment.txt'), content);
    }

    getRecordingInfo() {
        if (!this.isRecording) return null;
        const currentDuration = (Date.now() - this.startTime) / 1000;
        return {
            isRecording: true,
            isPaused: this.isPaused,
            outputPath: this.outputPath,
            audioFilePath: this.audioFilePath,
            duration: currentDuration,
            durationFormatted: this.formatDuration(currentDuration),
            consentTimestamp: this.consentTimestamp,
            consentGiven: this.consentGiven,
            speakerCount: this.stats.speakerCount,
            botAudioChunks: this.stats.botAudioChunks,
            journaledBytes: this.stats.totalBytesWritten
        };
    }

    formatDuration(seconds) {
        const hrs = Math.floor(seconds / 3600);
        const mins = Math.floor((seconds % 3600) / 60);
        const secs = Math.floor(seconds % 60);
        return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }

    isCurrentlyRecording() {
        return this.isRecording;
    }

    isCurrentlyPaused() {
        return this.isPaused;
    }

    destroy() {
        if (this.journal) this.journal.close();
        this.isRecording = false;
    }

    static recoverIncompleteRecordings(recordingDir) {
        return AudioJournal.recoverIncompleteRecordings(recordingDir);
    }
}

module.exports = { AudioRecorder };
