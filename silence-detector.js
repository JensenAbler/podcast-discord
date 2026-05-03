/**
 * Silence Detector - Detect 2+ seconds of silence in audio stream
 * 
 * Analyzes PCM audio data to detect when a speaker has stopped talking
 * for a specified duration (default 2 seconds).
 */

class SilenceDetector {
    constructor(options = {}) {
        this.options = {
            silenceDuration: options.silenceDuration || 2000, // milliseconds
            sampleRate: options.sampleRate || 48000,
            channels: options.channels || 2,
            threshold: options.threshold || 0.01, // Amplitude threshold (0-1)
            frameDuration: options.frameDuration || 20, // ms per frame check
            onSilence: options.onSilence || (() => {}),
            ...options
        };

        // Calculate bytes per sample
        this.bytesPerSample = 2; // 16-bit PCM
        this.samplesPerFrame = Math.floor(
            (this.options.sampleRate * this.options.frameDuration) / 1000
        );
        this.bytesPerFrame = this.samplesPerFrame * this.options.channels * this.bytesPerSample;

        // Silence tracking
        this.consecutiveSilentFrames = 0;
        this.framesNeededForSilence = Math.floor(
            this.options.silenceDuration / this.options.frameDuration
        );
        
        // State
        this.isSpeaking = false;
        this.silenceDetected = false;
        this.unprocessedData = Buffer.alloc(0);
        
        // Debug stats
        this.stats = {
            totalFrames: 0,
            silentFrames: 0,
            speakingFrames: 0
        };
    }

    /**
     * Process a chunk of PCM audio data
     * @param {Buffer} audioData - 16-bit PCM audio data
     */
    processAudio(audioData) {
        if (this.silenceDetected) return;

        // Append to unprocessed buffer
        this.unprocessedData = Buffer.concat([this.unprocessedData, audioData]);

        // Process complete frames
        while (this.unprocessedData.length >= this.bytesPerFrame) {
            const frame = this.unprocessedData.slice(0, this.bytesPerFrame);
            this.unprocessedData = this.unprocessedData.slice(this.bytesPerFrame);
            this.processFrame(frame);
        }
    }

    /**
     * Process a single frame of audio
     * @param {Buffer} frame - Audio frame
     */
    processFrame(frame) {
        this.stats.totalFrames++;

        // Calculate RMS (root mean square) amplitude
        const amplitude = this.calculateRMS(frame);
        
        // Determine if this frame is silent
        const isSilent = amplitude < this.options.threshold;

        if (isSilent) {
            this.stats.silentFrames++;
            this.consecutiveSilentFrames++;
            
            // Check if we've reached silence threshold
            if (this.consecutiveSilentFrames >= this.framesNeededForSilence && !this.silenceDetected) {
                this.silenceDetected = true;
                this.triggerSilenceCallback();
            }
        } else {
            this.stats.speakingFrames++;
            this.consecutiveSilentFrames = 0;
            this.isSpeaking = true;
        }
    }

    /**
     * Calculate RMS amplitude of audio frame
     * @param {Buffer} frame - 16-bit PCM audio data
     * @returns {number} - Normalized amplitude (0-1)
     */
    calculateRMS(frame) {
        let sumSquares = 0;
        const numSamples = frame.length / this.bytesPerSample;

        // Process as 16-bit signed integers
        for (let i = 0; i < frame.length; i += this.bytesPerSample) {
            const sample = frame.readInt16LE(i);
            sumSquares += sample * sample;
        }

        const rms = Math.sqrt(sumSquares / numSamples);
        
        // Normalize to 0-1 range (16-bit max is 32768)
        return rms / 32768;
    }

    /**
     * Called when user stops speaking (Discord event)
     * This accelerates silence detection
     */
    speakingStopped() {
        // If we've been processing audio and user stopped speaking,
        // we can trigger silence detection sooner
        if (this.isSpeaking && !this.silenceDetected) {
            // Reduce the frames needed since we got explicit stop signal
            this.framesNeededForSilence = Math.max(10, Math.floor(this.framesNeededForSilence / 2));
        }
    }

    /**
     * Trigger the silence callback
     */
    triggerSilenceCallback() {
        console.log(`[SilenceDetector] Silence detected after ${this.options.silenceDuration}ms`);
        
        try {
            this.options.onSilence();
        } catch (error) {
            console.error('[SilenceDetector] Error in silence callback:', error);
        }
    }

    /**
     * Check if silence has been detected
     * @returns {boolean}
     */
    hasSilenceBeenDetected() {
        return this.silenceDetected;
    }

    /**
     * Get detection statistics
     * @returns {Object}
     */
    getStats() {
        return {
            ...this.stats,
            consecutiveSilentFrames: this.consecutiveSilentFrames,
            framesNeededForSilence: this.framesNeededForSilence,
            silenceDetected: this.silenceDetected,
            speakingDuration: (this.stats.speakingFrames * this.options.frameDuration) / 1000
        };
    }

    /**
     * Reset the detector state
     */
    reset() {
        this.consecutiveSilentFrames = 0;
        this.isSpeaking = false;
        this.silenceDetected = false;
        this.unprocessedData = Buffer.alloc(0);
        this.framesNeededForSilence = Math.floor(
            this.options.silenceDuration / this.options.frameDuration
        );
        this.stats = {
            totalFrames: 0,
            silentFrames: 0,
            speakingFrames: 0
        };
    }

    /**
     * Destroy the detector
     */
    destroy() {
        this.reset();
        this.options.onSilence = null;
    }
}

module.exports = { SilenceDetector };
