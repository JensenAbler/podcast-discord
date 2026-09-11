/**
 * Voice Manager - Join/leave voice channels, manage connections
 * 
 * Handles Discord voice channel connections for the Alpha-Clawd Podcast
 */

const {
    joinVoiceChannel,
    VoiceConnectionStatus,
    EndBehaviorType,
    entersState,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus
} = require('@discordjs/voice');
const { pipeline } = require('stream');
const prism = require('prism-media');
const fs = require('fs');
const path = require('path');
const { AudioReceiver } = require('./audio-receiver');
const { AudioTransmitter } = require('./audio-transmitter');
const { LiveTurnController } = require('./live-turn-controller');
const { QuartzPlayback } = require('./quartz-playback');
const { AudioRecorder } = require('./audio-recorder');
const { EpisodePostProcessor } = require('./post-processor');
const { getRecordingDir } = require('./paths');

class VoiceManager {
    constructor(client, options = {}) {
        this.client = client;
        this.connections = new Map(); // guildId -> connection
        this.receivers = new Map(); // guildId -> AudioReceiver
        this.transmitters = new Map(); // guildId -> AudioTransmitter
        this.players = new Map(); // guildId -> audioPlayer
        this.quartzBackchannels = new Map(); // independent acknowledgment playback
        this.recorders = new Map(); // guildId -> AudioRecorder
        this.connectionChannels = new Map(); // guildId -> channelId
        this.isRecording = new Map(); // guildId -> boolean
        this.recordingPaths = new Map(); // guildId -> path
        this.recordingMetadata = new Map(); // guildId -> recording metadata
        this.transcriptSaveStops = new Map(); // guildId -> { stoppedAt, reason }
        
        this.options = {
            recordingDir: options.recordingDir || getRecordingDir(),
            silenceDuration: options.silenceDuration || 2000, // 2 seconds
            enableTranscription: options.enableTranscription !== false, // Default true
            voiceJoinAttempts: this.parsePositiveInt(
                options.voiceJoinAttempts ?? process.env.PODCAST_VOICE_JOIN_ATTEMPTS,
                2
            ),
            voiceJoinReadyTimeoutMs: this.parsePositiveInt(
                options.voiceJoinReadyTimeoutMs ?? process.env.PODCAST_VOICE_JOIN_READY_TIMEOUT_MS,
                30000
            ),
            audioPlayerMaxMissedFrames: this.parsePositiveInt(
                options.audioPlayerMaxMissedFrames ?? process.env.DISCORD_AUDIO_MAX_MISSED_FRAMES,
                1500
            ),
            ...options
        };

        // Initialize STT service for transcription.
        this.stt = options.stt;
        this.enableTranscription = this.options.enableTranscription;
        console.log(
            `[VoiceManager] Discord audio maxMissedFrames=${this.options.audioPlayerMaxMissedFrames}`
        );

        // Initialize post-processor for episode finalization
        this.postProcessor = new EpisodePostProcessor({
            recordingDir: this.options.recordingDir
        });

        // Ensure recording directory exists
        if (!fs.existsSync(this.options.recordingDir)) {
            fs.mkdirSync(this.options.recordingDir, { recursive: true });
        }

        this.recoveryPromise = AudioRecorder.recoverIncompleteRecordings(this.options.recordingDir)
            .then((recoveries) => {
                for (const recovery of recoveries) {
                    console.log(
                        `[VoiceManager] Recovered interrupted episode audio: ` +
                        `${recovery.episodePath} (${recovery.stems.length} stems)`
                    );
                }
                return recoveries;
            })
            .catch((error) => {
                console.error(`[VoiceManager] Interrupted recording recovery failed: ${error.message}`);
                return [];
            });

        this.handleVoiceStateUpdate = this.handleVoiceStateUpdate.bind(this);
        this.client.on('voiceStateUpdate', this.handleVoiceStateUpdate);
    }

    /**
     * Join a voice channel and set up audio handling
     * @param {VoiceChannel} channel - Discord voice channel
     * @param {Object} speakerMap - Map of Discord user IDs to speaker names
     * @returns {Promise<Object>} - Connection info
     */
    async joinChannel(channel, speakerMap = {}) {
        const guildId = channel.guild.id;

        // Leave existing connection if any
        if (this.connections.has(guildId)) {
            await this.leaveChannel(guildId);
        }

        console.log(`[VoiceManager] Joining voice channel: ${channel.name} (${channel.id})`);

        const connection = await this.connectToVoiceChannel(channel);

        // Store connection
        this.connections.set(guildId, connection);
        this.connectionChannels.set(guildId, channel.id);

        // Create audio player for transmitting
        const player = this.createPlaybackPlayer();
        this.players.set(guildId, player);
        connection.subscribe(player);

        // Create audio receiver for listening (with STT for transcription)
        // Pass bot's user ID to filter out self-audio
        const botUserId = this.client.user?.id;
        const receiver = new AudioReceiver({
            silenceDuration: this.options.silenceDuration,
            speakerMap: speakerMap,
            stt: this.stt,
            enableTranscription: this.enableTranscription,
            botUserId: botUserId,
            client: this.client,  // Pass Discord client for member lookups
            guildId: guildId,     // Pass guild ID for member lookups
            onUtterance: (utterance) => this.handleUtterance(guildId, utterance),
            onAudioChunk: (userId, chunk) => this.handleAudioChunk(guildId, userId, chunk),
            onSpeakingStart: (userId) => this.handleSpeakingStart(guildId, userId),
            onSpeakingStop: (userId) => this.handleSpeakingStop(guildId, userId),
            onSpeechEvidence: (userId, metadata) => this.handleSpeechEvidence(guildId, userId, metadata),
            onEndpointing: (userId, metadata) => this.handleEndpointing(guildId, userId, metadata),
            onAsrDispatched: (userId, metadata) => this.handleAsrDispatched(guildId, userId, metadata),
            onVadDiscarded: (userId, metadata) => this.handleVadDiscarded(guildId, userId, metadata),
            onAsrError: (userId, metadata) => this.handleAsrError(guildId, userId, metadata),
            getSpeechEvidenceFrameThreshold: (userId, stats, metadata) => this.getSpeechEvidenceFrameThreshold(guildId, userId, stats, metadata),
            getAsrCandidateFrameThreshold: (userId, stats, metadata) => this.getAsrCandidateFrameThreshold(guildId, userId, stats, metadata),
            onError: (error) => console.error('[VoiceManager] Receiver error:', error)
        });
        this.receivers.set(guildId, receiver);

        // Create audio transmitter for speaking
        const transmitter = new AudioTransmitter({
            player: player,
            onError: (error) => console.error('[VoiceManager] Transmitter error:', error)
        });
        this.transmitters.set(guildId, transmitter);

        // Set up connection event handlers
        connection.on(VoiceConnectionStatus.Disconnected, async () => {
            try {
                await Promise.race([
                    entersState(connection, VoiceConnectionStatus.Signalling, 5000),
                    entersState(connection, VoiceConnectionStatus.Connecting, 5000)
                ]);
            } catch (error) {
                console.log('[VoiceManager] Connection lost, cleaning up');
                this.leaveChannel(guildId);
            }
        });

        connection.on('error', (error) => {
            console.error('[VoiceManager] Connection error:', error);
        });

        // Start receiving audio
        receiver.start(connection);
        this.subscribeReceiverToChannelMembers(receiver, channel);

        return {
            guildId,
            channelId: channel.id,
            channelName: channel.name,
            status: 'connected'
        };
    }

