/**
 * ConversationBuffer - Manages utterance accumulation based on speaking state
 * 
 * Simplified architecture:
 * - speaking.on('start') → clear grace timer, prevent flush
 * - speaking.on('end') → start grace timer
 * - grace expires → flush all accumulated utterances
 * 
 * Modes:
 * - Chatty: 2s grace period
 * - Buffered: 10s grace period
 */

class ConversationBuffer {
    constructor(config) {
        this.config = { ...config };
        this.buffer = []; // Stores {speaker, transcription, timestamp, ...}
        this.flushCallback = null;
        
        // State tracking
        this.isUserSpeaking = false;
        this.graceTimer = null;
        this.cooldownTimer = null;
        this.isReady = true; // false during cooldown
        
        // Debug mode (immediate flush - for testing only)
        this.debugMode = false;
    }

    /**
     * Add an utterance to the buffer
     * DOES NOT reset timers - utterances just accumulate
     * Flush timing is purely based on speaking state + grace period
     * 
     * @param {Object} utterance - {speaker, speakerRole, transcription, words, language, duration, timestamp}
     */
    addUtterance(utterance) {
        this.buffer.push(utterance);
        
        const wordCount = utterance.words?.length || 0;
        console.log(`[ConversationBuffer] Added utterance: "${utterance.transcription?.substring(0, 40)}..." (${wordCount} words). Buffer: ${this.buffer.length} utterance(s)`);
        
        // Debug mode: immediate flush (for testing)
        if (this.debugMode) {
            this.forceFlush();
        }
        
        return this.buffer.length;
    }

    /**
     * Set the flush callback
     * Called when grace period expires and buffer has content
     */
    onFlush(callback) {
        this.flushCallback = callback;
    }

    /**
     * User started speaking
     * Clear grace timer - don't flush while someone is talking
     */
    setUserSpeaking(speaking) {
        this.isUserSpeaking = speaking;
        
        if (speaking) {
            // User started speaking - cancel any pending flush
            console.log('[ConversationBuffer] User speaking - clearing grace timer');
            this.clearGraceTimer();
        } else {
            // User stopped speaking - start grace period
            console.log('[ConversationBuffer] User stopped - starting grace period (' + this.config.gracePeriod + 'ms)');
            this.startGraceTimer();
        }
    }

    /**
     * Start the grace period timer
     * Flush happens when this expires (if not cancelled by new speech)
     */
    startGraceTimer() {
        this.clearGraceTimer();
        
        this.graceTimer = setTimeout(() => {
            console.log('[ConversationBuffer] Grace period expired');
            this.graceTimer = null;
            this.attemptFlush();
        }, this.config.gracePeriod);
    }

    /**
     * Clear the grace period timer
     */
    clearGraceTimer() {
        if (this.graceTimer) {
            clearTimeout(this.graceTimer);
            this.graceTimer = null;
        }
    }

    /**
     * Attempt to flush the buffer
     * Checks cooldown state, user speaking state
     * Called when grace period expires
     */
    attemptFlush() {
        // Can't flush if empty
        if (this.buffer.length === 0) {
            console.log('[ConversationBuffer] Buffer empty, nothing to flush');
            return false;
        }
        
        // Can't flush during cooldown
        if (!this.isReady) {
            console.log('[ConversationBuffer] In cooldown, delaying flush');
            return false;
        }
        
        // Can't flush while user is speaking
        if (this.isUserSpeaking) {
            console.log('[ConversationBuffer] User still speaking, delaying flush');
            return false;
        }
        
        // Flush!
        this._doFlush();
        return true;
    }

    /**
     * Force immediate flush (bypasses timing checks)
     * Used for debug mode or manual flush
     */
    forceFlush() {
        if (this.buffer.length === 0) return;
        this._doFlush();
    }

    /**
     * Internal flush - sends buffer to callback and clears
     */
    _doFlush() {
        const utterances = [...this.buffer];
        this.buffer = [];
        
        console.log(`[ConversationBuffer] Flushing ${utterances.length} utterance(s)`);
        
        if (this.flushCallback) {
            this.flushCallback(utterances);
        }
    }

    /**
     * Start cooldown period
     * Called after AI response plays to prevent rapid back-to-back responses
     */
    startCooldown() {
        console.log(`[ConversationBuffer] Starting cooldown (${this.config.cooldownPeriod}ms)`);
        this.isReady = false;
        this.clearCooldownTimer();
        
        this.cooldownTimer = setTimeout(() => {
            console.log('[ConversationBuffer] Cooldown complete');
            this.isReady = true;
            this.cooldownTimer = null;
            
            // Try flush any accumulated utterances during cooldown
            this.attemptFlush();
        }, this.config.cooldownPeriod);
    }

    /**
     * Clear cooldown timer
     */
    clearCooldownTimer() {
        if (this.cooldownTimer) {
            clearTimeout(this.cooldownTimer);
            this.cooldownTimer = null;
        }
    }

    /**
     * Switch buffering mode
     * @param {Object} config - { gracePeriod, cooldownPeriod }
     */
    setMode(config) {
        console.log(`[ConversationBuffer] Mode change: grace=${config.gracePeriod}ms, cooldown=${config.cooldownPeriod}ms`);
        this.config = { ...this.config, ...config };
    }

    /**
     * Get current buffer state (for status commands)
     */
    getState() {
        return {
            utteranceCount: this.buffer.length,
            isUserSpeaking: this.isUserSpeaking,
            isReady: this.isReady,
            gracePending: this.graceTimer !== null,
            cooldownPending: this.cooldownTimer !== null
        };
    }

    /**
     * Clear all state
     */
    clear() {
        this.buffer = [];
        this.clearGraceTimer();
        this.clearCooldownTimer();
        this.isReady = true;
        this.isUserSpeaking = false;
    }

    /**
     * Set debug mode (immediate flush)
     */
    setDebug(enabled) {
        this.debugMode = enabled;
    }
}

/**
 * Chatty mode: Fast responses, short grace period
 * Good for banter, quick exchanges
 */
const CHATTY_MODE = {
    gracePeriod: 2000,      // 2s grace after speaking stops
    cooldownPeriod: 2000    // 2s cooldown after AI response
};

/**
 * Buffered mode: Slower, more deliberate
 * Good for storytelling, monologues
 */
const BUFFERED_MODE = {
    gracePeriod: 10000,     // 10s grace after speaking stops
    cooldownPeriod: 15000   // 15s cooldown after AI response
};

module.exports = { ConversationBuffer, CHATTY_MODE, BUFFERED_MODE };
