/**
 * Audio Receiver - Receive audio from Discord users, buffer until silence
 *
 * Handles receiving Opus-encoded audio from Discord voice channels,
 * converting to PCM, buffering per speaker, and detecting silence.
 *
 * Lifecycle:
 * - A Discord receive subscription is a voice-channel resource. It is opened
 *   once for a user and kept alive until the user leaves, the bot leaves, or
 *   the receive stream errors/closes.
 * - An utterance buffer is a short-lived in-memory chunk list. SilenceDetector
 *   rolls this buffer over by snapshotting current chunks, clearing the list,
 *   and resetting the detector for the next utterance.
 * - Silence never calls cleanupUser. cleanupUser is reserved for real teardown
 *   and is where the underlying Discord stream subscription is destroyed.
 */

const { EndBehaviorType } = require('@discordjs/voice');
const prism = require('prism-media');
const { Writable } = require('stream');
const { SilenceDetector } = require('./silence-detector');
const { SpeakerTracker } = require('./speaker-tracker');
const { ElevenLabsIntegration } = require('./elevenlabs-integration');

class AudioReceiver {
    constructor(options = {}) {
        this.options = {
            silenceDuration: options.silenceDuration || 2000, // 2 seconds
            endpointingDebounce: options.endpointingDebounce || 50, // ms to wait after Discord stop before flushing for ASR
            speakerMap: options.speakerMap || {},
            maxUtteranceDuration: options.maxUtteranceDuration || 60000, // 60 seconds
            onUtterance: options.onUtterance || (() => {}),
            onSpeakingStart: options.onSpeakingStart || (() => {}),
            onSpeakingStop: options.onSpeakingStop || (() => {}),
            onEndpointing: options.onEndpointing || (() => {}), // (userId, { active, reason, debounceMs }) — Discord-stop debounce window
            onAsrDispatched: options.onAsrDispatched || (() => {}), // (userId, { reason, audioBytes, speechDuration }) — fires immediately before stt.transcribe
            onError: options.onError || console.error,
            enableTranscription: options.enableTranscription !== false, // Default true
            botUserId: options.botUserId, // Bot's own user ID to filter self-audio
            client: options.client,       // Discord client for member lookups
            guildId: options.guildId,     // Guild ID for member lookups
            ...options
        };

        // Initialize STT service (ElevenLabs Scribe)
        this.stt = options.stt;
        this.enableTranscription = this.options.enableTranscription;

        // Speaker audio buffers: userId -> { chunks: Buffer[], startTime, speakerInfo, detector }
        this.speakerBuffers = new Map();

        // Speaker tracker for conversation history
        this.speakerTracker = new SpeakerTracker();

        // Active subscriptions to clean up
        this.subscriptions = new Map(); // userId -> { stream, decoder, handler, detector, closing }

        // Transcription work that must finish before a recording can be finalized.
        this.processingUtterances = new Set();
        this.processingChains = new Map();

        this.activeSpeakers = new Set();
        this.connection = null;
        this.isRunning = false;
    }

    /**
     * Start receiving audio from a voice connection
     * @param {VoiceConnection} connection - Discord voice connection
     */
    start(connection) {
        if (this.isRunning) {
            throw new Error('Receiver already running');
        }

        this.connection = connection;
        this.isRunning = true;

        console.log('[AudioReceiver] Starting audio reception');

        // Listen for users starting to speak
        connection.receiver.speaking.on('start', (userId) => {
            this.handleUserStartSpeaking(userId);
        });

        // Listen for users stopping speaking
        connection.receiver.speaking.on('end', (userId) => {
            this.handleUserStopSpeaking(userId);
        });
    }

    /**
     * Handle user starting to speak
     * @param {string} userId - Discord user ID
     */
    handleUserStartSpeaking(userId) {
        if (!this.isRunning) return;

        // Skip bot's own audio to prevent feedback/duplication
        if (userId === this.options.botUserId) {
            return;
        }

        // User resumed within the debounce window — same utterance, keep accumulating.
        this.cancelEndpointTimer(userId, 'speaker resumed');

        if (!this.activeSpeakers.has(userId)) {
            this.activeSpeakers.add(userId);
            console.log(`[AudioReceiver] User ${userId} started speaking`);
            this.options.onSpeakingStart(userId);
        }

        this.subscribeToUser(userId);
    }

