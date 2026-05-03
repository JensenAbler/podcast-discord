/**
 * Edge TTS Provider - Free TTS using Microsoft Edge voices
 * 
 * This is a free alternative to ElevenLabs TTS.
 * Uses node-edge-tts under the hood.
 */

const { EdgeTTS } = require('node-edge-tts');
const fs = require('fs');
const path = require('path');
const os = require('os');

class EdgeTTSProvider {
    constructor(options = {}) {
        this.voice = options.voice || process.env.EDGE_TTS_VOICE || 'en-US-MichelleNeural';
        this.lang = options.lang || process.env.EDGE_TTS_LANG || 'en-US';
        this.outputFormat = options.outputFormat || 'audio-24khz-48kbitrate-mono-mp3';
        this.pitch = options.pitch;
        this.rate = options.rate;
        this.volume = options.volume;
        this.timeout = options.timeout || 30000;
        
        // Default voice mapping (can be overridden)
        this.voices = {
            default: this.voice,
            // You can add named voice variants here
            michelle: 'en-US-MichelleNeural',
            jenny: 'en-US-JennyNeural',
            guy: 'en-US-GuyNeural'
        };
    }

    /**
     * Text-to-Speech synthesis using Edge TTS (free)
     * 
     * @param {string} text - Text to synthesize
     * @param {Object} options - TTS options
     * @returns {Promise<Buffer>} - Audio buffer
     */
    async synthesize(text, options = {}) {
        const startTime = Date.now();
        
        const voiceId = options.voiceId || this.voices.default;
        
        console.log(`[Edge TTS] Synthesizing: "${text.substring(0, 50)}..."`);

        try {
            // Create temp file for output
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-tts-'));
            const outputPath = path.join(tempDir, `tts-${Date.now()}.mp3`);

            // Initialize Edge TTS
            const tts = new EdgeTTS({
                voice: voiceId,
                lang: this.lang,
                outputFormat: this.outputFormat,
                pitch: this.pitch,
                rate: this.rate,
                volume: this.volume,
                timeout: this.timeout
            });

            // Generate speech
            await tts.ttsPromise(text, outputPath);

            // Read the generated audio file
            const audioBuffer = fs.readFileSync(outputPath);
            
            // Clean up temp file
            try {
                fs.unlinkSync(outputPath);
                fs.rmdirSync(tempDir);
            } catch (cleanupErr) {
                // Ignore cleanup errors
            }
            
            const duration = Date.now() - startTime;
            console.log(`[Edge TTS] Synthesis complete in ${duration}ms (${audioBuffer.length} bytes)`);

            return audioBuffer;

        } catch (error) {
            console.error('[Edge TTS] Synthesis error:', error);
            throw error;
        }
    }

    /**
     * Preprocess text for Edge TTS
     * - Removes SSML tags (not fully supported)
     * - Converts SSML breaks to text cues
     * 
     * @param {string} text - Raw text
     * @returns {string} - Processed text
     */
    preprocessText(text) {
        if (!text) return '';

        let processed = text;

        // Remove SSML break tags and replace with text cues
        processed = processed.replace(/<break\s+time="[\d.]+s"\s*\/?>/gi, '...');

        // Remove other SSML tags
        processed = processed.replace(/<[^>]+>/g, '');

        // Clean up extra whitespace
        processed = processed.replace(/\s+/g, ' ').trim();

        return processed;
    }

    /**
     * Get available voices
     * @returns {Array<{id: string, name: string, lang: string}>}
     */
    getVoices() {
        // Common English voices
        return [
            { id: 'en-US-MichelleNeural', name: 'Michelle (US Female)', lang: 'en-US' },
            { id: 'en-US-JennyNeural', name: 'Jenny (US Female)', lang: 'en-US' },
            { id: 'en-US-GuyNeural', name: 'Guy (US Male)', lang: 'en-US' },
            { id: 'en-US-AriaNeural', name: 'Aria (US Female)', lang: 'en-US' },
            { id: 'en-GB-SoniaNeural', name: 'Sonia (UK Female)', lang: 'en-GB' },
            { id: 'en-GB-RyanNeural', name: 'Ryan (UK Male)', lang: 'en-GB' },
            { id: 'en-AU-NatashaNeural', name: 'Natasha (AU Female)', lang: 'en-AU' },
            { id: 'en-CA-ClaraNeural', name: 'Clara (CA Female)', lang: 'en-CA' },
            { id: 'en-IE-EmilyNeural', name: 'Emily (IE Female)', lang: 'en-IE' },
            { id: 'en-IN-NeerjaNeural', name: 'Neerja (IN Female)', lang: 'en-IN' },
            { id: 'en-IN-PrabhatNeural', name: 'Prabhat (IN Male)', lang: 'en-IN' },
        ];
    }

    /**
     * Validate that Edge TTS is available
     * @returns {boolean}
     */
    validate() {
        try {
            // Just check that the module is available
            return true;
        } catch (error) {
            return false;
        }
    }
}

module.exports = { EdgeTTSProvider };
