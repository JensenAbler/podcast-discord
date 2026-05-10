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
const { spawn } = require('child_process');
const { StreamType } = require('@discordjs/voice');

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
const { ConversationBuffer, BufferState } = require('./conversation-buffer');
const { getRecordingDir } = require('./paths');
const { PodcastGenerator } = require('./podcast-generator');

// Map a Fish TTS format string to the @discordjs/voice StreamType that lets
// Discord play the bytes without an FFmpeg transcode. Returning undefined
// preserves the legacy StreamType.Arbitrary path inside AudioTransmitter.
function streamTypeForLiveFormat(format) {
    switch (String(format || '').toLowerCase()) {
        case 'opus': return StreamType.OggOpus;
        default: return undefined;
    }
}

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
        this.participantActivityVersion = new Map(); // guildId -> monotonic counter for floor-taking changes
        this.participantActivityTimers = new Map(); // guildId -> Map<userId, timeout>
        this.participantActivityConfirmDelayMs = Number(process.env.PODCAST_PARTICIPANT_ACTIVITY_CONFIRM_MS || 200);
        this.bigBrainEnabled = options.bigBrainEnabled !== undefined
            ? Boolean(options.bigBrainEnabled)
            : process.env.PODCAST_BIG_BRAIN_ENABLED !== 'false';
        this.bigBrainTimeoutMs = Number(process.env.PODCAST_BIG_BRAIN_TIMEOUT_MS || 180000);
        this.bigBrainThinking = process.env.PODCAST_BIG_BRAIN_THINKING || 'high';
        this.bigBrainAmbientEnabled = options.bigBrainAmbientEnabled !== undefined
            ? Boolean(options.bigBrainAmbientEnabled)
            : process.env.PODCAST_BIG_BRAIN_AMBIENT_ENABLED !== 'false';
        this.bigBrainAmbientStartDelayMs = Number(process.env.PODCAST_BIG_BRAIN_AMBIENT_START_DELAY_MS || 1200);
        this.bigBrainAmbientChunkMs = Number(process.env.PODCAST_BIG_BRAIN_AMBIENT_CHUNK_MS || 6000);
        this.bigBrainAmbientVolume = Number(process.env.PODCAST_BIG_BRAIN_AMBIENT_VOLUME || 0.28);
        this.bigBrainAmbientBeds = new Map(); // guildId -> cancellable pending ambience playback
        this.bigBrainAmbientBedBuffer = options.bigBrainAmbientBedBuffer || null;
        this.bigBrainAmbientBedPromise = null;
        this.bigBrainToolSonificationEnabled = options.bigBrainToolSonificationEnabled !== undefined
            ? Boolean(options.bigBrainToolSonificationEnabled)
            : process.env.PODCAST_BIG_BRAIN_TOOL_SONIFICATION_ENABLED !== 'false';
        this.bigBrainToolToneMs = Number(process.env.PODCAST_BIG_BRAIN_TOOL_TONE_MS || 240);
        this.bigBrainToolToneVolume = Number(process.env.PODCAST_BIG_BRAIN_TOOL_TONE_VOLUME || 0.42);
        this.bigBrainToolToneCooldownMs = Number(process.env.PODCAST_BIG_BRAIN_TOOL_TONE_COOLDOWN_MS || 450);
        this.bigBrainToolToneBuffers = new Map(); // tone key -> generated MP3
        this.bigBrainToolToneActive = new Map(); // guildId -> active cue playback
        this.bigBrainToolToneLastAt = new Map(); // guildId -> ms timestamp
        this.pendingBigBrainResponses = new Map(); // runId -> pending handoff
        this.stagedBigBrainResponses = new Map(); // guildId -> completed handoffs awaiting host integration

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
        this.wsClient.on('chatEvent', (event) => this.handleWsChatEvent(event));
        this.wsClient.on('agentEvent', (event) => this.handleWsAgentEvent(event));
        this.wsClient.on('error', (error) => console.error('[Bot] WebSocket error:', error));
        this.wsClient.on('disconnected', () => console.log('[Bot] WebSocket disconnected'));

        // Initialize ConversationBuffer for utterance batching
        this.conversationBuffer = new ConversationBuffer();
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
            if (this.debugInject && transcription && this.wsClient.isAuthenticated && this.wsClient.canInjectMessages?.()) {
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
                this.confirmParticipantActivity(guildId, utterance.userId, 'transcript');
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
            this.stopBigBrainToolTone(guildId, 'participant started speaking');
            this.stopBigBrainAmbientBed(guildId, 'participant started speaking');
            console.log(`[Bot] User ${userId} started speaking, pausing buffer flush`);
            this.markProvisionalParticipantActivity(guildId, userId, 'speaking start');
            this.conversationBuffer.setUserSpeaking(userId, true);
        });

        this.voiceManager.setSpeakingStopHandler((guildId, userId) => {
            console.log(`[Bot] User ${userId} stopped speaking`);
            this.clearProvisionalParticipantActivity(guildId, userId, 'speaking stop before confirmation');
            this.conversationBuffer.setUserSpeaking(userId, false);
        });

        this.voiceManager.setEndpointingHandler((guildId, userId, metadata = {}) => {
            if (metadata.active) {
                console.log(`[Bot] Endpoint debounce armed for ${userId} (${metadata.reason}, ${metadata.debounceMs}ms)`);
                this.confirmParticipantActivity(guildId, userId, 'endpointing');
                this.conversationBuffer.markEndpointing(userId, true);
            } else {
                this.conversationBuffer.markEndpointing(userId, false);
            }
        });

        this.voiceManager.setAsrDispatchedHandler((guildId, userId, metadata = {}) => {
            console.log(`[Bot] ASR dispatched to Fish for ${userId} (${metadata.audioBytes} bytes, ${metadata.reason})`);
            this.confirmParticipantActivity(guildId, userId, 'ASR dispatched');
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
        return this.useGatewayGenerator() || this.gatewayMirror || this.bigBrainEnabled;
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
        this.participantActivityVersion.delete(guildId);
        this.stagedBigBrainResponses?.delete?.(guildId);
        this.stopBigBrainToolTone(guildId, 'idle loop stopped');
        this.stopBigBrainAmbientBed(guildId, 'idle loop stopped');
        this.clearParticipantActivityTimers(guildId);
    }

    canRunIdleDecision(guildId) {
        if (this.useGatewayGenerator()) return false;
        if (this.recordingState.get(guildId) !== this.RecordingState.RECORDING) return false;
        if (!this.lastParticipantSpeechAt.has(guildId)) return false;
        if (this.directResponseInFlight.has(guildId)) return false;

        const lastSpeechAt = this.lastParticipantSpeechAt.get(guildId);
        const handledSpeechAt = this.idleDecisionHandledSpeechAt.get(guildId) || 0;
        if (!this.hasStagedBigBrain(guildId) && Number.isFinite(lastSpeechAt) && handledSpeechAt >= lastSpeechAt) {
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

    getParticipantActivityVersion(guildId) {
        return this.participantActivityVersion?.get?.(guildId) || 0;
    }

    markParticipantActivity(guildId) {
        if (!guildId) return 0;
        if (!this.participantActivityVersion) {
            this.participantActivityVersion = new Map();
        }
        const current = this.getParticipantActivityVersion(guildId);
        const next = current + 1;
        this.participantActivityVersion.set(guildId, next);
        return next;
    }

    getParticipantActivityConfirmDelayMs() {
        return Number.isFinite(this.participantActivityConfirmDelayMs)
            ? Math.max(0, this.participantActivityConfirmDelayMs)
            : 200;
    }

    getParticipantActivityTimerMap(guildId) {
        if (!this.participantActivityTimers) {
            this.participantActivityTimers = new Map();
        }

        let timers = this.participantActivityTimers.get(guildId);
        if (!timers) {
            timers = new Map();
            this.participantActivityTimers.set(guildId, timers);
        }

        return timers;
    }

    markProvisionalParticipantActivity(guildId, userId, reason = 'speaking start') {
        if (!guildId || !userId) return;

        const timers = this.getParticipantActivityTimerMap(guildId);
        if (timers.has(userId)) {
            return;
        }

        const delayMs = this.getParticipantActivityConfirmDelayMs();
        const timer = setTimeout(() => {
            timers.delete(userId);
            if (timers.size === 0) {
                this.participantActivityTimers?.delete?.(guildId);
            }

            const floorState = this.getParticipantFloorState(guildId);
            if (floorState.activeSpeakers.includes(userId)) {
                this.markParticipantActivity(guildId);
                console.log(`[Bot] Participant activity confirmed for ${userId} after sustained ${reason} (${delayMs}ms)`);
            }
        }, delayMs);

        timers.set(userId, timer);
    }

    clearProvisionalParticipantActivity(guildId, userId, reason = 'cleared') {
        const timers = this.participantActivityTimers?.get?.(guildId);
        const timer = timers?.get?.(userId);
        if (!timer) {
            return;
        }

        clearTimeout(timer);
        timers.delete(userId);
        if (timers.size === 0) {
            this.participantActivityTimers.delete(guildId);
        }

        console.log(`[Bot] Provisional participant activity cleared for ${userId} (${reason})`);
    }

    confirmParticipantActivity(guildId, userId, reason = 'confirmed') {
        if (userId) {
            this.clearProvisionalParticipantActivity(guildId, userId, reason);
        }

        const version = this.markParticipantActivity(guildId);
        if (guildId) {
            console.log(`[Bot] Participant activity confirmed${userId ? ` for ${userId}` : ''} (${reason}); version=${version}`);
        }
        return version;
    }

    clearParticipantActivityTimers(guildId) {
        const timers = this.participantActivityTimers?.get?.(guildId);
        if (!timers) return;

        for (const timer of timers.values()) {
            clearTimeout(timer);
        }
        this.participantActivityTimers.delete(guildId);
    }

    didParticipantResumeSince(guildId, baseline) {
        if (!Number.isFinite(baseline)) {
            return false;
        }
        return this.getParticipantActivityVersion(guildId) > baseline;
    }

    getParticipantFloorState(guildId) {
        const state = this.conversationBuffer?.getState?.() || {};
        return {
            activeSpeakerCount: Number(state.activeSpeakerCount || 0),
            endpointingSpeakerCount: Number(state.endpointingSpeakerCount || 0),
            pendingAsrCount: Number(state.pendingAsrCount || 0),
            activeSpeakers: Array.isArray(state.activeSpeakers) ? state.activeSpeakers : []
        };
    }

    hasCurrentParticipantFloor(guildId) {
        const floorState = this.getParticipantFloorState(guildId);
        return (
            floorState.activeSpeakerCount > 0 ||
            floorState.endpointingSpeakerCount > 0 ||
            floorState.pendingAsrCount > 0
        );
    }

    async waitForParticipantFloorToSettle(guildId, timeoutMs = this.getParticipantActivityConfirmDelayMs() + 25) {
        if (!this.hasCurrentParticipantFloor(guildId)) {
            return true;
        }

        const startedAt = Date.now();
        while (Date.now() - startedAt < timeoutMs) {
            await new Promise(resolve => setTimeout(resolve, 25));
            if (!this.hasCurrentParticipantFloor(guildId)) {
                return true;
            }
        }

        return !this.hasCurrentParticipantFloor(guildId);
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
            const participantActivityBaseline = this.getParticipantActivityVersion(guildId);
            this.markIdleDecisionHandled(guildId, lastSpeechAt);

            console.log(`[Bot] Idle decision check after ${Math.round(idleSeconds)}s without participant speech`);
            const response = await this.podcastGenerator.generate({
                transcript: '',
                idleCheck: true,
                idleSeconds,
                stagedBigBrain: this.getStagedBigBrainForGenerator(guildId),
                remember: false
            });

            if (!response.shouldRespond) {
                console.log(`[Bot] Idle generator chose silence`);
                return;
            }

            if (!this.canRunIdleDecision(guildId)) {
                console.log('[Bot] Idle generator response discarded because live state changed');
                return;
            }

            const playbackResult = await this.speakDirectGeneratorResponse(guildId, response, {
                source: 'idle',
                playFiller: false,
                rememberAssistant: true,
                participantActivityBaseline
            });
            const finalResponse = playbackResult?.finalResponse || response;
            if (playbackResult?.played && finalResponse.bigBrain?.requested) {
                await this.dispatchBigBrainTurn(guildId, finalResponse, {
                    source: 'idle',
                    transcript: '',
                    participantActivityBaseline: this.getParticipantActivityVersion(guildId)
                });
            }
            this.consumeStagedBigBrainFromResponse(guildId, finalResponse);
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
        const isAsyncIter = text != null
            && typeof text !== 'string'
            && !Buffer.isBuffer(text)
            && typeof text[Symbol.asyncIterator] === 'function';
        const textLength = isAsyncIter ? null : String(text || '').length;

        if (this.voiceProvider.isStreamingEnabled(options)) {
            const label = isAsyncIter ? 'live text stream' : `${textLength} chars`;
            console.log(`[Bot] TTS function called (Fish WS streaming, ${label})`);
            const textChunks = isAsyncIter ? text : this.singleTextChunk(text);
            return this.voiceProvider.synthesizeStream(textChunks, {
                ...options
            });
        }

        if (isAsyncIter) {
            // HTTP fallback can't consume an async iterable; assemble first.
            let assembled = '';
            for await (const chunk of text) assembled += chunk;
            text = assembled;
        }
        console.log(`[Bot] TTS function called (HTTP fallback, ${String(text || '').length} chars)`);
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
        let playbackStartAborted = false;

        const inputType = options.inputType
            ?? (capture.isStream ? streamTypeForLiveFormat(this.voiceProvider?.format) : undefined);

        const playback = await this.voiceManager.speakWithTiming(guildId, capture.playbackAudio, {
            ...options,
            inputType,
            onStart: (timing) => {
                if (
                    typeof options.shouldAbortPlaybackStart === 'function' &&
                    options.shouldAbortPlaybackStart(timing)
                ) {
                    playbackStartAborted = true;
                    console.log('[Bot] TTS playback stopped at start because a participant resumed before playback');
                    this.voiceManager.stopPlayback(guildId);
                    this.disposeUnusedAudio(audio);
                    this.disposeUnusedAudio(capture.playbackAudio);
                    return;
                }

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

        if (playbackStartAborted) {
            return {
                playback,
                playbackTiming,
                botAudioRecorded: false,
                ttsCompletedAt: capture.completedAt,
                abortedBeforePlayback: true
            };
        }

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
            // Get topic FIRST (before joining)
            const topic = interaction.options.getString('topic') || 'the topic at hand';

            // Speaker names auto-resolve from Discord member info inside the
            // receiver (see AudioReceiver.getSpeakerInfo).
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

            // Notify Gateway/OpenClaw when it is driving responses, mirroring is enabled,
            // or bigBrain handoff may need session context.
            if (this.wsClient.isAuthenticated && this.shouldConnectGatewayWs() && this.wsClient.canInjectMessages?.()) {
                try {
                    const PODCAST_GUIDELINES = [
                        'Respond conversationally, as if speaking out loud',
                        'No code blocks, file paths, or technical formatting',
                        'Keep responses concise and natural for spoken delivery',
                        'No markdown, bullet points, or structured formatting',
                        'Listeners hear your FULL response as voice — there is no "silent" text channel'
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

            // Notify Gateway/OpenClaw when it is driving responses, mirroring is enabled,
            // or bigBrain handoff may need session context.
            if (wasRecording && this.wsClient.isAuthenticated && this.shouldConnectGatewayWs() && this.wsClient.canInjectMessages?.()) {
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
        message += `Buffer: ${bufferCount} utterance(s) | Ready: ${bufferReady ? '✅' : '⏳'}\n`;
        
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
        this.clearParticipantActivityTimers(guildId);
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
            // Inject for UI visibility when the connected Gateway scope permits it.
            if (this.wsClient.canInjectMessages?.()) {
                await this.wsClient.injectMessage(messageText, { label: 'discord-voice' });
            }

            // Send to trigger AI response
            await this.wsClient.sendChat(messageText, {
                idempotencyKey: `discord-buffer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
            });
        } catch (error) {
            console.error('[Bot] Failed to send buffered utterances:', error);
        }
    }

    async handleDirectGeneratorFlush(guildId, utterances, transcript, wordData) {
        if (this.directResponseInFlight.has(guildId)) {
            console.log('[Bot] Direct generator flush held because a response is already in flight');
            this.conversationBuffer?.requeueUtterances?.(utterances, 'overlapping direct response');
            return;
        }

        this.directResponseInFlight.add(guildId);
        this.conversationBuffer?.setFlushHold?.('direct-response', true);
        const participantActivityBaseline = this.getParticipantActivityVersion(guildId);
        let bigBrainDispatch = null;

        try {
            const response = await this.beginGeneratorTurn({
                utterances,
                transcript,
                wordData,
                stagedBigBrain: this.getStagedBigBrainForGenerator(guildId),
                remember: false
            });

            if (!response.shouldRespond) {
                await this.waitForParticipantFloorToSettle(guildId);
                if (this.discardStaleDirectResponse(guildId, {
                    source: 'buffer',
                    participantActivityBaseline,
                    flushedUtterances: utterances
                }, 'after silent generation')) {
                    return;
                }
                let toRemember = response;
                if (response.isStreaming) {
                    try { toRemember = await response.completed; } catch {}
                }
                this.podcastGenerator.rememberTurn?.(transcript, toRemember);
                console.log(`[Bot] Direct generator chose silence`);
                return;
            }

            const playbackResult = await this.speakDirectGeneratorResponse(guildId, response, {
                source: 'buffer',
                playFiller: true,
                participantActivityBaseline,
                flushedUtterances: utterances,
                rememberTranscript: transcript
            });
            const finalResponse = playbackResult?.finalResponse || response;
            if ((playbackResult?.played || playbackResult?.stale) && finalResponse.bigBrain?.requested) {
                if (playbackResult?.stale) {
                    console.log('[Bot] bigBrain request survived stale host response; dispatching without spoken stall');
                }
                bigBrainDispatch = {
                    response: finalResponse,
                    options: {
                        source: playbackResult?.stale ? 'buffer-stale' : 'buffer',
                        transcript,
                        utterances,
                        wordData,
                        participantActivityBaseline: this.getParticipantActivityVersion(guildId),
                        stallSpoken: playbackResult?.played === true
                    }
                };
            }
            if (playbackResult?.played) {
                this.consumeStagedBigBrainFromResponse(guildId, finalResponse);
            }
        } catch (error) {
            console.error('[Bot] Direct generator failed:', error);
            await this.waitForParticipantFloorToSettle(guildId);
            if (this.discardStaleDirectResponse(guildId, {
                source: 'buffer',
                participantActivityBaseline,
                flushedUtterances: utterances
            }, 'after generator failure')) {
                return;
            }
            const lastSpeaker = utterances[utterances.length - 1]?.speaker || 'there';
            await this.fallbackResponse(guildId, lastSpeaker, {
                error,
                rememberTranscript: transcript,
                source: 'fallback',
                participantActivityBaseline,
                flushedUtterances: utterances
            });
        } finally {
            this.directResponseInFlight.delete(guildId);
            this.conversationBuffer?.setFlushHold?.('direct-response', false);
        }

        if (bigBrainDispatch) {
            await this.dispatchBigBrainTurn(
                guildId,
                bigBrainDispatch.response,
                bigBrainDispatch.options
            );
        }
    }

    discardStaleDirectResponse(guildId, options = {}, stage = 'before playback') {
        const participantResumed = this.didParticipantResumeSince(guildId, options.participantActivityBaseline);
        const currentFloor = options.includeCurrentFloor ? this.hasCurrentParticipantFloor(guildId) : false;

        if (!participantResumed && !currentFloor) {
            return false;
        }

        const source = options.source || 'buffer';
        const reason = participantResumed
            ? 'a participant resumed before playback'
            : 'a participant is currently taking the floor';
        console.log(`[Bot] Direct generator response (${source}) discarded ${stage} because ${reason}`);

        if (Array.isArray(options.flushedUtterances) && options.flushedUtterances.length > 0) {
            this.conversationBuffer?.requeueUtterances?.(
                options.flushedUtterances,
                'participant resumed before host playback'
            );
        }

        return true;
    }

    disposeUnusedAudio(audio) {
        if (this.isReadableAudio(audio) && typeof audio.destroy === 'function') {
            audio.destroy();
        }
    }

    /**
     * Begin a generator turn, picking the streaming or non-streaming path
     * based on PODCAST_GENERATOR_STREAMING. Streaming returns the same
     * fields as generate() (shouldRespond, speech, bigBrain, etc.) plus
     * speechStream + completed handles for piping into Fish TTS while the
     * LLM is still emitting tokens. On streaming setup error we fall back
     * to the non-streaming generate() so failover and rate-limit handling
     * still work.
     */
    async beginGeneratorTurn(input = {}) {
        const useStreaming = process.env.PODCAST_GENERATOR_STREAMING === 'true';
        if (!useStreaming) {
            return this.podcastGenerator.generate(input);
        }

        let stream;
        try {
            stream = await this.podcastGenerator.generateStreaming(input);
        } catch (err) {
            console.warn(`[Bot] Streaming generator setup failed, falling back: ${err.message}`);
            return this.podcastGenerator.generate(input);
        }

        let shouldRespond;
        try {
            shouldRespond = await stream.shouldRespond;
        } catch (err) {
            console.warn(`[Bot] Streaming generator errored before shouldRespond, falling back: ${err.message}`);
            return this.podcastGenerator.generate(input);
        }

        return {
            shouldRespond,
            speech: '',
            text: '',
            bigBrain: { requested: false, reason: '' },
            speechStream: stream.speechStream,
            completed: stream.completed,
            isStreaming: true
        };
    }

    isBigBrainAvailable() {
        return Boolean(this.bigBrainEnabled && this.wsClient?.isAuthenticated);
    }

    hasStagedBigBrain(guildId) {
        return (this.stagedBigBrainResponses?.get?.(guildId) || []).length > 0;
    }

    getStagedBigBrainForGenerator(guildId) {
        return (this.stagedBigBrainResponses?.get?.(guildId) || [])
            .slice(0, 3)
            .map((item) => ({
                runId: item.runId,
                reason: item.reason,
                transcript: item.transcript,
                answer: item.answer,
                requestedAt: item.requestedAt,
                answeredAt: item.answeredAt
            }));
    }

    getBigBrainAmbientStartDelayMs() {
        const delayMs = Number(this.bigBrainAmbientStartDelayMs);
        return Number.isFinite(delayMs) ? Math.max(0, delayMs) : 1200;
    }

    getBigBrainAmbientChunkDurationMs() {
        const durationMs = Number(this.bigBrainAmbientChunkMs);
        return Number.isFinite(durationMs)
            ? Math.max(2000, Math.min(30000, durationMs))
            : 6000;
    }

    getBigBrainAmbientVolume() {
        const volume = Number(this.bigBrainAmbientVolume);
        return Number.isFinite(volume)
            ? Math.max(0, Math.min(1, volume))
            : 0.28;
    }

    async getBigBrainAmbientBedBuffer() {
        if (Buffer.isBuffer(this.bigBrainAmbientBedBuffer) && this.bigBrainAmbientBedBuffer.length > 0) {
            return this.bigBrainAmbientBedBuffer;
        }

        const cachedPath = path.join(__dirname, 'cached-audio', 'bigbrain-ambient-bed.mp3');
        if (fs.existsSync(cachedPath)) {
            this.bigBrainAmbientBedBuffer = fs.readFileSync(cachedPath);
            console.log(`[Bot] Loaded bigBrain ambient bed: ${cachedPath}`);
            return this.bigBrainAmbientBedBuffer;
        }

        if (!this.bigBrainAmbientBedPromise) {
            this.bigBrainAmbientBedPromise = this.generateBigBrainAmbientBedBuffer()
                .then((buffer) => {
                    this.bigBrainAmbientBedBuffer = buffer;
                    return buffer;
                })
                .finally(() => {
                    this.bigBrainAmbientBedPromise = null;
                });
        }

        return this.bigBrainAmbientBedPromise;
    }

    generateBigBrainAmbientBedBuffer() {
        const durationSeconds = Math.max(2, Math.min(30, Math.round(this.getBigBrainAmbientChunkDurationMs() / 1000)));
        const expression = `aevalsrc=0.018*sin(2*PI*196*t)+0.012*sin(2*PI*247*t)+0.009*sin(2*PI*330*t):s=48000:d=${durationSeconds}`;
        const args = [
            '-hide_banner',
            '-loglevel', 'error',
            '-f', 'lavfi',
            '-i', expression,
            '-ac', '2',
            '-ar', '48000',
            '-codec:a', 'libmp3lame',
            '-b:a', '96k',
            '-f', 'mp3',
            'pipe:1'
        ];

        return new Promise((resolve, reject) => {
            const ffmpeg = spawn('ffmpeg', args, { windowsHide: true });
            const chunks = [];
            let stderr = '';
            let settled = false;

            const finish = (error, buffer) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                if (error) {
                    reject(error);
                } else {
                    resolve(buffer);
                }
            };

            const timeout = setTimeout(() => {
                ffmpeg.kill('SIGKILL');
                finish(new Error('ffmpeg timed out generating bigBrain ambient bed'));
            }, 15000);

            ffmpeg.stdout.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
            ffmpeg.stderr.on('data', (chunk) => {
                stderr += chunk.toString();
            });
            ffmpeg.on('error', (error) => finish(error));
            ffmpeg.on('close', (code) => {
                if (code !== 0) {
                    finish(new Error(`ffmpeg ambient bed generation failed (${code}): ${stderr.trim()}`));
                    return;
                }

                const buffer = Buffer.concat(chunks);
                if (!buffer.length) {
                    finish(new Error('ffmpeg generated an empty bigBrain ambient bed'));
                    return;
                }

                console.log(`[Bot] Generated bigBrain ambient bed (${buffer.length} bytes, ${durationSeconds}s)`);
                finish(null, buffer);
            });
        });
    }

    isBigBrainAmbientBedCurrent(guildId, bed) {
        return Boolean(
            bed &&
            !bed.stopped &&
            this.bigBrainAmbientBeds?.get?.(guildId) === bed &&
            this.pendingBigBrainResponses?.has?.(bed.runId)
        );
    }

    startBigBrainAmbientBed(guildId, pending) {
        if (!this.bigBrainAmbientEnabled || !guildId || !pending?.runId) {
            return false;
        }
        if (this.recordingState.get(guildId) !== this.RecordingState.RECORDING) {
            return false;
        }

        this.stopBigBrainAmbientBed(guildId, 'replaced by new bigBrain run');

        const bed = {
            guildId,
            runId: pending.runId,
            stopped: false,
            timer: null,
            playbackActive: false,
            chunksPlayed: 0
        };
        this.bigBrainAmbientBeds.set(guildId, bed);

        const delayMs = this.getBigBrainAmbientStartDelayMs();
        const startPlayback = () => {
            bed.timer = null;
            this.playBigBrainAmbientChunk(guildId, bed).catch((error) => {
                console.warn(`[Bot] bigBrain ambient bed failed runId=${bed.runId}: ${error.message}`);
                this.stopBigBrainAmbientBed(guildId, 'ambient playback failed', { runId: bed.runId });
            });
        };

        if (delayMs > 0) {
            bed.timer = setTimeout(startPlayback, delayMs);
            if (typeof bed.timer.unref === 'function') {
                bed.timer.unref();
            }
        } else {
            startPlayback();
        }

        console.log(`[Bot] bigBrain ambient bed armed runId=${pending.runId}, delayMs=${delayMs}`);
        return true;
    }

    async playBigBrainAmbientChunk(guildId, bed) {
        if (!this.isBigBrainAmbientBedCurrent(guildId, bed)) {
            return;
        }
        if (this.recordingState.get(guildId) !== this.RecordingState.RECORDING) {
            this.stopBigBrainAmbientBed(guildId, 'recording ended', { runId: bed.runId });
            return;
        }
        if (this.hasCurrentParticipantFloor(guildId)) {
            this.stopBigBrainAmbientBed(guildId, 'participant floor active', { runId: bed.runId });
            return;
        }

        const playback = this.voiceManager?.getPlaybackStatus?.(guildId) || { isPlaying: false, queueLength: 0 };
        if (playback.isPlaying || playback.queueLength > 0) {
            bed.timer = setTimeout(() => {
                bed.timer = null;
                this.playBigBrainAmbientChunk(guildId, bed).catch((error) => {
                    console.warn(`[Bot] bigBrain ambient bed retry failed runId=${bed.runId}: ${error.message}`);
                    this.stopBigBrainAmbientBed(guildId, 'ambient retry failed', { runId: bed.runId });
                });
            }, 500);
            if (typeof bed.timer.unref === 'function') {
                bed.timer.unref();
            }
            return;
        }

        const buffer = await this.getBigBrainAmbientBedBuffer();
        if (!this.isBigBrainAmbientBedCurrent(guildId, bed)) {
            return;
        }

        let playbackStartedMs = null;
        const chunkNumber = bed.chunksPlayed + 1;
        bed.playbackActive = true;

        try {
            const ambientPlayback = await this.voiceManager.speakWithTiming(guildId, buffer, {
                inputType: StreamType.Arbitrary,
                volume: this.getBigBrainAmbientVolume(),
                onStart: (timing) => {
                    const parsed = Date.parse(timing.playbackStartedAt);
                    playbackStartedMs = Number.isNaN(parsed) ? null : parsed;
                    console.log(`[Bot] bigBrain ambient bed started runId=${bed.runId}, chunk=${chunkNumber}`);
                }
            });

            await ambientPlayback.finished;
        } finally {
            bed.playbackActive = false;
        }

        if (!this.isBigBrainAmbientBedCurrent(guildId, bed)) {
            return;
        }

        if (Number.isFinite(playbackStartedMs)) {
            this.voiceManager.addBotAudioToRecording(guildId, buffer, {
                startTime: playbackStartedMs,
                volume: this.getBigBrainAmbientVolume()
            });
        }
        bed.chunksPlayed++;

        bed.timer = setTimeout(() => {
            bed.timer = null;
            this.playBigBrainAmbientChunk(guildId, bed).catch((error) => {
                console.warn(`[Bot] bigBrain ambient bed loop failed runId=${bed.runId}: ${error.message}`);
                this.stopBigBrainAmbientBed(guildId, 'ambient loop failed', { runId: bed.runId });
            });
        }, 100);
        if (typeof bed.timer.unref === 'function') {
            bed.timer.unref();
        }
    }

    stopBigBrainAmbientBed(guildId, reason = 'stopped', options = {}) {
        const bed = this.bigBrainAmbientBeds?.get?.(guildId);
        if (!bed) {
            return false;
        }
        if (options.runId && bed.runId !== options.runId) {
            return false;
        }

        bed.stopped = true;
        if (bed.timer) {
            clearTimeout(bed.timer);
            bed.timer = null;
        }
        this.bigBrainAmbientBeds.delete(guildId);

        if (bed.playbackActive) {
            this.voiceManager?.stopPlayback?.(guildId);
        }

        console.log(`[Bot] bigBrain ambient bed stopped runId=${bed.runId} (${reason})`);
        return true;
    }

    getBigBrainToolToneDurationMs() {
        const durationMs = Number(this.bigBrainToolToneMs);
        return Number.isFinite(durationMs)
            ? Math.max(80, Math.min(1200, durationMs))
            : 240;
    }

    getBigBrainToolToneVolume() {
        const volume = Number(this.bigBrainToolToneVolume);
        return Number.isFinite(volume)
            ? Math.max(0, Math.min(1, volume))
            : 0.42;
    }

    getBigBrainToolToneCooldownMs() {
        const cooldownMs = Number(this.bigBrainToolToneCooldownMs);
        return Number.isFinite(cooldownMs)
            ? Math.max(0, cooldownMs)
            : 450;
    }

    getPentatonicFrequency(index) {
        const scale = [261.63, 293.66, 329.63, 392.00, 440.00, 523.25, 587.33, 659.25];
        const normalized = Math.abs(Math.trunc(Number(index) || 0)) % scale.length;
        return scale[normalized];
    }

    hashToolToneName(name) {
        const text = String(name || 'tool');
        let hash = 0;
        for (let i = 0; i < text.length; i++) {
            hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
        }
        return Math.abs(hash);
    }

    resolveBigBrainToolTone(event) {
        if (!this.bigBrainToolSonificationEnabled || event?.stream !== 'tool') {
            return null;
        }

        const data = event.data && typeof event.data === 'object' ? event.data : {};
        const phase = String(data.phase || '').trim().toLowerCase();
        if (!['start', 'result', 'end', 'error'].includes(phase)) {
            return null;
        }

        const toolName = String(data.name || data.toolName || data.tool || 'tool').trim() || 'tool';
        const isError = phase === 'error' || data.isError === true;
        const baseIndex = this.hashToolToneName(toolName) % 5;
        const phaseOffset = phase === 'start' ? 0 : 2;
        const scaleIndex = isError ? 1 : baseIndex + phaseOffset;

        return {
            key: `${phase}:${isError ? 'error' : 'ok'}:${scaleIndex}`,
            frequency: this.getPentatonicFrequency(scaleIndex),
            phase,
            isError,
            toolName,
            toolCallId: String(data.toolCallId || data.id || '')
        };
    }

    async getBigBrainToolToneBuffer(tone) {
        const key = tone.key;
        const cached = this.bigBrainToolToneBuffers?.get?.(key);
        if (Buffer.isBuffer(cached) && cached.length > 0) {
            return cached;
        }

        const buffer = await this.generateBigBrainToolToneBuffer(tone);
        if (!this.bigBrainToolToneBuffers) {
            this.bigBrainToolToneBuffers = new Map();
        }
        this.bigBrainToolToneBuffers.set(key, buffer);
        return buffer;
    }

    generateBigBrainToolToneBuffer(tone) {
        const durationSeconds = this.getBigBrainToolToneDurationMs() / 1000;
        const fadeOutStart = Math.max(0, durationSeconds - 0.05);
        const args = [
            '-hide_banner',
            '-loglevel', 'error',
            '-f', 'lavfi',
            '-i', `sine=frequency=${tone.frequency}:duration=${durationSeconds}:sample_rate=48000`,
            '-filter:a', `afade=t=in:st=0:d=0.02,afade=t=out:st=${fadeOutStart}:d=0.05`,
            '-ac', '2',
            '-ar', '48000',
            '-codec:a', 'libmp3lame',
            '-b:a', '96k',
            '-f', 'mp3',
            'pipe:1'
        ];

        return new Promise((resolve, reject) => {
            const ffmpeg = spawn('ffmpeg', args, { windowsHide: true });
            const chunks = [];
            let stderr = '';
            let settled = false;

            const finish = (error, buffer) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                if (error) {
                    reject(error);
                } else {
                    resolve(buffer);
                }
            };

            const timeout = setTimeout(() => {
                ffmpeg.kill('SIGKILL');
                finish(new Error('ffmpeg timed out generating bigBrain tool tone'));
            }, 10000);

            ffmpeg.stdout.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
            ffmpeg.stderr.on('data', (chunk) => {
                stderr += chunk.toString();
            });
            ffmpeg.on('error', (error) => finish(error));
            ffmpeg.on('close', (code) => {
                if (code !== 0) {
                    finish(new Error(`ffmpeg tool tone generation failed (${code}): ${stderr.trim()}`));
                    return;
                }

                const buffer = Buffer.concat(chunks);
                if (!buffer.length) {
                    finish(new Error('ffmpeg generated an empty bigBrain tool tone'));
                    return;
                }

                finish(null, buffer);
            });
        });
    }

    sonifyBigBrainToolEvent(guildId, pending, event) {
        const tone = this.resolveBigBrainToolTone(event);
        if (!tone || !pending?.runId) {
            return false;
        }
        if (this.recordingState.get(guildId) !== this.RecordingState.RECORDING) {
            return false;
        }
        if (this.hasCurrentParticipantFloor(guildId)) {
            return false;
        }
        if (this.bigBrainToolToneActive?.has?.(guildId)) {
            return false;
        }

        const now = Date.now();
        const cooldownMs = this.getBigBrainToolToneCooldownMs();
        const lastAt = this.bigBrainToolToneLastAt?.get?.(guildId) || 0;
        if (now - lastAt < cooldownMs) {
            return false;
        }
        if (!this.bigBrainToolToneLastAt) {
            this.bigBrainToolToneLastAt = new Map();
        }
        this.bigBrainToolToneLastAt.set(guildId, now);

        this.playBigBrainToolTone(guildId, pending, tone).catch((error) => {
            console.warn(`[Bot] bigBrain tool tone failed runId=${pending.runId}: ${error.message}`);
            this.stopBigBrainToolTone(guildId, 'tool tone failed', { runId: pending.runId });
        });
        return true;
    }

    async playBigBrainToolTone(guildId, pending, tone) {
        if (!this.pendingBigBrainResponses?.has?.(pending.runId)) {
            return;
        }

        this.stopBigBrainAmbientBed(guildId, 'tool tone starting', { runId: pending.runId });

        const state = {
            guildId,
            runId: pending.runId,
            stopped: false,
            playbackActive: false,
            tone
        };
        if (!this.bigBrainToolToneActive) {
            this.bigBrainToolToneActive = new Map();
        }
        this.bigBrainToolToneActive.set(guildId, state);

        let playbackStartedMs = null;
        try {
            const buffer = await this.getBigBrainToolToneBuffer(tone);
            if (state.stopped || !this.pendingBigBrainResponses?.has?.(pending.runId)) {
                return;
            }

            state.playbackActive = true;
            const playback = await this.voiceManager.speakWithTiming(guildId, buffer, {
                inputType: StreamType.Arbitrary,
                volume: this.getBigBrainToolToneVolume(),
                onStart: (timing) => {
                    const parsed = Date.parse(timing.playbackStartedAt);
                    playbackStartedMs = Number.isNaN(parsed) ? null : parsed;
                    console.log(`[Bot] bigBrain tool tone ${tone.phase} runId=${pending.runId}, tool=${tone.toolName}`);
                }
            });
            await playback.finished;
            state.playbackActive = false;

            if (state.stopped || !this.pendingBigBrainResponses?.has?.(pending.runId)) {
                return;
            }

            if (Number.isFinite(playbackStartedMs)) {
                this.voiceManager.addBotAudioToRecording(guildId, buffer, {
                    startTime: playbackStartedMs,
                    volume: this.getBigBrainToolToneVolume()
                });
            }
        } finally {
            state.playbackActive = false;
            if (this.bigBrainToolToneActive?.get?.(guildId) === state) {
                this.bigBrainToolToneActive.delete(guildId);
            }
        }

        if (!state.stopped && this.pendingBigBrainResponses?.has?.(pending.runId)) {
            this.startBigBrainAmbientBed(guildId, pending);
        }
    }

    stopBigBrainToolTone(guildId, reason = 'stopped', options = {}) {
        const state = this.bigBrainToolToneActive?.get?.(guildId);
        if (!state) {
            return false;
        }
        if (options.runId && state.runId !== options.runId) {
            return false;
        }

        state.stopped = true;
        this.bigBrainToolToneActive.delete(guildId);
        if (state.playbackActive) {
            this.voiceManager?.stopPlayback?.(guildId);
        }

        console.log(`[Bot] bigBrain tool tone stopped runId=${state.runId} (${reason})`);
        return true;
    }

    stageBigBrainResponse(guildId, pending, answer) {
        if (!guildId || !answer) {
            return null;
        }
        if (!this.stagedBigBrainResponses) {
            this.stagedBigBrainResponses = new Map();
        }

        const staged = {
            runId: pending.runId,
            reason: pending.reason,
            transcript: pending.transcript || '',
            answer,
            requestedAt: pending.requestedAt,
            answeredAt: new Date().toISOString()
        };
        const existing = this.stagedBigBrainResponses.get(guildId) || [];
        const withoutDuplicate = existing.filter((item) => item.runId !== staged.runId);
        withoutDuplicate.push(staged);
        this.stagedBigBrainResponses.set(guildId, withoutDuplicate.slice(-3));
        this.stopBigBrainToolTone(guildId, 'bigBrain response staged', { runId: staged.runId });
        this.stopBigBrainAmbientBed(guildId, 'bigBrain response staged', { runId: staged.runId });
        console.log(`[Bot] bigBrain response staged runId=${staged.runId}; stagedCount=${this.stagedBigBrainResponses.get(guildId).length}`);
        return staged;
    }

    consumeStagedBigBrainFromResponse(guildId, response = {}) {
        const consumedRunId = String(response?.bigBrain?.consumedRunId || '').trim();
        if (!consumedRunId) {
            return false;
        }

        const staged = this.stagedBigBrainResponses?.get?.(guildId) || [];
        const next = staged.filter((item) => item.runId !== consumedRunId);
        if (next.length === staged.length) {
            console.warn(`[Bot] Generator reported unknown staged bigBrain consumption: ${consumedRunId}`);
            return false;
        }

        if (next.length > 0) {
            this.stagedBigBrainResponses.set(guildId, next);
        } else {
            this.stagedBigBrainResponses.delete(guildId);
        }
        console.log(`[Bot] Staged bigBrain consumed by generator: runId=${consumedRunId}`);
        return true;
    }

    buildBigBrainPrompt(response, options = {}) {
        const transcript = String(options.transcript || '').trim()
            || this.podcastGenerator?.formatUtterances?.(options.utterances || [])
            || '(no transcript text captured)';
        const reason = String(response?.bigBrain?.reason || '').trim()
            || 'The small live host model requested deeper help.';
        const source = options.source || 'buffer';
        const lines = [
            '[Podcast bigBrain request]',
            '',
            'You are Open Claw helping Alpha-Clawd during a live Discord voice podcast.',
            options.stallSpoken === false
                ? 'The small live host model tried to speak a brief stall, but it was discarded because the guest resumed. Your response will still be staged and handed back to that model so it can integrate the answer when the live conversation is ready.'
                : 'The small live host model has already spoken a brief stall to the room. Your response will be staged and handed back to that model so it can integrate the answer when the live conversation is ready.',
            '',
            'Answer the guest request using any server memory, files, tools, web access, or runtime context available to you. If you cannot verify something, say that plainly.',
            'Return only the concise spoken answer. No markdown, bullets, code blocks, URLs unless essential, file paths unless asked, or stage directions.',
            'Aim for one to three natural sentences unless the guest explicitly asked for a longer result.',
            '',
            `Trigger source: ${source}`,
            `Small-model handoff reason: ${reason}`,
            '',
            'Live transcript that triggered the handoff:',
            transcript
        ];

        const wordData = String(options.wordData || '').trim();
        if (wordData) {
            lines.push('', 'STT confidence context:', wordData);
        }

        return lines.join('\n');
    }

    buildBigBrainGatewayMessage(prompt) {
        const message = String(prompt || '').trim();
        const directives = [];
        const thinking = String(this.bigBrainThinking || '').trim();

        if (thinking) {
            directives.push(`/think ${thinking}`);
        }
        if (this.bigBrainToolSonificationEnabled !== false) {
            directives.push('/verbose on');
        }

        if (!message || directives.length === 0) {
            return message;
        }
        return `${directives.join(' ')}\n\n${message}`;
    }

    async dispatchBigBrainTurn(guildId, response, options = {}) {
        if (!response?.bigBrain?.requested) {
            return { dispatched: false, reason: 'not_requested' };
        }

        const reason = String(response.bigBrain.reason || '').trim();
        if (!this.bigBrainEnabled) {
            console.log(`[Bot] bigBrain requested but disabled. reason="${reason}"`);
            return { dispatched: false, reason: 'disabled' };
        }

        if (!this.wsClient?.isAuthenticated) {
            console.warn(`[Bot] bigBrain requested but Gateway WebSocket is not authenticated. reason="${reason}"`);
            return { dispatched: false, reason: 'gateway_unavailable' };
        }

        const existing = Array.from(this.pendingBigBrainResponses.values())
            .find((pending) => pending.guildId === guildId);
        if (existing) {
            console.warn(`[Bot] bigBrain request skipped because run ${existing.runId} is still pending`);
            return { dispatched: false, reason: 'already_pending', runId: existing.runId };
        }

        const runId = `discord-bigbrain-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const timeoutMs = Number.isFinite(this.bigBrainTimeoutMs)
            ? Math.max(1000, this.bigBrainTimeoutMs)
            : 180000;
        const prompt = this.buildBigBrainGatewayMessage(this.buildBigBrainPrompt(response, options));
        const pending = {
            guildId,
            runId,
            reason,
            transcript: options.transcript || '',
            requestedAt: new Date().toISOString(),
            participantActivityBaseline: Number.isFinite(options.participantActivityBaseline)
                ? options.participantActivityBaseline
                : this.getParticipantActivityVersion(guildId),
            sessionKey: this.wsClient.sessionKey,
            timeout: null
        };

        pending.timeout = setTimeout(() => {
            this.handleBigBrainTimeout(runId);
        }, timeoutMs);
        if (typeof pending.timeout.unref === 'function') {
            pending.timeout.unref();
        }

        this.pendingBigBrainResponses.set(runId, pending);

        try {
            const ack = await this.wsClient.sendChat(prompt, {
                thinking: this.bigBrainThinking,
                timeoutMs,
                idempotencyKey: runId
            });
            console.log(`[Bot] bigBrain dispatched runId=${ack?.runId || runId}, timeoutMs=${timeoutMs}, reason="${reason}"`);
            this.startBigBrainAmbientBed(guildId, pending);
            return { dispatched: true, runId };
        } catch (error) {
            console.error('[Bot] bigBrain dispatch failed:', error);
            this.cleanupPendingBigBrain(runId);
            return { dispatched: false, reason: 'dispatch_failed', error };
        }
    }

    async settleGeneratorResponse(response, context = 'completion') {
        if (!response?.isStreaming || !response.completed) {
            return response;
        }

        try {
            return await response.completed;
        } catch (err) {
            console.warn(`[Bot] Streaming generator settled with error during ${context}: ${err.message}`);
            return {
                shouldRespond: response.shouldRespond,
                speech: '',
                text: '',
                bigBrain: { requested: false, reason: '', consumedRunId: '' }
            };
        }
    }

    handleBigBrainTimeout(runId) {
        const pending = this.pendingBigBrainResponses.get(runId);
        if (!pending) {
            return;
        }

        console.warn(`[Bot] bigBrain run timed out: runId=${runId}, reason="${pending.reason}"`);
        this.wsClient?.abortChat?.(runId, { sessionKey: pending.sessionKey }).catch((error) => {
            console.warn(`[Bot] Failed to abort timed-out bigBrain run ${runId}: ${error.message}`);
        });
        this.cleanupPendingBigBrain(runId);
    }

    cleanupPendingBigBrain(runId) {
        const pending = this.pendingBigBrainResponses.get(runId);
        if (!pending) {
            return null;
        }

        if (pending.timeout) {
            clearTimeout(pending.timeout);
        }
        this.stopBigBrainToolTone(pending.guildId, 'bigBrain run cleaned up', { runId });
        this.stopBigBrainAmbientBed(pending.guildId, 'bigBrain run cleaned up', { runId });
        this.pendingBigBrainResponses.delete(runId);
        return pending;
    }

    async handleBigBrainWsResponse(response) {
        const runId = response?.runId;
        const pending = runId ? this.pendingBigBrainResponses.get(runId) : null;
        if (!pending) {
            return false;
        }

        try {
            const guildId = pending.guildId;
            if (this.recordingState.get(guildId) !== this.RecordingState.RECORDING) {
                console.log(`[Bot] Dropping bigBrain response ${runId}; recording is no longer active`);
                return true;
            }

            const text = String(response.text || '').trim();
            const speech = this.podcastGenerator?.sanitizeSpeech?.(text) || text;
            if (!speech) {
                console.warn(`[Bot] bigBrain response ${runId} had no speakable text`);
                return true;
            }

            this.stageBigBrainResponse(guildId, pending, speech);
            return true;
        } catch (error) {
            console.error('[Bot] Error handling bigBrain response:', error);
            return true;
        } finally {
            this.cleanupPendingBigBrain(runId);
        }
    }

    stageBigBrainFailure(runId, rawError, source = 'gateway') {
        const pending = runId ? this.pendingBigBrainResponses.get(runId) : null;
        if (!pending) {
            return false;
        }

        const errorText = String(rawError || 'Open Claw did not provide an error message.').trim();
        const conciseError = errorText.length > 500
            ? `${errorText.slice(0, 497)}...`
            : errorText;

        try {
            if (this.recordingState.get(pending.guildId) === this.RecordingState.RECORDING) {
                const stagedText = `Open Claw could not complete the bigBrain request. ${conciseError}`;
                this.stageBigBrainResponse(pending.guildId, pending, stagedText);
                console.warn(`[Bot] bigBrain ${source} failure staged runId=${runId}: ${conciseError}`);
            } else {
                console.warn(`[Bot] bigBrain ${source} failure for ${runId} after recording ended: ${conciseError}`);
            }
        } finally {
            this.cleanupPendingBigBrain(runId);
        }

        return true;
    }

    handleWsChatEvent(event) {
        if (this.useGatewayGenerator()) {
            return;
        }
        const pending = event?.runId ? this.pendingBigBrainResponses.get(event.runId) : null;
        if (!pending || !['error', 'aborted'].includes(event.state)) {
            return;
        }

        console.warn(`[Bot] bigBrain run ${event.runId} ended with state=${event.state}: ${event.errorMessage || event.stopReason || 'no details'}`);
        this.stageBigBrainFailure(
            event.runId,
            event.errorMessage || event.stopReason || `Gateway chat state ${event.state}`,
            'chat'
        );
    }

    handleWsAgentEvent(event) {
        if (this.useGatewayGenerator()) {
            return;
        }

        const runId = event?.runId;
        const pending = runId ? this.pendingBigBrainResponses.get(runId) : null;
        if (!runId || !pending) {
            return;
        }

        if (event.stream === 'tool') {
            this.sonifyBigBrainToolEvent(pending.guildId, pending, event);
            return;
        }

        const data = event.data && typeof event.data === 'object' ? event.data : {};
        const lifecyclePhase = event.stream === 'lifecycle' && typeof data.phase === 'string'
            ? data.phase
            : null;
        if (lifecyclePhase !== 'error') {
            return;
        }

        this.stageBigBrainFailure(
            runId,
            data.error || data.reason || 'Gateway agent lifecycle error',
            'agent'
        );
    }

    async speakDirectGeneratorResponse(guildId, response, options = {}) {
        const alreadyInFlight = this.directResponseInFlight.has(guildId);
        this.directResponseInFlight.add(guildId);
        if (!alreadyInFlight) {
            this.conversationBuffer?.setFlushHold?.('direct-response', true);
        }
        const source = options.source || 'buffer';
        this.stopBigBrainToolTone(guildId, 'host response starting');
        this.stopBigBrainAmbientBed(guildId, 'host response starting');

        try {
            const isStreaming = Boolean(response?.isStreaming && response.speechStream);
            const generatedAt = response.generatedAt || new Date().toISOString();
            const previewText = isStreaming
                ? '(streaming)'
                : `${(response.speech || '').substring(0, 50)}...`;
            console.log(`[Bot] Direct generator response (${source}): "${previewText}"`);

            await this.waitForParticipantFloorToSettle(guildId);
            if (this.discardStaleDirectResponse(guildId, options, 'after generation')) {
                return {
                    played: false,
                    stale: true,
                    finalResponse: await this.settleGeneratorResponse(response, 'stale response after generation')
                };
            }

            // Play a cached filler only after the generator decides to answer.
            if (options.playFiller !== false) {
                await this.playFillerClip(guildId);
            }

            if (this.discardStaleDirectResponse(guildId, options, 'after filler')) {
                return {
                    played: false,
                    stale: true,
                    finalResponse: await this.settleGeneratorResponse(response, 'stale response after filler')
                };
            }

            const ttsStartedAt = new Date().toISOString();
            const speechSource = isStreaming ? response.speechStream : response.speech;
            const audio = await this.synthesizeLiveTTS(speechSource, {
                voiceId: this.voiceId
            });
            const ttsSetupCompletedAt = this.isReadableAudio(audio) ? null : new Date().toISOString();

            if (this.discardStaleDirectResponse(guildId, options, 'after TTS')) {
                this.disposeUnusedAudio(audio);
                return {
                    played: false,
                    stale: true,
                    finalResponse: await this.settleGeneratorResponse(response, 'stale response after TTS')
                };
            }

            this.markIdleDecisionHandled(guildId);
            const playbackResult = await this.playTtsAndRecord(guildId, audio, {
                shouldAbortPlaybackStart: () => this.discardStaleDirectResponse(
                    guildId,
                    { ...options, includeCurrentFloor: true },
                    'at playback start'
                )
            });

            if (playbackResult.abortedBeforePlayback) {
                return {
                    played: false,
                    stale: true,
                    finalResponse: await this.settleGeneratorResponse(response, 'stale response at playback start')
                };
            }

            const playback = playbackResult.playback;
            const playbackTiming = playbackResult.playbackTiming;

            const playbackStartedAt = playbackTiming.playbackStartedAt || playback.timing.playbackStartedAt;
            const playbackEndedAt = playbackTiming.playbackEndedAt || playback.timing.playbackEndedAt;
            const playbackStartedMs = Date.parse(playbackStartedAt);
            const playbackEndedMs = Date.parse(playbackEndedAt);
            const playbackDuration = !Number.isNaN(playbackStartedMs) && !Number.isNaN(playbackEndedMs)
                ? Math.max(0, playbackEndedMs - playbackStartedMs)
                : 0;

            // For the streaming path the LLM call may not be fully done
            // when playback ends (Fish often outpaces Groq on the tail of
            // a long response). Wait for the full output so transcript +
            // history use the authoritative text and bigBrain values.
            let finalResponse = await this.settleGeneratorResponse(response, 'playback');

            const transcriptEntry = {
                speaker: 'Alpha-Clawd',
                speakerRole: 'host',
                transcription: finalResponse.speech,
                timestamp: generatedAt,
                generatedAt,
                ttsStartedAt,
                ttsCompletedAt: playbackResult.ttsCompletedAt || ttsSetupCompletedAt || playbackEndedAt,
                playbackRequestedAt: playbackTiming.playbackRequestedAt || playback.timing.playbackRequestedAt,
                playbackStartedAt,
                playbackEndedAt,
                duration: playbackDuration
            };
            if (source) {
                transcriptEntry.source = source;
            }
            const consumedBigBrainRunId = finalResponse?.bigBrain?.consumedRunId;
            if (options.bigBrainRunId || consumedBigBrainRunId) {
                transcriptEntry.bigBrainRunId = options.bigBrainRunId || consumedBigBrainRunId;
            }
            this.voiceManager.saveTranscriptEntry(guildId, transcriptEntry);

            if (typeof options.rememberTranscript === 'string') {
                this.podcastGenerator.rememberTurn?.(options.rememberTranscript, finalResponse);
            } else if (options.rememberAssistant) {
                this.podcastGenerator.rememberAssistantResponse?.(finalResponse);
            }

            console.log(`[Bot] Direct generator playback complete (${source}), starting cooldown`);
            this.conversationBuffer.startCooldown();
            return { played: true, stale: false, finalResponse };
        } finally {
            if (!alreadyInFlight) {
                this.directResponseInFlight.delete(guildId);
                this.conversationBuffer?.setFlushHold?.('direct-response', false);
            }
        }
    }

    /**
     * Fallback response when Gateway unavailable
     */
    summarizeGeneratorError(error) {
        const providerError = error?.providerError || {};
        const errorBody = error?.body?.error || error?.body || {};
        const message = String(errorBody.message || error?.message || '');
        const retryMatch = message.match(/try again in ([0-9.]+)s/i);
        const orgMatch = message.match(/organization `([^`]+)`/i);

        return {
            status: providerError.status || error?.status || null,
            code: providerError.code || errorBody.code || null,
            type: providerError.type || errorBody.type || null,
            organization: providerError.organization || (orgMatch ? orgMatch[1] : null),
            retryAfterSeconds: Number.isFinite(providerError.retryAfterSeconds)
                ? providerError.retryAfterSeconds
                : (retryMatch ? Number(retryMatch[1]) : null),
            failedApiKeySources: Array.isArray(error?.failoverSources)
                ? error.failoverSources
                : [error?.apiKeySource].filter(Boolean)
        };
    }

    buildFallbackResponseText(error) {
        const summary = this.summarizeGeneratorError(error);
        const isRateLimit = summary.status === 429 || summary.code === 'rate_limit_exceeded';
        const retryAfter = Number.isFinite(summary.retryAfterSeconds)
            ? Math.max(1, Math.ceil(summary.retryAfterSeconds))
            : null;
        const retryText = retryAfter
            ? ` Groq says to wait about ${retryAfter} second${retryAfter === 1 ? '' : 's'} before retrying.`
            : '';

        if (isRateLimit) {
            const sourceText = summary.failedApiKeySources.length > 1
                ? ' on both configured Groq keys'
                : '';
            return `I'm hitting a Groq 429 rate limit${sourceText} right now.${retryText} I may need you to ask that again in a moment.`;
        }

        if (summary.status || summary.code) {
            const codeText = [summary.status, summary.code].filter(Boolean).join(' ');
            return `I hit a generator error (${codeText}) before I could answer. I may need you to ask that again in a moment.`;
        }

        return `I hit a generator error before I could answer. I may need you to ask that again in a moment.`;
    }

    async fallbackResponse(guildId, speakerName, options = {}) {
        const generatedAt = new Date().toISOString();
        const providerError = this.summarizeGeneratorError(options.error);
        const text = this.buildFallbackResponseText(options.error);

        try {
            const ttsStartedAt = new Date().toISOString();
            const audioBuffer = await this.voiceProvider.synthesize(text, {
                voiceId: this.voiceId
            });
            const ttsCompletedAt = new Date().toISOString();

            if (this.discardStaleDirectResponse(guildId, options, 'after fallback TTS')) {
                this.disposeUnusedAudio(audioBuffer);
                return { played: false, stale: true };
            }

            this.markIdleDecisionHandled(guildId);
            const playbackResult = await this.playTtsAndRecord(guildId, audioBuffer, {
                shouldAbortPlaybackStart: () => this.discardStaleDirectResponse(
                    guildId,
                    { ...options, includeCurrentFloor: true },
                    'at fallback playback start'
                )
            });

            if (playbackResult.abortedBeforePlayback) {
                return { played: false, stale: true };
            }

            const playback = playbackResult.playback;
            const playbackTiming = playbackResult.playbackTiming || playback?.timing || {};
            const playbackStartedAt = playbackTiming.playbackStartedAt || playback?.timing?.playbackStartedAt || null;
            const playbackEndedAt = playbackTiming.playbackEndedAt || playback?.timing?.playbackEndedAt || null;
            const playbackStartedMs = Date.parse(playbackStartedAt);
            const playbackEndedMs = Date.parse(playbackEndedAt);
            const playbackDuration = !Number.isNaN(playbackStartedMs) && !Number.isNaN(playbackEndedMs)
                ? Math.max(0, playbackEndedMs - playbackStartedMs)
                : 0;

            this.voiceManager.saveTranscriptEntry(guildId, {
                speaker: 'Alpha-Clawd',
                speakerRole: 'host',
                transcription: text,
                timestamp: generatedAt,
                generatedAt,
                ttsStartedAt,
                ttsCompletedAt,
                playbackRequestedAt: playbackTiming.playbackRequestedAt || playback?.timing?.playbackRequestedAt || null,
                playbackStartedAt,
                playbackEndedAt,
                duration: playbackDuration,
                source: 'fallback',
                fallbackReason: 'generator_error',
                providerError,
                audioEvents: ['fallback_response']
            });

            if (typeof options.rememberTranscript === 'string') {
                this.podcastGenerator?.rememberTurn?.(options.rememberTranscript, {
                    shouldRespond: true,
                    speech: text,
                    bigBrain: { requested: false, reason: '' }
                });
            } else {
                this.podcastGenerator?.rememberAssistantResponse?.({
                    shouldRespond: true,
                    speech: text,
                    bigBrain: { requested: false, reason: '' }
                });
            }

            this.conversationBuffer.startCooldown();
            return { played: true, stale: false };
        } catch (error) {
            console.error('[Bot] Fallback error:', error);
            return { played: false, stale: false, error };
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

        // Connect WebSocket client when Gateway/OpenClaw is the generator,
        // when direct sessions are mirrored, or when bigBrain handoff is enabled.
        if (this.shouldConnectGatewayWs()) {
            try {
                await this.wsClient.connect();
                console.log('[Bot] WebSocket client connected and authenticated');
            } catch (error) {
                console.error('[Bot] WebSocket connection failed:', error.message);
                if (this.useGatewayGenerator()) {
                    console.warn('[Bot] Will use fallback responses');
                } else if (this.bigBrainEnabled) {
                    console.warn('[Bot] bigBrain handoff will be unavailable until Gateway reconnects');
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
            const handledBigBrain = await this.handleBigBrainWsResponse(response);
            if (!handledBigBrain) {
                console.log('[Bot] Ignoring Gateway response because direct generator mode is active');
            }
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