    /**
     * Subscribe to a user's Discord receive stream without marking them speaking.
     * This is safe to call repeatedly; the stream stays open until real teardown.
     * @param {string} userId - Discord user ID
     * @returns {boolean} - Whether a subscription exists or was opened
     */
    subscribeToUser(userId) {
        if (!this.isRunning || !this.connection) return false;
        if (userId === this.options.botUserId) return false;

        const buffer = this.ensureUserBuffer(userId);

        if (this.subscriptions.has(userId)) {
            return true;
        }

        console.log(`[AudioReceiver] Opening persistent audio subscription for ${userId}`);

        // Subscribe to user's audio stream. Manual end behavior keeps the stream
        // alive across silence boundaries; cleanupUser performs the actual close.
        const audioStream = this.connection.receiver.subscribe(userId, {
            end: {
                behavior: EndBehaviorType.Manual
            }
        });

        // Create Opus decoder
        const opusDecoder = new prism.opus.Decoder({
            frameSize: 960,
            channels: 2,
            rate: 48000
        });

        // Create PCM stream handler
        const pcmHandler = new Writable({
            write: (chunk, encoding, callback) => {
                this.handleAudioChunk(userId, chunk);
                callback();
            }
        });

        const subscription = {
            stream: audioStream,
            decoder: opusDecoder,
            handler: pcmHandler,
            detector: buffer.detector,
            closing: false
        };

        this.subscriptions.set(userId, subscription);

        const finishUnexpectedly = (eventName) => {
            if (subscription.closing) return;
            subscription.closing = true;

            console.log(`[AudioReceiver] Audio stream ${eventName} for ${userId}`);
            this.flushUser(userId, `audio stream ${eventName}`)
                .finally(() => this.cleanupUser(userId, `audio stream ${eventName}`));
        };

        // Set up pipeline: Opus -> PCM -> Handler
        audioStream.pipe(opusDecoder).pipe(pcmHandler);

        // Handle stream end/close. With Manual end behavior, these should only
        // happen unexpectedly or after explicit teardown.
        audioStream.once('end', () => finishUnexpectedly('ended'));
        audioStream.once('close', () => finishUnexpectedly('closed'));

        // Handle errors
        audioStream.once('error', (error) => {
            console.error(`[AudioReceiver] Audio stream error for ${userId}:`, error);
            this.cleanupUser(userId, 'audio stream error');
        });

        opusDecoder.once('error', (error) => {
            console.error(`[AudioReceiver] Opus decoder error for ${userId}:`, error);
            this.cleanupUser(userId, 'opus decoder error');
        });

        pcmHandler.once('error', (error) => {
            console.error(`[AudioReceiver] PCM handler error for ${userId}:`, error);
            this.cleanupUser(userId, 'pcm handler error');
        });

        return true;
    }

    /**
     * Ensure a user has an utterance buffer and silence detector.
     * @param {string} userId - Discord user ID
     * @returns {Object} - Speaker buffer
     */
    ensureUserBuffer(userId) {
        const existing = this.speakerBuffers.get(userId);
        if (existing) {
            return existing;
        }

        const speakerInfo = this.getSpeakerInfo(userId);

        const silenceDetector = new SilenceDetector({
            silenceDuration: this.options.silenceDuration,
            onSilence: () => this.handleSilenceDetected(userId)
        });

        const buffer = {
            chunks: [],
            startTime: null,
            speakerInfo: speakerInfo,
            detector: silenceDetector,
            endpointTimer: null
        };

        this.speakerBuffers.set(userId, buffer);
        return buffer;
    }

