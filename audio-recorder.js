/**
 * Audio Recorder - Mixed audio recording for podcast episodes
 * 
 * Records mixed audio from ALL sources (speakers + bot output) into a single file.
 * Mixes multiple PCM streams into stereo output, saves as WAV or MP3.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Transform, Readable } = require('stream');

class AudioRecorder {
    constructor(options = {}) {
        this.options = {
            outputFormat: options.outputFormat || 'wav', // 'wav' or 'mp3'
            sampleRate: options.sampleRate || 48000,
            channels: options.channels || 2,
            bitDepth: options.bitDepth || 16,
            normalizeVolume: options.normalizeVolume !== false, // default true
            onError: options.onError || console.error,
            onStart: options.onStart || (() => {}),
            onStop: options.onStop || (() => {}),
            ...options
        };

        // Recording state
        this.isRecording = false;
        this.isPaused = false;
        this.outputPath = null;
        this.startTime = null;
        this.stopTime = null;
        this.consentTimestamp = null;
        this.consentGiven = false;

        // Audio sources - both buffered with timestamps for proper mixing
        this.speakerStreams = new Map(); // userId -> { stream, volume, chunks: [] }
        this.speakerAudioBuffer = []; // Array of {userId, buffer, timestamp, volume} for all speakers
        this.botAudioBuffer = []; // Array of {buffer, timestamp, volume} for bot audio

        // Mixing state
        this.mixBuffer = [];
        this.ffmpegProcess = null;
        this.writeStream = null;

        // Recording stats
        this.stats = {
            totalBytesWritten: 0,
            duration: 0,
            speakerCount: 0,
            botAudioChunks: 0
        };
    }

    /**
     * Start recording mixed audio
     * @param {string} outputPath - Directory path for recording
     * @param {Object} metadata - Recording metadata including consent
     * @returns {Object} - Recording info
     */
    startRecording(outputPath, metadata = {}) {
        if (this.isRecording) {
            throw new Error('Already recording');
        }

        this.outputPath = outputPath;
        this.startTime = Date.now();
        this.consentTimestamp = metadata.consentTimestamp || new Date().toISOString();
        this.consentGiven = metadata.consentGiven || false;

        // Create output directory
        if (!fs.existsSync(outputPath)) {
            fs.mkdirSync(outputPath, { recursive: true });
        }

        // Set up the audio file path
        const extension = this.options.outputFormat === 'mp3' ? 'mp3' : 'wav';
        this.audioFilePath = path.join(outputPath, `mixed-audio.${extension}`);

        // Reset state
        this.speakerStreams.clear();
        this.speakerAudioBuffer = [];
        this.botAudioBuffer = [];
        this.mixBuffer = [];
        this.stats = {
            totalBytesWritten: 0,
            duration: 0,
            speakerCount: 0,
            speakerAudioChunks: 0,
            botAudioChunks: 0
        };

        // Start ffmpeg for mixed recording
        this.startFFmpeg();

        this.isRecording = true;
        this.isPaused = false;

        console.log(`[AudioRecorder] Started recording to ${this.audioFilePath}`);
        this.options.onStart({
            outputPath: this.outputPath,
            audioFilePath: this.audioFilePath,
            startTime: this.startTime
        });

        return {
            outputPath: this.outputPath,
            audioFilePath: this.audioFilePath,
            startTime: new Date(this.startTime).toISOString(),
            consentTimestamp: this.consentTimestamp
        };
    }

    /**
     * Start FFmpeg process for audio mixing
     */
    startFFmpeg() {
        const { sampleRate, channels, outputFormat } = this.options;

        // FFmpeg command for mixing multiple inputs
        // We'll use raw PCM input via pipe
        const args = [
            '-y', // Overwrite output files
            '-f', 's16le', // Input format: signed 16-bit little-endian
            '-ar', sampleRate.toString(),
            '-ac', channels.toString(),
            '-i', 'pipe:0', // Input from stdin
            '-af', 'volume=0.8,dynaudnorm=p=0.95', // Normalize audio
            ...(outputFormat === 'mp3' ? [
                '-codec:a', 'libmp3lame',
                '-q:a', '2' // High quality VBR
            ] : [
                '-codec:a', 'pcm_s16le'
            ]),
            this.audioFilePath
        ];

        console.log(`[AudioRecorder] Starting FFmpeg: ffmpeg ${args.join(' ')}`);

        this.ffmpegProcess = spawn('ffmpeg', args, {
            stdio: ['pipe', 'pipe', 'pipe']
        });

        this.ffmpegProcess.on('error', (error) => {
            console.error('[AudioRecorder] FFmpeg error:', error);
            this.options.onError(error);
        });

        this.ffmpegProcess.on('exit', (code) => {
            if (code !== 0 && code !== null) {
                console.error(`[AudioRecorder] FFmpeg exited with code ${code}`);
            } else {
                console.log('[AudioRecorder] FFmpeg finished');
            }
        });

        this.ffmpegProcess.stderr.on('data', (data) => {
            // FFmpeg outputs progress info to stderr
            const output = data.toString();
            if (output.includes('Error') || output.includes('error')) {
                console.error('[AudioRecorder] FFmpeg:', output);
            }
        });
    }

    /**
     * Add a speaker's PCM audio chunk to the mix
     * @param {string} userId - Discord user ID
     * @param {Buffer} pcmBuffer - PCM audio data
     * @param {Object} options - Options (volume, etc.)
     */
    addSpeakerAudio(userId, pcmBuffer, options = {}) {
        if (!this.isRecording || this.isPaused) return;
        if (!Buffer.isBuffer(pcmBuffer) || pcmBuffer.length === 0) return;

        const volume = options.volume || 1.0;
        const hasProvidedStartTime = options.startTime !== undefined && options.startTime !== null;
        const providedStartTime = hasProvidedStartTime ? Number(options.startTime) : NaN;
        // Use provided startTime (when speech began) or fall back to current time.
        // Some utterances can finish ASR after recording starts even though their
        // audio began before it, so normalize those before they reach FFmpeg.
        let timestamp = hasProvidedStartTime && Number.isFinite(providedStartTime)
            ? providedStartTime - this.startTime
            : Date.now() - this.startTime;
        let buffer = pcmBuffer;

        if (!Number.isFinite(timestamp)) {
            console.warn(`[AudioRecorder] Skipping speaker audio for ${userId}: invalid timestamp ${timestamp}`);
            return;
        }

        if (timestamp < 0) {
            const trimMs = -timestamp;
            buffer = this.trimPcmStart(buffer, trimMs);
            if (buffer.length === 0) {
                console.warn(`[AudioRecorder] Skipping speaker audio for ${userId}: chunk ended before recording start`);
                return;
            }
            console.warn(`[AudioRecorder] Trimmed ${Math.round(trimMs)}ms of pre-recording speaker audio for ${userId}`);
            timestamp = 0;
        }

        // Store speaker stream info
        if (!this.speakerStreams.has(userId)) {
            this.speakerStreams.set(userId, {
                userId,
                volume,
                chunks: 0
            });
            this.stats.speakerCount = this.speakerStreams.size;
        }

        const speaker = this.speakerStreams.get(userId);
        speaker.chunks++;

        // Buffer with timestamp for proper mixing (don't write immediately)
        this.speakerAudioBuffer.push({
            userId,
            buffer,
            timestamp,
            volume
        });
        this.stats.speakerAudioChunks++;
    }

    /**
     * Trim raw PCM from the start of a chunk, aligned to whole audio frames.
     * @param {Buffer} buffer - PCM audio data
     * @param {number} trimMs - Milliseconds to remove
     * @returns {Buffer}
     */
    trimPcmStart(buffer, trimMs) {
        if (!Number.isFinite(trimMs) || trimMs <= 0) return buffer;

        const bytesPerSample = this.options.bitDepth / 8;
        const frameSize = this.options.channels * bytesPerSample;
        const framesToTrim = Math.ceil((trimMs / 1000) * this.options.sampleRate);
        const bytesToTrim = framesToTrim * frameSize;

        if (!Number.isFinite(bytesToTrim) || bytesToTrim <= 0) return buffer;
        if (bytesToTrim >= buffer.length) return Buffer.alloc(0);

        return buffer.slice(bytesToTrim);
    }

    /**
     * Convert a chunk timestamp to a safe FFmpeg adelay value.
     * @param {number} timestamp - Chunk offset in milliseconds
     * @param {string} label - Chunk label for diagnostics
     * @returns {number|null}
     */
    getSafeDelayMs(timestamp, label) {
        const delayMs = Math.round(Number(timestamp));

        if (!Number.isFinite(delayMs)) {
            console.warn(`[AudioRecorder] Skipping ${label}: invalid delay ${timestamp}`);
            return null;
        }

        if (delayMs < 0) {
            console.warn(`[AudioRecorder] Clamping ${label}: negative delay ${delayMs}ms`);
            return 0;
        }

        return delayMs;
    }

    /**
     * Add bot TTS audio to the mix
     * @param {Buffer} pcmBuffer - PCM audio data (should be 48kHz, stereo, s16le)
     * @param {Object} options - Options (volume, etc.)
     */
    addBotAudio(pcmBuffer, options = {}) {
        if (!this.isRecording || this.isPaused) return;

        const volume = options.volume || 0.9; // Slightly lower for bot

        // Convert MP3 to PCM if needed (ElevenLabs returns MP3)
        this.convertAndMixBotAudio(pcmBuffer, volume, options);
    }

    /**
     * Convert bot audio (MP3) to PCM and add to mix
     * @param {Buffer} audioBuffer - Audio buffer (MP3 or PCM)
     * @param {number} volume - Volume multiplier
     */
    async convertAndMixBotAudio(audioBuffer, volume, options = {}) {
        try {
            // For now, we'll write bot audio to a separate file and mix later
            // Real-time MP3 decoding requires more complex handling
            // Store for post-processing or use ffmpeg filter_complex

            // Store in buffer for now (will be mixed in finalization)
            const hasProvidedStartTime = options.startTime !== undefined && options.startTime !== null;
            const providedStartTime = hasProvidedStartTime ? Number(options.startTime) : NaN;
            const timestamp = hasProvidedStartTime && Number.isFinite(providedStartTime)
                ? providedStartTime - this.startTime
                : Date.now() - this.startTime;

            if (!Number.isFinite(timestamp)) {
                console.warn(`[AudioRecorder] Skipping bot audio: invalid timestamp ${timestamp}`);
                return;
            }

            this.botAudioBuffer.push({
                buffer: audioBuffer,
                timestamp,
                volume
            });
            this.stats.botAudioChunks++;

            // Write to ffmpeg stdin if available (assuming PCM for now)
            if (this.ffmpegProcess && this.ffmpegProcess.stdin.writable) {
                // Note: ElevenLabs returns MP3, so we need to convert
                // For real-time mixing, we'd need a proper MP3 decoder stream
                // This is a simplified implementation
            }
        } catch (error) {
            console.error('[AudioRecorder] Error adding bot audio:', error);
        }
    }

    /**
     * Add PCM buffer to the mix queue
     * @param {Buffer} buffer - PCM data
     * @param {string} source - 'speaker' or 'bot'
     * @param {string} sourceId - User ID or 'bot'
     */
    addToMix(buffer, source, sourceId) {
        // Write directly to ffmpeg stdin for real-time recording
        if (this.ffmpegProcess && this.ffmpegProcess.stdin.writable && !this.ffmpegProcess.stdin.destroyed) {
            try {
                this.ffmpegProcess.stdin.write(buffer);
                this.stats.totalBytesWritten += buffer.length;
            } catch (error) {
                console.error('[AudioRecorder] Error writing to FFmpeg:', error);
            }
        }
    }

    /**
     * Adjust volume of PCM buffer
     * @param {Buffer} buffer - PCM data
     * @param {number} volume - Volume multiplier (0.0 - 1.0)
     * @returns {Buffer}
     */
    adjustVolume(buffer, volume) {
        if (volume === 1.0) return buffer;

        // Create new buffer for adjusted audio
        const adjusted = Buffer.alloc(buffer.length);

        // Process as 16-bit samples
        for (let i = 0; i < buffer.length; i += 2) {
            const sample = buffer.readInt16LE(i);
            const adjustedSample = Math.max(-32768, Math.min(32767, Math.round(sample * volume)));
            adjusted.writeInt16LE(adjustedSample, i);
        }

        return adjusted;
    }

    /**
     * Mix multiple PCM buffers together
     * @param {Array<{buffer: Buffer, volume: number}>} inputs - Audio inputs
     * @returns {Buffer}
     */
    mixBuffers(inputs) {
        if (inputs.length === 0) return Buffer.alloc(0);
        if (inputs.length === 1) return inputs[0].buffer;

        // Find max length
        const maxLength = Math.max(...inputs.map(i => i.buffer.length));

        // Create output buffer
        const output = Buffer.alloc(maxLength);

        // Mix sample by sample
        for (let i = 0; i < maxLength; i += 2) {
            let mixed = 0;

            for (const input of inputs) {
                if (i < input.buffer.length) {
                    const sample = input.buffer.readInt16LE(i);
                    mixed += sample * input.volume;
                }
            }

            // Normalize to prevent clipping
            mixed = mixed / Math.sqrt(inputs.length);
            mixed = Math.max(-32768, Math.min(32767, Math.round(mixed)));

            output.writeInt16LE(mixed, i);
        }

        return output;
    }

    /**
     * Mix all audio chunks (speaker + bot) into the final recording
     * Uses ffmpeg to properly position audio at their recorded timestamps
     */
    async mixAllAudioIntoRecording() {
        const totalChunks = this.speakerAudioBuffer.length + this.botAudioBuffer.length;
        if (totalChunks === 0) return;

        console.log(`[AudioRecorder] Mixing ${this.speakerAudioBuffer.length} speaker chunks + ${this.botAudioBuffer.length} bot chunks into recording...`);

        const tempDir = path.join(this.outputPath, 'temp_audio');
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }

        try {
            // Build ffmpeg filter_complex for mixing
            const inputs = [];
            const delays = [];
            const mixes = [];

            // Main audio input is [0:a] (silence/base track)
            let inputIndex = 1;

            // Process speaker audio chunks (convert PCM to temp files)
            for (let i = 0; i < this.speakerAudioBuffer.length; i++) {
                const chunk = this.speakerAudioBuffer[i];
                const delayMs = this.getSafeDelayMs(chunk.timestamp, `speaker chunk ${i}`);
                if (delayMs === null || !chunk.buffer || chunk.buffer.length === 0) {
                    continue;
                }

                const tempFile = path.join(tempDir, `speaker_chunk_${i}.raw`);
                fs.writeFileSync(tempFile, chunk.buffer);
                inputs.push('-f', 's16le', '-ar', '48000', '-ac', '2', '-i', tempFile);

                const volume = chunk.volume || 1.0;

                // Create delayed stream with volume adjustment
                delays.push(`[${inputIndex}:a]adelay=delays=${delayMs}|${delayMs},volume=${volume}[spk${i}];`);
                mixes.push(`[spk${i}]`);
                inputIndex++;
            }

            // Process bot audio chunks (MP3 from ElevenLabs)
            for (let i = 0; i < this.botAudioBuffer.length; i++) {
                const chunk = this.botAudioBuffer[i];
                const delayMs = this.getSafeDelayMs(chunk.timestamp, `bot chunk ${i}`);
                if (delayMs === null || !chunk.buffer || chunk.buffer.length === 0) {
                    continue;
                }

                const tempFile = path.join(tempDir, `bot_chunk_${i}.mp3`);
                fs.writeFileSync(tempFile, chunk.buffer);
                inputs.push('-i', tempFile);

                const volume = chunk.volume || 0.9;

                delays.push(`[${inputIndex}:a]adelay=delays=${delayMs}|${delayMs},volume=${volume}[bot${i}];`);
                mixes.push(`[bot${i}]`);
                inputIndex++;
            }

            // Build the amix filter - mix main audio with all streams
            const totalInputs = 1 + mixes.length;
            if (mixes.length === 0) {
                console.warn('[AudioRecorder] No valid audio chunks to mix');
                return;
            }

            // normalize=0 prevents amix from dividing by the count of currently-active
            // inputs. The silent base track [0:a] is always active, so the default
            // normalize=1 was halving every chunk and dividing by more whenever chunks
            // overlapped. dynaudnorm levels perceived loudness and tames any summation
            // peaks. Matches the dynaudnorm=p=0.95 used during base-track recording.
            const mixFilter = `${mixes.join('')}[0:a]amix=inputs=${totalInputs}:duration=longest:dropout_transition=0.5:normalize=0[mixed];[mixed]dynaudnorm=p=0.95[out]`;

            const filterComplex = [...delays, mixFilter].join('');

            // Run ffmpeg to mix everything
            const args = [
                '-y',
                '-i', this.audioFilePath, // Main recording (silence/base) [0:a]
                ...inputs,                 // All audio chunks [1:a], [2:a], etc.
                '-filter_complex', filterComplex,
                '-map', '[out]',
                '-c:a', 'pcm_s16le',
                '-ar', this.options.sampleRate.toString(),
                '-ac', this.options.channels.toString(),
                `${this.audioFilePath}.mixed.wav`
            ];

            console.log(`[AudioRecorder] Running ffmpeg mix: ${this.speakerAudioBuffer.length} speaker + ${this.botAudioBuffer.length} bot chunks...`);

            await new Promise((resolve, reject) => {
                const ffmpeg = spawn('ffmpeg', args);
                let stderr = '';

                ffmpeg.stderr.on('data', (data) => {
                    stderr += data.toString();
                });

                ffmpeg.on('exit', (code) => {
                    if (code !== 0) {
                        console.error('[AudioRecorder] FFmpeg mix error:', stderr);
                        reject(new Error(`FFmpeg mix failed with code ${code}`));
                    } else {
                        resolve();
                    }
                });

                ffmpeg.on('error', reject);
            });

            // Replace original with mixed version
            fs.renameSync(`${this.audioFilePath}.mixed.wav`, this.audioFilePath);
            console.log(`[AudioRecorder] All audio mixed successfully (${this.speakerAudioBuffer.length} speaker + ${this.botAudioBuffer.length} bot chunks)`);

            // Update stats
            const stats = fs.statSync(this.audioFilePath);
            this.stats.totalBytesWritten = stats.size;

        } catch (error) {
            console.error('[AudioRecorder] Failed to mix audio:', error.message);
            if (fs.existsSync(`${this.audioFilePath}.mixed.wav`)) {
                fs.unlinkSync(`${this.audioFilePath}.mixed.wav`);
            }
        } finally {
            // Clean up temp directory
            if (fs.existsSync(tempDir)) {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        }
    }

    /**
     * Pause recording
     */
    pauseRecording() {
        if (!this.isRecording) {
            throw new Error('Not recording');
        }
        this.isPaused = true;
        console.log('[AudioRecorder] Recording paused');
    }

    /**
     * Resume recording
     */
    resumeRecording() {
        if (!this.isRecording) {
            throw new Error('Not recording');
        }
        this.isPaused = false;
        console.log('[AudioRecorder] Recording resumed');
    }

    /**
     * Stop recording and finalize the audio file
     * @returns {Object} - Recording result
     */
    async stopRecording() {
        if (!this.isRecording) {
            throw new Error('Not recording');
        }

        this.stopTime = Date.now();
        this.isRecording = false;
        this.isPaused = false;

        // Calculate duration
        this.stats.duration = (this.stopTime - this.startTime) / 1000;

        // Close ffmpeg stdin to finalize
        if (this.ffmpegProcess && this.ffmpegProcess.stdin) {
            this.ffmpegProcess.stdin.end();
        }

        // Wait for ffmpeg to finish (creates base silent track)
        await this.waitForFFmpeg();

        // Mix all audio (speaker + bot) with proper timestamps
        await this.mixAllAudioIntoRecording();

        // Get file stats
        const fileStats = this.getFileStats();

        // Save metadata
        await this.saveMetadata();

        // Save consent acknowledgment
        await this.saveConsentAcknowledgment();

        console.log(`[AudioRecorder] Stopped recording. Duration: ${this.stats.duration}s, Size: ${fileStats.size} bytes`);

        this.options.onStop({
            outputPath: this.outputPath,
            audioFilePath: this.audioFilePath,
            duration: this.stats.duration,
            ...fileStats
        });

        return {
            outputPath: this.outputPath,
            audioFilePath: this.audioFilePath,
            startTime: new Date(this.startTime).toISOString(),
            stopTime: new Date(this.stopTime).toISOString(),
            duration: this.stats.duration,
            consentTimestamp: this.consentTimestamp,
            botAudioChunks: this.stats.botAudioChunks,
            ...fileStats
        };
    }

    /**
     * Wait for FFmpeg process to complete
     * @returns {Promise<void>}
     */
    waitForFFmpeg() {
        return new Promise((resolve) => {
            if (!this.ffmpegProcess) {
                resolve();
                return;
            }

            const timeout = setTimeout(() => {
                console.warn('[AudioRecorder] FFmpeg wait timeout, forcing kill');
                this.ffmpegProcess.kill('SIGKILL');
                resolve();
            }, 10000);

            this.ffmpegProcess.on('exit', () => {
                clearTimeout(timeout);
                resolve();
            });
        });
    }

    /**
     * Get file statistics
     * @returns {Object}
     */
    getFileStats() {
        try {
            const stats = fs.statSync(this.audioFilePath);
            return {
                size: stats.size,
                sizeMB: (stats.size / (1024 * 1024)).toFixed(2)
            };
        } catch (error) {
            return { size: 0, sizeMB: '0.00' };
        }
    }

    /**
     * Save recording metadata
     */
    async saveMetadata() {
        const metadata = {
            episode: {
                recordedAt: new Date(this.startTime).toISOString(),
                duration: this.stats.duration,
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
                speakers: Array.from(this.speakerStreams.values()).map(s => ({
                    userId: s.userId,
                    chunks: s.chunks
                })),
                speakerCount: this.stats.speakerCount
            },
            audio: {
                speakerChunks: this.stats.speakerAudioChunks,
                botChunks: this.stats.botAudioChunks,
                totalChunks: this.stats.speakerAudioChunks + this.stats.botAudioChunks
            },
            files: {
                mixedAudio: path.basename(this.audioFilePath),
                transcript: 'transcript.jsonl',
                metadata: 'episode-complete.json'
            }
        };

        const metadataPath = path.join(this.outputPath, 'episode-complete.json');
        fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));

        return metadata;
    }

    /**
     * Save consent acknowledgment text file
     */
    async saveConsentAcknowledgment() {
        const content = `RECORDING CONSENT ACKNOWLEDGMENT
================================

Podcast: Alpha-Clawd
Episode Recording Started: ${new Date(this.startTime).toISOString()}
Consent Timestamp: ${this.consentTimestamp}
Consent Method: Explicit verbal acknowledgment via text

CONSENT GIVEN: ${this.consentGiven ? 'YES' : 'NO'}

Disclosure provided to participants:
"I'll be recording this conversation for the podcast. Do all participants 
consent to being recorded? Please type YES to proceed or NO to cancel."

Participant Response: ${this.consentGiven ? 'YES - Recording authorized' : 'NO - Recording declined'}

${this.consentGiven ? 
`All participants have explicitly consented to being recorded for this 
podcast episode. This recording is authorized and may be distributed 
in accordance with the podcast's terms.` : 
`Consent was not obtained. Recording was cancelled as requested.`}

