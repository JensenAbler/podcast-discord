/**
 * Post-Processor - Finalize podcast episode after recording
 * 
 * Handles:
 * - Transcript artifact generation from realtime transcript.jsonl
 * - Episode metadata compilation
 */

const fs = require('fs');
const path = require('path');

class EpisodePostProcessor {
    constructor(options = {}) {
        this.recordingDir = options.recordingDir;
    }

    /**
     * Process a completed recording
     * @param {Object} recordingInfo - From stopRecording()
     * @returns {Promise<Object>} - Processing results
     */
    async processEpisode(recordingInfo) {
        const recordingPath = recordingInfo.recordingPath;
        const jsonlPath = path.join(recordingPath, 'transcript.jsonl');
        
        console.log(`[PostProcessor] Processing episode at ${recordingPath}`);

        const results = {
            recordingPath,
            files: {},
            duration: recordingInfo.duration
        };

        // 1. Build transcript artifacts from the realtime transcript log
        if (fs.existsSync(jsonlPath)) {
            try {
                console.log('[PostProcessor] Building transcript from transcript.jsonl...');
                const transcriptResult = this.buildTranscriptFromJsonl(jsonlPath, recordingInfo);
                
                const transcriptPath = path.join(recordingPath, 'transcript.txt');
                fs.writeFileSync(transcriptPath, transcriptResult.text);
                results.files.transcript = transcriptPath;
                
                const transcriptJsonPath = path.join(recordingPath, 'transcript.json');
                fs.writeFileSync(transcriptJsonPath, JSON.stringify(transcriptResult, null, 2));
                results.files.transcriptJson = transcriptJsonPath;
                
                results.transcript = transcriptResult;
                console.log(`[PostProcessor] Transcript saved (${transcriptResult.utterances.length} utterances, ${transcriptResult.text.length} chars)`);
            } catch (error) {
                console.error('[PostProcessor] Transcript generation failed:', error.message);
                results.errors = [error.message];
            }
        } else {
            const message = 'transcript.jsonl not found';
            console.error(`[PostProcessor] ${message}`);
            results.errors = [message];
        }

        // 2. Generate episode metadata
        const metadataPath = path.join(recordingPath, 'episode-metadata.json');
        const metadata = {
            ...recordingInfo,
            processedAt: new Date().toISOString(),
            files: this.listRecordingFiles(recordingPath, [
                'episode-complete.json',
                'episode-metadata.json'
            ]),
            transcriptPreview: this.createTranscriptPreview(results.transcript?.text || '')
        };
        fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
        results.files.metadata = metadataPath;

        console.log('[PostProcessor] Episode processing complete');
        return results;
    }

    /**
     * Build clean transcript outputs from realtime JSONL utterances.
     * @param {string} jsonlPath - Path to transcript.jsonl
     * @param {Object} recordingInfo - Episode metadata from stopRecording()
     * @returns {Object} - Transcript artifact data
     */
    buildTranscriptFromJsonl(jsonlPath, recordingInfo = {}) {
        const raw = fs.readFileSync(jsonlPath, 'utf8');
        const baseTime = this.getRecordingStartMs(recordingInfo);
        const entries = raw
            .split(/\r?\n/)
            .map((line, index) => ({ line: line.trim(), index }))
            .filter(({ line }) => line.length > 0)
            .map(({ line, index }) => {
                try {
                    return {
                        entry: this.normalizeTranscriptEntry(JSON.parse(line)),
                        index
                    };
                } catch (error) {
                    throw new Error(`Invalid JSON in transcript.jsonl line ${index + 1}: ${error.message}`);
                }
            })
            .filter(({ entry }) => entry.text.trim().length > 0)
            .sort((a, b) => {
                const diff = this.getSortTimestamp(a.entry) - this.getSortTimestamp(b.entry);
                return diff || a.index - b.index;
            })
            .map(({ entry }) => entry);

        const textLines = entries.map(entry => {
            const speaker = entry.speaker || 'Unknown';
            return `${this.formatTranscriptTimestamp(entry, baseTime)} ${speaker}: ${entry.text}`;
        });
        const text = textLines.length > 0 ? `${textLines.join('\n')}\n` : '';
        const languages = this.getTranscriptLanguages(entries);
        const language = languages.length === 0
            ? 'en'
            : languages.length === 1
                ? languages[0]
                : languages;

        return {
            text,
            language,
            duration: recordingInfo.duration || 0,
            generatedAt: new Date().toISOString(),
            utterances: entries,
            speakers: this.getTranscriptSpeakers(entries),
            summary: this.createTranscriptPreview(entries.map(entry => entry.text).join(' '))
        };
    }

    normalizeTranscriptEntry(entry) {
        const text = typeof entry.text === 'string'
            ? entry.text
            : typeof entry.transcription === 'string'
                ? entry.transcription
                : '';

        return {
            ...entry,
            speaker: entry.speaker || 'Unknown',
            text: text.trim()
        };
    }

    getRecordingStartMs(recordingInfo) {
        const start = recordingInfo.startedAt || recordingInfo.startTime || recordingInfo.recordedAt;
        const parsed = Date.parse(start);
        return Number.isNaN(parsed) ? null : parsed;
    }

    getSortTimestamp(entry) {
        const timestamp = this.getTranscriptTimestampValue(entry);
        if (typeof timestamp === 'number') {
            return timestamp;
        }

        const parsed = Date.parse(timestamp);
        return Number.isNaN(parsed) ? Number.MAX_SAFE_INTEGER : parsed;
    }

    formatTranscriptTimestamp(entry, baseTime) {
        const timestamp = this.getTranscriptTimestampValue(entry);
        let seconds = 0;

        if (typeof timestamp === 'number') {
            seconds = timestamp > 1000 ? timestamp / 1000 : timestamp;
        } else {
            const parsed = Date.parse(timestamp);
            if (!Number.isNaN(parsed) && baseTime !== null) {
                seconds = Math.max(0, (parsed - baseTime) / 1000);
            }
        }

        const totalSeconds = Math.floor(seconds);
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const remainingSeconds = totalSeconds % 60;

        return [
            hours,
            minutes,
            remainingSeconds
        ].map(value => String(value).padStart(2, '0')).join(':');
    }

    getTranscriptTimestampValue(entry) {
        if (entry.playbackStartedAt) {
            return entry.playbackStartedAt;
        }

        if (entry.speechStartedAt) {
            return entry.speechStartedAt;
        }

        return entry.timestamp ?? entry.startTime ?? entry.start;
    }

    getTranscriptLanguages(entries) {
        return Array.from(new Set(entries
            .map(entry => entry.language)
            .filter(language => typeof language === 'string' && language.trim().length > 0)
            .map(language => language.trim())))
            .sort();
    }

    getTranscriptSpeakers(entries) {
        const speakers = new Map();
        for (const entry of entries) {
            const speaker = entry.speaker || 'Unknown';
            if (!speakers.has(speaker)) {
                speakers.set(speaker, {
                    speaker,
                    speakerRole: entry.speakerRole || null,
                    userId: entry.userId || null
                });
            }
        }

        return Array.from(speakers.values());
    }

    createTranscriptPreview(text) {
        const preview = (text || '').trim().substring(0, 500);
        return (text || '').trim().length > 500 ? `${preview}...` : preview;
    }

    listRecordingFiles(recordingPath, additionalFiles = []) {
        const files = new Set(fs.existsSync(recordingPath) ? fs.readdirSync(recordingPath) : []);
        for (const file of additionalFiles) {
            files.add(file);
        }

        return Array.from(files).sort();
    }
}

module.exports = { EpisodePostProcessor };