    /**
     * Handle user stopping speaking (initial silence indication)
     * @param {string} userId - Discord user ID
     */
    handleUserStopSpeaking(userId) {
        if (this.activeSpeakers.delete(userId)) {
            console.log(`[AudioReceiver] User ${userId} stopped speaking`);
            this.options.onSpeakingStop(userId);
        }

        const buffer = this.speakerBuffers.get(userId);
        if (buffer && buffer.detector) {
            buffer.detector.speakingStopped();
            // Discord-stop is ambiguous (mid-sentence breath vs end-of-thought).
            // Arm a debounce; if the user resumes, the timer is canceled. If it
            // expires, flushUser snapshots and ASR is dispatched. The in-stream
            // SilenceDetector may also beat us to flushUser; either way the
            // endpoint timer is canceled by snapshotUserBuffer.
            if (this.hasAsrCandidate(buffer)) {
                this.armEndpointTimer(userId, 'speaking stop with buffered audio');
            } else if (buffer.chunks.length > 0) {
                this.discardUserBuffer(userId, 'non-speech VAD flap');
            }
        }
    }

    /**
     * Handle incoming audio chunk
     * @param {string} userId - Discord user ID
     * @param {Buffer} chunk - PCM audio data
     */
    handleAudioChunk(userId, chunk) {
        const buffer = this.speakerBuffers.get(userId);
        if (!buffer) return;

        if (buffer.chunks.length === 0) {
            buffer.startTime = Date.now();
        }

        // Add chunk to buffer
        buffer.chunks.push(chunk);

        // Feed to silence detector
        buffer.detector.processAudio(chunk);

        // Stream to recorder in real-time (for mixed audio recording)
        if (this.options.onAudioChunk) {
            this.options.onAudioChunk(userId, chunk);
        }

        // Check for max utterance duration
        const duration = buffer.startTime ? Date.now() - buffer.startTime : 0;
        if (duration > this.options.maxUtteranceDuration) {
            console.log(`[AudioReceiver] Max utterance duration reached for ${userId}`);
            this.flushUser(userId, 'max utterance duration');
        }
    }

    /**
     * Handle silence detected for a user
     * @param {string} userId - Discord user ID
     */
    handleSilenceDetected(userId) {
        console.log(`[AudioReceiver] Silence detected for ${userId}, rolling over utterance buffer`);
        return this.flushUser(userId, 'silence detected');
    }

    /**
     * Whether the current receiver buffer represents speech-like audio that
     * should eventually become an ASR result.
     * @param {Object} buffer - Speaker buffer
     * @returns {boolean}
     */
    hasAsrCandidate(buffer) {
        if (!buffer || buffer.chunks.length === 0) return false;

        const stats = buffer.detector?.getStats?.();
        return !stats || stats.speakingFrames > 0;
    }

    /**
     * Drop buffered audio that never crossed the speech detector. Persistent
     * Discord subscriptions can receive tiny VAD blips; if we keep their PCM,
     * it gets prepended to the next real utterance and contaminates the mix.
     * @param {string} userId - Discord user ID
     * @param {string} reason - Reason for discarding the buffer
     */
    discardUserBuffer(userId, reason) {
        const buffer = this.speakerBuffers.get(userId);
        if (!buffer) return;

        const audioBytes = buffer.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
        const stats = buffer.detector?.getStats?.() || {};

        buffer.chunks = [];
        buffer.startTime = null;

        if (buffer.endpointTimer) {
            clearTimeout(buffer.endpointTimer);
            buffer.endpointTimer = null;
            this.options.onEndpointing(userId, { active: false, reason: `discard: ${reason}` });
        }

        if (buffer.detector) {
            buffer.detector.reset();
        }

        console.log(
            `[AudioReceiver] Discarded ${audioBytes} bytes for ${userId} (${reason}; ` +
            `speakingFrames=${stats.speakingFrames || 0}, silentFrames=${stats.silentFrames || 0})`
        );
    }

    /**
     * Arm the endpoint debounce timer. On expiry, flushUser snapshots and
     * dispatches ASR. If the user resumes within the window, the timer is
     * canceled (same utterance continues). Idempotent — re-arm is a no-op.
     * @param {string} userId - Discord user ID
     * @param {string} reason - What triggered the arm (for logs/metadata)
     */
    armEndpointTimer(userId, reason) {
        const buffer = this.speakerBuffers.get(userId);
        if (!buffer || buffer.endpointTimer) return;

        const debounceMs = this.options.endpointingDebounce;
        console.log(`[AudioReceiver] Endpoint debounce armed for ${userId} (${reason}, ${debounceMs}ms)`);

        const stats = buffer.detector?.getStats?.() || {};
        this.options.onEndpointing(userId, {
            active: true,
            reason,
            debounceMs,
            chunkCount: buffer.chunks.length,
            speakingFrames: stats.speakingFrames || 0,
            silentFrames: stats.silentFrames || 0
        });

        buffer.endpointTimer = setTimeout(() => {
            buffer.endpointTimer = null;
            console.log(`[AudioReceiver] Endpoint debounce expired for ${userId} -> flushing for ASR`);
            this.options.onEndpointing(userId, { active: false, reason: 'debounce expired' });
            this.flushUser(userId, 'endpoint debounce expired')
                .catch((err) => this.options.onError && this.options.onError(err));
        }, debounceMs);
    }