    createPlaybackPlayer() {
        // @discordjs/voice emits an Opus silence packet for each missed frame.
        // Keep doing that while Fish is synthesizing, with a finite ceiling
        // matching the provider timeout in case an upstream stream hangs.
        return createAudioPlayer({
            behaviors: {
                maxMissedFrames: this.options.audioPlayerMaxMissedFrames
            }
        });
    }

    async connectToVoiceChannel(channel) {
        const attempts = this.parsePositiveInt(this.options.voiceJoinAttempts, 2);
        const readyTimeoutMs = this.parsePositiveInt(this.options.voiceJoinReadyTimeoutMs, 30000);
        let lastError = null;

        for (let attempt = 1; attempt <= attempts; attempt += 1) {
            const connection = joinVoiceChannel({
                channelId: channel.id,
                guildId: channel.guild.id,
                adapterCreator: channel.guild.voiceAdapterCreator,
                selfDeaf: false,
                selfMute: false
            });
            this.attachVoiceConnectionDebugLogging(connection, channel, attempt, attempts);

            try {
                await entersState(connection, VoiceConnectionStatus.Ready, readyTimeoutMs);
                console.log(`[VoiceManager] Connected to ${channel.name} on attempt ${attempt}/${attempts}`);
                return connection;
            } catch (error) {
                lastError = error;
                console.warn(`[VoiceManager] Voice join attempt ${attempt}/${attempts} failed for ${channel.name}: ${error.message}; finalStatus=${connection.state.status}`);
                this.destroyVoiceConnection(connection, `join attempt ${attempt} failed`);
                if (attempt < attempts) {
                    await this.delay(1000);
                }
            }
        }

        throw new Error(`Failed to join voice channel after ${attempts} attempt${attempts === 1 ? '' : 's'}: ${lastError?.message || 'unknown error'}`);
    }

    attachVoiceConnectionDebugLogging(connection, channel, attempt, attempts) {
        connection.on('stateChange', (oldState, newState) => {
            console.log(`[VoiceManager] Voice join state ${channel.name} attempt ${attempt}/${attempts}: ${oldState.status} -> ${newState.status}`);
        });

        connection.on('debug', (message) => {
            console.log(`[VoiceManager] Voice debug ${channel.name} attempt ${attempt}/${attempts}: ${message}`);
        });
    }

    destroyVoiceConnection(connection, reason = 'cleanup') {
        if (!connection || connection.state.status === VoiceConnectionStatus.Destroyed) {
            return;
        }

        try {
            connection.destroy();
            console.log(`[VoiceManager] Destroyed voice connection (${reason})`);
        } catch (error) {
            console.warn(`[VoiceManager] Failed to destroy voice connection (${reason}): ${error.message}`);
        }
    }

