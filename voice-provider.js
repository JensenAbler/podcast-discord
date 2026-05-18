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

function envFlagEnabled(value, defaultValue = true) {
    if (value === undefined || value === null || value === '') {
        return defaultValue;
    }

    return !['false', '0', 'no', 'off'].includes(String(value).toLowerCase());
}

function isFishCreditError(error) {
    const status = Number(error?.status || error?.statusCode || error?.response?.status);
    const message = String(error?.message || '');
    const body = String(error?.bodyText || error?.body || '');

    return status === 402 ||
        /Fish Audio .*API error:\s*402/i.test(message) ||
        /Insufficient Balance/i.test(message) ||
        /Insufficient Balance/i.test(body);
}

class VoiceProvider {
    constructor(options = {}) {
        this.mode = options.mode || process.env.VOICE_MODE || 'fish';
        this.fishCreditDepleted = false;
        this.fishCreditWarningLogged = false;
        this.fishCreditFallbackEnabled = envFlagEnabled(
            options.fishCreditFallback ?? process.env.VOICE_FISH_CREDIT_FALLBACK,
            true
        );
        
        // Initialize the appropriate providers
        this.initializeProviders(options);
        this.initializeFishCreditFallbacks(options);
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

    initializeFishCreditFallbacks(options = {}) {
        this.fallbackTts = null;
        this.fallbackStt = null;
        this.fallbackSttProviderName = null;

        if (!this.fishCreditFallbackEnabled || !this.usesFishTts()) {
            return;
        }

        this.fallbackTts = new EdgeTTSProvider({
            voice: options.edgeVoice || process.env.EDGE_TTS_VOICE || 'en-US-MichelleNeural',
            lang: options.edgeLang || process.env.EDGE_TTS_LANG || 'en-US',
            pitch: options.edgePitch || process.env.EDGE_TTS_PITCH,
            rate: options.edgeRate || process.env.EDGE_TTS_RATE,
            volume: options.edgeVolume || process.env.EDGE_TTS_VOLUME
        });

        if (this.mode !== 'fish') {
            return;
        }

        const fallbackMode = String(
            options.fishAsrFallback ||
            process.env.VOICE_FISH_ASR_FALLBACK ||
            'auto'
        ).toLowerCase();

        if (fallbackMode === 'none' || fallbackMode === 'off' || fallbackMode === 'false') {
            return;
        }

        if (fallbackMode === 'local' || fallbackMode === 'whisper.cpp') {
            this.fallbackStt = new WhisperCppSTTProvider({
                whisperPath: options.whisperCppPath || process.env.WHISPER_CPP_PATH,
                modelPath: options.whisperCppModel || process.env.WHISPER_CPP_MODEL,
                threads: options.whisperCppThreads || process.env.WHISPER_CPP_THREADS,
                language: options.whisperCppLanguage || process.env.WHISPER_CPP_LANGUAGE || 'en'
            });
            this.fallbackSttProviderName = 'whisper.cpp';
            return;
        }

        if (fallbackMode === 'openai' || fallbackMode === 'openai-whisper' || fallbackMode === 'whisper') {
            this.fallbackStt = new WhisperSTTProvider({
                apiKey: options.openaiKey || process.env.OPENAI_API_KEY,
                model: options.whisperModel || process.env.WHISPER_MODEL || 'whisper-1',
                language: options.whisperLanguage || process.env.WHISPER_LANGUAGE || 'en'
            });
            this.fallbackSttProviderName = 'openai-whisper';
            return;
        }

        if (fallbackMode === 'auto' && (options.openaiKey || process.env.OPENAI_API_KEY)) {
            this.fallbackStt = new WhisperSTTProvider({
                apiKey: options.openaiKey || process.env.OPENAI_API_KEY,
                model: options.whisperModel || process.env.WHISPER_MODEL || 'whisper-1',
                language: options.whisperLanguage || process.env.WHISPER_LANGUAGE || 'en'
            });
            this.fallbackSttProviderName = 'openai-whisper';
        }
    }

    usesFishTts() {
        return this.mode === 'fish' || this.mode === 'fish-whisper';
    }

    noteFishCreditDepleted(error, operation) {
        this.fishCreditDepleted = true;

        if (!this.fishCreditWarningLogged) {
            console.warn(`[VoiceProvider] Fish Audio ${operation} returned insufficient balance; using configured fallback where possible.`);
            this.fishCreditWarningLogged = true;
        }

        if (error && typeof error === 'object') {
            error.fishCreditDepleted = true;
        }
    }

    shouldUseFallbackTts() {
        return Boolean(this.fallbackTts && this.fishCreditDepleted);
    }

    fallbackTtsOptions(options = {}) {
        const {
            voiceId,
            referenceId,
            model,
            latency,
            format,
            chunkLength,
            normalize,
            mp3Bitrate,
            speed,
            normalizeLoudness,
            ...fallbackOptions
        } = options;
        return fallbackOptions;
    }

    async collectText(textChunks) {
        if (typeof textChunks === 'string') {
            return textChunks;
        }

        if (textChunks && typeof textChunks[Symbol.asyncIterator] === 'function') {
            let text = '';
            for await (const chunk of textChunks) {
                text += chunk;
            }
            return text;
        }

        if (textChunks && typeof textChunks[Symbol.iterator] === 'function') {
            return Array.from(textChunks).join('');
        }

        return String(textChunks || '');
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
        this.fishCreditDepleted = false;
        this.fishCreditWarningLogged = false;
        this.initializeProviders({ ...options, mode });
        this.initializeFishCreditFallbacks({ ...options, mode });
        
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
        if (this.shouldUseFallbackTts()) {
            console.warn('[VoiceProvider] Using Edge TTS fallback because Fish Audio credit is depleted.');
            return this.fallbackTts.synthesize(text, this.fallbackTtsOptions(options));
        }

        try {
            return await this.tts.synthesize(text, options);
        } catch (error) {
            if (this.usesFishTts() && this.fishCreditFallbackEnabled && isFishCreditError(error) && this.fallbackTts) {
                this.noteFishCreditDepleted(error, 'TTS');
                return this.fallbackTts.synthesize(text, this.fallbackTtsOptions(options));
            }
            throw error;
        }
    }

    /**
     * Streaming Text-to-Speech synthesis where supported by the TTS provider.
     *
     * @param {AsyncIterable<string>|Iterable<string>|string} textChunks - Text chunks to synthesize
     * @param {Object} options - TTS options
     * @returns {Readable} - Audio stream
     */
    synthesizeStream(textChunks, options = {}) {
        if (this.shouldUseFallbackTts()) {
            console.warn('[VoiceProvider] Streaming disabled; using Edge TTS fallback because Fish Audio credit is depleted.');
            return this.collectText(textChunks)
                .then(text => this.fallbackTts.synthesize(text, this.fallbackTtsOptions(options)));
        }

        if (typeof this.tts.synthesizeStream !== 'function') {
            throw new Error(`Streaming TTS is not available in voice mode: ${this.mode}`);
        }

        return this.tts.synthesizeStream(textChunks, options);
    }

    /**
     * Check whether streaming TTS should be used for the current mode.
     * @returns {boolean}
     */
    isStreamingEnabled(options = {}) {
        if (this.shouldUseFallbackTts()) {
            return false;
        }

        return Boolean(
            typeof this.tts.isStreamingEnabled === 'function' &&
            this.tts.isStreamingEnabled(options)
        );
    }

    /**
     * Speech-to-Text transcription
     * 
     * @param {Buffer} audioBuffer - Audio file buffer
     * @param {Object} options - Transcription options
     * @returns {Promise<Object>} - Transcription result
     */
    async transcribe(audioBuffer, options = {}) {
        try {
            return await this.stt.transcribe(audioBuffer, options);
        } catch (error) {
            if (this.mode === 'fish' && this.fishCreditFallbackEnabled && isFishCreditError(error)) {
                this.noteFishCreditDepleted(error, 'ASR');
                if (this.fallbackStt) {
                    try {
                        console.warn(`[VoiceProvider] Retrying ASR with ${this.fallbackSttProviderName} fallback.`);
                        return await this.fallbackStt.transcribe(audioBuffer, options);
                    } catch (fallbackError) {
                        fallbackError.primaryError = error;
                        fallbackError.fishCreditDepleted = true;
                        fallbackError.fallbackProvider = this.fallbackSttProviderName;
                        throw fallbackError;
                    }
                }
            }

            throw error;
        }
    }

    isFishCreditError(error) {
        return isFishCreditError(error);
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
                provider: this.shouldUseFallbackTts() ? 'edge-fallback' : getTtsProvider(),
                voiceId: this.voiceId
            },
            stt: {
                provider: this.fishCreditDepleted && this.fallbackSttProviderName
                    ? `${getSttProvider()} -> ${this.fallbackSttProviderName}`
                    : getSttProvider()
            },
            fishCreditFallback: {
                enabled: this.fishCreditFallbackEnabled,
                depleted: this.fishCreditDepleted,
                ttsProvider: this.fallbackTts ? 'edge' : null,
                sttProvider: this.fallbackSttProviderName
            }
        };
    }
}

module.exports = { VoiceProvider, isFishCreditError };
