/**
 * Whisper.cpp STT Provider - Local Speech-to-Text using whisper.cpp
 * 
 * Completely free, runs locally on CPU.
 * - No API calls, no rate limits, no costs
 * - Latency: ~200-500ms for short utterances on modern CPU
 * - Quality: Good with base/small models, excellent with medium/large
 * 
 * Requires:
 * - whisper.cpp built at /opt/whisper.cpp
 * - GGML model files in /opt/whisper.cpp/models/
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

class WhisperCppSTTProvider {
    constructor(options = {}) {
        this.whisperPath = options.whisperPath || process.env.WHISPER_CPP_PATH || '/opt/whisper.cpp/build/bin/whisper-cli';
        this.modelPath = options.modelPath || process.env.WHISPER_CPP_MODEL || '/opt/whisper.cpp/models/ggml-base.en.bin';
        this.threads = options.threads || process.env.WHISPER_CPP_THREADS || Math.max(1, os.cpus().length - 1);
        this.language = options.language || process.env.WHISPER_CPP_LANGUAGE || 'en';
        this.timeout = options.timeout || 30000;
        
        // Validate paths on init
        this.validatePaths();
    }

    /**
     * Validate that whisper.cpp binary and model exist
     */
    validatePaths() {
        if (!fs.existsSync(this.whisperPath)) {
            console.warn(`[WhisperCpp STT] Binary not found at: ${this.whisperPath}`);
            console.warn(`[WhisperCpp STT] Run: cd /opt && git clone https://github.com/ggerganov/whisper.cpp.git && cd whisper.cpp && cmake -B build && cmake --build build`);
        }
        if (!fs.existsSync(this.modelPath)) {
            console.warn(`[WhisperCpp STT] Model not found at: ${this.modelPath}`);
            console.warn(`[WhisperCpp STT] Run: cd /opt/whisper.cpp && bash models/download-ggml-model.sh base.en`);
        }
    }

    /**
     * Speech-to-Text transcription using local whisper.cpp
     * 
     * @param {Buffer} audioBuffer - Audio file buffer (WAV format preferred)
     * @param {Object} options - Transcription options
     * @returns {Promise<Object>} - Transcription result
     */
    async transcribe(audioBuffer, options = {}) {
        const startTime = Date.now();
        
        console.log(`[WhisperCpp STT] Transcribing ${audioBuffer.length} bytes...`);

        // Validate binary and model exist
        if (!fs.existsSync(this.whisperPath)) {
            throw new Error(`whisper-cli binary not found at: ${this.whisperPath}. Please build whisper.cpp first.`);
        }
        if (!fs.existsSync(this.modelPath)) {
            throw new Error(`Model not found at: ${this.modelPath}. Please download a model first.`);
        }

        // Create temp file for audio input
        const tempDir = os.tmpdir();
        const tempInputFile = path.join(tempDir, `whisper-input-${Date.now()}.wav`);
        const tempOutputFile = path.join(tempDir, `whisper-output-${Date.now()}.txt`);

        try {
            // Write audio buffer to temp file with proper WAV header
            // Discord audio is PCM 48kHz, 16-bit, stereo - needs WAV header for whisper.cpp
            const wavBuffer = this.addWavHeader(audioBuffer, 48000, 2, 16);
            fs.writeFileSync(tempInputFile, wavBuffer);

            // Build whisper-cli arguments
            const args = [
                '-m', this.modelPath,
                '-f', tempInputFile,
                '-l', options.language || this.language,
                '-t', String(this.threads),
                '--no-timestamps',
                '-otxt', // Output to text file
                '-of', tempOutputFile.replace('.txt', '') // Output file prefix (whisper adds .txt)
            ];

            // Optional: Add print progress for debugging
            if (process.env.WHISPER_CPP_DEBUG) {
                args.push('-pp');
            }

            console.log(`[WhisperCpp STT] Running: ${this.whisperPath} ${args.join(' ')}`);

            // Run whisper-cli
            const result = await this.runWhisperCli(args, this.timeout);
            
            // Read output file
            let transcription = '';
            const actualOutputFile = tempOutputFile; // whisper adds .txt
            if (fs.existsSync(actualOutputFile)) {
                transcription = fs.readFileSync(actualOutputFile, 'utf8').trim();
                // Clean up whisper's output format (remove trailing newlines, etc.)
                transcription = transcription.replace(/\[.*?\]/g, '').trim();
            }

            const duration = Date.now() - startTime;
            console.log(`[WhisperCpp STT] Transcription complete in ${duration}ms: "${transcription.substring(0, 50)}..."`);

            // Normalize response to match other STT providers
            return {
                text: transcription,
                language: options.language || this.language,
                confidence: this.estimateConfidence(transcription),
                words: this.extractWords(transcription),
                duration: duration,
                raw: { transcription }
            };

        } catch (error) {
            console.error('[WhisperCpp STT] Transcription error:', error);
            throw error;
        } finally {
            // Cleanup temp files
            try {
                if (fs.existsSync(tempInputFile)) fs.unlinkSync(tempInputFile);
                if (fs.existsSync(tempOutputFile)) fs.unlinkSync(tempOutputFile);
                // Also clean up whisper's output files
                const whisperOutputTxt = tempOutputFile.replace('.txt', '') + '.txt';
                const whisperOutputWav = tempOutputFile.replace('.txt', '') + '.wav';
                if (fs.existsSync(whisperOutputTxt)) fs.unlinkSync(whisperOutputTxt);
                if (fs.existsSync(whisperOutputWav)) fs.unlinkSync(whisperOutputWav);
            } catch (cleanupError) {
                // Ignore cleanup errors
            }
        }
    }

    /**
     * Run whisper-cli process with timeout
     */
    runWhisperCli(args, timeoutMs) {
        return new Promise((resolve, reject) => {
            const process = spawn(this.whisperPath, args);
            let stdout = '';
            let stderr = '';
            let timedOut = false;

            const timeout = setTimeout(() => {
                timedOut = true;
                process.kill('SIGTERM');
                reject(new Error(`whisper-cli timed out after ${timeoutMs}ms`));
            }, timeoutMs);

            process.stdout.on('data', (data) => {
                stdout += data.toString();
            });

            process.stderr.on('data', (data) => {
                stderr += data.toString();
            });

            process.on('close', (code) => {
                clearTimeout(timeout);
                
                if (timedOut) return;
                
                if (code !== 0) {
                    reject(new Error(`whisper-cli exited with code ${code}: ${stderr}`));
                } else {
                    resolve({ stdout, stderr });
                }
            });

            process.on('error', (error) => {
                clearTimeout(timeout);
                reject(new Error(`Failed to start whisper-cli: ${error.message}`));
            });
        });
    }

    /**
     * Add WAV header to raw PCM audio data
     * 
     * @param {Buffer} pcmData - Raw PCM audio data
     * @param {number} sampleRate - Sample rate in Hz (e.g., 48000)
     * @param {number} numChannels - Number of channels (1 for mono, 2 for stereo)
     * @param {number} bitsPerSample - Bits per sample (8, 16, 24, 32)
     * @returns {Buffer} - WAV formatted buffer with header
     */
    addWavHeader(pcmData, sampleRate, numChannels, bitsPerSample) {
        const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
        const blockAlign = numChannels * (bitsPerSample / 8);
        const dataSize = pcmData.length;
        const fileSize = 36 + dataSize; // 44 byte header - 8 bytes for RIFF/Size fields

        const header = Buffer.alloc(44);
        let offset = 0;

        // RIFF chunk descriptor
        header.write('RIFF', offset); offset += 4;
        header.writeUInt32LE(fileSize, offset); offset += 4;
        header.write('WAVE', offset); offset += 4;

        // fmt sub-chunk
        header.write('fmt ', offset); offset += 4;
        header.writeUInt32LE(16, offset); offset += 4; // Subchunk1Size (16 for PCM)
        header.writeUInt16LE(1, offset); offset += 2; // AudioFormat (1 for PCM)
        header.writeUInt16LE(numChannels, offset); offset += 2;
        header.writeUInt32LE(sampleRate, offset); offset += 4;
        header.writeUInt32LE(byteRate, offset); offset += 4;
        header.writeUInt16LE(blockAlign, offset); offset += 2;
        header.writeUInt16LE(bitsPerSample, offset); offset += 2;

        // data sub-chunk
        header.write('data', offset); offset += 4;
        header.writeUInt32LE(dataSize, offset); offset += 4;

        // Combine header with PCM data
        return Buffer.concat([header, pcmData]);
    }

    /**
     * Estimate confidence score from transcription text
     * whisper.cpp doesn't provide per-word confidence, so we estimate
     * @param {string} text - Transcribed text
     * @returns {number} - Estimated confidence (0-1)
     */
    estimateConfidence(text) {
        if (!text || text.trim().length === 0) {
            return 0;
        }
        
        // Base confidence on text length and content
        // Longer transcriptions with punctuation = higher confidence
        const trimmed = text.trim();
        if (trimmed.length < 3) return 0.6;
        if (trimmed.length < 10) return 0.75;
        
        // Check for repeated words (common hallucination pattern)
        const words = trimmed.toLowerCase().split(/\s+/);
        const uniqueWords = new Set(words);
        const repetitionRatio = uniqueWords.size / words.length;
        
        if (repetitionRatio < 0.3) return 0.4; // Too repetitive
        
        return 0.85; // Default good confidence
    }

    /**
     * Extract word-level data from transcription
     * whisper.cpp with --no-timestamps doesn't give per-word timing,
     * so we return a single word entry
     * @param {string} text - Transcription text
     * @returns {Array} - Array of word objects
     */
    extractWords(text) {
        if (!text) return [];
        
        // Simple word splitting (whisper.cpp doesn't provide timestamps without special flags)
        const words = text.trim().split(/\s+/).filter(w => w.length > 0);
        
        return words.map((word, index) => ({
            text: word,
            start: index * 0.3, // Rough estimate: ~300ms per word
            end: (index + 1) * 0.3,
            confidence: 0.85
        }));
    }

    /**
     * Validate that whisper.cpp is properly set up
     * @returns {Promise<boolean>}
     */
    async validateApiKey() {
        // whisper.cpp doesn't use API keys, just check binary exists
        return fs.existsSync(this.whisperPath) && fs.existsSync(this.modelPath);
    }

    /**
     * Check if whisper.cpp is available and working
     * @returns {Promise<{available: boolean, error?: string}>}
     */
    async checkAvailability() {
        if (!fs.existsSync(this.whisperPath)) {
            return { 
                available: false, 
                error: `whisper-cli not found at ${this.whisperPath}. Build with: cd /opt/whisper.cpp && cmake -B build && cmake --build build` 
            };
        }
        
        if (!fs.existsSync(this.modelPath)) {
            return { 
                available: false, 
                error: `Model not found at ${this.modelPath}. Download with: cd /opt/whisper.cpp && bash models/download-ggml-model.sh base.en` 
            };
        }

        // Test whisper-cli by running --help
        try {
            const result = await this.runWhisperCli(['--help'], 5000);
            return { available: true };
        } catch (error) {
            return { available: false, error: error.message };
        }
    }

    /**
     * Get supported languages
     * @returns {Array<{code: string, name: string}>}
     */
    getSupportedLanguages() {
        // whisper.cpp supports 99 languages
        return [
            { code: 'en', name: 'English' },
            { code: 'es', name: 'Spanish' },
            { code: 'fr', name: 'French' },
            { code: 'de', name: 'German' },
            { code: 'it', name: 'Italian' },
            { code: 'pt', name: 'Portuguese' },
            { code: 'nl', name: 'Dutch' },
            { code: 'ja', name: 'Japanese' },
            { code: 'zh', name: 'Chinese' },
            { code: 'ko', name: 'Korean' },
            { code: 'ru', name: 'Russian' },
            { code: 'ar', name: 'Arabic' },
            { code: 'hi', name: 'Hindi' },
            { code: 'pl', name: 'Polish' },
            { code: 'tr', name: 'Turkish' },
            { code: 'vi', name: 'Vietnamese' },
        ];
    }

    /**
     * Get info about the current setup
     * @returns {Object}
     */
    getInfo() {
        return {
            binary: this.whisperPath,
            binaryExists: fs.existsSync(this.whisperPath),
            model: this.modelPath,
            modelExists: fs.existsSync(this.modelPath),
            threads: this.threads,
            language: this.language
        };
    }
}

module.exports = { WhisperCppSTTProvider };