    delay(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    /**
     * Open persistent receive subscriptions for users already in the joined channel.
     * @param {AudioReceiver} receiver - Audio receiver for the guild
     * @param {VoiceChannel} channel - Discord voice channel
     */
    subscribeReceiverToChannelMembers(receiver, channel) {
        const botUserId = this.client.user?.id;

        for (const member of channel.members.values()) {
            if (member.id === botUserId) continue;
            receiver.subscribeToUser(member.id);
        }
    }

    /**
     * Keep receiver subscriptions aligned with actual voice-channel membership.
     * @param {VoiceState} oldState - Previous Discord voice state
     * @param {VoiceState} newState - New Discord voice state
     */
    async handleVoiceStateUpdate(oldState, newState) {
        const guildId = oldState.guild?.id || newState.guild?.id;
        const channelId = this.connectionChannels.get(guildId);
        if (!channelId) return;

        const userId = newState.id || oldState.id;
        if (!userId || userId === this.client.user?.id) return;

        const receiver = this.receivers.get(guildId);
        if (!receiver) return;

        const joinedTrackedChannel = newState.channelId === channelId && oldState.channelId !== channelId;
        const leftTrackedChannel = oldState.channelId === channelId && newState.channelId !== channelId;

        if (joinedTrackedChannel) {
            console.log(`[VoiceManager] User ${userId} joined active voice channel; opening receiver subscription`);
            receiver.subscribeToUser(userId);
            return;
        }

        if (leftTrackedChannel) {
            console.log(`[VoiceManager] User ${userId} left active voice channel; closing receiver subscription`);
            try {
                await receiver.flushUser(userId, 'user left voice channel');
            } catch (error) {
                console.error(`[VoiceManager] Error flushing audio for ${userId} on leave:`, error);
            }
            receiver.cleanupUser(userId, 'user left voice channel');
        }
    }

    /**
     * Leave a voice channel and clean up
     * @param {string} guildId - Discord guild ID
     */
    async leaveChannel(guildId, options = {}) {
        console.log(`[VoiceManager] Leaving voice channel in guild ${guildId}`);
        const shouldStopRecording = options.stopRecording !== false;
        await this.stopQuartzBackchannel(guildId);

        // Stop recording if active
        if (shouldStopRecording && this.isRecording.get(guildId)) {
            await this.stopRecording(guildId);
        } else if (!shouldStopRecording && this.isRecording.get(guildId)) {
            console.log(`[VoiceManager] Leaving voice channel before recording finalization for guild ${guildId}`);
        }

        // Clean up receiver
        const receiver = this.receivers.get(guildId);
        if (receiver) {
            receiver.destroy();
            this.receivers.delete(guildId);
        }

        // Clean up transmitter
        const transmitter = this.transmitters.get(guildId);
        if (transmitter) {
            transmitter.destroy();
            this.transmitters.delete(guildId);
        }

        // Clean up player
        const player = this.players.get(guildId);
        if (player) {
            player.stop();
            this.players.delete(guildId);
        }

        // Clean up recorder
        const recorder = shouldStopRecording ? this.recorders.get(guildId) : null;
        if (recorder) {
            recorder.destroy();
            this.recorders.delete(guildId);
        }

        // Destroy connection (internal)
        const connection = this.connections.get(guildId);
        if (connection) {
            this.destroyVoiceConnection(connection, 'leave channel');
            this.connections.delete(guildId);
        }
        this.connectionChannels.delete(guildId);
        
        // Also kick from Discord voice channel if still there (handles restart case)
        try {
            const guild = this.client.guilds.cache.get(guildId);
            if (guild && guild.members.me && guild.members.me.voice.channel) {
                console.log(`[VoiceManager] Disconnecting from Discord voice channel`);
                await guild.members.me.voice.disconnect();
            }
        } catch (e) {
            console.log(`[VoiceManager] Note: ${e.message}`);
        }

        console.log(`[VoiceManager] Left voice channel in guild ${guildId}`);
    }

    /**
     * Handle a completed utterance from a speaker
     * @param {string} guildId - Discord guild ID
     * @param {Object} utterance - Utterance data
     */
    async handleUtterance(guildId, utterance) {
        console.log(`[VoiceManager] Utterance from ${utterance.speaker}: "${utterance.transcription?.substring(0, 50)}..."`);

        // Emit event for external handling (AI interviewer)
        if (this.onUtterance) {
            this.onUtterance(guildId, utterance);
        }

        // Decoded participant PCM is journaled continuously in handleAudioChunk.
        // A completed utterance only contributes transcript metadata here.
        if (this.isRecording.get(guildId)) {
            this.saveTranscriptEntry(guildId, utterance);
        }
    }

    /**
     * Forward decoded 48 kHz stereo PCM while preserving the normal ASR path.
     * @param {string} guildId - Discord guild ID
     * @param {string} userId - Discord user ID
     * @param {Buffer} chunk - Raw s16le PCM
     */
    handleAudioChunk(guildId, userId, chunk) {
        if (this.isRecording.get(guildId)) {
            const recorder = this.recorders.get(guildId);
            recorder?.addParticipantAudioChunk(userId, chunk, {
                capturedAt: Date.now(),
                sampleRate: 48000,
                channels: 2
            });
        }

        this.quartzBackchannels?.get(guildId)?.pushAudio(userId, chunk);
        if (this.onAudioChunk) {
            this.onAudioChunk(guildId, userId, chunk);
        }
    }

    /**
     * Handle user starting to speak
     * @param {string} guildId - Discord guild ID
     * @param {string} userId - Discord user ID
     */
    handleSpeakingStart(guildId, userId) {
        // Emit event for external handling
        if (this.onSpeakingStart) {
            this.onSpeakingStart(guildId, userId);
        }
    }

    /**
     * Handle user stopping speaking
     * @param {string} guildId - Discord guild ID
     * @param {string} userId - Discord user ID
     */
    handleSpeakingStop(guildId, userId) {
        // Emit event for external handling
        if (this.onSpeakingStop) {
            this.onSpeakingStop(guildId, userId);
        }
    }

    /**
     * Handle receiver evidence that buffered audio has crossed the speech threshold.
     * @param {string} guildId - Discord guild ID
     * @param {string} userId - Discord user ID
     * @param {Object} metadata - { threshold, speakingFrames, silentFrames, ... }
     */
    handleSpeechEvidence(guildId, userId, metadata = {}) {
        if (this.onSpeechEvidence) {
            this.onSpeechEvidence(guildId, userId, metadata);
        }
    }

    /**
     * Handle a receiver-announced endpoint debounce window.
     * @param {string} guildId - Discord guild ID
     * @param {string} userId - Discord user ID
     * @param {Object} metadata - { active, reason, debounceMs, ... }
     */
    handleEndpointing(guildId, userId, metadata = {}) {
        if (this.onEndpointing) {
            this.onEndpointing(guildId, userId, metadata);
        }
    }

    /**
     * Handle a receiver-announced ASR dispatch (Fish call genuinely in flight).
     * @param {string} guildId - Discord guild ID
     * @param {string} userId - Discord user ID
     * @param {Object} metadata - { reason, audioBytes, speechDuration }
     */
    handleAsrDispatched(guildId, userId, metadata = {}) {
        if (this.onAsrDispatched) {
            this.onAsrDispatched(guildId, userId, metadata);
        }
    }

    /**
     * Handle a receiver-discarded VAD flap that never became an ASR candidate.
     * @param {string} guildId - Discord guild ID
     * @param {string} userId - Discord user ID
     * @param {Object} metadata - { reason, audioBytes, speakingFrames, silentFrames, ... }
     */
    handleVadDiscarded(guildId, userId, metadata = {}) {
        if (this.onVadDiscarded) {
            this.onVadDiscarded(guildId, userId, metadata);
        }
    }

    /**
     * Handle a receiver-announced ASR failure.
     * @param {string} guildId - Discord guild ID
     * @param {string} userId - Discord user ID
     * @param {Object} metadata - { reason, audioBytes, speechDuration, error }
     */
    handleAsrError(guildId, userId, metadata = {}) {
        if (this.onAsrError) {
            this.onAsrError(guildId, userId, metadata);
        }
    }

    getSpeechEvidenceFrameThreshold(guildId, userId, stats = {}, metadata = {}) {
        if (typeof this.onGetSpeechEvidenceFrameThreshold === 'function') {
            return this.onGetSpeechEvidenceFrameThreshold(guildId, userId, stats, metadata);
        }
        return 1;
    }

    getAsrCandidateFrameThreshold(guildId, userId, stats = {}, metadata = {}) {
        if (typeof this.onGetAsrCandidateFrameThreshold === 'function') {
            return this.onGetAsrCandidateFrameThreshold(guildId, userId, stats, metadata);
        }
        return 1;
    }

    /**
     * Add bot audio to the mixed recording
     * @param {string} guildId - Discord guild ID
     * @param {Buffer} audioBuffer - Audio buffer (MP3 from ElevenLabs)
     */
    addBotAudioToRecording(guildId, audioBuffer, options = {}) {
        if (!this.isRecording.get(guildId)) return;

        const recorder = this.recorders.get(guildId);
        if (recorder) {
            recorder.addBotAudio(audioBuffer, { volume: 0.9, ...options });
        }
    }

    addBotPcmChunkToRecording(guildId, audioBuffer, options = {}) {
        if (!this.isRecording.get(guildId)) return;
        this.recorders.get(guildId)?.addBotPcmChunk(audioBuffer, options);
    }

    anchorBotAudioRecordingGroup(guildId, groupId, playbackStartedAt) {
        if (!this.isRecording.get(guildId)) return;
        const startTime = typeof playbackStartedAt === 'string'
            ? Date.parse(playbackStartedAt)
            : Number(playbackStartedAt);
        if (!Number.isFinite(startTime)) return;
        this.recorders.get(guildId)?.anchorBotAudioGroup(groupId, startTime);
    }

    /**
     * Speak a message in the voice channel
     * @param {string} guildId - Discord guild ID
     * @param {Buffer|string} audio - Audio buffer or file path
     * @returns {Promise<void>}
     */
    async startQuartzBackchannel(guildId, options = {}) {
        if (!options.apiKey) {
            console.log('[Quartz] Not started: configure PODCAST_LIVE_API_KEY with an OpenAI API key');
            return false;
        }
        if (!this.isRecording.get(guildId)) return false;
        if (!this.quartzBackchannels) this.quartzBackchannels = new Map();
        if (this.quartzBackchannels.has(guildId)) return false;
        const connection = this.connections.get(guildId);
        const alphaPlayer = this.players.get(guildId);
        if (!connection || !alphaPlayer) return false;
        const recordingPath = this.recordingPaths.get(guildId);
        const logEvent = event => {
            console.log('[LiveTurn] ' + JSON.stringify(event));
            if (recordingPath && this.isRecording.get(guildId)) {
                try {
                    fs.appendFileSync(path.join(recordingPath, 'live-turn-events.jsonl'),
                        JSON.stringify({ ...event, observedAt: new Date().toISOString() }) + '\n');
                } catch { console.error('[LiveTurn] Event journal write failed'); }
            }
        };
        const host = new QuartzPlayback({
            turnControl: options.turnControl,
            onDelegation: event => host.turnController?.request(event),
            onInputTranscript: event => {
                host.turnController?.observe({ kind: 'guest-live', text: event.text });
                if (options.turnControl) logEvent({ event: 'input-transcript', ...event });
            },
            onClose: () => {
                host.turnController?.close();
                logEvent({ event: 'disconnected', mode: options.turnControl ? 'live-alpha' : 'current' });
            },
            connection, alphaPlayer, apiKey: options.apiKey, voice: options.voice || 'quartz',
            onPcm: pcm => this.addBotPcmChunkToRecording(guildId, pcm, {
                sourceId: 'quartz', sampleRate: 48000, channels: 2, capturedAt: Date.now(), volume: 1
            }),
            onTranscript: event => {
                host.turnController?.observe({ kind: 'quartz', text: event.text, playbackBlocked: event.playbackBlocked });
                // Generated transcript fragments are observations, not completed
                // Alpha turns. Keep them out of the conversation buffer and ASR.
                if (!this.isRecording.get(guildId) || !recordingPath) return;
                try {
                    fs.appendFileSync(path.join(recordingPath, 'quartz-transcript.jsonl'),
                        JSON.stringify({ ...event, observedAt: new Date().toISOString() }) + '\n');
                } catch (error) {
                    console.error('[Quartz] Transcript save failed:', error.message);
                }
            },
            onLog: message => {
                console.log('[Quartz] ' + message);
                logEvent({ event: 'live-context', mode: options.turnControl ? 'live-alpha' : 'current', message });
            },
            onError: error => console.error('[Quartz] ' + error.message)
        });
        if (options.turnControl) {
            host.turnController = new LiveTurnController({
                runAlpha: options.runAlpha,
                isActive: () => this.quartzBackchannels.get(guildId) === host && !host.closed && this.isRecording.get(guildId),
                setState: state => host.setEnvironment(state),
                report: (id, text) => host.reportDelegation(id, text),
                log: logEvent
            });
        }
        this.quartzBackchannels.set(guildId, host);
        try {
            await host.start();
            if (!host.closed && recordingPath) {
                // Includes the opening announcement and any guests heard during startup.
                const transcriptPath = path.join(recordingPath, 'transcript.jsonl');
                if (fs.existsSync(transcriptPath)) {
                    for (const line of fs.readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean)) {
                        const entry = JSON.parse(line);
                        this.observeQuartzTranscript(guildId, { ...entry, transcription: entry.text });
                    }
                }
            }
            return this.quartzBackchannels.get(guildId) === host;
        } catch (error) {
            if (this.quartzBackchannels.get(guildId) === host) this.quartzBackchannels.delete(guildId);
            await host.stop();
            console.error('[Quartz] Startup failed; Alpha continues normally:', error.message);
            return false;
        }
    }

