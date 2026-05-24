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

const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, PermissionFlagsBits, AttachmentBuilder } = require('discord.js');
const { VoiceManager } = require('./voice-manager');
const { VoiceProvider } = require('./voice-provider');
const { GatewayBridge } = require('./gateway-bridge');
const { GatewayWsClient } = require('./gateway-ws-client');
const { ConversationBuffer, BufferState } = require('./conversation-buffer');
const { getPodcastRoot, getRecordingDir } = require('./paths');
const { PodcastGenerator } = require('./podcast-generator');
const { InternalThoughtManager } = require('./internal-thought-manager');
const { ShowRunnerManager } = require('./showrunner-manager');
const { BigBrainAwarenessSelector } = require('./bigbrain-awareness-selector');
const { buildTurnIdIntent } = require('./turn-intent');
const { ParticipantSignalProfile } = require('./participant-signal-profile');

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
        this.asrErrorNoticeLastSpokenAt = new Map(); // guildId -> ms timestamp
        this.asrErrorNoticeCooldownMs = Number(process.env.VOICE_ASR_ERROR_NOTICE_COOLDOWN_MS || 60000);
        this.participantActivityVersion = new Map(); // guildId -> monotonic counter for floor-taking changes
        this.participantActivityTimers = new Map(); // guildId -> Map<userId, timeout>
        this.participantActivityConfirmDelayMs = Number(process.env.PODCAST_PARTICIPANT_ACTIVITY_CONFIRM_MS || 200);
        this.participantSignalProfiles = new Map(); // guildId -> Map<userId, ParticipantSignalProfile>
        this.participantSignalStates = new Map(); // guildId -> Map<userId, raw VAD/evidence state>
        this.consecutiveGeneratorSilences = new Map(); // guildId -> consecutive shouldRespond=false decisions
        this.hostPlaybackState = new Map(); // guildId -> { active, startedAt, endedAt }
        this.latestParticipantTurnIdIntent = new Map(); // guildId -> deterministic turn intent for latest participant utterance
        this.awarenessTurnWaitMs = Number(process.env.PODCAST_AWARENESS_TURN_WAIT_MS ?? 200);
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
        this.bigBrainAmbientVolume = Number(process.env.PODCAST_BIG_BRAIN_AMBIENT_VOLUME || 0.56);
        this.bigBrainAmbientBeds = new Map(); // guildId -> cancellable pending ambience playback
        this.bigBrainAmbientBedBuffer = options.bigBrainAmbientBedBuffer || null;
        this.bigBrainAmbientBedPromise = null;
        this.bigBrainToolSonificationEnabled = options.bigBrainToolSonificationEnabled !== undefined
            ? Boolean(options.bigBrainToolSonificationEnabled)
            : process.env.PODCAST_BIG_BRAIN_TOOL_SONIFICATION_ENABLED !== 'false';
        this.bigBrainAgentActivitySonificationEnabled = options.bigBrainAgentActivitySonificationEnabled !== undefined
            ? Boolean(options.bigBrainAgentActivitySonificationEnabled)
            : process.env.PODCAST_BIG_BRAIN_AGENT_ACTIVITY_SONIFICATION_ENABLED !== 'false';
        this.bigBrainToolToneMs = Number(process.env.PODCAST_BIG_BRAIN_TOOL_TONE_MS || 420);
        this.bigBrainToolToneVolume = Number(process.env.PODCAST_BIG_BRAIN_TOOL_TONE_VOLUME || 0.72);
        this.bigBrainToolToneCooldownMs = Number(process.env.PODCAST_BIG_BRAIN_TOOL_TONE_COOLDOWN_MS || 450);
        this.bigBrainToolToneBuffers = new Map(); // tone key -> generated MP3
        this.bigBrainToolToneActive = new Map(); // guildId -> active cue playback
        this.bigBrainToolToneLastAt = new Map(); // guildId -> ms timestamp
        this.pendingBigBrainResponses = new Map(); // runId -> pending handoff
        this.stagedBigBrainResponses = new Map(); // guildId -> completed handoffs awaiting host integration
        this.internalThoughtsEnabled = options.internalThoughtsEnabled !== undefined
            ? Boolean(options.internalThoughtsEnabled)
            : process.env.PODCAST_INTERNAL_THOUGHTS_ENABLED === 'true';
        this.internalThoughtManager = options.internalThoughtManager || new InternalThoughtManager({
            enabled: this.internalThoughtsEnabled
        });
        this.showRunnerEnabled = options.showRunnerEnabled !== undefined
            ? Boolean(options.showRunnerEnabled)
            : process.env.PODCAST_SHOW_RUNNER_ENABLED === 'true';
        this.showRunnerManager = options.showRunnerManager || new ShowRunnerManager({
            enabled: this.showRunnerEnabled
        });
        this.bigBrainAwarenessSelectionEnabled = options.bigBrainAwarenessSelectionEnabled !== undefined
            ? Boolean(options.bigBrainAwarenessSelectionEnabled)
            : process.env.PODCAST_BIG_BRAIN_AWARENESS_SELECTION_ENABLED === 'true';
        this.bigBrainAwarenessSelector = options.bigBrainAwarenessSelector || new BigBrainAwarenessSelector();

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
            baseUrl: process.env.PODCAST_GENERATOR_BASE_URL,
            model: process.env.PODCAST_GENERATOR_MODEL,
            timeout: process.env.PODCAST_GENERATOR_TIMEOUT_MS,
            maxCompletionTokens: process.env.PODCAST_GENERATOR_MAX_TOKENS,
            maxHistoryTurns: process.env.PODCAST_GENERATOR_HISTORY_TURNS,
            voiceMode: this.voiceProvider.mode,
            fishAudioModel: this.voiceProvider.tts?.model || process.env.FISH_AUDIO_MODEL || 's2-pro'
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
                this.recordParticipantSignal(guildId, utterance.userId, 'real_transcript', utterance);
                this.confirmParticipantActivity(guildId, utterance.userId, 'transcript');
                const participantTurnIdIntent = this.buildGeneratorTurnIdIntent('participant', [utterance]);
                if (participantTurnIdIntent) {
                    this.latestParticipantTurnIdIntent.set(guildId, participantTurnIdIntent);
                }
                this.observeInternalThoughtTranscriptEntry(guildId, {
                    ...utterance,
                    speakerRole: utterance.speakerRole || 'guest',
                    source: 'participant'
                });
                this.observeShowRunnerTranscriptEntry(guildId, {
                    ...utterance,
                    speakerRole: utterance.speakerRole || 'guest',
                    source: 'participant'
                });
            } else {
                const eventType = Array.isArray(utterance.audioEvents) && utterance.audioEvents.includes('phantom')
                    ? 'phantom_utterance'
                    : 'empty_asr';
                this.recordParticipantSignal(guildId, utterance.userId, eventType, utterance);
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
                providerError: utterance.providerError,
                timestamp: utterance.timestamp || Date.now()
            });
            this.clearCompletedParticipantSignalState(guildId, utterance.userId, 'ASR result handled');
        });

        // Set up speaking start/stop handlers to prevent buffer flush while user is speaking
        this.voiceManager.setSpeakingStartHandler((guildId, userId) => {
            this.noteRawParticipantVadStart(guildId, userId);
        });

        this.voiceManager.setSpeakingStopHandler((guildId, userId) => {
            this.noteRawParticipantVadStop(guildId, userId);
        });

        this.voiceManager.setSpeechEvidenceHandler((guildId, userId, metadata = {}) => {
            this.confirmParticipantSpeechEvidence(guildId, userId, metadata);
        });

        this.voiceManager.setEndpointingHandler((guildId, userId, metadata = {}) => {
            if (metadata.active) {
                console.log(`[Bot] Endpoint debounce armed for ${userId} (${metadata.reason}, ${metadata.debounceMs}ms)`);
                if (this.hasParticipantSpeechEvidenceConfirmed(guildId, userId)) {
                    this.markInternalThoughtEndpointing(guildId, userId, true);
                    this.conversationBuffer.markEndpointing(userId, true);
                } else {
                    console.log(`[Bot] Endpoint debounce for ${userId} is low-evidence; not granting floor authority yet`);
                }
            } else {
                this.markInternalThoughtEndpointing(guildId, userId, false);
                this.conversationBuffer.markEndpointing(userId, false);
            }
        });

        this.voiceManager.setAsrDispatchedHandler((guildId, userId, metadata = {}) => {
            console.log(`[Bot] ASR dispatched to Fish for ${userId} (${metadata.audioBytes} bytes, ${metadata.reason})`);
            if (this.hasSpeechEvidenceForFloor(guildId, userId, metadata)) {
                this.confirmParticipantSpeechEvidence(guildId, userId, {
                    ...metadata,
                    source: 'ASR dispatched'
                });
                this.markInternalThoughtAsrPending(guildId, userId, metadata);
                this.conversationBuffer.markAsrPending(userId, metadata);
            } else {
                console.log(`[Bot] ASR dispatch for ${userId} is below floor-evidence threshold; awaiting transcript before changing floor state`);
            }
        });

        this.voiceManager.setVadDiscardedHandler((guildId, userId, metadata = {}) => {
            this.recordParticipantSignal(guildId, userId, 'vad_discarded', metadata);
            this.clearUnconfirmedParticipantSignalState(guildId, userId, 'discarded VAD flap');
        });

        this.voiceManager.setSpeechEvidenceFrameThresholdProvider((guildId, userId, stats = {}, metadata = {}) => {
            return this.getSpeechEvidenceFrameThreshold(guildId, userId, stats, metadata);
        });

        this.voiceManager.setAsrCandidateFrameThresholdProvider((guildId, userId, stats = {}, metadata = {}) => {
            return this.getAsrCandidateFrameThreshold(guildId, userId, stats, metadata);
        });

        this.voiceManager.setAsrErrorHandler((guildId, userId, metadata = {}) => {
            this.handleAsrError(guildId, userId, metadata).catch((error) => {
                console.error('[Bot] ASR error notice failed:', error);
            });
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

    startInternalThoughtSession(guildId, recordingInfo = {}) {
        if (!this.internalThoughtsEnabled || !this.internalThoughtManager?.startSession) {
            return null;
        }

        try {
            return this.internalThoughtManager.startSession(guildId, {
                recordingPath: recordingInfo.recordingPath,
                startedAt: recordingInfo.startedAt
            });
        } catch (error) {
            console.warn(`[Bot] Failed to start internal thought session: ${error.message}`);
            return null;
        }
    }

    startShowRunnerSession(guildId, recordingInfo = {}, topic = '') {
        if (!this.showRunnerEnabled || !this.showRunnerManager?.startSession) {
            return null;
        }

        try {
            return this.showRunnerManager.startSession(guildId, {
                recordingPath: recordingInfo.recordingPath,
                startedAt: recordingInfo.startedAt,
                topic: topic || 'general discussion',
                speakers: Object.values(this.speakerMap || {}).map(s => `${s.name} (${s.role || 'speaker'})`)
            });
        } catch (error) {
            console.warn(`[Bot] Failed to start show runner session: ${error.message}`);
            return null;
        }
    }

    async endInternalThoughtSession(guildId) {
        if (!this.internalThoughtsEnabled || !this.internalThoughtManager?.endSession) {
            return null;
        }

        try {
            return await this.internalThoughtManager.endSession(guildId);
        } catch (error) {
            console.warn(`[Bot] Failed to end internal thought session: ${error.message}`);
            return null;
        }
    }

    async endShowRunnerSession(guildId) {
        if (!this.showRunnerEnabled || !this.showRunnerManager?.endSession) {
            return null;
        }

        try {
            return await this.showRunnerManager.endSession(guildId);
        } catch (error) {
            console.warn(`[Bot] Failed to end show runner session: ${error.message}`);
            return null;
        }
    }

    observeInternalThoughtTranscriptEntry(guildId, entry = {}) {
        if (
            !this.internalThoughtsEnabled ||
            this.recordingState?.get?.(guildId) !== this.RecordingState?.RECORDING ||
            !this.internalThoughtManager?.handleTranscriptEntry
        ) {
            return null;
        }

        try {
            const result = this.internalThoughtManager.handleTranscriptEntry(guildId, entry);
            if (result && typeof result.catch === 'function') {
                result.catch((error) => {
                    console.warn(`[Bot] Internal thought transcript entry failed: ${error.message}`);
                });
            }
            return result;
        } catch (error) {
            console.warn(`[Bot] Internal thought transcript entry failed: ${error.message}`);
            return null;
        }
    }

    observeShowRunnerTranscriptEntry(guildId, entry = {}) {
        if (
            !this.showRunnerEnabled ||
            this.recordingState?.get?.(guildId) !== this.RecordingState?.RECORDING ||
            !this.showRunnerManager?.handleTranscriptEntry
        ) {
            return null;
        }

        try {
            const result = this.showRunnerManager.handleTranscriptEntry(guildId, entry);
            if (result && typeof result.catch === 'function') {
                result.catch((error) => {
                    console.warn(`[Bot] Show runner transcript entry failed: ${error.message}`);
                });
            }
            return result;
        } catch (error) {
            console.warn(`[Bot] Show runner transcript entry failed: ${error.message}`);
            return null;
        }
    }

    setInternalThoughtUserSpeaking(guildId, userId, speaking) {
        if (!this.internalThoughtsEnabled || !this.internalThoughtManager?.setUserSpeaking) {
            return null;
        }

        try {
            return this.internalThoughtManager.setUserSpeaking(guildId, userId, speaking);
        } catch (error) {
            console.warn(`[Bot] Internal thought packetization speaking update failed: ${error.message}`);
            return null;
        }
    }

    markInternalThoughtEndpointing(guildId, userId, active) {
        if (!this.internalThoughtsEnabled || !this.internalThoughtManager?.markEndpointing) {
            return null;
        }

        try {
            return this.internalThoughtManager.markEndpointing(guildId, userId, active);
        } catch (error) {
            console.warn(`[Bot] Internal thought packetization endpointing update failed: ${error.message}`);
            return null;
        }
    }

    markInternalThoughtAsrPending(guildId, userId, metadata = {}) {
        if (!this.internalThoughtsEnabled || !this.internalThoughtManager?.markAsrPending) {
            return null;
        }

        try {
            return this.internalThoughtManager.markAsrPending(guildId, userId, metadata);
        } catch (error) {
            console.warn(`[Bot] Internal thought packetization ASR update failed: ${error.message}`);
            return null;
        }
    }

    getAwarenessInjectionsForGenerator(guildId) {
        if (!this.internalThoughtsEnabled || !this.internalThoughtManager?.getActiveAwarenessInjections) {
            return [];
        }

        try {
            return this.internalThoughtManager.getActiveAwarenessInjections(guildId);
        } catch (error) {
            console.warn(`[Bot] Failed to read active awareness injections: ${error.message}`);
            return [];
        }
    }

    buildGeneratorTurnIdIntent(source, utterances = []) {
        try {
            const intent = buildTurnIdIntent(utterances, { source });
            return intent ? { ...intent, source } : null;
        } catch (error) {
            console.warn(`[Bot] Failed to build turn id intent: ${error.message}`);
            return null;
        }
    }

    getLatestParticipantTurnIdIntent(guildId) {
        return this.latestParticipantTurnIdIntent?.get?.(guildId) || null;
    }

    getAwarenessTurnWaitMs() {
        const parsed = Number(this.awarenessTurnWaitMs);
        if (!Number.isFinite(parsed)) {
            return 200;
        }
        return Math.max(0, Math.min(1000, Math.floor(parsed)));
    }

    async getAwarenessInjectionsForGeneratorTurn(guildId, turnIdIntent) {
        if (!this.internalThoughtsEnabled || !turnIdIntent?.turnId) {
            return [];
        }

        try {
            if (typeof this.internalThoughtManager?.waitForAwarenessInjectionsForTurn === 'function') {
                return await this.internalThoughtManager.waitForAwarenessInjectionsForTurn(guildId, turnIdIntent, {
                    timeoutMs: this.getAwarenessTurnWaitMs()
                });
            }
            if (typeof this.internalThoughtManager?.claimAwarenessInjectionsForTurn === 'function') {
                return this.internalThoughtManager.claimAwarenessInjectionsForTurn(guildId, turnIdIntent);
            }
            return [];
        } catch (error) {
            console.warn(`[Bot] Failed to claim awareness injections for turn: ${error.message}`);
            return [];
        }
    }

    getShowRunnerGuidanceForGenerator(guildId) {
        if (!this.showRunnerEnabled || !this.showRunnerManager?.getGuidance) {
            return null;
        }

        try {
            return this.showRunnerManager.getGuidance(guildId);
        } catch (error) {
            console.warn(`[Bot] Failed to read show runner guidance: ${error.message}`);
            return null;
        }
    }

    getGeneratorCallTiming(guildId) {
        const currentTime = new Date().toISOString();
        let currentEpisodeTimestamp = null;
        try {
            currentEpisodeTimestamp = this.internalThoughtManager?.getEpisodeTimestampForTime?.(guildId, currentTime) || null;
        } catch (error) {
            console.warn(`[Bot] Failed to resolve generator episode timestamp: ${error.message}`);
        }
        return { currentTime, currentEpisodeTimestamp };
    }

    getAwarenessShelfItemsForGenerator(guildId, options = {}) {
        if (!this.internalThoughtsEnabled || !this.internalThoughtManager?.getAwarenessShelfItemsForGenerator) {
            return [];
        }

        try {
            return this.internalThoughtManager.getAwarenessShelfItemsForGenerator(guildId, options);
        } catch (error) {
            console.warn(`[Bot] Failed to read awareness shelf items: ${error.message}`);
            return [];
        }
    }

    formatAwarenessInjectionsForTranscript(items = []) {
        return (Array.isArray(items) ? items : [])
            .map((item) => {
                const awarenessInjection = typeof item === 'string'
                    ? item
                    : item?.awarenessInjection || item?.text || '';
                return {
                    id: String(item?.id || '').trim(),
                    packetId: String(item?.packetId || '').trim(),
                    createdAt: item?.createdAt || null,
                    awarenessInjection: String(awarenessInjection).trim(),
                    reason: String(item?.reason || '').trim(),
                    turnIdIntent: item?.turnIdIntent || null
                };
            })
            .filter((item) => item.awarenessInjection);
    }

    formatAwarenessShelfItemsForTranscript(items = []) {
        return (Array.isArray(items) ? items : [])
            .map((item) => ({
                id: String(item?.id || '').trim(),
                text: String(item?.text || item?.awareness || item?.awarenessInjection || '').trim(),
                reason: String(item?.reason || '').trim(),
                topicAnchors: Array.isArray(item?.topicAnchors)
                    ? item.topicAnchors.map((anchor) => String(anchor || '').trim()).filter(Boolean)
                    : [],
                createdAt: item?.createdAt || null,
                updatedAt: item?.updatedAt || null,
                originTimestamp: item?.originTimestamp || null,
                originEpisodeTimestamp: item?.originEpisodeTimestamp || null,
                originEpisodeOffsetMs: Number.isFinite(Number(item?.originEpisodeOffsetMs))
                    ? Number(item.originEpisodeOffsetMs)
                    : null,
                expiresAfterTurns: Number.isFinite(Number(item?.expiresAfterTurns))
                    ? Number(item.expiresAfterTurns)
                    : null,
                presentedCount: Number.isFinite(Number(item?.presentedCount))
                    ? Number(item.presentedCount)
                    : 0,
                remainingTurns: Number.isFinite(Number(item?.remainingTurns))
                    ? Number(item.remainingTurns)
                    : null
            }))
            .filter((item) => item.text);
    }

    shouldInjectRecentInternalThoughts(transcript = '', utterances = []) {
        const utteranceText = Array.isArray(utterances)
            ? utterances
                .map((utterance) => `${utterance?.speaker || ''}: ${utterance?.transcription || utterance?.text || ''}`)
                .join('\n')
            : '';
        const text = [transcript, utteranceText].filter(Boolean).join('\n');
        if (!text.trim()) {
            return false;
        }

        return /\b(?:introspection|introspective|metacognition|metacognitive)\b/i.test(text) ||
            /\bself[-\s]?(?:knowledge|awareness|understanding|model)\b/i.test(text) ||
            /\b(?:internal|inner|private)\s+(?:thoughts?|monologue|awareness|state|states|life)\b/i.test(text) ||
            /\bchain[-\s]?of[-\s]?thought\b/i.test(text) ||
            /\b(?:awareness\s+(?:notes?|injections?)|private\s+reasoning|thought\s+process)\b/i.test(text) ||
            /\bwhat (?:are|were) you thinking\b/i.test(text);
    }

    getRecentInternalThoughtsForGenerator(guildId, transcript = '', utterances = []) {
        if (
            !this.internalThoughtsEnabled ||
            !this.internalThoughtManager?.getRecentInternalThoughts ||
            !this.shouldInjectRecentInternalThoughts(transcript, utterances)
        ) {
            return [];
        }

        try {
            return this.internalThoughtManager.getRecentInternalThoughts(guildId, 7);
        } catch (error) {
            console.warn(`[Bot] Failed to read recent internal thoughts: ${error.message}`);
            return [];
        }
    }

    async selectAwarenessInjectionsForBigBrain(guildId, response, options = {}) {
        const turnAwarenessInjections = Array.isArray(options.awarenessInjections)
            ? options.awarenessInjections
            : [];
        const activeAwarenessInjections = turnAwarenessInjections.length > 0
            ? turnAwarenessInjections
            : this.getAwarenessInjectionsForGenerator(guildId);
        if (
            !this.bigBrainAwarenessSelectionEnabled ||
            activeAwarenessInjections.length === 0 ||
            !this.bigBrainAwarenessSelector?.generate
        ) {
            return [];
        }

        try {
            const selection = await this.bigBrainAwarenessSelector.generate({
                requestReason: response?.bigBrain?.reason || '',
                transcript: this.resolveBigBrainTranscript(options),
                source: options.source || 'buffer',
                activeAwarenessInjections
            });
            const selected = selection?.selectedAwarenessInjections || [];
            console.log(`[Bot] bigBrain awareness selection include=${Boolean(selection?.includeAwareness)}, selected=${selected.length}`);
            return selected;
        } catch (error) {
            console.warn(`[Bot] bigBrain awareness selection failed: ${error.message}`);
            return [];
        }
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

    getConsecutiveGeneratorSilences(guildId) {
        const count = this.consecutiveGeneratorSilences?.get?.(guildId) || 0;
        return Number.isFinite(Number(count))
            ? Math.max(0, Math.floor(Number(count)))
            : 0;
    }

    resetConsecutiveGeneratorSilences(guildId) {
        if (!guildId) return 0;
        if (!this.consecutiveGeneratorSilences) {
            this.consecutiveGeneratorSilences = new Map();
        }
        this.consecutiveGeneratorSilences.set(guildId, 0);
        return 0;
    }

    recordGeneratorSilence(guildId, source = 'generator') {
        if (!guildId) return 0;
        if (!this.consecutiveGeneratorSilences) {
            this.consecutiveGeneratorSilences = new Map();
        }
        const next = this.getConsecutiveGeneratorSilences(guildId) + 1;
        this.consecutiveGeneratorSilences.set(guildId, next);
        console.log(`[Bot] Consecutive generator silence decisions=${next} (${source})`);
        return next;
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

    getParticipantSignalProfileMap(guildId) {
        if (!this.participantSignalProfiles) {
            this.participantSignalProfiles = new Map();
        }

        let profiles = this.participantSignalProfiles.get(guildId);
        if (!profiles) {
            profiles = new Map();
            this.participantSignalProfiles.set(guildId, profiles);
        }

        return profiles;
    }

    getParticipantSignalProfile(guildId, userId) {
        const profiles = this.getParticipantSignalProfileMap(guildId);
        const key = userId || '__unknown__';
        let profile = profiles.get(key);
        if (!profile) {
            profile = new ParticipantSignalProfile();
            profiles.set(key, profile);
        }
        return profile;
    }

    getParticipantSignalStateMap(guildId) {
        if (!this.participantSignalStates) {
            this.participantSignalStates = new Map();
        }

        let states = this.participantSignalStates.get(guildId);
        if (!states) {
            states = new Map();
            this.participantSignalStates.set(guildId, states);
        }

        return states;
    }

    getParticipantSignalState(guildId, userId, create = false) {
        if (!guildId || !userId) return null;

        const states = this.getParticipantSignalStateMap(guildId);
        let state = states.get(userId);
        if (!state && create) {
            state = {
                userId,
                rawActive: false,
                speechEvidence: false,
                floorConfirmed: false,
                startedAt: null,
                evidenceAt: null,
                hostPlaybackContextAtStart: null
            };
            states.set(userId, state);
        }

        return state || null;
    }

    getHostPlaybackContext(guildId, at = Date.now()) {
        const playback = this.hostPlaybackState?.get?.(guildId) || {};
        const startedAt = Number(playback.startedAt);
        const endedAt = Number(playback.endedAt);
        const hasStarted = Number.isFinite(startedAt);
        const active = Boolean(playback.active) && hasStarted && at >= startedAt;
        const duringHostPlayback = hasStarted &&
            at >= startedAt &&
            (active || !Number.isFinite(endedAt) || at <= endedAt);
        const nearHostPlaybackStart = hasStarted && Math.abs(at - startedAt) <= 600;

        return {
            duringHostPlayback,
            nearHostPlaybackStart,
            hostPlaybackActive: active,
            hostPlaybackStartedAt: hasStarted ? startedAt : null,
            hostPlaybackEndedAt: Number.isFinite(endedAt) ? endedAt : null,
            msSinceHostPlaybackStart: hasStarted ? at - startedAt : null
        };
    }

    noteHostPlaybackStart(guildId, timing = {}) {
        const parsed = Date.parse(timing.playbackStartedAt);
        const startedAt = Number.isNaN(parsed) ? Date.now() : parsed;
        if (!this.hostPlaybackState) {
            this.hostPlaybackState = new Map();
        }
        this.hostPlaybackState.set(guildId, {
            active: true,
            startedAt,
            endedAt: null
        });
    }

    noteHostPlaybackEnd(guildId, timing = {}) {
        const parsed = Date.parse(timing.playbackEndedAt);
        const endedAt = Number.isNaN(parsed) ? Date.now() : parsed;
        const existing = this.hostPlaybackState?.get?.(guildId) || {};
        if (!this.hostPlaybackState) {
            this.hostPlaybackState = new Map();
        }
        this.hostPlaybackState.set(guildId, {
            ...existing,
            active: false,
            endedAt
        });
    }

    recordParticipantSignal(guildId, userId, type, metadata = {}) {
        if (!guildId || !userId) return null;

        const at = Number.isFinite(metadata.at)
            ? metadata.at
            : (metadata.speechStartedAt ? Date.parse(metadata.speechStartedAt) : Date.now());
        const context = metadata.hostPlaybackContext || this.getHostPlaybackContext(guildId, Number.isNaN(at) ? Date.now() : at);
        const profile = this.getParticipantSignalProfile(guildId, userId);
        const snapshot = profile.recordSignal({
            ...metadata,
            ...context,
            type,
            at: Number.isNaN(at) ? Date.now() : at
        });

        if (type !== 'raw_vad_start' && snapshot.strictnessLevel > 0) {
            console.log(
                `[Bot] Participant signal profile ${userId}: type=${type}, ` +
                `vadNoise=${snapshot.vadNoiseScore.toFixed(2)}, ` +
                `phantom=${snapshot.phantomScore.toFixed(2)}, ` +
                `echo=${snapshot.echoScore.toFixed(2)}, strictness=${snapshot.strictnessLevel}`
            );
        }

        return snapshot;
    }

    noteRawParticipantVadStart(guildId, userId) {
        const now = Date.now();
        const state = this.getParticipantSignalState(guildId, userId, true);
        const context = this.getHostPlaybackContext(guildId, now);
        const hadConfirmedFloor = Boolean(state.floorConfirmed || state.speechEvidence);

        state.rawActive = true;
        state.startedAt = state.startedAt || now;
        state.hostPlaybackContextAtStart = state.hostPlaybackContextAtStart || context;

        this.recordParticipantSignal(guildId, userId, 'raw_vad_start', {
            at: now,
            hostPlaybackContext: context
        });

        if (hadConfirmedFloor) {
            state.speechEvidence = true;
            state.floorConfirmed = true;
            console.log(`[Bot] User ${userId} raw VAD resumed with existing speech evidence; reasserting floor authority`);
            this.setInternalThoughtUserSpeaking(guildId, userId, true);
            this.conversationBuffer.setUserSpeaking(userId, true);
            this.confirmParticipantActivity(guildId, userId, 'confirmed speech resumed');
            return;
        }

        state.speechEvidence = false;
        state.floorConfirmed = false;
        state.startedAt = now;
        state.evidenceAt = null;
        state.hostPlaybackContextAtStart = context;

        console.log(`[Bot] User ${userId} raw VAD started; awaiting speech evidence before taking floor authority`);
    }

    noteRawParticipantVadStop(guildId, userId) {
        const state = this.getParticipantSignalState(guildId, userId, false);
        const hadConfirmedFloor = Boolean(state?.floorConfirmed);

        console.log(`[Bot] User ${userId} raw VAD stopped${hadConfirmedFloor ? '' : ' before speech evidence'}`);
        this.clearProvisionalParticipantActivity(guildId, userId, 'speaking stop');

        if (hadConfirmedFloor) {
            this.setInternalThoughtUserSpeaking(guildId, userId, false);
            this.conversationBuffer.setUserSpeaking(userId, false);
            if (state) {
                state.rawActive = false;
            }
            return;
        }

        const states = this.participantSignalStates?.get?.(guildId);
        states?.delete?.(userId);
        if (states?.size === 0) {
            this.participantSignalStates.delete(guildId);
        }
    }

    clearUnconfirmedParticipantSignalState(guildId, userId, reason = 'cleared') {
        const state = this.getParticipantSignalState(guildId, userId, false);
        if (!state || state.floorConfirmed) {
            return;
        }

        const states = this.participantSignalStates?.get?.(guildId);
        states?.delete?.(userId);
        if (states?.size === 0) {
            this.participantSignalStates.delete(guildId);
        }

        console.log(`[Bot] Unconfirmed raw VAD cleared for ${userId} (${reason})`);
    }

    clearCompletedParticipantSignalState(guildId, userId, reason = 'completed') {
        const state = this.getParticipantSignalState(guildId, userId, false);
        if (!state || state.rawActive) {
            return;
        }

        const states = this.participantSignalStates?.get?.(guildId);
        states?.delete?.(userId);
        if (states?.size === 0) {
            this.participantSignalStates.delete(guildId);
        }

        console.log(`[Bot] Participant signal state cleared for ${userId} (${reason})`);
    }

    confirmParticipantSpeechEvidence(guildId, userId, metadata = {}) {
        if (!guildId || !userId) return false;

        const now = Date.now();
        const state = this.getParticipantSignalState(guildId, userId, true);
        const context = state.hostPlaybackContextAtStart || this.getHostPlaybackContext(guildId, now);

        state.speechEvidence = true;
        state.evidenceAt = now;

        this.recordParticipantSignal(guildId, userId, 'speech_evidence', {
            ...metadata,
            at: now,
            hostPlaybackContext: context
        });

        if (state.floorConfirmed) {
            return true;
        }

        state.floorConfirmed = true;
        const reason = metadata.source || 'speech evidence';
        if (!this.getHostPlaybackContext(guildId, now).duringHostPlayback) {
            this.stopBigBrainToolTone(guildId, 'participant speech evidence');
        }
        console.log(
            `[Bot] Speech evidence confirmed for ${userId} ` +
            `(frames=${metadata.speakingFrames || 0}, threshold=${metadata.threshold || 1}, source=${reason})`
        );
        this.setInternalThoughtUserSpeaking(guildId, userId, true);
        this.conversationBuffer.setUserSpeaking(userId, true);
        this.confirmParticipantActivity(guildId, userId, reason);
        return true;
    }

    hasParticipantSpeechEvidenceConfirmed(guildId, userId) {
        const state = this.getParticipantSignalState(guildId, userId, false);
        return Boolean(state?.floorConfirmed);
    }

    hasSpeechEvidenceForFloor(guildId, userId, metadata = {}) {
        if (this.hasParticipantSpeechEvidenceConfirmed(guildId, userId)) {
            return true;
        }

        const stats = {
            speakingFrames: metadata.speakingFrames || 0,
            silentFrames: metadata.silentFrames || 0,
            totalFrames: metadata.totalFrames || 0
        };
        const threshold = this.getSpeechEvidenceFrameThreshold(guildId, userId, stats, metadata);
        return stats.speakingFrames >= threshold;
    }

    getSpeechEvidenceFrameThreshold(guildId, userId, stats = {}, metadata = {}) {
        const profile = this.getParticipantSignalProfile(guildId, userId);
        return profile.getSpeechEvidenceFrameThreshold({
            ...this.getHostPlaybackContext(guildId),
            ...metadata,
            speakingFrames: stats.speakingFrames || 0
        });
    }

    getAsrCandidateFrameThreshold(guildId, userId, stats = {}, metadata = {}) {
        const profile = this.getParticipantSignalProfile(guildId, userId);
        return profile.getAsrCandidateFrameThreshold({
            ...this.getHostPlaybackContext(guildId),
            ...metadata,
            speakingFrames: stats.speakingFrames || 0
        });
    }

    getPendingUnconfirmedParticipantSignals(guildId) {
        const states = this.participantSignalStates?.get?.(guildId);
        if (!states) return [];

        return Array.from(states.values())
            .filter(state => state.rawActive && !state.floorConfirmed);
    }

    async waitForPendingParticipantSpeechEvidenceBeforePlayback(guildId) {
        const pending = this.getPendingUnconfirmedParticipantSignals(guildId);
        if (pending.length === 0) {
            return { waited: false, reason: 'no pending raw VAD' };
        }

        const waitMs = pending.reduce((maxWait, state) => {
            const profile = this.getParticipantSignalProfile(guildId, state.userId);
            return Math.max(maxWait, profile.getPrePlaybackEvidenceWaitMs({
                pendingUnconfirmedCount: pending.length,
                ...this.getHostPlaybackContext(guildId)
            }));
        }, 0);

        if (waitMs <= 0) {
            return { waited: false, reason: 'no wait configured' };
        }

        console.log(`[Bot] Pending raw VAD before playback; waiting up to ${waitMs}ms for speech evidence`);
        const startedAt = Date.now();
        while (Date.now() - startedAt < waitMs) {
            if (this.hasCurrentParticipantFloor(guildId)) {
                return { waited: true, speechEvidence: true, waitedMs: Date.now() - startedAt };
            }

            if (this.getPendingUnconfirmedParticipantSignals(guildId).length === 0) {
                return { waited: true, cleared: true, waitedMs: Date.now() - startedAt };
            }

            const remaining = waitMs - (Date.now() - startedAt);
            await new Promise(resolve => setTimeout(resolve, Math.min(25, Math.max(1, remaining))));
        }

        return { waited: true, timedOut: true, waitedMs: Date.now() - startedAt };
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
            const turnIdIntent = this.getLatestParticipantTurnIdIntent(guildId);
            const awarenessInjections = await this.getAwarenessInjectionsForGeneratorTurn(guildId, turnIdIntent);
            const generatorTiming = this.getGeneratorCallTiming(guildId);
            const awarenessShelfItems = this.getAwarenessShelfItemsForGenerator(guildId, {
                ...generatorTiming,
                turnIdIntent
            });
            const showRunnerGuidance = this.getShowRunnerGuidanceForGenerator(guildId);

            console.log(`[Bot] Idle decision check after ${Math.round(idleSeconds)}s without participant speech`);
            const response = await this.podcastGenerator.generate({
                transcript: '',
                idleCheck: true,
                idleSeconds,
                stagedBigBrain: this.getStagedBigBrainForGenerator(guildId),
                pendingBigBrain: this.getPendingBigBrainForGenerator(guildId),
                awarenessInjections,
                awarenessShelfItems,
                showRunnerGuidance,
                consecutiveSilenceTurns: this.getConsecutiveGeneratorSilences(guildId),
                ...generatorTiming,
                remember: false
            });

            if (this.shouldSuppressDuplicateBigBrainStall(guildId, response)) {
                console.log('[Bot] Idle generator requested bigBrain while one is already pending; suppressing duplicate stall');
                return;
            }

            if (!response.shouldRespond) {
                if (this.getParticipantActivityVersion(guildId) === participantActivityBaseline) {
                    this.recordGeneratorSilence(guildId, 'idle');
                }
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
                awarenessInjections,
                awarenessShelfItems,
                participantActivityBaseline
            });
            const finalResponse = playbackResult?.finalResponse || response;
            if (playbackResult?.played) {
                if (finalResponse.bigBrain?.requested) {
                    await this.dispatchBigBrainTurn(guildId, finalResponse, {
                        source: 'idle',
                        transcript: '',
                        awarenessInjections,
                        awarenessShelfItems,
                        participantActivityBaseline: this.getParticipantActivityVersion(guildId)
                    });
                }
                this.consumeStagedBigBrainFromResponse(guildId, finalResponse);
            }
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
            this.duckBigBrainAmbientBed(guildId, 'filler clip starting');
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

        this.duckBigBrainAmbientBed(guildId, 'foreground TTS starting');
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
                this.noteHostPlaybackStart(guildId, timing);

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
        let playbackTiming;
        try {
            playbackTiming = await playback.finished;
        } catch (error) {
            if (!playbackStartAborted && Number.isFinite(playbackStartMs)) {
                this.noteHostPlaybackEnd(guildId, { playbackEndedAt: new Date().toISOString() });
            }
            throw error;
        }

        if (playbackStartAborted) {
            return {
                playback,
                playbackTiming,
                botAudioRecorded: false,
                ttsCompletedAt: capture.completedAt,
                abortedBeforePlayback: true
            };
        }

        this.noteHostPlaybackEnd(guildId, playbackTiming);

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
            console.log(`[Bot] Interaction received: ${interaction.type}, isCommand: ${interaction.isChatInputCommand()}, isAutocomplete: ${interaction.isAutocomplete()}`);
            try {
                if (interaction.isAutocomplete()) {
                    await this.handleAutocomplete(interaction);
                } else if (interaction.isChatInputCommand()) {
                    console.log(`[Bot] Handling command: ${interaction.commandName}`);
                    await this.handleCommand(interaction);
                }
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
                .setName('podcast-production')
                .setDescription('Render a versioned episode from a recording without publishing')
                .addIntegerOption(option =>
                    option
                        .setName('episode')
                        .setDescription('Episode number to assign (defaults to next episode)')
                        .setRequired(false)
                        .setMinValue(1)
                        .setAutocomplete(true))
                .addStringOption(option =>
                    option
                        .setName('recording')
                        .setDescription('Start typing to see available recordings, or leave blank for latest')
                        .setRequired(false)
                        .setAutocomplete(true))
                .addStringOption(option =>
                    option
                        .setName('intro-outro-creative-direction')
                        .setDescription('Creative direction for regenerating AI intro/outro copy')
                        .setMaxLength(1000)
                        .setRequired(false)),
            new SlashCommandBuilder()
                .setName('podcast-publish')
                .setDescription('Publish a produced episode to the podcast feed')
                .addIntegerOption(option =>
                    option
                        .setName('episode')
                        .setDescription('Episode number to publish (defaults to latest produced)')
                        .setRequired(false)
                        .setMinValue(1)
                        .setAutocomplete(true))
                .addStringOption(option =>
                    option
                        .setName('version')
                        .setDescription('Produced version to publish (defaults to latest)')
                        .setRequired(false)
                        .setAutocomplete(true))
                .addStringOption(option =>
                    option
                        .setName('title')
                        .setDescription('Override the feed title')
                        .setRequired(false)
                        .setMaxLength(160))
                .addStringOption(option =>
                    option
                        .setName('description')
                        .setDescription('Override the feed description')
                        .setRequired(false)
                        .setMaxLength(1500))
                .addBooleanOption(option =>
                    option
                        .setName('dry-run')
                        .setDescription('Preview the feed update without publishing')
                        .setRequired(false))
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
                case 'podcast-production':
                    await this.handleProductionCommand(interaction);
                    break;
                case 'podcast-publish':
                    await this.handlePublishCommand(interaction);
                    break;
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
     * Handle autocomplete interactions for podcast production/publish options
     */
    async handleAutocomplete(interaction) {
        if (!['podcast-production', 'podcast-publish'].includes(interaction.commandName)) return;
        const focused = interaction.options.getFocused(true);

        try {
            if (focused.name === 'episode') {
                const includeNext = interaction.commandName === 'podcast-production';
                await interaction.respond(this.getPodcastEpisodeAutocompleteChoices(focused.value, includeNext));
                return;
            }

            if (interaction.commandName === 'podcast-production' && focused.name === 'recording') {
                const recordings = this.listAvailableRecordings();
                const choices = recordings.slice(0, 25).map(r => ({
                    name: r.label,
                    value: r.value
                }));
                await interaction.respond(choices);
                return;
            }

            if (interaction.commandName === 'podcast-publish' && focused.name === 'version') {
                const episode = interaction.options.getInteger('episode');
                if (!episode) {
                    await interaction.respond([{ name: 'Select an episode first', value: '' }]);
                    return;
                }
                const query = String(focused.value ?? '').trim().toLowerCase();
                const versions = this.listAvailableVersions(episode)
                    .filter(v => !query || v.value.toLowerCase().includes(query) || v.label.toLowerCase().includes(query))
                    .slice(0, 25)
                    .map(v => ({ name: v.label, value: v.value }));
                await interaction.respond(versions.length ? versions : [{ name: 'No versions found', value: '' }]);
                return;
            }

            await interaction.respond([]);
        } catch (error) {
            console.error('[Bot] Autocomplete failed:', error);
            await interaction.respond([]);
        }
    }

    /**
     * Return episode-number suggestions for podcast production/publish commands.
     */
    getPodcastEpisodeAutocompleteChoices(focusedValue = '', includeNext = true) {
        const state = this.getProductionEpisodeState();
        const suggestions = [];
        const seen = new Set();

        const addChoice = (label, value) => {
            if (!Number.isInteger(value) || value < 1 || seen.has(value)) return;
            seen.add(value);
            suggestions.push({ name: label, value });
        };

        if (
            Number.isInteger(state.latestProduced) &&
            Number.isInteger(state.latestPublished) &&
            state.latestProduced === state.latestPublished
        ) {
            addChoice(`Latest published: Episode ${state.latestPublished}`, state.latestPublished);
            if (includeNext) {
                addChoice(`Next episode: Episode ${state.next}`, state.next);
            }
        } else {
            if (includeNext) {
                addChoice(`Next episode: Episode ${state.next}`, state.next);
            }
            addChoice(`Latest produced: Episode ${state.latestProduced}`, state.latestProduced);
            addChoice(`Latest published: Episode ${state.latestPublished}`, state.latestPublished);
        }

        const query = String(focusedValue ?? '').trim().toLowerCase();
        return suggestions
            .filter(choice => !query || String(choice.value).startsWith(query) || choice.name.toLowerCase().includes(query))
            .slice(0, 25);
    }

    getProductionEpisodeAutocompleteChoices(focusedValue = '') {
        return this.getPodcastEpisodeAutocompleteChoices(focusedValue);
    }

    getProductionEpisodeState() {
        const latestProduced = this.getLatestProducedEpisodeNumber();
        const latestPublished = this.getLatestPublishedEpisodeNumber();
        const latestKnown = Math.max(latestProduced || 0, latestPublished || 0);

        return {
            latestProduced,
            latestPublished,
            next: latestKnown + 1 || 1
        };
    }

    getLatestProducedEpisodeNumber() {
        const root = getPodcastRoot();
        const numbers = new Set();

        const episodesDir = path.join(root, 'episodes');
        if (fs.existsSync(episodesDir)) {
            for (const entry of fs.readdirSync(episodesDir, { withFileTypes: true })) {
                if (!entry.isFile()) continue;
                const match = entry.name.match(/^episode-(\d{1,4})\.mp3$/i);
                if (match) numbers.add(Number.parseInt(match[1], 10));
            }
        }

        const productionDir = path.join(root, 'production');
        if (fs.existsSync(productionDir)) {
            for (const entry of fs.readdirSync(productionDir, { withFileTypes: true })) {
                if (!entry.isDirectory()) continue;
                const match = entry.name.match(/^episode-(\d{1,4})$/i);
                if (!match) continue;

                const episodeNumber = Number.parseInt(match[1], 10);
                const episodeDir = path.join(productionDir, entry.name);
                if (this.productionEpisodeHasFinalMp3(episodeDir, episodeNumber)) {
                    numbers.add(episodeNumber);
                }
            }
        }

        return this.maxEpisodeNumber(numbers);
    }

    productionEpisodeHasFinalMp3(episodeDir, episodeNumber) {
        if (!fs.existsSync(episodeDir)) return false;
        const padded = String(episodeNumber).padStart(2, '0');

        for (const entry of fs.readdirSync(episodeDir, { withFileTypes: true })) {
            if (!entry.isDirectory() || !/^v\d+/i.test(entry.name)) continue;
            const versionDir = path.join(episodeDir, entry.name);
            const expected = path.join(versionDir, `episode-${padded}-${entry.name}.mp3`);
            if (fs.existsSync(expected)) return true;

            const hasAnyEpisodeMp3 = fs.readdirSync(versionDir, { withFileTypes: true })
                .some(file => file.isFile() && /^episode-\d{1,4}-v\d+\.mp3$/i.test(file.name));
            if (hasAnyEpisodeMp3) return true;
        }

        return false;
    }

    getLatestPublishedEpisodeNumber() {
        const feedPath = path.join(getPodcastRoot(), 'feed.xml');
        if (!fs.existsSync(feedPath)) return null;

        try {
            const feedXml = fs.readFileSync(feedPath, 'utf8');
            const numbers = new Set();
            for (const match of feedXml.matchAll(/episode-(\d{1,4})\.mp3/gi)) {
                numbers.add(Number.parseInt(match[1], 10));
            }
            return this.maxEpisodeNumber(numbers);
        } catch (error) {
            console.error(`[Bot] Failed to read podcast feed for episode autocomplete: ${error.message}`);
            return null;
        }
    }

    maxEpisodeNumber(numbers) {
        const values = Array.from(numbers || []).filter(n => Number.isInteger(n) && n > 0);
        return values.length ? Math.max(...values) : null;
    }

    /**
     * List available produced versions for an episode.
     */
    listAvailableVersions(episodeNumber) {
        const root = getPodcastRoot();
        const episodeDir = path.join(root, 'production', `episode-${String(episodeNumber).padStart(2, '0')}`);
        if (!fs.existsSync(episodeDir)) {
            return [];
        }

        const versions = [];
        for (const entry of fs.readdirSync(episodeDir, { withFileTypes: true })) {
            if (!entry.isDirectory() || !/^v\d+$/i.test(entry.name)) continue;
            const versionDir = path.join(episodeDir, entry.name);
            const padded = String(episodeNumber).padStart(2, '0');
            const expectedMp3 = path.join(versionDir, `episode-${padded}-${entry.name}.mp3`);
            const hasMp3 = fs.existsSync(expectedMp3) ||
                fs.readdirSync(versionDir, { withFileTypes: true })
                    .some(f => f.isFile() && new RegExp(`^episode-\\d{1,4}-${entry.name}\\.mp3$`, 'i').test(f.name));

            if (!hasMp3) continue;
            versions.push({ label: entry.name, value: entry.name });
        }

        // Sort descending by version number
        versions.sort((a, b) => {
            const numA = parseInt(a.value.replace(/^v/i, ''), 10);
            const numB = parseInt(b.value.replace(/^v/i, ''), 10);
            return numB - numA;
        });

        return versions;
    }

    /**
     * List available recordings from the content root recordings directory
     */
    listAvailableRecordings() {
        const recordingDir = getRecordingDir();
        if (!fs.existsSync(recordingDir)) {
            return [{ label: 'latest (no recordings yet)', value: 'latest' }];
        }

        const entries = fs.readdirSync(recordingDir, { withFileTypes: true })
            .filter(d => d.isDirectory() && d.name.startsWith('episode-'))
            .map(d => {
                const dirPath = path.join(recordingDir, d.name);
                let meta = {};
                const metaPath = path.join(dirPath, 'episode-metadata.json');
                const completePath = path.join(dirPath, 'episode-complete.json');
                try {
                    meta = JSON.parse(fs.readFileSync(fs.existsSync(metaPath) ? metaPath : completePath, 'utf8'));
                } catch (_e) {
                    /* ignore */ }

                const started = meta.startedAt ? new Date(meta.startedAt).toLocaleString('en-US', {
                    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
                }) : d.name;
                const duration = meta.duration ? `${Math.round(meta.duration)}s` : '';
                const label = duration ? `${started} · ${duration}` : started;
                return { label, value: d.name, startedAt: meta.startedAt || 0 };
            })
            .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));

        const choices = entries.map(e => ({ label: e.label, value: e.value }));
        choices.unshift({ label: 'latest (most recent)', value: 'latest' });
        return choices;
    }

    /**
     * Extract the last JSON object from multi-line stdout output.
     */
    extractLastJson(stdout) {
        if (!stdout) return null;

        let best = null;
        let bestEnd = -1;
        let bestStart = -1;

        for (let start = 0; start < stdout.length; start++) {
            if (stdout[start] !== '{') continue;

            let depth = 0;
            let inString = false;
            let escaped = false;

            for (let end = start; end < stdout.length; end++) {
                const char = stdout[end];

                if (inString) {
                    if (escaped) {
                        escaped = false;
                    } else if (char === '\\') {
                        escaped = true;
                    } else if (char === '"') {
                        inString = false;
                    }
                    continue;
                }

                if (char === '"') {
                    inString = true;
                } else if (char === '{') {
                    depth++;
                } else if (char === '}') {
                    depth--;
                    if (depth === 0) {
                        try {
                            const parsed = JSON.parse(stdout.slice(start, end + 1));
                            if (end > bestEnd || (end === bestEnd && (bestStart === -1 || start < bestStart))) {
                                best = parsed;
                                bestEnd = end;
                                bestStart = start;
                            }
                        } catch (_e) {
                            // Keep scanning for the last complete JSON object.
                        }
                        break;
                    }
                }
            }
        }

        return best;
    }

    getDiscordAttachmentLimitMB() {
        const configured = Number(
            process.env.PODCAST_DISCORD_ATTACHMENT_LIMIT_MB ||
            process.env.DISCORD_ATTACHMENT_LIMIT_MB ||
            8
        );
        return Number.isFinite(configured) && configured > 0 ? configured : 8;
    }

    buildEpisodeDownloadUrl(data, mp3Path) {
        const downloadBase = (process.env.PODCAST_DOWNLOAD_BASE_URL || 'https://clawcast.jensenabler.com/episodes').replace(/\/+$/, '');
        const fileName = path.basename(data?.versionedEpisodesCopy || data?.episodesCopy || '');
        return fileName ? `${downloadBase}/${fileName}` : null;
    }

    appendDownloadNotice(content, fileSizeMB, limitMB, downloadUrl, mp3Path, reason = 'too large for Discord attachment') {
        let next = content + `\n\nFile is **${fileSizeMB.toFixed(1)} MB** (${reason}; limit: ${limitMB} MB).`;
        if (downloadUrl) {
            next += `\nDownload: ${downloadUrl}`;
        }
        if (mp3Path) {
            next += `\nPath:\n\`\`\`\n${mp3Path}\n\`\`\``;
        }
        return next;
    }

    ensureProductionVersionedDownload(data) {
        if (!data?.finalMp3 || data.versionedEpisodesCopy) return data;

        const rawEpisode = String(data.episode || '');
        if (!/^\d+$/.test(rawEpisode)) return data;
        const episode = rawEpisode.padStart(2, '0');
        const version = String(data.version || '');
        if (!/^v\d+$/.test(version)) return data;

        try {
            const finalMp3 = path.resolve(data.finalMp3);
            if (!fs.existsSync(finalMp3)) return data;

            const episodesDir = path.join(getPodcastRoot(), 'episodes');
            fs.mkdirSync(episodesDir, { recursive: true });
            const versionedPath = path.join(episodesDir, `episode-${episode}-${version}.mp3`);

            if (fs.existsSync(versionedPath) || fs.lstatSync?.(versionedPath, { throwIfNoEntry: false })?.isSymbolicLink()) {
                fs.unlinkSync(versionedPath);
            }

            try {
                fs.symlinkSync(path.relative(episodesDir, finalMp3), versionedPath);
            } catch {
                fs.copyFileSync(finalMp3, versionedPath);
            }

            data.versionedEpisodesCopy = versionedPath;
        } catch (error) {
            console.error('[Bot] Failed to prepare versioned production download:', error);
        }

        return data;
    }

    isDiscordRequestTooLarge(error) {
        return error?.code === 40005 || /request entity too large/i.test(error?.message || '');
    }

    /**
     * Handle /podcast-production command
     */
    formatDiscordCommand(name, options) {
        const parts = [`/${name}`];
        for (const [key, value] of Object.entries(options)) {
            if (value === undefined || value === null || value === '') continue;
            parts.push(`${key}:${value}`);
        }
        return parts.join(' ');
    }

    async handleProductionCommand(interaction) {
        let episode = interaction.options.getInteger('episode');
        if (!episode) {
            episode = this.getProductionEpisodeState().next;
        }
        const recording = interaction.options.getString('recording') || 'latest';
        const creativeDirection = (interaction.options.getString('intro-outro-creative-direction') || '').trim();

        await interaction.deferReply({ ephemeral: false });

        const args = [
            '/opt/podcast-production/tools/podcast-tool.py',
            'produce-recording',
            '--episode', String(episode),
            '--recording', recording,
            '--skip-finalize',
            '--resume'
        ];
        if (creativeDirection) {
            args.push('--regenerate-copy', '--intro-outro-creative-direction', creativeDirection);
        }

        const discordCommand = this.formatDiscordCommand('podcast-production', {
            episode,
            recording: recording !== 'latest' ? recording : undefined,
            'intro-outro-creative-direction': creativeDirection || undefined
        });
        const commandBlock = `\n\`\`\`\n${discordCommand}\n\`\`\``;
        console.log(`[Bot] Starting podcast production: episode=${episode} recording=${recording} creativeDirection=${creativeDirection ? 'yes' : 'no'}`);

        try {
            const result = await this.runProductionProcess(args);
            const data = this.extractLastJson(result.stdout);
            if (data) this.ensureProductionVersionedDownload(data);

            let summary = '';
            if (data) {
                summary = `**Episode ${data.episode || episode}** · version ${data.version || '?'}`;
                if (data.finalMp3) summary += `\n📁 ${data.finalMp3}`;
                if (data.durationSeconds) {
                    const mins = Math.floor(data.durationSeconds / 60);
                    const secs = Math.round(data.durationSeconds % 60);
                    summary += `\n⏱️ ${mins}:${secs.toString().padStart(2, '0')}`;
                }
            } else {
                summary = `Episode ${episode} production completed.`;
            }

            const replyOptions = {
                content: `✅ **Podcast Production Complete**\n${summary}${commandBlock}`
            };

            if (data && data.finalMp3) {
                const mp3Path = data.finalMp3;
                try {
                    if (fs.existsSync(mp3Path)) {
                        const stats = fs.statSync(mp3Path);
                        const fileSizeMB = stats.size / (1024 * 1024);
                        const DISCORD_LIMIT_MB = this.getDiscordAttachmentLimitMB();
                        const fileName = path.basename(mp3Path);
                        const downloadUrl = this.buildEpisodeDownloadUrl(data, mp3Path);
                        if (fileSizeMB <= DISCORD_LIMIT_MB) {
                            const attachment = new AttachmentBuilder(mp3Path, { name: fileName });
                            replyOptions.files = [attachment];
                        } else {
                            replyOptions.content = this.appendDownloadNotice(
                                replyOptions.content,
                                fileSizeMB,
                                DISCORD_LIMIT_MB,
                                downloadUrl,
                                mp3Path
                            );
                        }
                    }
                } catch (attachErr) {
                    console.error('[Bot] Attachment error:', attachErr);
                }
            }

            try {
                await interaction.editReply(replyOptions);
            } catch (replyErr) {
                if (replyOptions.files?.length && this.isDiscordRequestTooLarge(replyErr)) {
                    console.warn('[Bot] Discord rejected production attachment as too large; retrying with download link only');
                    const mp3Path = data?.finalMp3;
                    const stats = mp3Path && fs.existsSync(mp3Path) ? fs.statSync(mp3Path) : null;
                    const fileSizeMB = stats ? stats.size / (1024 * 1024) : 0;
                    replyOptions.files = [];
                    replyOptions.content = this.appendDownloadNotice(
                        replyOptions.content,
                        fileSizeMB,
                        this.getDiscordAttachmentLimitMB(),
                        this.buildEpisodeDownloadUrl(data, mp3Path),
                        mp3Path,
                        'Discord rejected the attachment'
                    );
                    await interaction.editReply(replyOptions);
                } else {
                    throw replyErr;
                }
            }
            console.log('[Bot] Production reply sent successfully');
        } catch (error) {
            console.error('[Bot] Production failed:', error);
            await interaction.editReply({
                content: `❌ **Production failed for episode ${episode}**${commandBlock}\n\`\`\`\n${error.message}\n${error.stderr || ''}\n\`\`\``
            });
        }
    }

    /**
     * Handle /podcast-publish command
     */
    async handlePublishCommand(interaction) {
        let episode = interaction.options.getInteger('episode');
        if (!episode) {
            episode = this.getProductionEpisodeState().latestProduced;
            if (!episode) {
                await interaction.reply({ content: 'No produced episodes found. Run `/podcast-production` first.', ephemeral: true });
                return;
            }
        }
        const version = interaction.options.getString('version');
        const title = interaction.options.getString('title');
        const description = interaction.options.getString('description');
        const dryRun = interaction.options.getBoolean('dry-run') || false;

        await interaction.deferReply({ ephemeral: false });

        const args = [
            '/opt/podcast-production/tools/podcast-tool.py',
            'publish',
            '--episode', String(episode)
        ];

        if (version) args.push('--version', version);
        if (title) args.push('--title', title);
        if (description) args.push('--description', description);
        if (dryRun) args.push('--dry-run');

        const syncTarget = process.env.PODCAST_PUBLISH_SYNC_TARGET;
        if (syncTarget) args.push('--sync-target', syncTarget);

        const baseUrl = process.env.PODCAST_BASE_URL || process.env.PODCAST_DOWNLOAD_BASE_URL;
        if (baseUrl) args.push('--base-url', baseUrl.replace(/\/episodes\/?$/, ''));

        console.log(`[Bot] Starting podcast publish: episode=${episode} version=${version || 'latest'} dryRun=${dryRun}`);

        try {
            const result = await this.runProductionProcess(args);
            const data = this.extractLastJson(result.stdout);

            let content;
            if (data) {
                const status = data.dryRun ? 'Podcast Publish Dry Run' : 'Podcast Published';
                const syncSummary = data.syncTarget
                    ? (data.syncResults || []).map(r => r.returnCode === 0 || r.dryRun ? 'ok' : `failed:${r.returnCode}`).join(', ')
                    : 'not configured';
                const versionLabel = data.publishedVersion || data.version || data.metadataVersion || 'unknown';
                const versionedMp3 = data.publishedVersionUrl || data.publishedVersionMp3 || 'unknown';
                const publicMetadata = data.publicMetadataUrl || data.publicMetadataPath || null;
                content = `**${status}**\n` +
                    `Episode ${data.episode || episode}: ${data.title || 'Untitled'}\n` +
                    `Version: ${versionLabel}\n` +
                    `Versioned MP3: ${versionedMp3}\n` +
                    (publicMetadata ? `Metadata: ${publicMetadata}\n` : '') +
                    `Duration: ${data.duration || 'unknown'}\n` +
                    `Episode URL: ${data.episodeUrl || data.stableMp3 || data.mp3 || 'unknown'}\n` +
                    `Feed: ${data.feedUrl || data.feed || 'unknown'}\n` +
                    `RSS item: ${data.replacedExistingItem ? 'replaced existing item' : 'added new item'}\n` +
                    `Sync: ${syncSummary}`;
            } else {
                content = `**Podcast Publish Complete**\nEpisode ${episode}`;
                if (result.stdout.trim()) {
                    content += `\n\`\`\`\n${result.stdout.trim().slice(-1200)}\n\`\`\``;
                }
            }

            await interaction.editReply({ content });
            console.log('[Bot] Publish reply sent successfully');
        } catch (error) {
            console.error('[Bot] Publish failed:', error);
            await interaction.editReply({
                content: `**Publish failed for episode ${episode}**\n\`\`\`\n${error.message}\n${error.stderr || ''}\n\`\`\``
            });
        }
    }

    /**
     * Spawn the podcast-production tool and capture output
     */
    runProductionProcess(args) {
        return new Promise((resolve, reject) => {
            const proc = spawn('python3', args, {
                cwd: '/opt/podcast-production',
                env: { ...process.env },
                stdio: ['ignore', 'pipe', 'pipe']
            });

            let stdout = '';
            let stderr = '';

            proc.stdout.on('data', (data) => {
                const chunk = data.toString('utf8');
                stdout += chunk;
                console.log('[Production]', chunk.trimEnd());
            });

            proc.stderr.on('data', (data) => {
                const chunk = data.toString('utf8');
                stderr += chunk;
                console.error('[Production]', chunk.trimEnd());
            });

            proc.on('close', (code) => {
                if (code === 0) {
                    resolve({ stdout, stderr });
                } else {
                    const err = new Error(`Production process exited with code ${code}`);
                    err.stdout = stdout;
                    err.stderr = stderr;
                    reject(err);
                }
            });

            proc.on('error', (error) => {
                error.stdout = stdout;
                error.stderr = stderr;
                reject(error);
            });
        });
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
        this.resetConsecutiveGeneratorSilences(guildId);
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
        this.startInternalThoughtSession(guildId, recordingInfo);
        this.startShowRunnerSession(guildId, recordingInfo, topic);

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
                    if (/^(fish|fish-whisper)$/i.test(this.voiceProvider.mode || '')) {
                        if (String(this.voiceProvider.tts?.model || process.env.FISH_AUDIO_MODEL || '').toLowerCase().startsWith('s1')) {
                            PODCAST_GUIDELINES.push('Fish Audio S1 is active: sparse (break) or (long-break) controls are allowed when they improve spoken pacing');
                        } else {
                            PODCAST_GUIDELINES.push('Fish Audio S2 is active: sparse controls like [short pause], [pause], [long pause], [soft voice], [emphasis], or [sigh] are allowed when they improve spoken pacing');
                        }
                    } else {
                        PODCAST_GUIDELINES.push('Use punctuation and wording for pacing; do not include Fish control tags because Fish Audio is not the active TTS mode');
                    }
                    
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
                this.consecutiveGeneratorSilences?.delete?.(guildId);
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
                let result = null;
                try {
                    result = await this.voiceManager.stopRecording(guildId);
                    recordingPath = result?.recordingPath;
                } finally {
                    await this.endShowRunnerSession(guildId);
                    await this.endInternalThoughtSession(guildId);
                }
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
        this.consecutiveGeneratorSilences?.delete?.(guildId);
        this.clearParticipantActivityTimers(guildId);
        this.podcastGenerator.endSession();
        await this.endShowRunnerSession(guildId);
        await this.endInternalThoughtSession(guildId);

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
        const turnIdIntent = this.buildGeneratorTurnIdIntent('direct-generator', utterances);
        if (turnIdIntent) {
            this.latestParticipantTurnIdIntent?.set?.(guildId, turnIdIntent);
        }
        const awarenessInjections = await this.getAwarenessInjectionsForGeneratorTurn(guildId, turnIdIntent);
        const generatorTiming = this.getGeneratorCallTiming(guildId);
        const awarenessShelfItems = this.getAwarenessShelfItemsForGenerator(guildId, {
            ...generatorTiming,
            turnIdIntent
        });
        const showRunnerGuidance = this.getShowRunnerGuidanceForGenerator(guildId);
        let bigBrainDispatch = null;

        try {
            let response = await this.beginGeneratorTurn({
                utterances,
                transcript,
                wordData,
                stagedBigBrain: this.getStagedBigBrainForGenerator(guildId),
                pendingBigBrain: this.getPendingBigBrainForGenerator(guildId),
                awarenessInjections,
                awarenessShelfItems,
                showRunnerGuidance,
                recentInternalThoughts: this.getRecentInternalThoughtsForGenerator(guildId, transcript, utterances),
                consecutiveSilenceTurns: this.getConsecutiveGeneratorSilences(guildId),
                ...generatorTiming,
                remember: false
            });

            if (this.hasPendingBigBrain(guildId) && response?.isStreaming) {
                response = await this.settleGeneratorResponse(response, 'pending bigBrain duplicate check');
            }

            if (this.shouldSuppressDuplicateBigBrainStall(guildId, response)) {
                this.podcastGenerator.rememberTurn?.(transcript, {
                    shouldRespond: false,
                    speech: '',
                    bigBrain: { requested: false, reason: '', consumedRunId: '' }
                });
                console.log('[Bot] Direct generator requested bigBrain while one is already pending; suppressing duplicate stall');
                return;
            }

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
                this.recordGeneratorSilence(guildId, 'buffer');
                console.log(`[Bot] Direct generator chose silence`);
                return;
            }

            const playbackResult = await this.speakDirectGeneratorResponse(guildId, response, {
                source: 'buffer',
                playFiller: true,
                participantActivityBaseline,
                awarenessInjections,
                awarenessShelfItems,
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
                        awarenessInjections,
                        awarenessShelfItems,
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

    serializeVoiceProviderError(error) {
        if (!error) return null;
        return {
            message: error.message || String(error),
            status: error.status || error.statusCode || null,
            provider: error.provider || null,
            operation: error.operation || null,
            fishCreditDepleted: Boolean(error.fishCreditDepleted)
        };
    }

    shouldThrottleAsrErrorNotice(guildId) {
        const lastSpokenAt = this.asrErrorNoticeLastSpokenAt.get(guildId) || 0;
        return Date.now() - lastSpokenAt < this.asrErrorNoticeCooldownMs;
    }

    buildAsrErrorNotice(metadata = {}) {
        const providerError = metadata.error || {};
        if (providerError.fishCreditDepleted) {
            return "I'm still here, but Fish Audio speech transcription just ran out of balance, so I can't understand new speech right now.";
        }
        return "I'm still here, but speech transcription is failing right now, so I may miss what you just said.";
    }

    async handleAsrError(guildId, userId, metadata = {}) {
        const providerError = metadata.error || this.serializeVoiceProviderError(metadata.rawError);
        console.warn(`[Bot] ASR failed for ${userId}: ${providerError?.message || 'unknown error'}`);

        if (!this.voiceManager.isConnected(guildId) || this.shouldThrottleAsrErrorNotice(guildId)) {
            return;
        }

        this.asrErrorNoticeLastSpokenAt.set(guildId, Date.now());
        await this.speakServiceNotice(guildId, this.buildAsrErrorNotice({ ...metadata, error: providerError }), {
            fallbackReason: providerError?.fishCreditDepleted ? 'fish_asr_credit_depleted' : 'asr_error',
            providerError,
            audioEvents: ['asr_error_notice']
        });
    }

    async speakServiceNotice(guildId, text, options = {}) {
        if (!this.voiceManager.isConnected(guildId)) return { played: false, disconnected: true };

        const generatedAt = new Date().toISOString();
        const ttsStartedAt = new Date().toISOString();
        const audioBuffer = await this.voiceProvider.synthesize(text, {
            voiceId: this.voiceId
        });
        const ttsCompletedAt = new Date().toISOString();

        if (this.recordingState.get(guildId) === this.RecordingState.RECORDING) {
            const playbackResult = await this.playTtsAndRecord(guildId, audioBuffer);
            const playback = playbackResult.playback;
            const playbackTiming = playbackResult.playbackTiming || playback?.timing || {};
            const playbackStartedAt = playbackTiming.playbackStartedAt || playback?.timing?.playbackStartedAt || null;
            const playbackEndedAt = playbackTiming.playbackEndedAt || playback?.timing?.playbackEndedAt || null;
            const playbackStartedMs = Date.parse(playbackStartedAt);
            const playbackEndedMs = Date.parse(playbackEndedAt);
            const playbackDuration = !Number.isNaN(playbackStartedMs) && !Number.isNaN(playbackEndedMs)
                ? Math.max(0, playbackEndedMs - playbackStartedMs)
                : 0;

            const transcriptEntry = {
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
                source: 'service_notice',
                fallbackReason: options.fallbackReason || 'service_notice',
                providerError: options.providerError || null,
                audioEvents: options.audioEvents || ['service_notice']
            };
            this.voiceManager.saveTranscriptEntry(guildId, transcriptEntry);
            this.observeInternalThoughtTranscriptEntry(guildId, transcriptEntry);
            this.observeShowRunnerTranscriptEntry(guildId, transcriptEntry);
        } else {
            await this.voiceManager.speak(guildId, audioBuffer);
        }

        return { played: true, stale: false };
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
        const useStreaming = process.env.PODCAST_GENERATOR_STREAMING === 'true' &&
            (typeof this.podcastGenerator.supportsStreaming !== 'function' || this.podcastGenerator.supportsStreaming());
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

    hasPendingBigBrain(guildId) {
        return Array.from(this.pendingBigBrainResponses?.values?.() || [])
            .some((pending) => pending.guildId === guildId);
    }

    getPendingBigBrainForGenerator(guildId) {
        return Array.from(this.pendingBigBrainResponses?.values?.() || [])
            .filter((pending) => pending.guildId === guildId)
            .slice(0, 1)
            .map((pending) => ({
                runId: pending.runId,
                reason: pending.reason,
                transcript: pending.transcript || '',
                requestedAt: pending.requestedAt
            }));
    }

    shouldSuppressDuplicateBigBrainStall(guildId, response = {}) {
        return Boolean(response?.bigBrain?.requested && this.hasPendingBigBrain(guildId));
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
            : 0.56;
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

    startBigBrainAmbientBed(guildId, pending, options = {}) {
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
            ducked: false,
            timer: null,
            playbackActive: false,
            chunksPlayed: 0
        };
        this.bigBrainAmbientBeds.set(guildId, bed);

        const overrideDelayMs = Number(options.delayMs);
        const delayMs = Number.isFinite(overrideDelayMs)
            ? Math.max(0, overrideDelayMs)
            : this.getBigBrainAmbientStartDelayMs();
        const startPlayback = () => {
            bed.timer = null;
            this.playBigBrainAmbientChunk(guildId, bed).catch((error) => {
                if (!this.isBigBrainAmbientBedCurrent(guildId, bed)) {
                    return;
                }
                console.warn(`[Bot] bigBrain ambient bed failed runId=${bed.runId}: ${error.message}`);
                this.stopBigBrainAmbientBed(guildId, 'ambient playback failed', { runId: bed.runId, bed });
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

    ensureBigBrainAmbientBed(guildId, pending, options = {}) {
        if (this.bigBrainAmbientBeds?.has?.(guildId)) {
            return false;
        }
        return this.startBigBrainAmbientBed(guildId, pending, options);
    }

    scheduleNextBigBrainAmbientChunk(guildId, bed, delayMs, reason = 'loop') {
        if (!this.isBigBrainAmbientBedCurrent(guildId, bed)) {
            return false;
        }

        bed.timer = setTimeout(() => {
            bed.timer = null;
            this.playBigBrainAmbientChunk(guildId, bed).catch((error) => {
                if (!this.isBigBrainAmbientBedCurrent(guildId, bed)) {
                    return;
                }
                console.warn(`[Bot] bigBrain ambient bed ${reason} failed runId=${bed.runId}: ${error.message}`);
                this.stopBigBrainAmbientBed(guildId, `ambient ${reason} failed`, { runId: bed.runId, bed });
            });
        }, Math.max(100, delayMs));
        if (typeof bed.timer.unref === 'function') {
            bed.timer.unref();
        }
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

        const buffer = await this.getBigBrainAmbientBedBuffer();
        if (!this.isBigBrainAmbientBedCurrent(guildId, bed)) {
            return;
        }

        const durationMs = this.getBigBrainAmbientChunkDurationMs();
        const chunkNumber = bed.chunksPlayed + 1;
        const playback = this.voiceManager?.getPlaybackStatus?.(guildId) || { isPlaying: false, queueLength: 0 };
        if (playback.isPlaying || playback.queueLength > 0) {
            const startTime = Date.now();
            this.voiceManager.addBotAudioToRecording(guildId, buffer, {
                startTime,
                volume: this.getBigBrainAmbientVolume()
            });
            bed.chunksPlayed++;
            console.log(`[Bot] bigBrain ambient bed recorded under active playback runId=${bed.runId}, chunk=${chunkNumber}`);
            this.scheduleNextBigBrainAmbientChunk(guildId, bed, durationMs, 'record-only loop');
            return;
        }

        let playbackStartedMs = null;
        let playbackEndedMs = null;
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

            const playbackTiming = await ambientPlayback.finished;
            const parsedEnd = Date.parse(playbackTiming?.playbackEndedAt || '');
            playbackEndedMs = Number.isNaN(parsedEnd) ? Date.now() : parsedEnd;
        } catch (error) {
            if (!this.isBigBrainAmbientBedCurrent(guildId, bed)) {
                return;
            }
            if (bed.ducked) {
                playbackEndedMs = Date.now();
                console.log(`[Bot] bigBrain ambient bed playback ducked cleanly runId=${bed.runId}, chunk=${chunkNumber}`);
            } else {
                throw error;
            }
        } finally {
            bed.playbackActive = false;
            bed.ducked = false;
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

        const elapsedMs = Number.isFinite(playbackStartedMs) && Number.isFinite(playbackEndedMs)
            ? Math.max(0, playbackEndedMs - playbackStartedMs)
            : durationMs;
        const nextDelayMs = Math.max(100, durationMs - elapsedMs + 100);
        this.scheduleNextBigBrainAmbientChunk(guildId, bed, nextDelayMs, 'loop');
    }

    duckBigBrainAmbientBed(guildId, reason = 'foreground audio starting', options = {}) {
        const bed = this.bigBrainAmbientBeds?.get?.(guildId);
        if (!bed) {
            return false;
        }
        if (options.runId && bed.runId !== options.runId) {
            return false;
        }
        if (options.bed && bed !== options.bed) {
            return false;
        }
        if (!bed.playbackActive) {
            return false;
        }

        bed.ducked = true;
        const stopped = this.voiceManager?.stopPlayback?.(guildId);
        if (!stopped) {
            bed.ducked = false;
            return false;
        }
        console.log(`[Bot] bigBrain ambient bed ducked runId=${bed.runId} (${reason})`);
        return true;
    }

    stopBigBrainAmbientBed(guildId, reason = 'stopped', options = {}) {
        const bed = this.bigBrainAmbientBeds?.get?.(guildId);
        if (!bed) {
            return false;
        }
        if (options.runId && bed.runId !== options.runId) {
            return false;
        }
        if (options.bed && bed !== options.bed) {
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
        if (!['start', 'update', 'result', 'end', 'error'].includes(phase)) {
            return null;
        }

        const toolName = String(data.name || data.toolName || data.tool || 'tool').trim() || 'tool';
        const isError = phase === 'error' || data.isError === true;
        const baseIndex = this.hashToolToneName(toolName) % 5;
        const phaseOffset = phase === 'start' ? 0 : phase === 'update' ? 1 : 2;
        const scaleIndex = isError ? 1 : baseIndex + phaseOffset;

        return {
            key: `tool:${phase}:${isError ? 'error' : 'ok'}:${scaleIndex}`,
            frequency: this.getPentatonicFrequency(scaleIndex),
            phase,
            isError,
            toolName,
            toolCallId: String(data.toolCallId || data.id || ''),
            toneType: 'tool',
            sourceStream: 'tool'
        };
    }

    resolveBigBrainAgentActivityTone(event) {
        if (
            !this.bigBrainToolSonificationEnabled ||
            !this.bigBrainAgentActivitySonificationEnabled ||
            event?.stream === 'tool'
        ) {
            return null;
        }

        const sourceStream = String(event?.stream || '').trim().toLowerCase();
        if (!sourceStream || sourceStream === 'lifecycle') {
            return null;
        }

        const data = event.data && typeof event.data === 'object' ? event.data : {};
        const isError = sourceStream === 'error' || data.isError === true || data.phase === 'error';
        const phase = isError ? 'error' : 'activity';
        const toolName = String(data.name || data.toolName || data.tool || sourceStream || 'agent')
            .trim() || 'agent';
        const baseIndex = this.hashToolToneName(`${sourceStream}:${toolName}`) % 5;
        const streamOffset = sourceStream === 'assistant' ? 3 : 1;
        const scaleIndex = isError ? 1 : baseIndex + streamOffset;

        return {
            key: `agent:${sourceStream}:${phase}:${isError ? 'error' : 'ok'}:${scaleIndex}`,
            frequency: this.getPentatonicFrequency(scaleIndex),
            phase,
            isError,
            toolName,
            toolCallId: '',
            toneType: 'agent',
            sourceStream
        };
    }

    resolveBigBrainSonificationTone(event) {
        return this.resolveBigBrainToolTone(event) || this.resolveBigBrainAgentActivityTone(event);
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
        const tone = this.resolveBigBrainSonificationTone(event);
        if (!tone || !pending?.runId) {
            return false;
        }
        if (this.recordingState.get(guildId) !== this.RecordingState.RECORDING) {
            return false;
        }
        if (this.hasCurrentParticipantFloor(guildId)) {
            return false;
        }
        if (this.directResponseInFlight?.has?.(guildId)) {
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

            this.duckBigBrainAmbientBed(guildId, 'tool tone starting', { runId: pending.runId });
            const playback = await this.voiceManager.speakWithTiming(guildId, buffer, {
                inputType: StreamType.Arbitrary,
                volume: this.getBigBrainToolToneVolume(),
                onStart: (timing) => {
                    state.playbackActive = true;
                    if (state.stopped || !this.pendingBigBrainResponses?.has?.(pending.runId)) {
                        this.voiceManager?.stopPlayback?.(guildId);
                        return;
                    }

                    const parsed = Date.parse(timing.playbackStartedAt);
                    playbackStartedMs = Number.isNaN(parsed) ? null : parsed;
                    const label = tone.toneType === 'tool' ? 'tool tone' : 'agent tone';
                    const stream = tone.sourceStream && tone.sourceStream !== tone.toneType
                        ? `, stream=${tone.sourceStream}`
                        : '';
                    console.log(`[Bot] bigBrain ${label} ${tone.phase} runId=${pending.runId}, tool=${tone.toolName}${stream}`);
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
            this.ensureBigBrainAmbientBed(guildId, pending, { delayMs: 0 });
        }
    }

    shouldResumeAmbientAfterToolToneStop(reason = 'stopped') {
        return ![
            'bigBrain response staged',
            'bigBrain run cleaned up',
            'idle loop stopped'
        ].includes(reason);
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
        if (this.shouldResumeAmbientAfterToolToneStop(reason)) {
            const pending = this.pendingBigBrainResponses?.get?.(state.runId);
            if (pending?.guildId === guildId) {
                this.ensureBigBrainAmbientBed(guildId, pending, { delayMs: 0 });
            }
        }
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

    resolveBigBrainTranscript(options = {}) {
        const transcript = String(options.transcript || '').trim()
            || this.podcastGenerator?.formatUtterances?.(options.utterances || [])
            || '';
        return String(transcript || '').trim();
    }

    normalizeBigBrainRequestText(value) {
        return String(value || '')
            .replace(/^\s*[^:\n]{1,40}:\s*/gm, ' ')
            .replace(/\bhey\s+alpha\s+claude\b/gi, ' ')
            .replace(/\balpha[-\s]?clawd\b/gi, ' ')
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    getMeaningfulBigBrainRequestTokens(value) {
        const normalized = this.normalizeBigBrainRequestText(value);
        if (!normalized) {
            return [];
        }

        const stopWords = new Set([
            'a', 'about', 'ah', 'an', 'and', 'ask', 'asked', 'asking', 'big', 'bigbrain',
            'brain', 'can', 'check', 'claw', 'clawd', 'could', 'do', 'er', 'for',
            'from', 'get', 'give', 'guest', 'handoff', 'here', 'hey', 'i', 'in',
            'info', 'information', 'it', 'just', 'kind', 'kinds', 'let', 'lets',
            'like', 'look', 'lookup', 'me', 'my', 'need', 'needs', 'of', 'on',
            'open', 'please', 'request', 'requested', 'said', 'says', 'should',
            'sort', 'sorts', 'that', 'the', 'there', 'this', 'to', 'told', 'uh',
            'um', 'up', 'use', 'using', 'verify', 'want', 'will', 'with', 'would',
            'you', 'your'
        ]);

        return normalized
            .split(/\s+/)
            .filter((token) => token && !stopWords.has(token));
    }

    shouldDeferIncompleteBigBrainRequest(response, options = {}) {
        const transcript = this.resolveBigBrainTranscript(options);
        const normalizedTranscript = this.normalizeBigBrainRequestText(transcript);
        if (!/\b(?:big\s+brain|bigbrain|open\s+claw)\b/.test(normalizedTranscript)) {
            return false;
        }

        const transcriptTokens = this.getMeaningfulBigBrainRequestTokens(transcript);
        const reasonTokens = this.getMeaningfulBigBrainRequestTokens(response?.bigBrain?.reason || '');
        return transcriptTokens.length < 2 && reasonTokens.length < 2;
    }

    formatBigBrainAwarenessInjections(items = []) {
        return (Array.isArray(items) ? items : [])
            .map((item) => {
                const awarenessInjection = String(item?.awarenessInjection || item?.text || item || '').trim();
                if (!awarenessInjection) return null;
                return awarenessInjection;
            })
            .filter(Boolean)
            .join('\n\n');
    }

    buildBigBrainPrompt(response, options = {}) {
        const transcript = this.resolveBigBrainTranscript(options)
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
            'Do not add Fish TTS control tags here; the live host generator owns final delivery and may add pacing controls when it speaks your staged answer.',
            'Aim for one to three natural sentences unless the guest explicitly asked for a longer result.',
            '',
            `Trigger source: ${source}`,
            `Small-model handoff reason: ${reason}`,
            '',
            'Live transcript that triggered the handoff:',
            transcript
        ];

        const awarenessInjections = this.formatBigBrainAwarenessInjections(options.awarenessInjections || []);
        if (awarenessInjections) {
            lines.push(
                '',
                awarenessInjections
            );
        }

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

        const transcript = this.resolveBigBrainTranscript(options);
        if (this.shouldDeferIncompleteBigBrainRequest(response, { ...options, transcript })) {
            const preview = transcript.replace(/\s+/g, ' ').slice(0, 160);
            console.log(`[Bot] bigBrain request deferred until the guest's specific question is clear. reason="${reason}", transcript="${preview}"`);
            return { dispatched: false, reason: 'incomplete_request' };
        }

        const existing = Array.from(this.pendingBigBrainResponses.values())
            .find((pending) => pending.guildId === guildId);
        if (existing) {
            console.warn(`[Bot] bigBrain request skipped because run ${existing.runId} is still pending`);
            return { dispatched: false, reason: 'already_pending', runId: existing.runId };
        }

        const awarenessInjections = await this.selectAwarenessInjectionsForBigBrain(guildId, response, {
            ...options,
            transcript
        });
        const existingAfterSelection = Array.from(this.pendingBigBrainResponses.values())
            .find((pending) => pending.guildId === guildId);
        if (existingAfterSelection) {
            console.warn(`[Bot] bigBrain request skipped because run ${existingAfterSelection.runId} started during awareness selection`);
            return { dispatched: false, reason: 'already_pending', runId: existingAfterSelection.runId };
        }

        const runId = `discord-bigbrain-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const timeoutMs = Number.isFinite(this.bigBrainTimeoutMs)
            ? Math.max(1000, this.bigBrainTimeoutMs)
            : 180000;
        const prompt = this.buildBigBrainGatewayMessage(this.buildBigBrainPrompt(response, {
            ...options,
            transcript,
            awarenessInjections
        }));
        const pending = {
            guildId,
            runId,
            reason,
            transcript,
            awarenessInjections,
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

        this.sonifyBigBrainToolEvent(pending.guildId, pending, event);

        if (event.stream === 'tool') {
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

            await this.waitForPendingParticipantSpeechEvidenceBeforePlayback(guildId);
            if (this.discardStaleDirectResponse(guildId, options, 'after speech-evidence wait')) {
                this.disposeUnusedAudio(audio);
                return {
                    played: false,
                    stale: true,
                    finalResponse: await this.settleGeneratorResponse(response, 'stale response after speech-evidence wait')
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
            const injectedAwarenessInjections = this.formatAwarenessInjectionsForTranscript(options.awarenessInjections);
            if (injectedAwarenessInjections.length > 0) {
                transcriptEntry.injectedAwarenessInjections = injectedAwarenessInjections;
            }
            const presentedAwarenessShelfItems = this.formatAwarenessShelfItemsForTranscript(options.awarenessShelfItems);
            if (presentedAwarenessShelfItems.length > 0) {
                transcriptEntry.presentedAwarenessShelfItems = presentedAwarenessShelfItems;
            }
            this.voiceManager.saveTranscriptEntry(guildId, transcriptEntry);
            this.observeInternalThoughtTranscriptEntry(guildId, transcriptEntry);
            this.observeShowRunnerTranscriptEntry(guildId, transcriptEntry);
            this.resetConsecutiveGeneratorSilences(guildId);

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
            message,
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
        const isRequestTooLarge = summary.status === 413 ||
            /request too large|context length|too many tokens|maximum context/i.test(summary.message || '');
        const isRateLimit = summary.status === 429 ||
            (!isRequestTooLarge && summary.code === 'rate_limit_exceeded');
        const retryAfter = Number.isFinite(summary.retryAfterSeconds)
            ? Math.max(1, Math.ceil(summary.retryAfterSeconds))
            : null;
        const retryText = retryAfter
            ? ` Groq says to wait about ${retryAfter} second${retryAfter === 1 ? '' : 's'} before retrying.`
            : '';

        if (isRateLimit) {
            const sourceText = summary.failedApiKeySources.length > 1
                ? ' after trying both configured Groq keys'
                : '';
            return `I'm hitting a Groq rate limit (429)${sourceText} right now.${retryText} I may need you to ask that again in a moment.`;
        }

        if (isRequestTooLarge) {
            return `I hit Groq's request-size limit (413) before I could answer. I need to compact the conversation context and have you ask again in a moment.`;
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

            await this.waitForPendingParticipantSpeechEvidenceBeforePlayback(guildId);
            if (this.discardStaleDirectResponse(guildId, options, 'after fallback speech-evidence wait')) {
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

            const transcriptEntry = {
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
            };
            this.voiceManager.saveTranscriptEntry(guildId, transcriptEntry);
            this.observeInternalThoughtTranscriptEntry(guildId, transcriptEntry);
            this.observeShowRunnerTranscriptEntry(guildId, transcriptEntry);
            this.resetConsecutiveGeneratorSilences(guildId);

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