Generated: ${new Date().toISOString()}
`;

        const consentPath = path.join(this.outputPath, 'consent-acknowledgment.txt');
        fs.writeFileSync(consentPath, content);
    }

    /**
     * Get current recording information
     * @returns {Object|null}
     */
    getRecordingInfo() {
        if (!this.isRecording) {
            return null;
        }

        const currentDuration = (Date.now() - this.startTime) / 1000;
        const fileStats = this.getFileStats();

        return {
            isRecording: this.isRecording,
            isPaused: this.isPaused,
            outputPath: this.outputPath,
            audioFilePath: this.audioFilePath,
            duration: currentDuration,
            durationFormatted: this.formatDuration(currentDuration),
            consentTimestamp: this.consentTimestamp,
            consentGiven: this.consentGiven,
            speakerCount: this.stats.speakerCount,
            botAudioChunks: this.stats.botAudioChunks,
            ...fileStats
        };
    }

    /**
     * Format seconds as HH:MM:SS
     * @param {number} seconds
     * @returns {string}
     */
    formatDuration(seconds) {
        const hrs = Math.floor(seconds / 3600);
        const mins = Math.floor((seconds % 3600) / 60);
        const secs = Math.floor(seconds % 60);
        return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }

    /**
     * Check if currently recording
     * @returns {boolean}
     */
    isCurrentlyRecording() {
        return this.isRecording;
    }

    /**
     * Check if recording is paused
     * @returns {boolean}
     */
    isCurrentlyPaused() {
        return this.isPaused;
    }

    /**
     * Clean up resources
     */
    destroy() {
        if (this.isRecording) {
            this.stopRecording().catch(console.error);
        }

        if (this.ffmpegProcess) {
            this.ffmpegProcess.kill('SIGKILL');
            this.ffmpegProcess = null;
        }

        this.speakerStreams.clear();
        this.botAudioBuffer = [];
    }
}

module.exports = { AudioRecorder };
