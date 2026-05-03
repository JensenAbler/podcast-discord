/**
 * Post-Processor - Finalize podcast episode after recording
 * 
 * Handles:
 * - Full audio transcription using ElevenLabs Scribe
 * - Clean transcript generation (txt + json formats)
 * - Episode metadata compilation
 */

const fs = require('fs');
const path = require('path');

class EpisodePostProcessor {
    constructor(options = {}) {
        this.elevenLabs = options.elevenLabs;
        this.recordingDir = options.recordingDir;
    }

    /**
     * Process a completed recording
     * @param {Object} recordingInfo - From stopRecording()
     * @returns {Promise<Object>} - Processing results
     */
    async processEpisode(recordingInfo) {
        const recordingPath = recordingInfo.recordingPath;
        const mixedAudioPath = path.join(recordingPath, recordingInfo.mixedAudio);
        
        console.log(`[PostProcessor] Processing episode at ${recordingPath}`);

        const results = {
            recordingPath,
            files: {},
            duration: recordingInfo.duration
        };

        // 1. Transcribe full mixed audio
        if (fs.existsSync(mixedAudioPath)) {
            try {
                console.log('[PostProcessor] Transcribing mixed audio...');
                const transcriptResult = await this.transcribeFullAudio(mixedAudioPath);
                
                // Save full transcript
                const transcriptPath = path.join(recordingPath, 'transcript.txt');
                fs.writeFileSync(transcriptPath, transcriptResult.text);
                results.files.transcript = transcriptPath;
                
                // Save detailed transcript with word-level timing
                const transcriptJsonPath = path.join(recordingPath, 'transcript.json');
                fs.writeFileSync(transcriptJsonPath, JSON.stringify({
                    text: transcriptResult.text,
                    language: transcriptResult.language,
                    confidence: transcriptResult.confidence,
                    words: transcriptResult.words,
                    duration: recordingInfo.duration,
                    generatedAt: new Date().toISOString()
                }, null, 2));
                results.files.transcriptJson = transcriptJsonPath;
                
                results.transcript = transcriptResult;
                console.log(`[PostProcessor] Transcript saved (${transcriptResult.text.length} chars)`);
            } catch (error) {
                console.error('[PostProcessor] Transcription failed:', error.message);
                results.errors = [error.message];
            }
        }

        // 2. Generate episode metadata
        const metadataPath = path.join(recordingPath, 'episode-metadata.json');
        const metadata = {
            ...recordingInfo,
            processedAt: new Date().toISOString(),
            files: results.files,
            transcriptPreview: results.transcript?.text?.substring(0, 500) + '...'
        };
        fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
        results.files.metadata = metadataPath;

        // 3. Clean up the old corrupted transcript.jsonl if it exists
        const jsonlPath = path.join(recordingPath, 'transcript.jsonl');
        if (fs.existsSync(jsonlPath)) {
            const stats = fs.statSync(jsonlPath);
            // If file is huge (>1MB), it's probably corrupted with audio buffers
            if (stats.size > 1000000) {
                const backupPath = jsonlPath + '.backup';
                fs.renameSync(jsonlPath, backupPath);
                console.log(`[PostProcessor] Moved corrupted transcript.jsonl to backup`);
                results.files.transcriptBackup = backupPath;
            }
        }

        console.log('[PostProcessor] Episode processing complete');
        return results;
    }

    /**
     * Transcribe full audio file using ElevenLabs Scribe
     * @param {string} audioPath - Path to audio file
     * @returns {Promise<Object>} - Transcription result
     */
    async transcribeFullAudio(audioPath) {
        if (!this.elevenLabs) {
            throw new Error('ElevenLabs integration not available');
        }

        const audioBuffer = fs.readFileSync(audioPath);
        console.log(`[PostProcessor] Sending ${audioBuffer.length} bytes to ElevenLabs Scribe...`);

        const result = await this.elevenLabs.transcribe(audioBuffer, {
            tagAudioEvents: true
        });

        return result;
    }
}

module.exports = { EpisodePostProcessor };