    /**
     * Cancel an armed endpoint debounce. Safe to call when no timer is armed.
     * @param {string} userId - Discord user ID
     * @param {string} reason - Why we are canceling (for logs/metadata)
     */
    cancelEndpointTimer(userId, reason) {
        const buffer = this.speakerBuffers.get(userId);
        if (!buffer || !buffer.endpointTimer) return;

        clearTimeout(buffer.endpointTimer);
        buffer.endpointTimer = null;
        console.log(`[AudioReceiver] Endpoint debounce canceled for ${userId} (${reason})`);
        this.options.onEndpointing(userId, { active: false, reason });
    }

    /**
     * Snapshot and clear the current in-memory chunks for a user.
     * @param {string} userId - Discord user ID
     * @param {string} reason - Reason for the rollover
     * @returns {Object|null} - Snapshot to process
     */
    snapshotUserBuffer(userId, reason) {
        const buffer = this.speakerBuffers.get(userId);
        if (!buffer) return null;

        const chunks = buffer.chunks;
        const snapshotAtMs = Date.now();
        const startTime = buffer.startTime || snapshotAtMs;
        const duration = buffer.startTime ? snapshotAtMs - buffer.startTime : 0;
        const audioBuffer = chunks.length > 0 ? Buffer.concat(chunks) : Buffer.alloc(0);
        const detectorStats = buffer.detector?.getStats?.() || {};
        const speechStartedAtMs = detectorStats.firstSpeechAtMs || startTime;
        const speechEndedAtMs = detectorStats.lastSpeechAtMs || snapshotAtMs;
        const speechDuration = Math.max(0, speechEndedAtMs - speechStartedAtMs);

        // Whatever caused this snapshot supersedes the endpoint debounce.
        if (buffer.endpointTimer) {
            clearTimeout(buffer.endpointTimer);
            buffer.endpointTimer = null;
            this.options.onEndpointing(userId, { active: false, reason: `snapshot: ${reason}` });
        }

        if (audioBuffer.length === 0) {
            console.log(`[AudioReceiver] No buffered audio for ${userId} on ${reason}`);
            buffer.chunks = [];
            buffer.startTime = null;
            if (buffer.detector) {
                buffer.detector.reset();
            }
            return null;
        }

        if (!this.hasAsrCandidate(buffer)) {
            this.discardUserBuffer(userId, reason);
            return null;
        }

        buffer.chunks = [];
        buffer.startTime = null;

        if (buffer.detector) {
            buffer.detector.reset();
        }

        return {
            userId: userId,
            speakerInfo: buffer.speakerInfo,
            audioBuffer: audioBuffer,
            startTime: startTime,
            duration: duration,
            speechStartedAt: new Date(speechStartedAtMs).toISOString(),
            speechEndedAt: new Date(speechEndedAtMs).toISOString(),
            speechDuration,
            timestamp: new Date(speechStartedAtMs).toISOString(),
            reason: reason
        };
    }

    /**
     * Flush a user's current utterance buffer without closing their subscription.
     * @param {string} userId - Discord user ID
     * @param {string} reason - Reason for the flush
     * @returns {Promise<void>}
     */
    flushUser(userId, reason = 'manual flush') {
        const snapshot = this.snapshotUserBuffer(userId, reason);
        if (!snapshot) {
            return Promise.resolve();
        }

        return this.enqueueUtterance(snapshot);
    }