    notifyQuartzBackendReady(guildId, kind, runId) {
        const host = this.quartzBackchannels?.get(guildId);
        if (!host?.turnController || host.turnController.closed) return;
        const text = kind + ' result is ready for Alpha to use on its next turn. No result has been spoken yet.';
        host.turnController.backendReady(kind + ':' + runId, text);
        host.appendConversation('Backend availability', text);
    }

    observeQuartzTranscript(guildId, entry) {
        const host = this.quartzBackchannels?.get(guildId);
        if (!host?.client?.started || host.closed) return;
        const text = entry.transcription || entry.text;
        if (!text) return;
        const alpha = entry.speakerRole === 'host';
        host.turnController?.observe({ kind: alpha ? 'alpha' : 'guest', speaker: entry.speaker, text });
        host.appendConversation(alpha ? 'Alpha delivered transcript' : 'Guest transcript',
            (entry.speaker || '') + ': ' + text);
    }

    updateQuartzProgress(guildId, stage, preview = '') {
        const quartz = this.quartzBackchannels?.get(guildId);
        if (!quartz) return;
        if (preview) quartz.alphaPreview = String(preview).slice(0, 600);
        if (stage === 'thinking' || stage === 'idle') quartz.alphaPreview = '';
        quartz.updateAlphaProgress(stage, preview);
    }

