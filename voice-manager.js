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
        this.recorders = new Map(); // guildId -> AudioRecorder
        this.connectionChannels = new Map(); // guildId -> channelId
        this.isRecording = new Map(); // guildId -> boolean
        this.recordingPaths = new Map(); // guildId -> path
        this.recordingMetadata = new Map(); // guildId -> recording metadata
        
        this.options = {
            recordingDir: options.recordingDir || getRecordingDir(),
            silenceDuration: options.silenceDuration || 2000, // 2 seconds
            enableTranscription: options.enableTranscription !== false, // Default true
            ...options
        };

        // Initialize STT service for transcription.
        this.stt = options.stt;
        this.enableTranscription = this.options.enableTranscription;

        // Initialize post-processor for episode finalization
        this.postProcessor = new EpisodePostProcessor({
            recordingDir: this.options.recordingDir
        });

        // Ensure recording directory exists
        if (!fs.existsSync(this.options.recordingDir)) {
            fs.mkdirSync(this.options.recordingDir, { recursive: true });
        }

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

        // Create voice connection with the legacy encryption mode for broad deploy compatibility.
        const connection = joinVoiceChannel({
            channelId: channel.id,
            guildId: channel.guild.id,
            adapterCreator: channel.guild.voiceAdapterCreator,
            selfDeaf: false,
            selfMute: false,
        });

        // Wait for connection to be ready
        try {
            await entersState(connection, VoiceConnectionStatus.Ready, 30000);
            console.log(`[VoiceManager] Connected to ${channel.name}`);
        } catch (error) {
            connection.destroy();
            throw new Error(`Failed to join voice channel: ${error.message}`);
        }

        // Store connection
        this.connections.set(guildId, connection);
        this.connectionChannels.set(guildId, channel.id);

        // Create audio player for transmitting
        const player = createAudioPlayer();
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
    async leaveChannel(guildId) {
        console.log(`[VoiceManager] Leaving voice channel in guild ${guildId}`);

        // Stop recording if active
        if (this.isRecording.get(guildId)) {
            await this.stopRecording(guildId);
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
        const recorder = this.recorders.get(guildId);
        if (recorder) {
            recorder.destroy();
            this.recorders.delete(guildId);
        }

        // Destroy connection (internal)
        const connection = this.connections.get(guildId);
        if (connection) {
            connection.destroy();
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

        // If recording, save utterance to transcript and mixed audio
        if (this.isRecording.get(guildId)) {
            this.saveTranscriptEntry(guildId, utterance);

            // Add speaker audio to mixed recording
            const recorder = this.recorders.get(guildId);
            if (recorder && utterance.audioBuffer) {
                recorder.addSpeakerAudio(utterance.userId, utterance.audioBuffer, {
                    volume: 1.0,
                    startTime: utterance.startTime
                });
            }
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

    /**
     * Speak a message in the voice channel
     * @param {string} guildId - Discord guild ID
     * @param {Buffer|string} audio - Audio buffer or file path
     * @returns {Promise<void>}
     */
    async speak(guildId, audio, options = {}) {
        const transmitter = this.transmitters.get(guildId);
        if (!transmitter) {
            console.error(`[VoiceManager] No transmitter for guild ${guildId}. Available: ${Array.from(this.transmitters.keys()).join(', ')}`);
            throw new Error('Not connected to voice channel');
        }

        await transmitter.play(audio, options);
    }

    stopPlayback(guildId) {
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
        
        // Create AudioRecorder instance
        const recorder = new AudioRecorder({
            outputFormat: 'wav',
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
            episodeName
        });

        this.recorders.set(guildId, recorder);
        this.isRecording.set(guildId, true);
        this.recordingPaths.set(guildId, recordingPath);
        this.recordingMetadata.set(guildId, recordingInfo);

        // Create transcript file
        const transcriptPath = path.join(recordingPath, 'transcript.jsonl');
        fs.writeFileSync(transcriptPath, '');

        console.log(`[VoiceManager] Started recording to ${recordingPath}`);

        return {
            recordingPath,
            transcriptPath,
            audioFilePath: recordingInfo.audioFilePath,
            startedAt: recordingInfo.startTime,
            consentTimestamp: recordingInfo.consentTimestamp
        };
    }

    /**
     * Stop recording and finalize mixed audio
     * @param {string} guildId - Discord guild ID
     * @returns {Object} - Recording result
     */
    async stopRecording(guildId) {
        if (!this.isRecording.get(guildId)) {
            throw new Error('Not recording');
        }

        const recordingPath = this.recordingPaths.get(guildId);
        const recorder = this.recorders.get(guildId);
        const receiver = this.receivers.get(guildId);
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
            }
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
}

module.exports = { VoiceManager };
