/**
 * Voice Provider Factory - Unified interface for TTS and STT providers
 * 
 * Supports modes:
 * - 'fish': Fish Audio TTS + Fish Audio ASR (default)
 * - 'fish-whisper': Fish Audio TTS + OpenAI Whisper STT
 * - 'elevenlabs': Premium TTS + STT (requires API key)
 * - 'free': Edge TTS + OpenAI Whisper STT (cheaper/free tier)
 * - 'hybrid': ElevenLabs TTS + OpenAI Whisper STT
 * - 'local': Edge TTS + whisper.cpp STT (completely free, local CPU)
 */

const { FishAudioProvider } = require('./fish-audio-provider');
const { ElevenLabsIntegration } = require('./elevenlabs-integration');
const { EdgeTTSProvider } = require('./edge-tts-provider');
const { WhisperSTTProvider } = require('./whisper-stt-provider');
const { WhisperCppSTTProvider } = require('./whisper-cpp-stt-provider');

class VoiceProvider {
    constructor(options = {}) {
        this.mode = options.mode || process.env.VOICE_MODE || 'fish';
        
        // Initialize the appropriate providers
        this.initializeProviders(options);
    }

    /**
     * Initialize TTS and STT providers based on mode
     */
    initializeProviders(options) {
        switch (this.mode) {
            case 'fish':
                // Default: Fish Audio for both TTS and ASR.
                this.tts = new FishAudioProvider({
                    apiKey: options.fishApiKey || process.env.FISH_AUDIO_API_KEY || process.env.FISH_API_KEY,
                    defaultVoice: options.fishVoiceId || process.env.FISH_AUDIO_VOICE_ID || process.env.FISH_AUDIO_MODEL_ID,
                    model: options.fishModel || process.env.FISH_AUDIO_MODEL,
                    latency: options.fishLatency || process.env.FISH_AUDIO_LATENCY
                });
                this.stt = this.tts;
                this.voiceId = this.tts.voiceId;
                console.log('[VoiceProvider] Mode: fish (Fish Audio TTS + ASR)');
                break;

            case 'fish-whisper':
                // Fish TTS with OpenAI Whisper STT.
                this.tts = new FishAudioProvider({
                    apiKey: options.fishApiKey || process.env.FISH_AUDIO_API_KEY || process.env.FISH_API_KEY,
                    defaultVoice: options.fishVoiceId || process.env.FISH_AUDIO_VOICE_ID || process.env.FISH_AUDIO_MODEL_ID,
                    model: options.fishModel || process.env.FISH_AUDIO_MODEL,
                    latency: options.fishLatency || process.env.FISH_AUDIO_LATENCY
                });
                this.stt = new WhisperSTTProvider({
                    apiKey: options.openaiKey || process.env.OPENAI_API_KEY,
                    model: options.whisperModel || process.env.WHISPER_MODEL || 'whisper-1',
                    language: options.whisperLanguage || process.env.WHISPER_LANGUAGE || 'en'
                });
                this.voiceId = this.tts.voiceId;
                console.log('[VoiceProvider] Mode: fish-whisper (Fish Audio TTS + OpenAI Whisper STT)');
                break;

            case 'elevenlabs':
                // Premium: ElevenLabs for both TTS and STT
                this.tts = new ElevenLabsIntegration({
                    apiKey: options.apiKey || process.env.ELEVENLABS_API_KEY,
                    defaultVoice: options.defaultVoice || process.env.ELEVENLABS_VOICE_ID || 'DusxpIechtn2D8hID1Jy'
                });
                this.stt = this.tts; // ElevenLabs handles both
                this.voiceId = options.defaultVoice || process.env.ELEVENLABS_VOICE_ID || 'DusxpIechtn2D8hID1Jy';
                console.log('[VoiceProvider] Mode: elevenlabs (premium TTS + STT)');
                break;
                
            case 'free':
                // Free/Cheap: Edge TTS + Whisper STT
                this.tts = new EdgeTTSProvider({
                    voice: options.edgeVoice || process.env.EDGE_TTS_VOICE || 'en-US-MichelleNeural',
                    lang: options.edgeLang || process.env.EDGE_TTS_LANG || 'en-US',
                    pitch: options.edgePitch || process.env.EDGE_TTS_PITCH,
                    rate: options.edgeRate || process.env.EDGE_TTS_RATE,
                    volume: options.edgeVolume || process.env.EDGE_TTS_VOLUME
                });
                this.stt = new WhisperSTTProvider({
                    apiKey: options.openaiKey || process.env.OPENAI_API_KEY,
                    model: options.whisperModel || process.env.WHISPER_MODEL || 'whisper-1',
                    language: options.whisperLanguage || process.env.WHISPER_LANGUAGE || 'en'
                });
                this.voiceId = options.edgeVoice || process.env.EDGE_TTS_VOICE || 'en-US-MichelleNeural';
                console.log('[VoiceProvider] Mode: free (Edge TTS + Whisper STT)');
                break;
                
            case 'hybrid':
                // Hybrid: ElevenLabs TTS + OpenAI Whisper STT (best quality/cost balance)
                this.tts = new ElevenLabsIntegration({
                    apiKey: options.apiKey || process.env.ELEVENLABS_API_KEY,
                    defaultVoice: options.defaultVoice || process.env.ELEVENLABS_VOICE_ID || 'DusxpIechtn2D8hID1Jy'
                });
                this.stt = new WhisperSTTProvider({
                    apiKey: options.openaiKey || process.env.OPENAI_API_KEY,
                    model: options.whisperModel || process.env.WHISPER_MODEL || 'whisper-1',
                    language: options.whisperLanguage || process.env.WHISPER_LANGUAGE || 'en'
                });
                this.voiceId = options.defaultVoice || process.env.ELEVENLABS_VOICE_ID || 'DusxpIechtn2D8hID1Jy';
                console.log('[VoiceProvider] Mode: hybrid (ElevenLabs TTS + OpenAI Whisper STT)');
                break;

            case 'local':
                // Local: Edge TTS + whisper.cpp STT (completely free, runs on CPU)
                this.tts = new EdgeTTSProvider({
                    voice: options.edgeVoice || process.env.EDGE_TTS_VOICE || 'en-US-MichelleNeural',
                    lang: options.edgeLang || process.env.EDGE_TTS_LANG || 'en-US',
                    pitch: options.edgePitch || process.env.EDGE_TTS_PITCH,
                    rate: options.edgeRate || process.env.EDGE_TTS_RATE,
                    volume: options.edgeVolume || process.env.EDGE_TTS_VOLUME
                });
                this.stt = new WhisperCppSTTProvider({
                    whisperPath: options.whisperCppPath || process.env.WHISPER_CPP_PATH,
                    modelPath: options.whisperCppModel || process.env.WHISPER_CPP_MODEL,
                    threads: options.whisperCppThreads || process.env.WHISPER_CPP_THREADS,
                    language: options.whisperCppLanguage || process.env.WHISPER_CPP_LANGUAGE || 'en'
                });
                this.voiceId = options.edgeVoice || process.env.EDGE_TTS_VOICE || 'en-US-MichelleNeural';
                console.log('[VoiceProvider] Mode: local (Edge TTS + whisper.cpp STT)');
                break;
                
            default:
                throw new Error(`Unknown voice mode: ${this.mode}. Use 'fish', 'fish-whisper', 'elevenlabs', 'free', 'hybrid', or 'local'.`);
        }
    }