    async stopQuartzBackchannel(guildId) {
        const host = this.quartzBackchannels?.get(guildId);
        if (!host) return;
        this.quartzBackchannels.delete(guildId);
        await host.stop();
    }

    async speak(guildId, audio, options = {}) {
        const transmitter = this.transmitters.get(guildId);
        if (!transmitter) {
            console.error(`[VoiceManager] No transmitter for guild ${guildId}. Available: ${Array.from(this.transmitters.keys()).join(', ')}`);
            throw new Error('Not connected to voice channel');
        }

        const quartz = this.quartzBackchannels?.get(guildId);
        let release, audioError;
        const trackAudioError = error => { audioError = error; };
        if (quartz && typeof audio?.on === 'function') audio.on('error', trackAudioError);
        try {
            if (quartz) {
                // A streaming TTS handle can exist before its first audio byte.
                if (audio && typeof audio.once === 'function' && !audio.readableLength && !audio.readableEnded) {
                    await new Promise((resolve, reject) => {
                        const cleanup = () => {
                            clearTimeout(timer);
                            audio.off('readable', ready);
                            audio.off('error', failed);
                            audio.off('end', empty);
                            audio.off('close', empty);
                        };
                        const ready = () => { cleanup(); resolve(); };
                        const failed = error => { cleanup(); reject(error); };
                        const empty = () => failed(new Error('Alpha audio ended before becoming ready'));
                        const timer = setTimeout(() => failed(new Error('Alpha audio readiness timed out')), 15000);
                        audio.once('readable', ready);
                        audio.once('error', failed);
                        audio.once('end', empty);
                        audio.once('close', empty);
                    });
                }
                release = await quartz.acquireAlpha(options.alphaPreview || quartz.alphaPreview || '');
            }
            if (audioError) throw audioError;
            if (quartz && audio?.destroyed) throw new Error('Alpha audio closed during handoff');
            await transmitter.play(audio, {
                ...options,
                onFinish: () => {
                    try { options.onFinish?.(); } finally { release?.(); }
                },
                onError: error => {
                    try { options.onError?.(error); } finally { release?.(); }
                }
            });
        } catch (error) {
            release?.();
            if (audio && typeof audio.destroy === 'function') audio.destroy();
            throw error;
        } finally {
            if (quartz && typeof audio?.off === 'function') audio.off('error', trackAudioError);
        }
    }

    stopPlayback(guildId) {
        this.quartzBackchannels?.get(guildId)?.cancelPendingAlpha();
        const transmitter = this.transmitters.get(guildId);
        if (!transmitter) {
            return false;
        }

        transmitter.stop();
        return true;
    }

    /**
     * Speak audio and expose playback timing callbacks.
     * @param {string} guildId - Discord guild ID
     * @param {Buffer|string} audio - Audio buffer or file path
     * @param {Object} options - Playback options
     * @returns {Promise<Object>} - { timing, finished }
     */
    async speakWithTiming(guildId, audio, options = {}) {
        const timing = {
            playbackRequestedAt: new Date().toISOString(),
            playbackStartedAt: null,
            playbackEndedAt: null
        };

        let resolveFinished;
        let rejectFinished;
        const finished = new Promise((resolve, reject) => {
            resolveFinished = resolve;
            rejectFinished = reject;
        });

        try {
            await this.speak(guildId, audio, {
                ...options,
                onStart: () => {
                    timing.playbackStartedAt = new Date().toISOString();
                    if (typeof options.onStart === 'function') {
                        options.onStart(timing);
                    }
                },
                onFinish: () => {
                    timing.playbackEndedAt = new Date().toISOString();
                    if (typeof options.onFinish === 'function') {
                        options.onFinish(timing);
                    }
                    resolveFinished({ ...timing });
                },
                onError: (error) => {
                    timing.playbackErrorAt = new Date().toISOString();
                    if (typeof options.onError === 'function') {
                        options.onError(error, timing);
                    }
                    rejectFinished(error);
                }
            });
        } catch (error) {
            timing.playbackErrorAt = new Date().toISOString();
            resolveFinished({ ...timing });
            throw error;
        }

        return { timing, finished };
    }

