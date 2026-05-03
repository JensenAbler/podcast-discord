/**
 * TTS Provider Factory - Unified interface for TTS providers
 * 
 * Supports:
 * - fish: Fish Audio, requires API key
 * - elevenlabs: Premium quality, requires API key
 * - edge: Free, uses Microsoft Edge voices
 */

const { FishAudioProvider } = require('./fish-audio-provider');
const { ElevenLabsIntegration } = require('./elevenlabs-integration');
const { EdgeTTSProvider } = require('./edge-tts-provider');

class TTSProvider {
    constructor(options = {}) {
        this.provider = options.provider || process.env.TTS_PROVIDER || 'fish';
        
        // Initialize the appropriate provider
        this.initializeProvider(options);
    }

    /**
     * Initialize the selected TTS provider
     */
    initializeProvider(options) {
        switch (this.provider) {
            case 'fish':
                this.engine = new FishAudioProvider({
                    apiKey: options.apiKey || process.env.FISH_AUDIO_API_KEY || process.env.FISH_API_KEY,
                    defaultVoice: options.defaultVoice || process.env.FISH_AUDIO_VOICE_ID || process.env.FISH_AUDIO_MODEL_ID,
                    model: options.model || process.env.FISH_AUDIO_MODEL,
                    latency: options.latency || process.env.FISH_AUDIO_LATENCY
                });
                this.voiceId = this.engine.voiceId;
                console.log('[TTSProvider] Using Fish Audio TTS');
                break;

            case 'elevenlabs':
                this.engine = new ElevenLabsIntegration({
                    apiKey: options.apiKey || process.env.ELEVENLABS_API_KEY,
                    defaultVoice: options.defaultVoice || process.env.ELEVENLABS_VOICE_ID || 'DusxpIechtn2D8hID1Jy'
                });
                this.voiceId = options.defaultVoice || process.env.ELEVENLABS_VOICE_ID || 'DusxpIechtn2D8hID1Jy';
                console.log('[TTSProvider] Using ElevenLabs TTS');
                break;
                
            case 'edge':
                this.engine = new EdgeTTSProvider({
                    voice: options.edgeVoice || process.env.EDGE_TTS_VOICE || 'en-US-MichelleNeural',
                    lang: options.edgeLang || process.env.EDGE_TTS_LANG || 'en-US',
                    pitch: options.edgePitch || process.env.EDGE_TTS_PITCH,
                    rate: options.edgeRate || process.env.EDGE_TTS_RATE,
                    volume: options.edgeVolume || process.env.EDGE_TTS_VOLUME
                });
                this.voiceId = options.edgeVoice || process.env.EDGE_TTS_VOICE || 'en-US-MichelleNeural';
                console.log('[TTSProvider] Using Edge TTS (free)');
                break;
                
            default:
                throw new Error(`Unknown TTS provider: ${this.provider}. Use 'fish', 'elevenlabs', or 'edge'.`);
        }
    }

    /**
     * Get the current provider name
     * @returns {string}
     */
    getProvider() {
        return this.provider;
    }

    /**
     * Switch to a different TTS provider at runtime
     * @param {string} provider - 'fish', 'elevenlabs', or 'edge'
     * @param {Object} options - Provider-specific options
     */
    switchProvider(provider, options = {}) {
        if (!['fish', 'elevenlabs', 'edge'].includes(provider)) {
            throw new Error(`Unknown TTS provider: ${provider}`);
        }
        
        const oldProvider = this.provider;
        this.provider = provider;
        this.initializeProvider(options);
        
        console.log(`[TTSProvider] Switched from ${oldProvider} to ${provider}`);
    }

    /**
     * Text-to-Speech synthesis
     * 
     * @param {string} text - Text to synthesize
     * @param {Object} options - TTS options (provider-specific)
     * @returns {Promise<Buffer>} - Audio buffer
     */
    async synthesize(text, options = {}) {
        // Handle provider override in options
        if (options.provider && options.provider !== this.provider) {
            // Create a temporary instance for this call
            const tempProvider = new TTSProvider({ 
                provider: options.provider,
                ...options
            });
            return tempProvider.synthesize(text, options);
        }

        // Use current provider
        return this.engine.synthesize(text, options);
    }

    /**
     * Speech-to-Text transcription (available with Fish Audio or ElevenLabs)
     * 
     * @param {Buffer} audioBuffer - PCM or audio file buffer
     * @param {Object} options - Transcription options
     * @returns {Promise<Object>} - Transcription result
     */
    async transcribe(audioBuffer, options = {}) {
        if (this.provider !== 'fish' && this.provider !== 'elevenlabs') {
            throw new Error('Speech-to-Text is only available with Fish Audio or ElevenLabs providers.');
        }
        
        return this.engine.transcribe(audioBuffer, options);
    }

    /**
     * Check if STT is available
     * @returns {boolean}
     */
    isSTTAvailable() {
        return this.provider === 'fish' || this.provider === 'elevenlabs';
    }

    /**
     * Get available voices for the current provider
     * @returns {Array}
     */
    getVoices() {
        if (this.provider === 'edge') {
            return this.engine.getVoices();
        }
        // ElevenLabs has an async method
        return this.engine.getVoices();
    }

    /**
     * Validate the current provider configuration
     * @returns {Promise<boolean> | boolean}
     */
    validate() {
        if (this.provider === 'fish' || this.provider === 'elevenlabs') {
            return this.engine.validateApiKey();
        }
        // Edge TTS doesn't require validation
        return true;
    }

    /**
     * Preprocess text for the current provider
     * @param {string} text - Raw text
     * @returns {string} - Processed text
     */
    preprocessText(text) {
        if (this.provider === 'edge') {
            return this.engine.preprocessText(text);
        }
        if (this.provider === 'fish') {
            return this.engine.preprocessText(text);
        }
        // ElevenLabs has its own preprocessing in synthesize.
        return text;
    }
}

module.exports = { TTSProvider };
