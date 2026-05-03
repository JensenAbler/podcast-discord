/**
 * Audio Transmitter - Play AI responses into voice channel
 * 
 * Handles converting audio buffers/files to Discord playable format
 * and managing the audio playback queue.
 */

const {
    createAudioResource,
    AudioPlayerStatus,
    StreamType
} = require('@discordjs/voice');
const { Readable } = require('stream');
const fs = require('fs');
const path = require('path');

class AudioTransmitter {
    constructor(options = {}) {
        this.options = {
            volume: options.volume || 1.0,
            onError: options.onError || console.error,
            onStart: options.onStart || (() => {}),
            onFinish: options.onFinish || (() => {}),
            ...options
        };

        this.player = options.player;
        this.queue = [];
        this.isPlaying = false;
        this.currentResource = null;

        if (this.player) {
            this.setupPlayerEvents();
        }
    }

    /**
     * Set up audio player event handlers
     */
    setupPlayerEvents() {
        this.player.on(AudioPlayerStatus.Playing, () => {
            console.log('[AudioTransmitter] Started playing audio');
            this.isPlaying = true;
            this.options.onStart();
        });

        this.player.on(AudioPlayerStatus.Idle, () => {
            console.log('[AudioTransmitter] Finished playing audio');
            this.isPlaying = false;
            this.currentResource = null;
            this.options.onFinish();
            
            // Play next in queue if any
            this.playNext();
        });

        this.player.on('error', (error) => {
            console.error('[AudioTransmitter] Player error:', error);
            this.isPlaying = false;
            this.currentResource = null;
            this.options.onError(error);
            
            // Try to continue with queue
            setTimeout(() => this.playNext(), 100);
        });
    }

    /**
     * Play audio (buffer, file path, or stream)
     * @param {Buffer|string|Readable} audio - Audio to play
     * @param {Object} options - Playback options
     * @returns {Promise<void>}
     */
    async play(audio, options = {}) {
        return new Promise((resolve, reject) => {
            const playOptions = {
                volume: options.volume || this.options.volume,
                ...options
            };

            // Add to queue if already playing
            if (this.isPlaying) {
                console.log('[AudioTransmitter] Adding to queue');
                this.queue.push({ audio, options: playOptions, resolve, reject });
                return;
            }

            this.playNow(audio, playOptions, resolve, reject);
        });
    }

    /**
     * Play audio immediately
     * @param {Buffer|string|Readable} audio - Audio to play
     * @param {Object} options - Playback options
     * @param {Function} resolve - Promise resolve
     * @param {Function} reject - Promise reject
     */
    playNow(audio, options, resolve, reject) {
        try {
            let resource;

            if (Buffer.isBuffer(audio)) {
                // Buffer - create readable stream
                console.log(`[AudioTransmitter] Playing buffer (${audio.length} bytes)`);
                const stream = Readable.from([audio]);
                resource = createAudioResource(stream, {
                    inputType: StreamType.Arbitrary,
                    inlineVolume: true
                });
            } else if (typeof audio === 'string') {
                // File path
                console.log(`[AudioTransmitter] Playing file: ${audio}`);
                if (!fs.existsSync(audio)) {
                    throw new Error(`Audio file not found: ${audio}`);
                }
                resource = createAudioResource(audio, {
                    inputType: StreamType.Arbitrary,
                    inlineVolume: true
                });
            } else if (audio && typeof audio.pipe === 'function') {
                // Stream
                console.log('[AudioTransmitter] Playing stream');
                resource = createAudioResource(audio, {
                    inputType: StreamType.Arbitrary,
                    inlineVolume: true
                });
            } else {
                throw new Error('Invalid audio format');
            }

            // Set volume if supported
            if (resource.volume && options.volume !== undefined) {
                resource.volume.setVolume(options.volume);
            }

            this.currentResource = resource;

            // Play the resource
            this.player.play(resource);

            // Resolve immediately (actual completion handled by events)
            resolve();

        } catch (error) {
            console.error('[AudioTransmitter] Error playing audio:', error);
            reject(error);
        }
    }

    /**
     * Play next item in queue
     */
    playNext() {
        if (this.queue.length === 0) return;

        const next = this.queue.shift();
        this.playNow(next.audio, next.options, next.resolve, next.reject);
    }

    /**
     * Play TTS audio with automatic format handling
     * @param {Buffer} audioBuffer - MP3 audio buffer from ElevenLabs
     * @param {Object} options - Playback options
     * @returns {Promise<void>}
     */
    async playTTS(audioBuffer, options = {}) {
        console.log(`[AudioTransmitter] Playing TTS (${audioBuffer.length} bytes)`);
        return this.play(audioBuffer, options);
    }

    /**
     * Stop current playback
     */
    stop() {
        if (this.player) {
            this.player.stop();
        }
        this.isPlaying = false;
        this.currentResource = null;
        this.queue = [];
    }

    /**
     * Pause playback
     */
    pause() {
        if (this.player) {
            this.player.pause();
        }
    }

    /**
     * Resume playback
     */
    resume() {
        if (this.player) {
            this.player.unpause();
        }
    }

    /**
     * Check if currently playing
     * @returns {boolean}
     */
    isCurrentlyPlaying() {
        return this.isPlaying;
    }

    /**
     * Get queue length
     * @returns {number}
     */
    getQueueLength() {
        return this.queue.length;
    }

    /**
     * Clear the queue
     */
    clearQueue() {
        this.queue = [];
    }

    /**
     * Set player instance
     * @param {AudioPlayer} player - Discord.js audio player
     */
    setPlayer(player) {
        this.player = player;
        this.setupPlayerEvents();
    }

    /**
     * Destroy the transmitter
     */
    destroy() {
        this.stop();
        this.player = null;
    }
}

module.exports = { AudioTransmitter };