    /**
     * Start recording the podcast with mixed audio
     * @param {string} guildId - Discord guild ID
     * @param {string} episodeName - Name of the episode
     * @param {Object} options - Recording options including consent info
     * @returns {Object} - Recording info
     */
    startRecording(guildId, episodeName, options = {}) {
        if (this.isRecording.get(guildId)) {
            throw new Error('Already recording');
        }

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const recordingPath = path.join(this.options.recordingDir, `${episodeName}-${timestamp}`);
        
        fs.mkdirSync(recordingPath, { recursive: true });
        const episodePlan = this.writeEpisodePlanSnapshot(recordingPath, options.episodePlan);
        
        // Create AudioRecorder instance
        const recorder = new AudioRecorder({
            outputFormat: 'mp3',
            sampleRate: 48000,
            channels: 2,
            onError: (error) => console.error('[VoiceManager] Recorder error:', error),
            onStart: (info) => console.log('[VoiceManager] Recording started:', info),
            onStop: (info) => console.log('[VoiceManager] Recording stopped:', info)
        });

        // Start recording with consent metadata
        const recordingInfo = recorder.startRecording(recordingPath, {
            consentGiven: options.consentGiven || false,
            consentTimestamp: options.consentTimestamp || new Date().toISOString(),
            episodeName,
            episodePlan
        });

        this.recorders.set(guildId, recorder);
        this.isRecording.set(guildId, true);
        this.recordingPaths.set(guildId, recordingPath);
        this.transcriptSaveStops.delete(guildId);
        const storedRecordingInfo = {
            ...recordingInfo,
            episodePlan
        };
        this.recordingMetadata.set(guildId, storedRecordingInfo);

        // Create transcript file
        const transcriptPath = path.join(recordingPath, 'transcript.jsonl');
        fs.writeFileSync(transcriptPath, '');

        console.log(`[VoiceManager] Started recording to ${recordingPath}`);

        return {
            recordingPath,
            transcriptPath,
            audioFilePath: recordingInfo.audioFilePath,
            startedAt: recordingInfo.startTime,
            consentTimestamp: recordingInfo.consentTimestamp,
            episodePlan
        };
    }

    writeEpisodePlanSnapshot(recordingPath, input = null) {
        if (!input) {
            return null;
        }

        const plan = input.plan || input.snapshot || input;
        if (!plan || typeof plan !== 'object') {
            return null;
        }

        const basename = String(input.basename || plan.basename || '').trim();
        const version = String(input.version || plan.version || '').trim();
        const sourcePath = String(input.path || input.sourcePath || '').trim();
        const relativePath = 'episode-plan.json';
        const outputPath = path.join(recordingPath, relativePath);

        try {
            fs.writeFileSync(outputPath, JSON.stringify(plan, null, 2));
            return {
                basename,
                version,
                path: relativePath,
                sourcePath: sourcePath || null
            };
        } catch (error) {
            console.warn(`[VoiceManager] Failed to write episode plan snapshot: ${error.message}`);
            return {
                basename,
                version,
                path: null,
                sourcePath: sourcePath || null,
                error: error.message
            };
        }
    }

    /**
     * Stop recording and finalize mixed audio
     * @param {string} guildId - Discord guild ID
     * @returns {Object} - Recording result
     */
    async stopRecording(guildId) {
        await this.stopQuartzBackchannel(guildId);
        if (!this.isRecording.get(guildId)) {
            throw new Error('Not recording');
        }

        const recordingPath = this.recordingPaths.get(guildId);
        const recorder = this.recorders.get(guildId);
        const receiver = this.receivers.get(guildId);
        const storedMetadata = this.recordingMetadata.get(guildId) || {};
        let audioResult = null;

        if (receiver) {
            await receiver.flushAll('recording stop');
        }

        // Stop the audio recorder
        if (recorder) {
            try {
                audioResult = await recorder.stopRecording();
                console.log(`[VoiceManager] Mixed audio saved: ${audioResult.audioFilePath}`);
            } catch (error) {
                console.error('[VoiceManager] Error stopping audio recorder:', error);
            }
            this.recorders.delete(guildId);
        }

        this.isRecording.set(guildId, false);

        // Compile final recording metadata
        const transcriptPath = path.join(recordingPath, 'transcript.jsonl');
        const finalPath = path.join(recordingPath, 'episode-complete.json');
        const startedAt = audioResult
            ? audioResult.startTime
            : this.recordingMetadata.get(guildId)?.startTime || null;

        const recording = {
            guildId,
            recordingPath,
            transcriptPath,
            startedAt,
            stoppedAt: new Date().toISOString(),
            files: this.listRecordingFiles(recordingPath, ['episode-complete.json']),
            mixedAudio: audioResult ? path.basename(audioResult.audioFilePath) : null,
            duration: audioResult ? audioResult.duration : 0,
            consent: {
                given: audioResult ? audioResult.consentGiven : false,
                timestamp: audioResult ? audioResult.consentTimestamp : null
            },
            episodePlan: storedMetadata.episodePlan || null
        };

        fs.writeFileSync(finalPath, JSON.stringify(recording, null, 2));

        console.log(`[VoiceManager] Stopped recording. Files saved to ${recordingPath}`);

        // Clean up metadata
        this.recordingMetadata.delete(guildId);

        // Post-process: generate clean transcript artifacts from transcript.jsonl
        try {
            console.log('[VoiceManager] Starting post-processing...');
            const postProcessResult = await this.postProcessor.processEpisode(recording);
            recording.postProcessed = true;
            recording.transcriptFile = postProcessResult.files?.transcript;
            recording.transcriptJsonFile = postProcessResult.files?.transcriptJson;
            console.log('[VoiceManager] Post-processing complete');
        } catch (error) {
            console.error('[VoiceManager] Post-processing failed:', error.message);
            recording.postProcessed = false;
            recording.postProcessError = error.message;
        }

        recording.files = this.listRecordingFiles(recordingPath, ['episode-complete.json']);
        fs.writeFileSync(finalPath, JSON.stringify(recording, null, 2));

        return recording;
    }