    /**
     * Get the current mode
     * @returns {string}
     */
    getMode() {
        return this.mode;
    }

    /**
     * Switch to a different voice mode at runtime
     * @param {string} mode - 'fish', 'fish-whisper', 'elevenlabs', 'free', 'hybrid', or 'local'
     * @param {Object} options - Provider-specific options
     */
    switchMode(mode, options = {}) {
        if (!['fish', 'fish-whisper', 'elevenlabs', 'free', 'hybrid', 'local'].includes(mode)) {
            throw new Error(`Unknown voice mode: ${mode}`);
        }
        
        const oldMode = this.mode;
        this.mode = mode;
        this.initializeProviders({ ...options, mode });
        
        console.log(`[VoiceProvider] Switched from ${oldMode} to ${mode}`);
    }

    /**
     * Text-to-Speech synthesis
     * 
     * @param {string} text - Text to synthesize
     * @param {Object} options - TTS options
     * @returns {Promise<Buffer>} - Audio buffer
     */
    async synthesize(text, options = {}) {
        return this.tts.synthesize(text, options);
    }

    /**
     * Speech-to-Text transcription
     * 
     * @param {Buffer} audioBuffer - Audio file buffer
     * @param {Object} options - Transcription options
     * @returns {Promise<Object>} - Transcription result
     */
    async transcribe(audioBuffer, options = {}) {
        return this.stt.transcribe(audioBuffer, options);
    }

    /**
     * Get available TTS voices
     * @returns {Array}
     */
    getVoices() {
        if (this.tts.getVoices) {
            return this.tts.getVoices();
        }
        return [];
    }

    /**
     * Validate the current configuration
     * @returns {Promise<{valid: boolean, tts: boolean, stt: boolean, errors: string[]}>}
     */
    async validate() {
        const errors = [];
        let ttsValid = false;
        let sttValid = false;

        // Validate TTS
        try {
            if (this.mode === 'fish' || this.mode === 'fish-whisper' || this.mode === 'elevenlabs' || this.mode === 'hybrid') {
                ttsValid = await this.tts.validateApiKey();
            } else {
                // Edge TTS doesn't require validation
                ttsValid = true;
            }
        } catch (error) {
            errors.push(`TTS validation failed: ${error.message}`);
        }

        // Validate STT
        try {
            if (this.mode === 'fish' || this.mode === 'elevenlabs') {
                sttValid = await this.stt.validateApiKey();
            } else if (this.mode === 'local') {
                // whisper.cpp STT - check if binary and model exist
                const availability = await this.stt.checkAvailability();
                sttValid = availability.available;
                if (!sttValid) {
                    errors.push(`whisper.cpp STT not available: ${availability.error}`);
                }
            } else {
                // OpenAI Whisper STT
                sttValid = await this.stt.validateApiKey();
            }
        } catch (error) {
            errors.push(`STT validation failed: ${error.message}`);
        }

        return {
            valid: ttsValid && sttValid,
            tts: ttsValid,
            stt: sttValid,
            errors
        };
    }

    /**
     * Get configuration info
     * @returns {Object}
     */
    getInfo() {
        const getSttProvider = () => {
            if (this.mode === 'fish') return 'fish-audio-asr';
            if (this.mode === 'fish-whisper') return 'openai-whisper';
            if (this.mode === 'elevenlabs') return 'elevenlabs';
            if (this.mode === 'local') return 'whisper.cpp';
            return 'openai-whisper';
        };

        const getTtsProvider = () => {
            if (this.mode === 'fish' || this.mode === 'fish-whisper') return 'fish-audio';
            if (this.mode === 'elevenlabs' || this.mode === 'hybrid') return 'elevenlabs';
            return 'edge';
        };

        return {
            mode: this.mode,
            tts: {
                provider: getTtsProvider(),
                voiceId: this.voiceId
            },
            stt: {
                provider: getSttProvider()
            }
        };
    }
}

module.exports = { VoiceProvider };
