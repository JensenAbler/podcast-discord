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
        this.currentPlayback = null;

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
            if (typeof this.currentPlayback?.options?.onStart === 'function') {
                this.currentPlayback.options.onStart();
            }
            this.options.onStart();
        });

        this.player.on(AudioPlayerStatus.Idle, () => {
            console.log('[AudioTransmitter] Finished playing audio');
            const completedPlayback = this.currentPlayback;
            this.isPlaying = false;
            this.currentResource = null;
            this.currentPlayback = null;
            if (typeof completedPlayback?.options?.onFinish === 'function') {
                completedPlayback.options.onFinish();
            }
            this.options.onFinish();
            
            // Play next in queue if any
            this.playNext();
        });

        this.player.on('error', (error) => {
            console.error('[AudioTransmitter] Player error:', error);
            const failedPlayback = this.currentPlayback;
            this.isPlaying = false;
            this.currentResource = null;
            this.currentPlayback = null;
            if (typeof failedPlayback?.options?.onError === 'function') {
                failedPlayback.options.onError(error);
            }
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
            const inputType = options.inputType || StreamType.Arbitrary;

            if (Buffer.isBuffer(audio)) {
                // Buffer - create readable stream
                console.log(`[AudioTransmitter] Playing buffer (${audio.length} bytes)`);
                const stream = Readable.from([audio]);
                resource = createAudioResource(stream, {
                    inputType,
                    inlineVolume: true
                });
            } else if (typeof audio === 'string') {
                // File path
                console.log(`[AudioTransmitter] Playing file: ${audio}`);
                if (!fs.existsSync(audio)) {
                    throw new Error(`Audio file not found: ${audio}`);
                }
                resource = createAudioResource(audio, {
                    inputType,
                    inlineVolume: true
                });
            } else if (audio && typeof audio.pipe === 'function') {
                // Stream
                console.log('[AudioTransmitter] Playing stream');
                resource = createAudioResource(audio, {
                    inputType,
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
            this.currentPlayback = { options };

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
    async playTTS(audio, options = {}) {
        const size = Buffer.isBuffer(audio) ? ` (${audio.length} bytes)` : '';
        console.log(`[AudioTransmitter] Playing TTS${size}`);
        return this.play(audio, options);
    }

    /**
     * Stop current playback
     */
    stop() {
        const stoppedPlayback = this.currentPlayback;
        const queuedItems = [...this.queue];
        this.currentPlayback = null;
        this.queue = [];

        if (this.player) {
            this.player.stop();
        }

        this.isPlaying = false;
        this.currentResource = null;

        if (typeof stoppedPlayback?.options?.onFinish === 'function') {
            stoppedPlayback.options.onFinish();
        }

        for (const item of queuedItems) {
            if (typeof item.reject === 'function') {
                item.reject(new Error('Playback stopped before queued audio started'));
            }
        }
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
        for (const item of this.queue) {
            if (typeof item.reject === 'function') {
                item.reject(new Error('Playback queue cleared'));
            }
        }
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