    /**
     * Stop saving transcript rows for a recording that is ending.
     * Audio finalization may continue after this point, but post-leave ASR
     * results should not extend the transcript beyond the audible episode.
     * @param {string} guildId - Discord guild ID
     * @param {string} reason - Stop reason for logs
     */
    stopTranscriptSaving(guildId, reason = 'recording_stop') {
        const stoppedAt = new Date().toISOString();
        this.transcriptSaveStops.set(guildId, { stoppedAt, reason });
        console.log(`[VoiceManager] Transcript saving stopped for guild ${guildId}: ${reason} at ${stoppedAt}`);
    }

    isTranscriptSavingStopped(guildId) {
        return this.transcriptSaveStops.has(guildId);
    }

    listRecordingFiles(recordingPath, additionalFiles = []) {
        const files = new Set(fs.existsSync(recordingPath) ? fs.readdirSync(recordingPath) : []);
        for (const file of additionalFiles) {
            files.add(file);
        }

        return Array.from(files).sort();
    }

    /**
     * Save a transcript entry
     * @param {string} guildId - Discord guild ID
     * @param {Object} utterance - Utterance data
     */
    saveTranscriptEntry(guildId, utterance) {
        const recordingPath = this.recordingPaths.get(guildId);
        if (!recordingPath) return;
        const stopped = this.transcriptSaveStops.get(guildId);
        if (stopped) {
            const speaker = utterance.speaker || 'Unknown';
            const source = utterance.source || utterance.fallbackReason || 'unknown';
            console.log(`[VoiceManager] Skipped transcript after stop (${stopped.reason}): ${speaker} source=${source}`);
            return;
        }
        const transcriptionText = (utterance.transcription || '').trim();
        const audioEvents = utterance.audioEvents || [];
        const providerError = utterance.providerError || null;
        // Preserve forensic record of audio events (phantom mic-feedback
        // transcripts, etc.) even when normalized transcription is empty.
        if (!transcriptionText && audioEvents.length === 0 && !providerError) return;

        const transcriptPath = path.join(recordingPath, 'transcript.jsonl');
        
        // Create a clean transcript entry WITHOUT raw audio buffer
        // transcript.jsonl should only contain text metadata, not binary data
        const cleanEntry = {
            timestamp: utterance.timestamp || new Date().toISOString(),
            speaker: utterance.speaker || 'Unknown',
            speakerRole: utterance.speakerRole || 'guest',
            text: utterance.transcription || '',
            rawTranscription: utterance.rawTranscription || null,
            textConfidence: utterance.transcriptionConfidence || null,
            language: utterance.language || null,
            duration: utterance.duration ?? 0,
            userId: utterance.userId,
            speechStartedAt: utterance.speechStartedAt || null,
            speechEndedAt: utterance.speechEndedAt || null,
            speechDuration: utterance.speechDuration ?? null,
            asrStartedAt: utterance.asrStartedAt || null,
            asrCompletedAt: utterance.asrCompletedAt || null,
            generatedAt: utterance.generatedAt || null,
            ttsStartedAt: utterance.ttsStartedAt || null,
            ttsCompletedAt: utterance.ttsCompletedAt || null,
            playbackRequestedAt: utterance.playbackRequestedAt || null,
            playbackStartedAt: utterance.playbackStartedAt || null,
            playbackEndedAt: utterance.playbackEndedAt || null,
            source: utterance.source || null,
            fallbackReason: utterance.fallbackReason || null,
            providerError,
            injectedAwarenessInjections: Array.isArray(utterance.injectedAwarenessInjections)
                ? utterance.injectedAwarenessInjections.map((item) => ({
                    id: item.id || '',
                    packetId: item.packetId || '',
                    createdAt: item.createdAt || null,
                    awarenessInjection: item.awarenessInjection || '',
                    reason: item.reason || '',
                    turnIdIntent: item.turnIdIntent || null,
                    expiresAfterTurns: item.expiresAfterTurns || 0,
                    remainingTurns: item.remainingTurns || 0
                }))
                : null,
            presentedAwarenessShelfItems: Array.isArray(utterance.presentedAwarenessShelfItems)
                ? utterance.presentedAwarenessShelfItems.map((item) => ({
                    id: item.id || '',
                    text: item.text || '',
                    reason: item.reason || '',
                    topicAnchors: Array.isArray(item.topicAnchors) ? item.topicAnchors : [],
                    createdAt: item.createdAt || null,
                    updatedAt: item.updatedAt || null,
                    originTimestamp: item.originTimestamp || null,
                    originEpisodeTimestamp: item.originEpisodeTimestamp || null,
                    originEpisodeOffsetMs: item.originEpisodeOffsetMs ?? null,
                    expiresAfterTurns: item.expiresAfterTurns ?? null,
                    presentedCount: item.presentedCount ?? 0,
                    remainingTurns: item.remainingTurns ?? null
                }))
                : null,
            words: (utterance.words || []).map(w => ({
                text: w.text || w.word,
                start: w.start,
                end: w.end,
                confidence: w.confidence || w.probability,
                type: w.type || 'word'
            })),
            wordCount: (utterance.words || []).length,
            lowConfidenceWords: (utterance.words || [])
                .filter(w => (w.confidence || w.probability || 1) < 0.7)
                .map(w => w.text || w.word),
            audioEvents: [
                ...(utterance.audioEvents || []),
                ...(utterance.words || [])
                    .filter(w => w.type === 'audio_event' || /\[.*\]/.test(w.text || w.word))
                    .map(w => w.text || w.word)
            ]
        };

        const entry = JSON.stringify(cleanEntry);
        fs.appendFileSync(transcriptPath, entry + '\n');
        this.observeQuartzTranscript?.(guildId, utterance);
        
        const wordCount = cleanEntry.wordCount;
        const lowConfCount = cleanEntry.lowConfidenceWords.length;
        const events = cleanEntry.audioEvents.length > 0 ? ` [Events: ${cleanEntry.audioEvents.join(', ')}]` : '';
        console.log(`[VoiceManager] Saved transcript: ${utterance.speaker}: "${cleanEntry.text.substring(0, 50)}..." (${wordCount} words${lowConfCount > 0 ? `, ${lowConfCount} low-conf` : ''}${events})`);
    }

