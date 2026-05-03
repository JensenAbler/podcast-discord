/**
 * Audio Receiver - Receive audio from Discord users, buffer until silence
 * 
 * Handles receiving Opus-encoded audio from Discord voice channels,
 * converting to PCM, buffering per speaker, and detecting silence.
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
            speakerMap: options.speakerMap || {},
            maxUtteranceDuration: options.maxUtteranceDuration || 60000, // 60 seconds
            onUtterance: options.onUtterance || (() => {}),
            onSpeakingStart: options.onSpeakingStart || (() => {}),
            onSpeakingStop: options.onSpeakingStop || (() => {}),
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

        // Speaker audio buffers: userId -> { chunks: Buffer[], startTime: Date, detector: SilenceDetector }
        this.speakerBuffers = new Map();
        
        // Speaker tracker for conversation history
        this.speakerTracker = new SpeakerTracker();
        
        // Active subscriptions to clean up
        this.subscriptions = new Map(); // userId -> { stream, decoder, detector }
        
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

        // Skip if already tracking this user
        if (this.subscriptions.has(userId)) {
            return;
        }

        console.log(`[AudioReceiver] User ${userId} started speaking`);
        
        // Notify that user started speaking
        this.options.onSpeakingStart(userId);

        // Get speaker info
        const speakerInfo = this.getSpeakerInfo(userId);

        // Create silence detector for this user
        const silenceDetector = new SilenceDetector({
            silenceDuration: this.options.silenceDuration,
            onSilence: () => this.handleSilenceDetected(userId)
        });

        // Initialize buffer for this speaker
        this.speakerBuffers.set(userId, {
            chunks: [],
            startTime: Date.now(),
            speakerInfo: speakerInfo,
            detector: silenceDetector
        });

        // Subscribe to user's audio stream
        const audioStream = this.connection.receiver.subscribe(userId, {
            end: {
                behavior: EndBehaviorType.AfterSilence,
                duration: 1000
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

        // Set up pipeline: Opus -> PCM -> Handler
        audioStream.pipe(opusDecoder).pipe(pcmHandler);

        // Store subscription for cleanup
        this.subscriptions.set(userId, {
            stream: audioStream,
            decoder: opusDecoder,
            handler: pcmHandler,
            detector: silenceDetector
        });

        // Handle stream end
        audioStream.on('end', () => {
            console.log(`[AudioReceiver] Audio stream ended for ${userId}`);
            // Process any remaining audio before cleanup
            const buffer = this.speakerBuffers.get(userId);
            if (buffer && buffer.chunks.length > 0 && !buffer.processing) {
                console.log(`[AudioReceiver] Processing remaining audio for ${userId}`);
                this.handleSilenceDetected(userId);
            } else {
                this.cleanupUser(userId);
            }
        });

        // Handle errors
        audioStream.on('error', (error) => {
            console.error(`[AudioReceiver] Audio stream error for ${userId}:`, error);
            this.cleanupUser(userId);
        });
    }

    /**
     * Handle user stopping speaking (initial silence indication)
     * @param {string} userId - Discord user ID
     */
    handleUserStopSpeaking(userId) {
        console.log(`[AudioReceiver] User ${userId} stopped speaking`);
        
        // Notify that user stopped speaking
        this.options.onSpeakingStop(userId);
        
        const buffer = this.speakerBuffers.get(userId);
        if (buffer && buffer.detector) {
            // Notify detector that speaking stopped
            buffer.detector.speakingStopped();
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

        // Add chunk to buffer
        buffer.chunks.push(chunk);

        // Feed to silence detector
        buffer.detector.processAudio(chunk);

        // Stream to recorder in real-time (for mixed audio recording)
        if (this.options.onAudioChunk) {
            this.options.onAudioChunk(userId, chunk);
        }

        // Check for max utterance duration
        const duration = Date.now() - buffer.startTime;
        if (duration > this.options.maxUtteranceDuration) {
            console.log(`[AudioReceiver] Max utterance duration reached for ${userId}`);
            this.handleSilenceDetected(userId);
        }
    }

    /**
     * Handle silence detected for a user
     * @param {string} userId - Discord user ID
     */
    async handleSilenceDetected(userId) {
        const buffer = this.speakerBuffers.get(userId);
        if (!buffer || buffer.processing) return;

        // Mark as processing to prevent double-processing
        buffer.processing = true;

        console.log(`[AudioReceiver] Silence detected for ${userId}, processing utterance`);

        try {
            // Combine all chunks into single buffer
            const audioBuffer = Buffer.concat(buffer.chunks);
            const duration = Date.now() - buffer.startTime;
            
            if (audioBuffer.length === 0) {
                console.log(`[AudioReceiver] Empty audio buffer for ${userId}, emitting empty utterance`);
                this.options.onUtterance({
                    userId: userId,
                    speaker: buffer.speakerInfo.name,
                    speakerRole: buffer.speakerInfo.role,
                    transcription: '',
                    transcriptionConfidence: 0,
                    words: [],
                    language: null,
                    duration: duration,
                    timestamp: new Date().toISOString(),
                    sampleRate: 48000,
                    channels: 2
                });
                this.cleanupUser(userId);
                return;
            }

            console.log(`[AudioReceiver] Processing ${duration}ms utterance from ${buffer.speakerInfo.name}`);

            // Transcribe audio to text
            let transcription = '';
            let transcriptionConfidence = 0;
            let wordLevelData = [];
            let language = null;
            
            if (this.enableTranscription && this.stt) {
                try {
                    const sttResult = await this.stt.transcribe(audioBuffer);
                    transcription = sttResult.text || '';
                    transcriptionConfidence = sttResult.confidence || 0;
                    wordLevelData = sttResult.words || [];
                    language = sttResult.language || null;
                    
                    console.log(`[AudioReceiver] Transcription: "${transcription}" (${wordLevelData.length} words)`);
                    console.log(`[AudioReceiver] STT result - confidence: ${transcriptionConfidence}, language: ${language}`);
                    
                    // Debug: Log full STT result structure (first word as sample)
                    if (wordLevelData.length > 0) {
                        console.log(`[AudioReceiver] STT word sample:`, JSON.stringify(wordLevelData[0]));
                    } else {
                        console.log(`[AudioReceiver] WARNING: No word-level data received from STT`);
                    }
                    
                    // Log low-confidence words for debugging
                    const lowConfidenceWords = wordLevelData.filter(w => (w.confidence || 0) < 0.7);
                    if (lowConfidenceWords.length > 0) {
                        console.log(`[AudioReceiver] Low confidence words: ${lowConfidenceWords.map(w => `"${w.text}"(${Math.round((w.confidence||0)*100)}%)`).join(', ')}`);
                    }
                } catch (sttError) {
                    console.error('[AudioReceiver] STT error:', sttError.message);
                    // Continue without transcription - don't block the flow
                }
            }

            // Create utterance object with transcription (NOT raw audio buffer for transcript)
            const utterance = {
                userId: userId,
                speaker: buffer.speakerInfo.name,
                speakerRole: buffer.speakerInfo.role,
                transcription: transcription,
                transcriptionConfidence: transcriptionConfidence,
                words: wordLevelData, // Include full word-level data
                language: language,
                duration: duration,
                timestamp: new Date().toISOString(),
                sampleRate: 48000,
                channels: 2
            };

            // Keep audioBuffer for recording purposes (for mixed-audio.wav)
            // but DON'T include it in the utterance object for transcript.jsonl
            const utteranceForRecording = {
                ...utterance,
                audioBuffer: audioBuffer, // Only for internal recording use
                startTime: buffer.startTime // When speech started (for correct timestamp alignment)
            };

            // Track in conversation history
            this.speakerTracker.addUtterance(utterance);

            // Emit utterance for processing (with audioBuffer for recording, transcription for AI)
            this.options.onUtterance(utteranceForRecording);

        } catch (error) {
            this.options.onError(error);
        } finally {
            // Clean up this user's buffer
            this.cleanupUser(userId);
        }
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
     */
    cleanupUser(userId) {
        const subscription = this.subscriptions.get(userId);
        if (subscription) {
            // Clean up streams
            try {
                subscription.stream.destroy();
                subscription.decoder.destroy();
                subscription.handler.destroy();
                subscription.detector.destroy();
            } catch (error) {
                // Ignore cleanup errors
            }
            this.subscriptions.delete(userId);
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
        for (const userId of this.subscriptions.keys()) {
            this.cleanupUser(userId);
        }

        this.subscriptions.clear();
        this.speakerBuffers.clear();
        this.connection = null;
    }
}

module.exports = { AudioReceiver };