    /**
     * Flush all user buffers and wait for pending transcriptions to finish.
     * @param {string} reason - Reason for the flush
     * @returns {Promise<void>}
     */
    async flushAll(reason = 'flush all') {
        const flushes = [];

        for (const userId of Array.from(this.speakerBuffers.keys())) {
            flushes.push(this.flushUser(userId, reason));
        }

        await Promise.allSettled(flushes);
        await this.waitForPendingUtterances();
    }

    /**
     * Wait for all queued utterance processing to finish.
     * @returns {Promise<void>}
     */
    async waitForPendingUtterances() {
        while (this.processingUtterances.size > 0) {
            await Promise.allSettled(Array.from(this.processingUtterances));
        }
    }

    /**
     * Queue utterance processing per user so transcript rows remain ordered.
     * @param {Object} snapshot - Snapshot created by snapshotUserBuffer
     * @returns {Promise<void>}
     */
    enqueueUtterance(snapshot) {
        const previous = this.processingChains.get(snapshot.userId) || Promise.resolve();
        const task = previous
            .catch(() => {})
            .then(() => this.processUtteranceSnapshot(snapshot));

        let tracked;
        tracked = task.finally(() => {
            this.processingUtterances.delete(tracked);
            if (this.processingChains.get(snapshot.userId) === tracked) {
                this.processingChains.delete(snapshot.userId);
            }
        });

        this.processingUtterances.add(tracked);
        this.processingChains.set(snapshot.userId, tracked);
        return tracked;
    }

    /**
     * Process an utterance snapshot.
     * @param {Object} snapshot - Snapshot created by snapshotUserBuffer
     */
    async processUtteranceSnapshot(snapshot) {
        const {
            userId,
            speakerInfo,
            audioBuffer,
            startTime,
            duration,
            timestamp,
            speechStartedAt,
            speechEndedAt,
            speechDuration,
            reason: snapshotReason
        } = snapshot;

        console.log(`[AudioReceiver] Processing ${duration}ms utterance from ${speakerInfo.name}`);

        try {
            // Transcribe audio to text
            let transcription = '';
            let rawTranscription = '';
            let transcriptionConfidence = 0;
            let wordLevelData = [];
            let language = null;
            let audioEvents = [];
            const asrStartedAt = new Date().toISOString();

            if (this.enableTranscription && this.stt) {
                try {
                    // Real "ASR in flight" signal — Fish call is being made right now.
                    // Downstream (conversation-buffer) keys its 8s safety net off this.
                    this.options.onAsrDispatched(userId, {
                        reason: snapshotReason || 'snapshot',
                        audioBytes: audioBuffer.length,
                        speechDuration
                    });
                    const sttResult = await this.stt.transcribe(audioBuffer);
                    rawTranscription = sttResult.text || '';
                    const normalized = this.normalizeTranscription(rawTranscription);
                    transcription = normalized.transcription;
                    audioEvents = normalized.audioEvents;
                    transcriptionConfidence = sttResult.confidence || 0;
                    wordLevelData = sttResult.words || [];
                    language = sttResult.language || null;

                    console.log(`[AudioReceiver] Transcription: "${transcription}" (${wordLevelData.length} words)`);
                    if (rawTranscription && rawTranscription !== transcription) {
                        console.log(`[AudioReceiver] Raw transcription normalized from: "${rawTranscription}"`);
                    }
                    console.log(`[AudioReceiver] STT result - confidence: ${transcriptionConfidence}, language: ${language}`);

                    // Debug: Log full STT result structure (first word as sample)
                    if (wordLevelData.length > 0) {
                        console.log(`[AudioReceiver] STT word sample:`, JSON.stringify(wordLevelData[0]));
                    } else {
                        console.log('[AudioReceiver] WARNING: No word-level data received from STT');
                    }

                    // Log low-confidence words for debugging
                    const lowConfidenceWords = wordLevelData.filter(w => (w.confidence || 0) < 0.7);
                    if (lowConfidenceWords.length > 0) {
                        console.log(`[AudioReceiver] Low confidence words: ${lowConfidenceWords.map(w => `"${w.text}"(${Math.round((w.confidence || 0) * 100)}%)`).join(', ')}`);
                    }
                } catch (sttError) {
                    console.error('[AudioReceiver] STT error:', sttError.message);
                    // Continue without transcription - don't block the flow
                }
            }
            const asrCompletedAt = new Date().toISOString();

            // Create utterance object with transcription (NOT raw audio buffer for transcript)
            const utterance = {
                userId: userId,
                speaker: speakerInfo.name,
                speakerRole: speakerInfo.role,
                transcription: transcription,
                rawTranscription: rawTranscription,
                audioEvents,
                transcriptionConfidence: transcriptionConfidence,
                words: wordLevelData, // Include full word-level data
                language: language,
                duration: duration,
                timestamp: timestamp,
                speechStartedAt,
                speechEndedAt,
                speechDuration,
                asrStartedAt,
                asrCompletedAt,
                sampleRate: 48000,
                channels: 2
            };

            // Keep audioBuffer for recording purposes (for mixed-audio.wav)
            // but DON'T include it in the utterance object for transcript.jsonl
            // Use detector-derived speech start so the recorder mix lines up
            // with the transcript (renderer also keys off speechStartedAt).
            // buffer.startTime tracks the first chunk, which can precede real
            // speech when Discord's voice activity opens on a breath or click.
            const speechStartedAtMs = Date.parse(speechStartedAt);
            const utteranceForRecording = {
                ...utterance,
                audioBuffer: audioBuffer,
                startTime: Number.isFinite(speechStartedAtMs) ? speechStartedAtMs : startTime
            };

            // Track in conversation history
            this.speakerTracker.addUtterance(utterance);

            // Emit utterance for processing (with audioBuffer for recording, transcription for AI)
            this.options.onUtterance(utteranceForRecording);

        } catch (error) {
            this.options.onError(error);
        }
    }