    /**
     * Get connection status
     * @param {string} guildId - Discord guild ID
     * @returns {Object|null}
     */
    getStatus(guildId) {
        const connection = this.connections.get(guildId);
        if (!connection) return null;

        const recorder = this.recorders.get(guildId);
        const recordingInfo = recorder ? recorder.getRecordingInfo() : null;

        return {
            connected: connection.state.status === VoiceConnectionStatus.Ready,
            state: connection.state.status,
            isRecording: this.isRecording.get(guildId) || false,
            recordingPath: this.recordingPaths.get(guildId) || null,
            recordingInfo: recordingInfo
        };
    }

    /**
     * Get playback status for a guild.
     * @param {string} guildId - Discord guild ID
     * @returns {Object}
     */
    getPlaybackStatus(guildId) {
        const transmitter = this.transmitters.get(guildId);
        if (!transmitter) {
            return {
                isPlaying: false,
                queueLength: 0
            };
        }

        return {
            isPlaying: transmitter.isCurrentlyPlaying(),
            queueLength: transmitter.getQueueLength()
        };
    }

    /**
     * Get recording info for a guild
     * @param {string} guildId - Discord guild ID
     * @returns {Object|null}
     */
    getRecordingInfo(guildId) {
        const recorder = this.recorders.get(guildId);
        if (!recorder) return null;
        return recorder.getRecordingInfo();
    }

    /**
     * Check if connected to a voice channel
     * @param {string} guildId - Discord guild ID
     * @returns {boolean}
     */
    isConnected(guildId) {
        // First check our internal connection Map
        const connection = this.connections.get(guildId);
        if (connection) {
            const validStates = [
                VoiceConnectionStatus.Ready,
                VoiceConnectionStatus.Signalling,
                VoiceConnectionStatus.Connecting
            ];
            if (validStates.includes(connection.state.status)) {
                return true;
            }
        }
        
        // Also check Discord's actual voice state (for reconnections after restart)
        try {
            const guild = this.client.guilds.cache.get(guildId);
            if (guild && guild.members.me && guild.members.me.voice.channel) {
                return true;
            }
        } catch (e) {
            // Ignore errors, just means we're not connected
        }
        
        return false;
    }

    /**
     * Set the utterance handler callback
     * @param {Function} handler - (guildId, utterance) => void
     */
    setUtteranceHandler(handler) {
        this.onUtterance = handler;
    }

    /**
     * Set the decoded PCM handler callback.
     * @param {Function} handler - (guildId, userId, chunk) => void
     */
    setAudioChunkHandler(handler) {
        this.onAudioChunk = handler;
    }

    /**
     * Set the speaking start handler callback
     * @param {Function} handler - (guildId, userId) => void
     */
    setSpeakingStartHandler(handler) {
        this.onSpeakingStart = handler;
    }

    /**
     * Set the speaking stop handler callback
     * @param {Function} handler - (guildId, userId) => void
     */
    setSpeakingStopHandler(handler) {
        this.onSpeakingStop = handler;
    }

    /**
     * Set the speech-evidence handler callback.
     * @param {Function} handler - (guildId, userId, { threshold, speakingFrames, ... }) => void
     */
    setSpeechEvidenceHandler(handler) {
        this.onSpeechEvidence = handler;
    }

    /**
     * Set the endpoint-debounce handler callback.
     * @param {Function} handler - (guildId, userId, { active, reason, debounceMs, ... }) => void
     */
    setEndpointingHandler(handler) {
        this.onEndpointing = handler;
    }

    /**
     * Set the ASR-dispatched handler callback (Fish call in flight).
     * @param {Function} handler - (guildId, userId, { reason, audioBytes, speechDuration }) => void
     */
    setAsrDispatchedHandler(handler) {
        this.onAsrDispatched = handler;
    }

    /**
     * Set the discarded-VAD handler callback.
     * @param {Function} handler - (guildId, userId, { reason, audioBytes, speakingFrames, ... }) => void
     */
    setVadDiscardedHandler(handler) {
        this.onVadDiscarded = handler;
    }

    /**
     * Set the ASR-error handler callback.
     * @param {Function} handler - (guildId, userId, { reason, audioBytes, speechDuration, error }) => void
     */
    setAsrErrorHandler(handler) {
        this.onAsrError = handler;
    }

    /**
     * Set the receiver speech-evidence threshold provider.
     * @param {Function} provider - (guildId, userId, stats, metadata) => frame threshold
     */
    setSpeechEvidenceFrameThresholdProvider(provider) {
        this.onGetSpeechEvidenceFrameThreshold = provider;
    }

    /**
     * Set the receiver ASR-candidate threshold provider.
     * @param {Function} provider - (guildId, userId, stats, metadata) => frame threshold
     */
    setAsrCandidateFrameThresholdProvider(provider) {
        this.onGetAsrCandidateFrameThreshold = provider;
    }

    /**
     * Get the speaker tracker for a guild
     * @param {string} guildId - Discord guild ID
     * @returns {SpeakerTracker|null}
     */
    getSpeakerTracker(guildId) {
        const receiver = this.receivers.get(guildId);
        if (!receiver) return null;
        return receiver.speakerTracker;
    }

    parsePositiveInt(value, fallback) {
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed <= 0) {
            return fallback;
        }
        return Math.floor(parsed);
    }
}

module.exports = { VoiceManager };
