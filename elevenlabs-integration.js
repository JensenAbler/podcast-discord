/**
 * ElevenLabs Integration - STT and TTS for voice processing
 * 
 * Uses ElevenLabs v3 (alpha) for TTS - latest model with:
 * - Natural emotional expression from text context
 * - 70+ language support
 * - Better conversational flow
 * - No SSML support (use text cues like "..." for pauses)
 * 
 * STT uses scribe_v1 for transcription.
 */

const fs = require('fs');
const path = require('path');

class ElevenLabsIntegration {
    constructor(options = {}) {
        this.apiKey = options.apiKey || process.env.ELEVENLABS_API_KEY;
        this.baseUrl = 'https://api.elevenlabs.io/v1';
        
        // Voice IDs
        this.voices = {
            jensenMedium: options.jensenMediumVoice || 'DusxpIechtn2D8hID1Jy',
            jensenCalm: options.jensenCalmVoice || 'VfhbnjxGzBpkTBV6ObAB',
            jensenHigh: options.jensenHighVoice || 'WFJiIqlsdR0bI3D24kRh',
            default: options.defaultVoice || 'DusxpIechtn2D8hID1Jy'
        };

        this.options = {
            model: options.model || 'eleven_v3', // v3 alpha - latest and most expressive
            sttModel: options.sttModel || 'scribe_v1',
            outputFormat: options.outputFormat || 'mp3_44100_128',
            timeout: options.timeout || 30000,
            ...options
        };

        if (!this.apiKey) {
            throw new Error('ElevenLabs API key not provided. Set ELEVENLABS_API_KEY or pass apiKey option.');
        }
    }

    /**
     * Speech-to-Text transcription
     * @param {Buffer} audioBuffer - PCM or audio file buffer
     * @param {Object} options - Transcription options
     * @returns {Promise<Object>} - Transcription result
     */
    async transcribe(audioBuffer, options = {}) {
        const startTime = Date.now();
        
        console.log(`[ElevenLabs] Transcribing ${audioBuffer.length} bytes...`);

        try {
            // Convert PCM to WAV if needed
            const audioData = await this.prepareAudioForSTT(audioBuffer, options);

            // Create form data using native FormData (Node 18+)
            const form = new FormData();
            
            // Create a Blob from the audio buffer
            const blob = new Blob([audioData], { type: 'audio/wav' });
            form.append('file', blob, options.filename || 'audio.wav');
            form.append('model_id', this.options.sttModel);
            
            if (options.language) {
                form.append('language_code', options.language);
            }
            
            if (options.tagAudioEvents !== false) {
                form.append('tag_audio_events', 'true');
            }
            
            // Enable word-level timestamps for confidence analysis
            form.append('timestamps_granularity', 'word');

            const response = await fetch(`${this.baseUrl}/speech-to-text`, {
                method: 'POST',
                headers: {
                    'xi-api-key': this.apiKey
                },
                body: form
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`STT API error: ${response.status} - ${errorText}`);
            }

            const result = await response.json();
            
            const duration = Date.now() - startTime;
            console.log(`[ElevenLabs] Transcription complete in ${duration}ms`);
            console.log(`[ElevenLabs] Raw result keys:`, Object.keys(result));
            console.log(`[ElevenLabs] Words count:`, result.words?.length || 0);
            if (result.words && result.words.length > 0) {
                console.log(`[ElevenLabs] First word sample:`, JSON.stringify(result.words[0]));
            }

            return {
                text: result.text || '',
                language: result.language_code,
                confidence: result.confidence,
                words: result.words || [],
                duration: duration
            };

        } catch (error) {
            console.error('[ElevenLabs] Transcription error:', error);
            throw error;
        }
    }