    normalizeTranscription(text) {
        const raw = String(text || '').trim();
        if (!raw) {
            return {
                transcription: '',
                audioEvents: []
            };
        }

        if (this.isLikelyLaughterTranscription(raw)) {
            return {
                transcription: '[laughs]',
                audioEvents: ['laughter']
            };
        }

        if (this.isLikelyPhantomTranscription(raw)) {
            return {
                transcription: '',
                audioEvents: ['phantom']
            };
        }

        return {
            transcription: raw,
            audioEvents: []
        };
    }

    isLikelyLaughterTranscription(text) {
        const compact = String(text || '')
            .normalize('NFKC')
            .toLowerCase()
            .replace(/[\s.,!?;:'"\u201c\u201d\u2018\u2019\u3002\uff01\uff1f\u3001\uff0c\u2026~\-\u2014_()[\]{}]+/gu, '');

        if (!compact) return false;

        if (/^(ha|he|hi|ho|hu){2,}$/.test(compact)) return true;
        if (/^(haha|hehe|hihi|hoho|huhu)+$/.test(compact)) return true;
        if (/^(lol|lmao|rofl)+$/.test(compact)) return true;
        if (/^[\u5475\u54c8\u563f\u563b\u55ec]{2,}$/u.test(compact)) return true;

        return false;
    }

    isLikelyPhantomTranscription(text) {
        // Mic feedback during bot speech bleeds into participant channels and
        // gets transcribed as one-character Chinese particles (\u55ef, \u554a, \u54ce, \u54e6,
        // \u54e5, \u4f1a, \u5bf9, etc.). These are noise, not the guest's intent. Strip
        // them so the generator doesn't read them as hold-space cues.
        // The laughter detector handles \u54c8/\u5475/\u563f/\u563b/\u566c patterns separately
        // (and requires 2+ chars), so we exclude that set to avoid eating
        // single-character chuckles that the laughter check intentionally
        // lets through.
        const compact = String(text || '')
            .normalize('NFKC')
            .replace(/[\s.,!?;:'"\u201c\u201d\u2018\u2019\u3002\uff01\uff1f\u3001\uff0c\u2026~\-\u2014_()[\]{}]+/gu, '');

        if (!compact) return false;

        if (/^[\u4e00-\u9fff]$/u.test(compact) && !/[\u5475\u54c8\u563f\u563b\u55ec]/u.test(compact)) {
            return true;
        }

        // Observed Fish/Discord feedback can also produce tiny CJK fragments
        // like "\u6211\u4eec\u3002" during bot playback. Keep the raw text in
        // transcript metadata, but do not let these trigger a second host turn.
        const shortCjkPhantoms = new Set(['\u6211\u4eec']);
        if (shortCjkPhantoms.has(compact)) {
            return true;
        }

        const shortJapanesePhantoms = new Set(['\u3046\u3093', '\u3048\u3048', '\u3042']);
        if (shortJapanesePhantoms.has(compact)) {
            return true;
        }

        return false;
    }

    /**
     * Get speaker information from user ID
     * @param {string} userId - Discord user ID
     * @returns {Object} - Speaker info
     */
    getSpeakerInfo(userId) {
        // Check configured speaker map first
        if (this.options.speakerMap[userId]) {
            return this.options.speakerMap[userId];
        }

        // Try to fetch Discord user info using the client
        try {
            const client = this.options.client;
            const guildId = this.options.guildId;

            if (client && guildId) {
                const guild = client.guilds.cache.get(guildId);
                if (guild) {
                    const member = guild.members.cache.get(userId);
                    if (member) {
                        const name = member.displayName || member.user.username;
                        // Cache it for next time
                        this.options.speakerMap[userId] = {
                            name: name,
                            role: 'guest',
                            userId: userId
                        };
                        return this.options.speakerMap[userId];
                    }
                }
            }
        } catch (error) {
            console.error(`[AudioReceiver] Error looking up member ${userId}:`, error.message);
        }

        // Default to unknown (but include userId for debugging)
        return {
            name: 'Unknown',
            role: 'guest',
            userId: userId
        };
    }

    /**
     * Clean up resources for a user
     * @param {string} userId - Discord user ID
     * @param {string} reason - Teardown reason for logs
     */
    cleanupUser(userId, reason = 'teardown') {
        console.log(`[AudioReceiver] cleanupUser for ${userId}: ${reason}`);

        const subscription = this.subscriptions.get(userId);
        const buffer = this.speakerBuffers.get(userId);
        const detector = buffer?.detector || subscription?.detector;

        if (buffer && buffer.endpointTimer) {
            clearTimeout(buffer.endpointTimer);
            buffer.endpointTimer = null;
        }

        if (this.activeSpeakers.delete(userId)) {
            this.options.onSpeakingStop(userId);
        }

        if (subscription) {
            subscription.closing = true;

            // Clean up streams
            try {
                if (subscription.stream && !subscription.stream.destroyed) {
                    subscription.stream.destroy();
                }
                if (subscription.decoder && !subscription.decoder.destroyed) {
                    subscription.decoder.destroy();
                }
                if (subscription.handler && !subscription.handler.destroyed) {
                    subscription.handler.destroy();
                }
            } catch (error) {
                // Ignore cleanup errors
            }

            this.subscriptions.delete(userId);
        }

        if (detector) {
            try {
                detector.destroy();
            } catch (error) {
                // Ignore cleanup errors
            }
        }

        this.speakerBuffers.delete(userId);
    }

    /**
     * Update the speaker map
     * @param {Object} speakerMap - Map of userId -> speaker info
     */
    updateSpeakerMap(speakerMap) {
        this.options.speakerMap = { ...this.options.speakerMap, ...speakerMap };
        console.log('[AudioReceiver] Updated speaker map:', Object.keys(speakerMap));
    }

    /**
     * Get conversation history
     * @returns {Array} - Array of utterances
     */
    getConversationHistory() {
        return this.speakerTracker.getHistory();
    }

    /**
     * Get the speaker tracker
     * @returns {SpeakerTracker}
     */
    getSpeakerTracker() {
        return this.speakerTracker;
    }

    /**
     * Stop receiving audio and clean up
     */
    destroy() {
        console.log('[AudioReceiver] Destroying receiver');

        this.isRunning = false;

        // Clean up all user subscriptions
        for (const userId of Array.from(this.subscriptions.keys())) {
            this.cleanupUser(userId, 'receiver destroy');
        }

        for (const userId of Array.from(this.speakerBuffers.keys())) {
            this.cleanupUser(userId, 'receiver destroy');
        }

        this.subscriptions.clear();
        this.speakerBuffers.clear();
        this.activeSpeakers.clear();
        this.connection = null;
    }
}

module.exports = { AudioReceiver };
