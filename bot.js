/**
 * Alpha-Clawd Discord Voice Bot
 * 
 * Main bot implementation with podcast voice channel commands.
 * Now uses external Gateway (Clawdbot) as AI brain instead of built-in interviewer.
 * 
 * Architecture:
 * Discord → Bot → STT → Gateway (Clawdbot) → Response → TTS → Discord
 */

const fs = require('fs');
const path = require('path');
const { PassThrough } = require('stream');

// Setup robust file logging
const LOG_FILE = '/tmp/alpha-clawd-bot.log';

// Store original console methods BEFORE overriding
const originalLog = console.log;
const originalError = console.error;

function log(message, level = 'INFO') {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] [${level}] ${message}\n`;
    try {
        fs.appendFileSync(LOG_FILE, line);
    } catch (err) {
        // Log file write failed, still log to console
        originalError(`[LOG FILE ERROR] ${err.message}`);
    }
    originalLog(line.trim());
}

// Override console methods to use file logging
console.log = (...args) => log(args.join(' '), 'INFO');
console.error = (...args) => log(args.join(' '), 'ERROR');

// Catch ALL errors and log them
process.on('uncaughtException', (err) => {
    try {
        originalError(`[FATAL] UNCAUGHT EXCEPTION: ${err.message}\n${err.stack}`);
    } catch (e) {
        // Last resort - can't even log
    }
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    try {
        log(`UNHANDLED REJECTION: ${reason}\nPromise: ${promise}`, 'FATAL');
    } catch (e) {
        originalError(`[FATAL] UNHANDLED REJECTION: ${reason}`);
    }
});

log('Bot starting...');

// Load .env file manually (no dotenv dependency)
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
        const match = line.match(/^([^=]+)=(.*)$/);
        if (match && !process.env[match[1]]) {
            process.env[match[1]] = match[2];
        }
    });
}

const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { VoiceManager } = require('./voice-manager');
const { VoiceProvider } = require('./voice-provider');
const { GatewayBridge } = require('./gateway-bridge');
const { GatewayWsClient } = require('./gateway-ws-client');
const { ConversationBuffer, CHATTY_MODE, BUFFERED_MODE, BufferState } = require('./conversation-buffer');
const { getRecordingDir } = require('./paths');
const { PodcastGenerator } = require('./podcast-generator');

class AlphaClawdVoiceBot {
    constructor(options = {}) {
        this.token = options.token || process.env.DISCORD_BOT_TOKEN;
        this.clientId = options.clientId || process.env.DISCORD_CLIENT_ID;
        this.guildId = options.guildId || process.env.DISCORD_GUILD_ID;
        
        // Speaker configuration (Discord user ID -> name mapping)
        this.speakerMap = options.speakerMap || {};
        
        // Cached audio buffers for boilerplate vocalizations (saves TTS API credits)
        this.cachedAudio = this.loadCachedAudio();
        
        // Podcast state
        this.activeSessions = new Map(); // guildId -> session info
        this.isProcessing = new Map(); // guildId -> boolean
        this.recordingState = new Map(); // guildId -> 'IDLE' | 'AWAITING_CONSENT' | 'RECORDING' | 'PAUSED'
        this.consentWaiters = new Map(); // guildId -> { userId, timeout }
        this.disabledCronJobs = []; // Track cron jobs disabled during podcast
        this.idleDecisionIntervalMs = Number(process.env.PODCAST_IDLE_DECISION_INTERVAL_MS || 5000);
        this.idleDecisionTimers = new Map(); // guildId -> interval
        this.idleDecisionInFlight = new Set(); // guildId
        this.idleDecisionHandledSpeechAt = new Map(); // guildId -> ms timestamp of participant speech already handled by idle logic
        this.directResponseInFlight = new Set(); // guildId
        this.lastParticipantSpeechAt = new Map(); // guildId -> ms timestamp

        // Recording states
        this.RecordingState = {
            IDLE: 'IDLE',
            AWAITING_CONSENT: 'AWAITING_CONSENT',
            RECORDING: 'RECORDING',
            PAUSED: 'PAUSED'
        };

        // Initialize Discord client
        this.client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildVoiceStates,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent
            ]
        });

        // Load API keys
        this.elevenLabsKey = options.elevenLabsKey || this.loadElevenLabsKey();
        this.fishAudioKey = options.fishAudioKey || process.env.FISH_AUDIO_API_KEY || process.env.FISH_API_KEY;
        this.openaiKey = options.openaiKey || process.env.OPENAI_API_KEY;
        this.generatorMode = this.normalizeGeneratorMode(options.generatorMode || process.env.PODCAST_GENERATOR || 'direct');
        this.gatewayMirror = process.env.PODCAST_GATEWAY_MIRROR === 'true';

        // Initialize Voice Provider (unified TTS + STT)
        this.voiceProvider = new VoiceProvider({
            mode: process.env.VOICE_MODE || 'fish',
            apiKey: this.elevenLabsKey,
            fishApiKey: this.fishAudioKey,
            openaiKey: this.openaiKey,
            defaultVoice: process.env.ELEVENLABS_VOICE_ID || 'DusxpIechtn2D8hID1Jy',
            fishVoiceId: process.env.FISH_AUDIO_VOICE_ID || process.env.FISH_AUDIO_MODEL_ID,
            fishModel: process.env.FISH_AUDIO_MODEL || 's2-pro',
            fishLatency: process.env.FISH_AUDIO_LATENCY || 'balanced',
            edgeVoice: process.env.EDGE_TTS_VOICE || 'en-US-MichelleNeural',
            edgeLang: process.env.EDGE_TTS_LANG || 'en-US',
            whisperModel: process.env.WHISPER_MODEL || 'whisper-1',
            whisperLanguage: process.env.WHISPER_LANGUAGE || 'en'
        });
        this.voiceId = this.voiceProvider.voiceId;

        // Direct structured generator for live podcast responses.
        const podcastGeneratorOptions = {
            model: process.env.PODCAST_GENERATOR_MODEL,
            timeout: process.env.PODCAST_GENERATOR_TIMEOUT_MS,
            maxCompletionTokens: process.env.PODCAST_GENERATOR_MAX_TOKENS,
            maxHistoryTurns: process.env.PODCAST_GENERATOR_HISTORY_TURNS
        };

        if (options.generatorApiKey) {
            podcastGeneratorOptions.apiKey = options.generatorApiKey;
        }

        this.podcastGenerator = new PodcastGenerator(podcastGeneratorOptions);

        // Initialize voice manager with unified voice provider
        this.voiceManager = new VoiceManager(this.client, {
            recordingDir: getRecordingDir(),
            stt: this.voiceProvider,  // Unified STT provider
            elevenLabs: this.voiceProvider.mode === 'elevenlabs' ? this.voiceProvider.tts : null,
            enableTranscription: true
        });

        // Initialize Gateway bridge (HTTP server stub for future use)
        this.gatewayBridge = new GatewayBridge({
            gatewayUrl: process.env.GATEWAY_URL || 'http://localhost:18789',
            responsePort: parseInt(process.env.DISCORD_BOT_RESPONSE_PORT) || 4567,
            authToken: process.env.GATEWAY_AUTH_TOKEN || 'dev-token'
        });

        // Initialize WebSocket client for direct Gateway communication
        this.wsClient = new GatewayWsClient({
            gatewayUrl: process.env.GATEWAY_WS_URL || 'ws://localhost:18789/ws',
            authToken: process.env.GATEWAY_AUTH_TOKEN || 'dev-token',
            sessionKey: process.env.TARGET_SESSION_KEY || 'agent:main:main'
        });

        // Set up WebSocket event handlers
        this.wsClient.on('response', (response) => this.handleWsResponse(response));
        this.wsClient.on('error', (error) => console.error('[Bot] WebSocket error:', error));
        this.wsClient.on('disconnected', () => console.log('[Bot] WebSocket disconnected'));

        // Initialize ConversationBuffer for utterance batching
        this.conversationBuffer = new ConversationBuffer(CHATTY_MODE);
        this.conversationBuffer.onFlush((utterances) => {
            this.handleBufferFlush(utterances);
        });

        // Debug: inject individual utterances for Gateway UI visibility (default ON)
        this.debugInject = true;

        // Set up event handlers
        this.setupEventHandlers();
        
        // Set up voice manager utterance handler
        this.voiceManager.setUtteranceHandler(async (guildId, utterance) => {
            const transcription = (utterance.transcription || '').trim();

            // Debug: inject individual utterance for Gateway UI visibility
            if (this.debugInject && transcription && this.wsClient.isAuthenticated) {
                try {
                    await this.wsClient.injectMessage(
                        `[Podcast Voice] ${utterance.speaker}: ${transcription}`,
                        { label: 'discord-voice' }
                    );
                } catch (err) {
                    console.error('[Bot] Debug inject failed:', err.message);
                }
            }

            // Buffer the utterance (buffer handles timing and flush)
            // Include full word-level data from ElevenLabs STT for confidence analysis
            if (transcription) {
                this.lastParticipantSpeechAt.set(guildId, Date.now());
            }

            this.conversationBuffer.addUtterance({
                userId: utterance.userId,
                speaker: utterance.speaker,
                speakerRole: utterance.speakerRole,
                transcription: transcription,
                rawTranscription: utterance.rawTranscription,
                audioEvents: utterance.audioEvents,
                transcriptionConfidence: utterance.transcriptionConfidence,
                words: utterance.words,
                language: utterance.language,
                duration: utterance.duration,
                speechStartedAt: utterance.speechStartedAt,
                speechEndedAt: utterance.speechEndedAt,
                speechDuration: utterance.speechDuration,
                asrStartedAt: utterance.asrStartedAt,
                asrCompletedAt: utterance.asrCompletedAt,
                timestamp: utterance.timestamp || Date.now()
            });
        });

        // Set up speaking start/stop handlers to prevent buffer flush while user is speaking
        this.voiceManager.setSpeakingStartHandler((guildId, userId) => {
            console.log(`[Bot] User ${userId} started speaking, pausing buffer flush`);
            this.conversationBuffer.setUserSpeaking(userId, true);
        });

        this.voiceManager.setSpeakingStopHandler((guildId, userId) => {
            console.log(`[Bot] User ${userId} stopped speaking`);
            this.conversationBuffer.setUserSpeaking(userId, false);
        });

        this.voiceManager.setEndpointingHandler((guildId, userId, metadata = {}) => {
            if (metadata.active) {
                console.log(`[Bot] Endpoint debounce armed for ${userId} (${metadata.reason}, ${metadata.debounceMs}ms)`);
                this.conversationBuffer.markEndpointing(userId, true);
            } else {
                this.conversationBuffer.markEndpointing(userId, false);
            }
        });

        this.voiceManager.setAsrDispatchedHandler((guildId, userId, metadata = {}) => {
            console.log(`[Bot] ASR dispatched to Fish for ${userId} (${metadata.audioBytes} bytes, ${metadata.reason})`);
            this.conversationBuffer.markAsrPending(userId, metadata);
        });
    }

    normalizeGeneratorMode(mode) {
        const normalized = String(mode || 'direct').toLowerCase();
        if (normalized === 'openclaw') return 'gateway';
        if (normalized === 'clawdbot') return 'gateway';
        if (normalized === 'gateway') return 'gateway';
        return 'direct';
    }

    useGatewayGenerator() {
        return this.generatorMode === 'gateway';
    }

    shouldConnectGatewayWs() {
        return this.useGatewayGenerator() || this.gatewayMirror;
    }

    startIdleDecisionLoop(guildId) {
        if (this.useGatewayGenerator() || this.idleDecisionIntervalMs <= 0) {
            return;
        }

        this.stopIdleDecisionLoop(guildId);
        this.lastParticipantSpeechAt.delete(guildId);
        this.idleDecisionHandledSpeechAt.delete(guildId);

        const timer = setInterval(() => {
            this.handleIdleDecisionTick(guildId).catch((error) => {
                console.error('[Bot] Idle decision tick failed:', error);
            });
        }, this.idleDecisionIntervalMs);

        if (typeof timer.unref === 'function') {
            timer.unref();
        }

        this.idleDecisionTimers.set(guildId, timer);
        console.log(`[Bot] Started idle decision loop (${this.idleDecisionIntervalMs}ms)`);
    }

    stopIdleDecisionLoop(guildId) {
        const timer = this.idleDecisionTimers.get(guildId);
        if (timer) {
            clearInterval(timer);
            this.idleDecisionTimers.delete(guildId);
            console.log('[Bot] Stopped idle decision loop');
        }

        this.idleDecisionInFlight.delete(guildId);
        this.directResponseInFlight.delete(guildId);
        this.lastParticipantSpeechAt.delete(guildId);
        this.idleDecisionHandledSpeechAt.delete(guildId);
    }

    canRunIdleDecision(guildId) {
        if (this.useGatewayGenerator()) return false;
        if (this.recordingState.get(guildId) !== this.RecordingState.RECORDING) return false;
        if (!this.lastParticipantSpeechAt.has(guildId)) return false;
        if (this.directResponseInFlight.has(guildId)) return false;

        const lastSpeechAt = this.lastParticipantSpeechAt.get(guildId);
        const handledSpeechAt = this.idleDecisionHandledSpeechAt.get(guildId) || 0;
        if (Number.isFinite(lastSpeechAt) && handledSpeechAt >= lastSpeechAt) {
            return false;
        }

        const bufferState = this.conversationBuffer.getState();
        if (
            bufferState.state !== BufferState.IDLE ||
            bufferState.utteranceCount > 0 ||
            bufferState.activeSpeakerCount > 0 ||
            bufferState.pendingAsrCount > 0
        ) {
            return false;
        }

        const playback = this.voiceManager.getPlaybackStatus(guildId);
        return !playback.isPlaying && playback.queueLength === 0;
    }

    markIdleDecisionHandled(guildId, speechAt = this.lastParticipantSpeechAt.get(guildId)) {
        if (Number.isFinite(speechAt)) {
            this.idleDecisionHandledSpeechAt.set(guildId, speechAt);
        }
    }

    async handleIdleDecisionTick(guildId) {
        if (!this.canRunIdleDecision(guildId)) {
            return;
        }

        if (this.idleDecisionInFlight.has(guildId)) {
            return;
        }

        this.idleDecisionInFlight.add(guildId);

        try {
            const lastSpeechAt = this.lastParticipantSpeechAt.get(guildId) || Date.now();
            const idleSeconds = (Date.now() - lastSpeechAt) / 1000;
            this.markIdleDecisionHandled(guildId, lastSpeechAt);

            console.log(`[Bot] Idle decision check after ${Math.round(idleSeconds)}s without participant speech`);
            const response = await this.podcastGenerator.generate({
                transcript: '',
                currentMode: this.getBufferModeName(),
                idleCheck: true,
                idleSeconds,
                remember: false
            });

            this.applyGeneratorMode(response.mode);

            if (!response.shouldRespond) {
                console.log(`[Bot] Idle generator chose silence (confidence=${response.confidence})`);
                return;
            }

            if (!this.canRunIdleDecision(guildId)) {
                console.log('[Bot] Idle generator response discarded because live state changed');
                return;
            }

            await this.speakDirectGeneratorResponse(guildId, response, {
                source: 'idle',
                playFiller: false,
                rememberAssistant: true
            });
        } catch (error) {
            console.error('[Bot] Idle generator failed:', error);
        } finally {
            this.idleDecisionInFlight.delete(guildId);
        }
    }

    /**
     * Load ElevenLabs API key from env or file
     */
    loadElevenLabsKey() {
        // Try environment first
        if (process.env.ELEVENLABS_API_KEY) {
            return process.env.ELEVENLABS_API_KEY;
        }
        
        // Optional legacy local file, ignored by git.
        const keyPath = path.join(__dirname, '.elevenlabs-api-key');
        if (fs.existsSync(keyPath)) {
            const content = fs.readFileSync(keyPath, 'utf8');
            const match = content.match(/ELEVENLABS_API_KEY=(.+)/);
            if (match) return match[1].trim();
        }
        
        return null;
    }

    /**
     * Load cached audio buffers for boilerplate vocalizations
     * Saves TTS API credits by pre-generating common phrases
     */
    loadCachedAudio() {
        const cacheDir = path.join(__dirname, 'cached-audio');
        const files = {
            consentDisclosure: 'consent-disclosure.mp3',
            recordingStarted: 'recording-started.mp3',
            recordingCancelled: 'recording-cancelled.mp3',
            consentTimeout: 'consent-timeout.mp3'
        };

        const buffers = {};
        for (const [key, filename] of Object.entries(files)) {
            const filePath = path.join(cacheDir, filename);
            if (fs.existsSync(filePath)) {
                try {
                    buffers[key] = fs.readFileSync(filePath);
                    console.log(`[Bot] Loaded cached audio: ${filename}`);
                } catch (err) {
                    console.warn(`[Bot] Failed to load cached audio ${filename}: ${err.message}`);
                }
            } else {
                console.warn(`[Bot] Cached audio not found: ${filePath}`);
            }
        }

        // Load filler clips (instant "thinking" audio to bridge TTS delay)
        buffers.fillerClips = [];
        const fillerFiles = [
            'filler-one-moment.mp3',
            'filler-hold-tight.mp3',
            'filler-crunching-numbers.mp3',
            'filler-working-on-it.mp3',
            'filler-work-that-out.mp3',
            'filler-hang-on-mate.mp3',
            'filler-give-me-a-sec.mp3',
            'filler-chew-on-that.mp3',
            'filler-lemme-yeah-thinking.mp3',
            'filler-beep-boop-joke.mp3'
        ];

        for (const filename of fillerFiles) {
            const filePath = path.join(cacheDir, filename);
            if (fs.existsSync(filePath)) {
                try {
                    const buffer = fs.readFileSync(filePath);
                    buffers.fillerClips.push(buffer);
                    console.log(`[Bot] Loaded filler clip: ${filename}`);
                } catch (err) {
                    console.warn(`[Bot] Failed to load filler clip ${filename}: ${err.message}`);
                }
            } else {
                console.warn(`[Bot] Filler clip not found: ${filePath}`);
            }
        }

        console.log(`[Bot] Loaded ${buffers.fillerClips.length} filler clips`);
        return buffers;
    }

    /**
     * Play a random filler clip to bridge TTS delay
     * @param {string} guildId - Discord guild ID
     */
    async playFillerClip(guildId) {
        if (!this.cachedAudio.fillerClips || this.cachedAudio.fillerClips.length === 0) {
            return;
        }

        try {
            const randomIndex = Math.floor(Math.random() * this.cachedAudio.fillerClips.length);
            const fillerBuffer = this.cachedAudio.fillerClips[randomIndex];
            console.log(`[Bot] Playing filler clip (${fillerBuffer.length} bytes)`);
            await this.voiceManager.speak(guildId, fillerBuffer);
        } catch (error) {
            console.error('[Bot] Error playing filler clip:', error);
        }
    }

    async *singleTextChunk(text) {
        yield text;
    }

    async synthesizeLiveTTS(text, options = {}) {
        const textLength = String(text || '').length;

        if (this.voiceProvider.isStreamingEnabled(options)) {
            console.log(`[Bot] TTS function called (Fish WS streaming, ${textLength} chars)`);
            return this.voiceProvider.synthesizeStream(this.singleTextChunk(text), {
                ...options,
                latency: options.latency || 'balanced'
            });
        }

        console.log(`[Bot] TTS function called (HTTP fallback, ${textLength} chars)`);
        return this.voiceProvider.synthesize(text, options);
    }

    isReadableAudio(audio) {
        return audio && typeof audio.pipe === 'function' && !Buffer.isBuffer(audio);
    }

    teeAudioForRecording(audio) {
        const capture = {
            playbackAudio: audio,
            isStream: false,
            chunks: [],
            byteLength: 0,
            completedAt: null
        };

        if (!this.isReadableAudio(audio)) {
            return capture;
        }

        const playbackAudio = new PassThrough();
        const recordingAudio = new PassThrough();

        capture.playbackAudio = playbackAudio;
        capture.isStream = true;

        audio.once('error', (error) => {
            playbackAudio.destroy(error);
            recordingAudio.destroy(error);
        });

        recordingAudio.on('data', (chunk) => {
            const buffer = Buffer.from(chunk);
            capture.chunks.push(buffer);
            capture.byteLength += buffer.length;
        });

        recordingAudio.once('end', () => {
            capture.completedAt = new Date().toISOString();
        });

        recordingAudio.once('error', (error) => {
            console.error('[Bot] Error capturing streamed TTS for recording:', error);
        });

        audio.pipe(playbackAudio);
        audio.pipe(recordingAudio);

        return capture;
    }

    getCapturedAudioBuffer(capture) {
        if (!capture || capture.byteLength <= 0) {
            return null;
        }

        return Buffer.concat(capture.chunks, capture.byteLength);
    }

    async playTtsAndRecord(guildId, audio, options = {}) {
        const capture = this.teeAudioForRecording(audio);
        let botAudioRecorded = false;
        let playbackStartMs;

        const playback = await this.voiceManager.speakWithTiming(guildId, capture.playbackAudio, {
            ...options,
            onStart: (timing) => {
                const parsedStartMs = Date.parse(timing.playbackStartedAt);
                playbackStartMs = Number.isNaN(parsedStartMs) ? undefined : parsedStartMs;

                if (!capture.isStream && Buffer.isBuffer(audio)) {
                    this.voiceManager.addBotAudioToRecording(guildId, audio, {
                        startTime: playbackStartMs
                    });
                    botAudioRecorded = true;
                }

                if (typeof options.onStart === 'function') {
                    options.onStart(timing);
                }
            }
        });
        const playbackTiming = await playback.finished;

        if (capture.isStream) {
            const recordedAudio = this.getCapturedAudioBuffer(capture);
            if (recordedAudio) {
                this.voiceManager.addBotAudioToRecording(guildId, recordedAudio, {
                    startTime: playbackStartMs
                });
                botAudioRecorded = true;
            } else {
                console.warn('[Bot] Streamed TTS produced no captured audio for recording');
            }
        } else if (!botAudioRecorded && Buffer.isBuffer(audio)) {
            this.voiceManager.addBotAudioToRecording(guildId, audio);
            botAudioRecorded = true;
        }

        return {
            playback,
            playbackTiming,
            botAudioRecorded,
            ttsCompletedAt: capture.completedAt
        };
    }

    /**
     * Set up Discord event handlers
     */
    setupEventHandlers() {
        this.client.on('ready', () => {
            console.log(`[Bot] Logged in as ${this.client.user.tag}`);
            this.registerCommands();
        });

        this.client.on('interactionCreate', async (interaction) => {
            console.log(`[Bot] Interaction received: ${interaction.type}, isCommand: ${interaction.isChatInputCommand()}`);
            if (!interaction.isChatInputCommand()) return;
            console.log(`[Bot] Handling command: ${interaction.commandName}`);
            try {
                await this.handleCommand(interaction);
            } catch (error) {
                console.error(`[Bot] Error in interaction handler:`, error);
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({ content: 'An error occurred!', ephemeral: true }).catch(() => {});
                }
            }
        });

        this.client.on('messageCreate', (message) => {
            if (message.author.bot) return;
            this.handleMessage(message);
        });

        this.client.on('error', (error) => {
            console.error('[Bot] Discord client error:', error);
        });
    }

    /**
     * Register slash commands
     */
    async registerCommands() {
        const commands = [
            new SlashCommandBuilder()
                .setName('podcast-join')
                .setDescription('Join voice channel and start recording')
                .addStringOption(option =>
                    option.setName('topic')
                        .setDescription('Topic for the podcast')
                        .setRequired(false))
                .addStringOption(option =>
                    option.setName('jensen_id')
                        .setDescription('Discord ID for Jensen')
                        .setRequired(false))
                .addStringOption(option =>
                    option.setName('jade_id')
                        .setDescription('Discord ID for Jade')
                        .setRequired(false)),
            new SlashCommandBuilder()
                .setName('podcast-leave')
                .setDescription('Stop recording and leave voice channel'),
            new SlashCommandBuilder()
                .setName('podcast-status')
                .setDescription('Check podcast status'),
            new SlashCommandBuilder()
                .setName('podcast-reset')
                .setDescription('Reset bot state (emergency cleanup)'),
            new SlashCommandBuilder()
                .setName('podcast-mode')
                .setDescription('Switch conversation buffering mode')
                .addStringOption(option =>
                    option
                        .setName('mode')
                        .setDescription('Buffering mode')
                        .setRequired(true)
                        .addChoices(
                            { name: 'Chatty (~700ms grace)', value: 'chatty' },
                            { name: 'Buffered (10s grace)', value: 'buffered' }
                        )
                ),
            new SlashCommandBuilder()
                .setName('podcast-debug')
                .setDescription('Toggle debug modes')
                .addBooleanOption(option =>
                    option
                        .setName('inject')
                        .setDescription('Inject individual utterances for Gateway UI')
                        .setRequired(false)
                )
                .addBooleanOption(option =>
                    option
                        .setName('flush')
                        .setDescription('Immediate flush mode (bypass timing)')
                        .setRequired(false)
                ),
            new SlashCommandBuilder()
                .setName('podcast-tts')
                .setDescription('Switch voice mode (TTS + STT)')
                .addStringOption(option =>
                    option
                        .setName('mode')
                        .setDescription('Voice mode configuration')
                        .setRequired(true)
                        .addChoices(
                            { name: 'Fish Audio (TTS + ASR)', value: 'fish' },
                            { name: 'Fish Audio + OpenAI Whisper STT', value: 'fish-whisper' },
                            { name: 'Premium (ElevenLabs TTS + STT)', value: 'elevenlabs' },
                            { name: 'Free (Edge TTS + OpenAI Whisper STT)', value: 'free' },
                            { name: 'Hybrid (ElevenLabs TTS + OpenAI Whisper STT)', value: 'hybrid' },
                            { name: 'Local (Edge TTS + whisper.cpp STT)', value: 'local' }
                        )
                )
        ];

        const rest = new REST({ version: '10' }).setToken(this.token);

        try {
            console.log('[Bot] Registering slash commands...');
            
            if (this.guildId) {
                // Register for specific guild (faster, for testing)
                await rest.put(
                    Routes.applicationGuildCommands(this.clientId, this.guildId),
                    { body: commands.map(c => c.toJSON()) }
                );
                console.log(`[Bot] Commands registered for guild ${this.guildId}`);
            } else {
                // Register globally (takes up to an hour)
                await rest.put(
                    Routes.applicationCommands(this.clientId),
                    { body: commands.map(c => c.toJSON()) }
                );
                console.log('[Bot] Commands registered globally');
            }
        } catch (error) {
            console.error('[Bot] Failed to register commands:', error);
        }
    }

    /**
     * Handle slash commands
     */
    async handleCommand(interaction) {
        const { commandName, guildId } = interaction;

        try {
            switch (commandName) {
                case 'podcast-join':
                    await this.handleJoinCommand(interaction);
                    break;
                case 'podcast-leave':
                    await this.handleLeaveCommand(interaction);
                    break;
                case 'podcast-status':
                    await this.handleStatusCommand(interaction);
                    break;
                case 'podcast-reset':
                    await this.handleResetCommand(interaction);
                    break;
                case 'podcast-mode': {
                    const mode = interaction.options.getString('mode');
                    const newMode = mode === 'buffered' ? BUFFERED_MODE : CHATTY_MODE;
                    this.conversationBuffer.setMode(newMode);
                    this.conversationBuffer.forceFlush();
                    await interaction.reply({ 
                        content: `Switched to **${mode}** mode.`, 
                        ephemeral: true 
                    });
                    break;
                }
                case 'podcast-debug': {
                    const inject = interaction.options.getBoolean('inject');
                    const flush = interaction.options.getBoolean('flush');
                    
                    if (inject !== null) {
                        this.debugInject = inject;
                    }
                    if (flush !== null) {
                        this.conversationBuffer.setDebug(flush);
                    }
                    
                    await interaction.reply({
                        content: `Debug: inject=${this.debugInject}, flush=${this.conversationBuffer.debugMode}`,
                        ephemeral: true
                    });
                    break;
                }
                case 'podcast-tts': {
                    const mode = interaction.options.getString('mode');
                    const oldMode = this.voiceProvider.getMode();
                    
                    if (mode === oldMode) {
                        await interaction.reply({
                            content: `Voice mode is already set to **${mode}**.`,
                            ephemeral: true
                        });
                        break;
                    }
                    
                    // Defer reply to give time for mode switch
                    await interaction.deferReply({ ephemeral: true });
                    
                    try {
                        this.voiceProvider.switchMode(mode);
                        this.voiceId = this.voiceProvider.voiceId;
                        
                        const info = this.voiceProvider.getInfo();
                        const modeDescription = {
                            'fish': 'Fish Audio (TTS + ASR)',
                            'fish-whisper': 'Fish Audio + OpenAI Whisper STT',
                            'elevenlabs': 'Premium (ElevenLabs TTS + STT)',
                            'free': 'Free (Edge TTS + OpenAI Whisper STT)',
                            'hybrid': 'Hybrid (ElevenLabs TTS + OpenAI Whisper STT)',
                            'local': 'Local (Edge TTS + whisper.cpp STT)'
                        };
                        
                        await interaction.editReply({
                            content: `🎙️ Voice mode switched from **${oldMode}** to **${mode}**\n` +
                                     `**Configuration:** ${modeDescription[mode]}\n` +
                                     `TTS: ${info.tts.provider} | STT: ${info.stt.provider}`
                        });
                        console.log(`[Bot] Voice mode switched from ${oldMode} to ${mode}`);
                    } catch (error) {
                        console.error(`[Bot] Error switching voice mode:`, error);
                        try {
                            await interaction.editReply({
                                content: `❌ Error switching voice mode: ${error.message}`
                            });
                        } catch (replyError) {
                            console.error(`[Bot] Failed to send error reply:`, replyError);
                        }
                    }
                    break;
                }
            }
        } catch (error) {
            console.error(`[Bot] Error handling command ${commandName}:`, error);
            console.error(error.stack);
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ 
                    content: `Error: ${error.message}`, 
                    ephemeral: true 
                });
            }
        }
    }

    /**
     * Handle /podcast-join command - joins voice channel and starts recording
     */
    async handleJoinCommand(interaction) {
        const member = interaction.member;
        const voiceChannel = member.voice.channel;
        const guildId = interaction.guildId;

        if (!voiceChannel) {
            return interaction.reply({
                content: 'You need to be in a voice channel first!',
                ephemeral: true
            });
        }

        // Check if already recording
        const currentState = this.recordingState.get(guildId);
        if (currentState === this.RecordingState.RECORDING) {
            return interaction.reply({
                content: '🎙️ Already recording! Use "/podcast-leave" to stop and leave.',
                ephemeral: true
            });
        }
        if (currentState === this.RecordingState.AWAITING_CONSENT) {
            return interaction.reply({
                content: '⏳ Already waiting for consent. Please type YES or NO to proceed.',
                ephemeral: true
            });
        }

        await interaction.deferReply();

        try {
            // Get options FIRST (before joining)
            const topic = interaction.options.getString('topic') || 'the topic at hand';
            const jensenId = interaction.options.getString('jensen_id');
            const jadeId = interaction.options.getString('jade_id');

            // Update speaker map BEFORE joining (so it's passed to AudioReceiver)
            if (jensenId) {
                this.speakerMap[jensenId] = { name: 'Jensen', role: 'guest' };
            }
            if (jadeId) {
                this.speakerMap[jadeId] = { name: 'Jade', role: 'guest' };
            }

            // Join the voice channel (speakerMap now populated)
            await this.voiceManager.joinChannel(voiceChannel, this.speakerMap);

            // Set recording state to awaiting consent
            this.recordingState.set(guildId, this.RecordingState.AWAITING_CONSENT);
            this.consentWaiters.set(guildId, {
                userId: interaction.user.id,
                topic: topic,
                timestamp: Date.now()
            });

            // Speak consent disclosure (use cached audio to save API credits)
            const audioBuffer = this.cachedAudio.consentDisclosure;
            if (audioBuffer) {
                await this.voiceManager.speak(guildId, audioBuffer);
            } else {
                // Fallback to synthesis if cached audio not available
                const disclosureText = "I'll be recording this conversation for the podcast. Do all participants consent to being recorded? Please type YES to proceed or NO to cancel.";
                const synthesizedBuffer = await this.voiceProvider.synthesize(disclosureText, {
                    voiceId: this.voiceId
                });
                await this.voiceManager.speak(guildId, synthesizedBuffer);
            }

            await interaction.editReply(
                `✅ Joined **${voiceChannel.name}**!\n\n` +
                `🎙️ **Consent Request Sent**\n` +
                `I've asked participants for recording consent in voice.\n` +
                `Please type **YES** to proceed or **NO** to cancel.\n\n` +
                `(Waiting 60 seconds for response...)`
            );

            // Set timeout for consent
            setTimeout(() => {
                if (this.recordingState.get(guildId) === this.RecordingState.AWAITING_CONSENT) {
                    this.recordingState.set(guildId, this.RecordingState.IDLE);
                    this.consentWaiters.delete(guildId);
                    // Use cached audio for timeout message (saves API credits)
                    const audioBuffer = this.cachedAudio.consentTimeout;
                    if (audioBuffer && this.voiceManager.isConnected(guildId)) {
                        this.voiceManager.speak(guildId, audioBuffer);
                    } else {
                        this.speakInGuild(guildId, "Consent request timed out. Please start again when ready.");
                    }
                }
            }, 60000);

        } catch (error) {
            console.error('[Bot] Join error:', error);
            await interaction.editReply(`❌ Error: ${error.message}`);
        }
    }

    /**
     * Handle YES/NO consent responses
     */
    async handleMessage(message) {
        const guildId = message.guildId;
        const userId = message.author.id;
        const content = message.content.toLowerCase().trim();

        // Check if we're awaiting consent
        if (this.recordingState.get(guildId) !== this.RecordingState.AWAITING_CONSENT) {
            return;
        }

        const waiter = this.consentWaiters.get(guildId);
        if (!waiter) return;

        // Only accept from the user who started
        if (waiter.userId !== userId) return;

        if (content === 'yes') {
            await this.grantConsent(guildId, waiter.topic);
        } else if (content === 'no') {
            await this.denyConsent(guildId);
        }
    }

    /**
     * Grant consent and start recording
     */
    async grantConsent(guildId, topic) {
        this.recordingState.set(guildId, this.RecordingState.RECORDING);
        const consentTimestamp = new Date().toISOString();

        // Disable all cron jobs to prevent interruptions during podcast
        try {
            this.disabledCronJobs = await this.gatewayBridge.disableAllCronJobs();
        } catch (error) {
            console.error('[Bot] Failed to disable cron jobs:', error.message);
            this.disabledCronJobs = [];
        }

        // Start recording with consent metadata
        const recordingInfo = this.voiceManager.startRecording(guildId, 'episode', {
            consentGiven: true,
            consentTimestamp: consentTimestamp
        });

        // Announce start (use cached audio to save API credits)
        try {
            const audioBuffer = this.cachedAudio.recordingStarted;
            if (audioBuffer) {
                this.voiceManager.addBotAudioToRecording(guildId, audioBuffer);
                await this.voiceManager.speak(guildId, audioBuffer);
            } else {
                // Fallback to synthesis if cached audio not available
                const startText = `Recording started! Episode is now live. Speak naturally and I'll join the conversation.`;
                const synthesizedBuffer = await this.voiceProvider.synthesize(startText, {
                    voiceId: this.voiceId
                });
                this.voiceManager.addBotAudioToRecording(guildId, synthesizedBuffer);
                await this.voiceManager.speak(guildId, synthesizedBuffer);
            }

            this.podcastGenerator.startSession({
                topic: topic || 'general discussion',
                recording: true,
                speakers: Object.values(this.speakerMap).map(s => `${s.name} (${s.role || 'speaker'})`)
            });
            this.startIdleDecisionLoop(guildId);

            // Notify Gateway/OpenClaw when it is driving responses or mirroring is enabled.
            if (this.wsClient.isAuthenticated && this.shouldConnectGatewayWs()) {
                try {
                    const PODCAST_GUIDELINES = [
                        'Respond conversationally, as if speaking out loud',
                        'No code blocks, file paths, or technical formatting',
                        'Keep responses concise and natural for spoken delivery',
                        'No markdown, bullet points, or structured formatting',
                        'Listeners hear your FULL response as voice — there is no "silent" text channel',
                        '',
                        '--- MODE SWITCHING DIRECTIVE ---',
                        'You can dynamically adjust the podcast\'s responsiveness by emitting action directives in your response text.',
                        'These are parsed and removed before reaching users.',
                        '',
                        'Syntax: [ACTION:mode:MODE_NAME]',
                        '',
                        'Available modes:',
                        '- chatty: Fast responses (2 second silence detection, 2 second cooldown), good for banter, quick exchanges, high-energy moments',
                        '- buffered: Slower, more deliberate (10 second silence detection, batches 3+ utterances, 15 second cooldown), good for storytelling, monologues, structured segments',
                        '',
                        'When to use:',
                        '- Emit [ACTION:mode:chatty] when: engaging in rapid back-and-forth, reacting to quick user inputs, keeping energy high, conversational ping-pong',
                        '- Emit [ACTION:mode:buffered] when: beginning a story, delivering a monologue, wanting to gather thoughts before speaking, transitioning to narrative content',
                        '',
                        'Examples:',
                        '- User: "Tell me a joke!" → You: [ACTION:mode:chatty] "Why did the lobster blush? Because the sea weed!"',
                        '- User: "What happened next in the story?" → You: [ACTION:mode:buffered] "Let me gather my thoughts... [then continue with story after brief pause]"',
                        '',
                        'Important: The directive is invisible to users. It only affects how your responses are timed and batched. You remain in control of when to switch modes.'
                    ];
                    
                    await this.wsClient.injectPodcastEvent({
                        event: 'session_start',
                        recording: true,
                        guidelines: PODCAST_GUIDELINES,
                        topic: topic || 'general discussion'
                    });
                    console.log('[Bot] Injected podcast session_start event');
                } catch (err) {
                    console.error('[Bot] Failed to notify agent of session start:', err.message);
                }
            }
        } catch (error) {
            console.error('[Bot] Error speaking start:', error);
        }

        this.consentWaiters.delete(guildId);
    }

    /**
     * Deny consent
     */
    async denyConsent(guildId) {
        this.recordingState.set(guildId, this.RecordingState.IDLE);
        
        // Use cached audio for cancel message (saves API credits)
        try {
            const audioBuffer = this.cachedAudio.recordingCancelled;
            if (audioBuffer) {
                await this.voiceManager.speak(guildId, audioBuffer);
            } else {
                // Fallback to synthesis if cached audio not available
                const cancelText = "Recording cancelled. You can start again without recording if you'd like.";
                const synthesizedBuffer = await this.voiceProvider.synthesize(cancelText, {
                    voiceId: this.voiceId
                });
                await this.voiceManager.speak(guildId, synthesizedBuffer);
            }
        } catch (error) {
            console.error('[Bot] Error speaking cancel:', error);
        }

        this.consentWaiters.delete(guildId);
    }

    /**
     * Handle /podcast-leave command - stops recording and leaves voice channel
     */
    async handleLeaveCommand(interaction) {
        const guildId = interaction.guildId;
        
        // IMPORTANT: Defer IMMEDIATELY to avoid 3-second timeout
        await interaction.deferReply();
        
        console.log(`[Bot] Leave command received for guild ${guildId}`);

        try {
            if (!this.voiceManager.isConnected(guildId)) {
                console.log(`[Bot] Not connected to voice in guild ${guildId}`);
                return await interaction.editReply({
                    content: 'I\'m not in a voice channel.'
                });
            }

            const wasRecording = this.recordingState.get(guildId) === this.RecordingState.RECORDING;
            let recordingPath = null;

            if (wasRecording) {
                this.stopIdleDecisionLoop(guildId);
                this.podcastGenerator.endSession();
            }

            // Notify Gateway/OpenClaw when it is driving responses or mirroring is enabled.
            if (wasRecording && this.wsClient.isAuthenticated && this.shouldConnectGatewayWs()) {
                try {
                    await this.wsClient.injectPodcastEvent({
                        event: 'session_end',
                        recording: false
                    });
                    console.log('[Bot] Injected podcast session_end event');
                } catch (err) {
                    console.error('[Bot] Failed to notify agent of session end:', err.message);
                }
            }

            // Re-enable cron jobs that were disabled
            if (this.disabledCronJobs.length > 0) {
                try {
                    await this.gatewayBridge.enableAllCronJobs();
                    console.log(`[Bot] Re-enabled ${this.disabledCronJobs.length} cron job(s)`);
                } catch (error) {
                    console.error('[Bot] Failed to re-enable cron jobs:', error.message);
                }
                this.disabledCronJobs = [];
            }

            // Stop recording if active
            if (wasRecording) {
                const result = await this.voiceManager.stopRecording(guildId);
                recordingPath = result?.recordingPath;
            }

            // Clean up recording state
            this.recordingState.delete(guildId);
            this.consentWaiters.delete(guildId);

            // Leave voice channel
            await this.voiceManager.leaveChannel(guildId);

            // Build response message
            let message = '👋 Left the voice channel.';
            if (wasRecording && recordingPath) {
                message += `\n\n✅ **Episode saved to:**\n\`\`\`${recordingPath}\`\`\``;
            }
            message += '\n\nSee you next time!';

            await interaction.editReply(message);

        } catch (error) {
            console.error('[Bot] Leave error:', error);
            await interaction.editReply(`❌ Error: ${error.message}`);
        }
    }

    /**
     * Handle /podcast-status command
     */
    async handleStatusCommand(interaction) {
        const guildId = interaction.guildId;
        const status = this.voiceManager.getStatus(guildId);

        if (!status) {
            return interaction.reply({
                content: 'Not connected to a voice channel.',
                ephemeral: true
            });
        }

        const recordingInfo = this.voiceManager.getRecordingInfo(guildId);
        const state = this.recordingState.get(guildId) || 'IDLE';
        const bufferState = this.conversationBuffer?.getState();
        const bufferMode = this.getBufferModeName();
        const bufferCount = bufferState?.utteranceCount || 0;
        const bufferReady = bufferState?.isReady ?? true;

        const voiceMode = this.voiceProvider?.getMode() || 'unknown';
        const info = this.voiceProvider?.getInfo();
        const generatorInfo = this.useGatewayGenerator()
            ? { provider: 'gateway-openclaw', model: this.wsClient.sessionKey }
            : this.podcastGenerator.getInfo();
        
        let message = `📊 **Status**\n\n`;
        message += `Connected: ${status.connected ? '✅' : '❌'}\n`;
        message += `State: ${state}\n`;
        message += `Voice Mode: **${voiceMode}** (${info?.tts.provider}/${info?.stt.provider})\n`;
        message += `Generator: **${this.generatorMode}** (${generatorInfo.provider}/${generatorInfo.model})\n`;
        message += `Buffer Mode: **${bufferMode}** | ${bufferCount} utterance(s) | Ready: ${bufferReady ? '✅' : '⏳'}\n`;
        
        if (recordingInfo) {
            message += `Duration: ${recordingInfo.durationFormatted || 'N/A'}\n`;
            message += `File: ${recordingInfo.audioFilePath || 'N/A'}\n`;
        }

        await interaction.reply({ content: message, ephemeral: true });
    }

    /**
     * Handle /podcast-reset command
     */
    async handleResetCommand(interaction) {
        const guildId = interaction.guildId;

        this.recordingState.set(guildId, this.RecordingState.IDLE);
        this.consentWaiters.delete(guildId);
        this.isProcessing.set(guildId, false);
        this.stopIdleDecisionLoop(guildId);
        this.podcastGenerator.endSession();

        await interaction.reply({
            content: '✅ Bot state reset to IDLE.',
            ephemeral: true
        });
    }

    /**
     * Handle an utterance from a speaker (legacy - now handled via buffer)
     */
    async handleUtterance(guildId, utterance) {
        // This method is now handled by the conversation buffer
        console.log(`[Bot] Utterance from ${utterance.speaker}: "${utterance.transcription?.substring(0, 50)}..." (buffered)`);
    }

    /**
     * Handle buffer flush - send batched utterances to the configured generator
     * @param {Array} utterances - Array of {speaker, transcription, timestamp, words}
     */
    async handleBufferFlush(utterances) {
        if (this.useGatewayGenerator() && !this.wsClient.isAuthenticated) {
            console.warn('[Bot] Cannot flush buffer: WebSocket not authenticated');
            return;
        }

        const guildId = this.getActiveGuildId();
        if (!guildId) {
            console.warn('[Bot] Cannot flush buffer: No active recording session');
            return;
        }

        // Debug: Log what word data we received
        utterances.forEach((u, i) => {
            console.log(`[Bot] Utterance ${i}: ${u.words?.length || 0} words, confidence: ${u.transcriptionConfidence}, speakerRole: ${u.speakerRole}`);
            if (u.words && u.words.length > 0) {
                console.log(`[Bot] First word sample:`, JSON.stringify(u.words[0]));
            }
        });

        // Format utterances as transcript with word-level data
        const formatted = utterances
            .map(u => `${u.speaker}: ${u.transcription}`)
            .join('\n');

        // Build detailed word-level data for each utterance
        const utterancesWithWordData = utterances.map(u => ({
            speaker: u.speaker,
            speakerRole: u.speakerRole || 'guest',
            transcription: u.transcription,
            rawTranscription: u.rawTranscription,
            audioEvents: u.audioEvents || [],
            confidence: u.transcriptionConfidence,
            language: u.language,
            wordCount: u.words?.length || 0,
            words: (u.words || []).map(w => ({
                text: w.text || w.word,
                start: w.start,
                end: w.end,
                confidence: w.confidence || w.probability,
                type: w.type || 'word' // 'word' or 'audio_event'
            })),
            lowConfidenceWords: (u.words || [])
                .filter(w => (w.confidence || w.probability || 1) < 0.7)
                .map(w => w.text || w.word),
            wordAudioEvents: (u.words || [])
                .filter(w => w.type === 'audio_event' || /\[.*\]/.test(w.text || w.word))
                .map(w => w.text || w.word),
            duration: u.duration,
            speechStartedAt: u.speechStartedAt,
            speechEndedAt: u.speechEndedAt,
            speechDuration: u.speechDuration,
            asrStartedAt: u.asrStartedAt,
            asrCompletedAt: u.asrCompletedAt,
            timestamp: u.timestamp
        }));

        // Only include word-level data for ElevenLabs mode (real confidence scores)
        const isElevenLabsMode = this.voiceProvider.mode === 'elevenlabs';
        
        let messageText;
        let wordDataSummary = null;
        if (isElevenLabsMode) {
            const wordLevelSummary = utterancesWithWordData.map(u => {
                const avgConfidence = u.words.length > 0 
                    ? (u.words.reduce((sum, w) => sum + (w.confidence || 0), 0) / u.words.length).toFixed(2)
                    : 'N/A';
                const lowConfCount = u.lowConfidenceWords.length;
                const events = [...u.audioEvents, ...u.wordAudioEvents];
                const eventSummary = events.length > 0 ? ` [Events: ${events.join(', ')}]` : '';
                return `${u.speaker}: "${u.transcription}" (avg conf: ${avgConfidence}, ${u.wordCount} words${lowConfCount > 0 ? `, ${lowConfCount} low-conf` : ''}${eventSummary})`;
            }).join('\n');
            wordDataSummary = wordLevelSummary;
            messageText = `[Podcast Voice - Conversation Buffer]\n${formatted}\n\n[Word-Level Data]:\n${wordLevelSummary}`;
            console.log(`[Bot] Flushing ${utterances.length} utterance(s) to ${this.generatorMode} generator with word-level data (ElevenLabs mode)`);
        } else {
            messageText = `[Podcast Voice - Conversation Buffer]\n${formatted}`;
            console.log(`[Bot] Flushing ${utterances.length} utterance(s) to ${this.generatorMode} generator (${this.voiceProvider.mode} mode, no word-level data)`);
        }

        if (!this.useGatewayGenerator()) {
            await this.handleDirectGeneratorFlush(guildId, utterances, formatted, wordDataSummary);
            return;
        }

        // Play instant filler clip to bridge TTS delay (cached, no API call)
        await this.playFillerClip(guildId);

        try {
            // Inject for UI visibility (with word-level data)
            await this.wsClient.injectMessage(messageText, { label: 'discord-voice' });

            // Send to trigger AI response
            await this.wsClient.sendChat(messageText, {
                idempotencyKey: `discord-buffer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
            });
        } catch (error) {
            console.error('[Bot] Failed to send buffered utterances:', error);
        }
    }

    getBufferModeName() {
        return this.conversationBuffer?.config.gracePeriod === BUFFERED_MODE.gracePeriod
            ? 'buffered'
            : 'chatty';
    }

    applyGeneratorMode(mode) {
        if (!mode || mode === 'unchanged') {
            return;
        }

        const newMode = mode === 'buffered' ? BUFFERED_MODE : CHATTY_MODE;
        this.conversationBuffer.setMode(newMode);
        console.log(`[Bot] Generator requested mode switch: ${mode}`);
    }

    async handleDirectGeneratorFlush(guildId, utterances, transcript, wordData) {
        this.directResponseInFlight.add(guildId);

        try {
            const response = await this.podcastGenerator.generate({
                utterances,
                transcript,
                wordData,
                currentMode: this.getBufferModeName()
            });

            this.applyGeneratorMode(response.mode);

            if (!response.shouldRespond) {
                console.log(`[Bot] Direct generator chose silence (confidence=${response.confidence})`);
                return;
            }

            await this.speakDirectGeneratorResponse(guildId, response, {
                source: 'buffer',
                playFiller: true
            });
        } catch (error) {
            console.error('[Bot] Direct generator failed:', error);
            const lastSpeaker = utterances[utterances.length - 1]?.speaker || 'there';
            await this.fallbackResponse(guildId, lastSpeaker);
        } finally {
            this.directResponseInFlight.delete(guildId);
        }
    }

    async speakDirectGeneratorResponse(guildId, response, options = {}) {
        const alreadyInFlight = this.directResponseInFlight.has(guildId);
        this.directResponseInFlight.add(guildId);
        const source = options.source || 'buffer';

        try {
            const generatedAt = response.generatedAt || new Date().toISOString();
            console.log(`[Bot] Direct generator response (${source}): "${response.speech.substring(0, 50)}..."`);
            this.markIdleDecisionHandled(guildId);

            // Play a cached filler only after the generator decides to answer.
            if (options.playFiller !== false) {
                await this.playFillerClip(guildId);
            }

            const ttsStartedAt = new Date().toISOString();
            const audio = await this.synthesizeLiveTTS(response.speech, {
                voiceId: this.voiceId
            });
            const ttsSetupCompletedAt = this.isReadableAudio(audio) ? null : new Date().toISOString();

            const playbackResult = await this.playTtsAndRecord(guildId, audio);
            const playback = playbackResult.playback;
            const playbackTiming = playbackResult.playbackTiming;

            const playbackStartedAt = playbackTiming.playbackStartedAt || playback.timing.playbackStartedAt;
            const playbackEndedAt = playbackTiming.playbackEndedAt || playback.timing.playbackEndedAt;
            const playbackStartedMs = Date.parse(playbackStartedAt);
            const playbackEndedMs = Date.parse(playbackEndedAt);
            const playbackDuration = !Number.isNaN(playbackStartedMs) && !Number.isNaN(playbackEndedMs)
                ? Math.max(0, playbackEndedMs - playbackStartedMs)
                : 0;

            this.voiceManager.saveTranscriptEntry(guildId, {
                speaker: 'Alpha-Clawd',
                speakerRole: 'host',
                transcription: response.speech,
                timestamp: generatedAt,
                generatedAt,
                ttsStartedAt,
                ttsCompletedAt: playbackResult.ttsCompletedAt || ttsSetupCompletedAt || playbackEndedAt,
                playbackRequestedAt: playbackTiming.playbackRequestedAt || playback.timing.playbackRequestedAt,
                playbackStartedAt,
                playbackEndedAt,
                duration: playbackDuration
            });

            if (options.rememberAssistant) {
                this.podcastGenerator.rememberAssistantResponse(response);
            }

            console.log(`[Bot] Direct generator playback complete (${source}), starting cooldown`);
            this.conversationBuffer.startCooldown();
        } finally {
            if (!alreadyInFlight) {
                this.directResponseInFlight.delete(guildId);
            }
        }
    }

    /**
     * Fallback response when Gateway unavailable
     */
    async fallbackResponse(guildId, speakerName) {
        const fallbacks = [
            `That's fascinating, ${speakerName}. Tell me more.`,
            `Interesting point, ${speakerName}. What led you to that?`,
            `I love that perspective, ${speakerName}.`,
            `Go on, ${speakerName}. I'm listening.`
        ];
        
        const text = fallbacks[Math.floor(Math.random() * fallbacks.length)];
        
        try {
            this.markIdleDecisionHandled(guildId);

            const audioBuffer = await this.voiceProvider.synthesize(text, {
                voiceId: this.voiceId
            });
            
            this.voiceManager.addBotAudioToRecording(guildId, audioBuffer);
            await this.voiceManager.speak(guildId, audioBuffer);
            this.conversationBuffer.startCooldown();
        } catch (error) {
            console.error('[Bot] Fallback error:', error);
        }
    }

    /**
     * Speak text in a guild
     */
    async speakInGuild(guildId, text) {
        if (!this.voiceManager.isConnected(guildId)) return;
        
        try {
            const audioBuffer = await this.voiceProvider.synthesize(text, {
                voiceId: this.voiceId
            });
            await this.voiceManager.speak(guildId, audioBuffer);
        } catch (error) {
            console.error('[Bot] Speak error:', error);
        }
    }

    /**
     * Start the bot
     */
    async start() {
        if (!this.token) {
            throw new Error('Discord bot token not provided');
        }

        // Validate voice provider
        const validation = await this.voiceProvider.validate();
        if (!validation.valid) {
            console.warn('[Bot] Voice provider validation issues:');
            validation.errors.forEach(e => console.warn(`  - ${e}`));
        } else {
            const info = this.voiceProvider.getInfo();
            console.log(`[Bot] Voice providers validated: TTS=${info.tts.provider}, STT=${info.stt.provider}`);
        }

        if (!this.useGatewayGenerator()) {
            const generatorValidation = this.podcastGenerator.validate();
            if (!generatorValidation.valid) {
                console.warn('[Bot] Podcast generator validation issues:');
                generatorValidation.errors.forEach(e => console.warn(`  - ${e}`));
                console.warn('[Bot] Direct generator will use fallback responses until configured');
            } else {
                console.log(`[Bot] Podcast generator ready: ${generatorValidation.provider}/${generatorValidation.model}`);
            }
        }

        // Initialize Gateway bridge (HTTP response server)
        await this.gatewayBridge.initialize();

        // Connect WebSocket client only when Gateway/OpenClaw is the generator,
        // or when explicitly mirroring direct sessions into Gateway for visibility.
        if (this.shouldConnectGatewayWs()) {
            try {
                await this.wsClient.connect();
                console.log('[Bot] WebSocket client connected and authenticated');
            } catch (error) {
                console.error('[Bot] WebSocket connection failed:', error.message);
                if (this.useGatewayGenerator()) {
                    console.warn('[Bot] Will use fallback responses');
                }
            }
        } else {
            console.log('[Bot] Skipping Gateway WebSocket connection (direct generator mode)');
        }

        // Check Gateway availability
        const gatewayAvailable = await this.gatewayBridge.isGatewayAvailable();
        if (gatewayAvailable) {
            console.log('[Bot] Gateway connection verified');
        } else {
            const gatewayWarning = this.useGatewayGenerator()
                ? 'Gateway not available - will use fallback responses'
                : 'Gateway not available - cron pause/resume and mirroring may be unavailable';
            console.warn(`[Bot] ${gatewayWarning}`);
        }

        await this.client.login(this.token);
    }

    /**
     * Handle WebSocket response from Gateway
     */
    async handleWsResponse(response) {
        const { text, runId, message } = response;
        console.log(`[Bot] Received WebSocket response: "${text?.substring(0, 50)}..."`);

        if (!this.useGatewayGenerator()) {
            console.log('[Bot] Ignoring Gateway response because direct generator mode is active');
            return;
        }
        
        const guildId = this.getActiveGuildId();
        
        if (!guildId) {
            console.log('[Bot] No active recording session, skipping response');
            console.log(`[Bot] Recording states: ${JSON.stringify(Object.fromEntries(this.recordingState))}`);
            return;
        }
        
        // Skip TTS for injected messages (chat.inject broadcasts with runId starting with 'inject-')
        // These are context additions, not AI responses
        if (runId?.startsWith('inject-')) {
            console.log('[Bot] Skipping TTS for injected message (not an AI response)');
            return;
        }
        
        // BUGFIX: Skip TTS for user utterances that were echoed back from Gateway
        // User speech is formatted as "[discord-voice]\n\n[Podcast Voice] Speaker: ..."
        // Session markers like [podcast-session] are also not AI responses
        // Only assistant responses should be spoken
        if (text?.includes('[discord-voice]') || text?.includes('[Podcast Voice]') || text?.includes('[podcast-session]')) {
            console.log('[Bot] Skipping TTS for user utterance or session marker (not an assistant response)');
            return;
        }
        
        // Skip TTS for structured content blocks that aren't text (e.g., podcast_event)
        // These are system state updates, not assistant responses
        if (message?.content && Array.isArray(message.content)) {
            const hasNonTextContent = message.content.some(block => block.type !== 'text');
            const hasOnlyPodcastEvents = message.content.every(block => 
                block.type === 'podcast_event' || block.type === 'text'
            );
            if (hasNonTextContent && hasOnlyPodcastEvents) {
                console.log('[Bot] Skipping TTS for structured event (not an assistant response)');
                return;
            }
        }

        // Check for action blocks (mode switching directives from AI)
        if (message?.content && Array.isArray(message.content)) {
            const actionBlocks = message.content.filter(block => 
                block.type === 'action' && block.actionType === 'mode'
            );
            
            for (const block of actionBlocks) {
                const modeValue = block.value;
                console.log(`[Bot] AI requested mode switch: ${modeValue}`);
                
                const newMode = modeValue === 'buffered' ? BUFFERED_MODE : CHATTY_MODE;
                this.conversationBuffer.setMode(newMode);
                
                // Force flush pending buffer on mode switch
                this.conversationBuffer.forceFlush();
            }
        }
        
        console.log(`[Bot] Active guildId: ${guildId}, synthesizing TTS...`);

        try {
            // Synthesize response
            const audio = await this.synthesizeLiveTTS(text, {
                voiceId: this.voiceId
            });

            // Speak and add the completed audio to the mixed recording.
            await this.playTtsAndRecord(guildId, audio);

            // Start cooldown after playback completes
            console.log('[Bot] Audio playback complete, starting cooldown');
            this.conversationBuffer.startCooldown();

        } catch (error) {
            console.error('[Bot] Error speaking WebSocket response:', error);
        }
    }

    /**
     * Get the active guild ID (where recording is happening)
     */
    getActiveGuildId() {
        for (const [guildId, state] of this.recordingState.entries()) {
            if (state === this.RecordingState.RECORDING) {
                return guildId;
            }
        }
        return null;
    }

    /**
     * Stop the bot
     */
    async stop() {
        // Leave all voice channels
        for (const guildId of this.voiceManager.connections.keys()) {
            await this.voiceManager.leaveChannel(guildId);
        }

        // Clear conversation buffer
        if (this.conversationBuffer) {
            this.conversationBuffer.clear();
        }

        // Disconnect WebSocket client
        this.wsClient.disconnect();

        // Destroy Gateway bridge
        this.gatewayBridge.destroy();

        this.client.destroy();
    }
}

// Export for use as module or standalone
module.exports = { AlphaClawdVoiceBot };

// Run if called directly
if (require.main === module) {
    const bot = new AlphaClawdVoiceBot();
    
    bot.start().catch((error) => {
        log(`Bot failed to start: ${error.message}\n${error.stack}`, 'FATAL');
        process.exit(1);
    });
}