    /**
     * Text-to-Speech synthesis using ElevenLabs v3
     * 
     * v3 Features:
     * - Natural emotional expression from text context
     * - No SSML support (use text cues like "..." for pauses)
     * - Better contextual understanding for conversational flow
     * - Supports 70+ languages
     * 
     * @param {string} text - Text to synthesize (AI response text)
     * @param {Object} options - TTS options
     * @returns {Promise<Buffer>} - Audio buffer
     */
    async synthesize(text, options = {}) {
        const startTime = Date.now();
        
        const voiceId = options.voiceId || this.voices.default;
        
        // NOTE: The persona prompt guides the AI's response generation (via Gateway)
        // It should NOT be sent to TTS - ElevenLabs will speak whatever text you send!
        // Just send the actual response text for synthesis.
        const processedText = this.preprocessForV3(text);
        
        console.log(`[ElevenLabs v3] Synthesizing as Alpha-Clawd: "${text.substring(0, 50)}..."`);

        try {
            const requestBody = {
                text: processedText,
                model_id: this.options.model,
            };

            // v3 uses different voice settings structure
            // Only include voice_settings if explicitly provided or for non-v3 models
            if (options.voiceSettings && this.options.model !== 'eleven_v3') {
                requestBody.voice_settings = options.voiceSettings;
            }

            const response = await fetch(
                `${this.baseUrl}/text-to-speech/${voiceId}?output_format=${this.options.outputFormat}`,
                {
                    method: 'POST',
                    headers: {
                        'xi-api-key': this.apiKey,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(requestBody)
                }
            );

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`TTS API error: ${response.status} - ${errorText}`);
            }

            const audioBuffer = Buffer.from(await response.arrayBuffer());
            
            const duration = Date.now() - startTime;
            console.log(`[ElevenLabs v3] Synthesis complete in ${duration}ms (${audioBuffer.length} bytes)`);

            return audioBuffer;

        } catch (error) {
            console.error('[ElevenLabs v3] Synthesis error:', error);
            throw error;
        }
    }

    /**
     * Preprocess text for ElevenLabs v3 compatibility
     * - Removes SSML tags (not supported in v3)
     * - Converts SSML breaks to text cues
     * - Enhances emotional markers for better expression
     * 
     * @param {string} text - Raw text
     * @returns {string} - Processed text for v3
     */
    preprocessForV3(text) {
        if (!text) return '';

        let processed = text;

        // Remove SSML break tags and replace with text cues
        // <break time="1s" /> → ...
        processed = processed.replace(/<break\s+time="[\d.]+s"\s*\/?>/gi, '...');

        // Remove other SSML tags
        processed = processed.replace(/<[^>]+>/g, '');

        // Normalize emotional markers for better v3 expression
        // Ensure emotional cues are clear
        processed = processed.replace(/\*([^*]+)\*/g, '$1'); // Remove asterisk markers, v3 reads them literally

        // Clean up extra whitespace
        processed = processed.replace(/\s+/g, ' ').trim();

        return processed;
    }

    /**
     * Prepare audio for STT (convert PCM to WAV if needed)
     * @param {Buffer} audioBuffer - Input audio
     * @param {Object} options - Processing options
     * @returns {Promise<Buffer>} - WAV formatted buffer
     */
    async prepareAudioForSTT(audioBuffer, options = {}) {
        // If already a file buffer (starts with RIFF), return as-is
        if (audioBuffer.slice(0, 4).toString('ascii') === 'RIFF') {
            return audioBuffer;
        }

        // Assume PCM - convert to WAV
        const sampleRate = options.sampleRate || 48000;
        const channels = options.channels || 2;
        const bitsPerSample = 16;

        return this.createWavFromPcm(audioBuffer, sampleRate, channels, bitsPerSample);
    }

    /**
     * Create WAV file from PCM buffer
     * @param {Buffer} pcmData - PCM audio data
     * @param {number} sampleRate - Sample rate (Hz)
     * @param {number} channels - Number of channels
     * @param {number} bitsPerSample - Bits per sample
     * @returns {Buffer} - WAV file buffer
     */
    createWavFromPcm(pcmData, sampleRate, channels, bitsPerSample) {
        const byteRate = sampleRate * channels * bitsPerSample / 8;
        const blockAlign = channels * bitsPerSample / 8;
        const dataSize = pcmData.length;
        const fileSize = 36 + dataSize;

        const header = Buffer.alloc(44);

        // RIFF chunk
        header.write('RIFF', 0);
        header.writeUInt32LE(fileSize, 4);
        header.write('WAVE', 8);

        // fmt chunk
        header.write('fmt ', 12);
        header.writeUInt32LE(16, 16); // Subchunk1Size (16 for PCM)
        header.writeUInt16LE(1, 20); // AudioFormat (1 = PCM)
        header.writeUInt16LE(channels, 22);
        header.writeUInt32LE(sampleRate, 24);
        header.writeUInt32LE(byteRate, 28);
        header.writeUInt16LE(blockAlign, 32);
        header.writeUInt16LE(bitsPerSample, 34);

        // data chunk
        header.write('data', 36);
        header.writeUInt32LE(dataSize, 40);

        return Buffer.concat([header, pcmData]);
    }

    /**
     * Get available voices
     * @returns {Promise<Array>}
     */
    async getVoices() {
        try {
            const response = await fetch(`${this.baseUrl}/voices`, {
                headers: {
                    'xi-api-key': this.apiKey
                }
            });

            if (!response.ok) {
                throw new Error(`Failed to get voices: ${response.status}`);
            }

            const data = await response.json();
            return data.voices || [];

        } catch (error) {
            console.error('[ElevenLabs] Error getting voices:', error);
            return [];
        }
    }

    /**
     * Validate API key
     * @returns {Promise<boolean>}
     */
    async validateApiKey() {
        // For scoped API keys, we can't validate via standard endpoints
        // Just check the key exists and has valid format
        if (!this.apiKey || typeof this.apiKey !== 'string') {
            return false;
        }
        // Key should start with 'sk_' and be reasonably long
        return this.apiKey.startsWith('sk_') && this.apiKey.length > 20;
    }
}

module.exports = { ElevenLabsIntegration };
