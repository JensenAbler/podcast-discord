/**
 * ConversationBuffer - ASR-aware utterance accumulation.
 *
 * The grace timer starts only after all active speakers have stopped and all
 * receiver-announced ASR candidates have completed. This keeps "user paused"
 * separate from "transcription landed" so slow ASR cannot orphan an utterance
 * in the buffer without treating every Discord speaking-stop flap as ASR work.
 *
 * States:
 * - IDLE: ready, no active speakers, no pending ASR, empty buffer
 * - USER_SPEAKING: at least one speaker is actively talking
 * - AWAITING_ASR: everyone stopped, but one or more ASR jobs are still pending
 * - GRACE: ASR is complete and buffered text is waiting for a short resume window
 * - COOLDOWN: host response just played; hold before another response
 */

const BufferState = Object.freeze({
    IDLE: 'IDLE',
    USER_SPEAKING: 'USER_SPEAKING',
    AWAITING_ASR: 'AWAITING_ASR',
    GRACE: 'GRACE',
    COOLDOWN: 'COOLDOWN'
});

const DEFAULT_USER_ID = '__default_user__';
const DEFAULT_PENDING_ASR_TIMEOUT = 8000;

class ConversationBuffer {
    constructor(config = {}) {
        this.config = {
            pendingAsrTimeout: DEFAULT_PENDING_ASR_TIMEOUT,
            ...config
        };

        this.buffer = []; // Stores {userId, speaker, transcription, timestamp, ...}
        this.flushCallback = null;

        // Explicit state machine state and per-user tracking.
        this.state = BufferState.IDLE;
        this.activeSpeakers = new Set();
        this.pendingASR = new Set();
        this.pendingAsrCounts = new Map();
        this.pendingAsrReasons = new Map();
        this.pendingAsrTimers = new Map();
        this.nextInsertionOrder = 0;

        this.graceTimer = null;
        this.cooldownTimer = null;

        // Backwards-compatible status fields read by bot.js.
        this.isUserSpeaking = false;
        this.isReady = true;

        // Debug mode (immediate flush - for testing only)
        this.debugMode = false;
    }

    /**
     * Add a completed ASR result to the buffer.
     * Empty transcriptions clear pending-ASR tracking but do not enter the buffer.
     *
     * @param {Object} utterance - {userId, speaker, speakerRole, transcription, words, language, speechStartedAt, speechEndedAt, asrCompletedAt}
     * @returns {number} Current buffered utterance count.
     */
    addUtterance(utterance = {}) {
        const userId = this.normalizeUserId(utterance.userId || utterance.speakerId);
        this.markAsrComplete(userId);

        const transcription = this.normalizeTranscription(utterance);
        if (!transcription) {
            console.log(`[ConversationBuffer] ASR completed for ${this.describeUser(userId, utterance)}, empty transcription dropped. Buffer: ${this.buffer.length} utterance(s)`);
            this.evaluateState('empty ASR result');
            return this.buffer.length;
        }

        const bufferedUtterance = {
            ...utterance,
            transcription,
            insertionOrder: this.nextInsertionOrder++
        };

        this.buffer.push(bufferedUtterance);

        const wordCount = utterance.words?.length || 0;
        console.log(`[ConversationBuffer] Added utterance from ${this.describeUser(userId, utterance)}: "${transcription.substring(0, 40)}..." (${wordCount} words). Buffer: ${this.buffer.length} utterance(s)`);

        // Debug mode: immediate flush (for testing)
        if (this.debugMode) {
            this.forceFlush();
        } else {
            this.evaluateState('utterance added');
        }

        return this.buffer.length;
    }

    /**
     * Set the flush callback.
     * Called when grace period expires and buffer has content.
     */
    onFlush(callback) {
        this.flushCallback = callback;
    }

    /**
     * Track per-user speaking state.
     *
     * Preferred signature: setUserSpeaking(userId, speaking)
     * Backwards-compatible signature: setUserSpeaking(speaking)
     */
    setUserSpeaking(userIdOrSpeaking, speaking) {
        const legacySignature = typeof speaking === 'undefined';
        const userId = legacySignature
            ? DEFAULT_USER_ID
            : (this.normalizeUserId(userIdOrSpeaking) || DEFAULT_USER_ID);
        const isSpeaking = legacySignature ? Boolean(userIdOrSpeaking) : Boolean(speaking);

        if (isSpeaking) {
            this.activeSpeakers.add(userId);
            console.log(`[ConversationBuffer] User ${userId} speaking; active=${this.activeSpeakers.size}, pendingASR=${this.pendingASR.size}`);
            this.clearGraceTimer();
        } else {
            this.activeSpeakers.delete(userId);
            console.log(`[ConversationBuffer] User ${userId} stopped; active=${this.activeSpeakers.size}, pendingASR=${this.pendingASR.size}`);
        }

        this.evaluateState(isSpeaking ? 'speaker started' : 'speaker stopped');
    }

    /**
     * Start the grace period timer.
     * The timer is valid only after ASR has completed for every stopped speaker.
     */
    startGraceTimer(options = {}) {
        const restart = Boolean(options.restart);

        if (this.state === BufferState.COOLDOWN) {
            return;
        }

        if (this.activeSpeakers.size > 0 || this.pendingASR.size > 0 || this.buffer.length === 0) {
            this.clearGraceTimer();
            return;
        }

        if (this.graceTimer && !restart) {
            return;
        }

        this.clearGraceTimer();

        console.log(`[ConversationBuffer] Starting grace period after ASR completion (${this.config.gracePeriod}ms)`);
        this.graceTimer = setTimeout(() => {
            console.log('[ConversationBuffer] Grace period expired');
            this.graceTimer = null;
            this.attemptFlush();
        }, this.config.gracePeriod);
    }

    /**
     * Clear the grace period timer.
     */
    clearGraceTimer() {
        if (this.graceTimer) {
            clearTimeout(this.graceTimer);
            this.graceTimer = null;
        }
    }

    /**
     * Attempt to flush the buffer after grace expires.
     */
    attemptFlush() {
        if (this.buffer.length === 0) {
            console.log('[ConversationBuffer] Buffer empty, nothing to flush');
            this.evaluateState('empty flush attempt');
            return false;
        }

        if (this.state === BufferState.COOLDOWN) {
            console.log('[ConversationBuffer] In cooldown, delaying flush');
            return false;
        }

        if (this.activeSpeakers.size > 0) {
            console.log('[ConversationBuffer] User still speaking, delaying flush');
            this.evaluateState('flush blocked by active speaker');
            return false;
        }

        if (this.pendingASR.size > 0) {
            console.log(`[ConversationBuffer] Awaiting ASR for ${this.pendingASR.size} speaker(s), delaying flush`);
            this.evaluateState('flush blocked by pending ASR');
            return false;
        }

        this.doFlush();
        return true;
    }

    /**
     * Force immediate flush (bypasses timing checks).
     * Used for debug mode or manual flush.
     */
    forceFlush() {
        if (this.buffer.length === 0) return;
        this.clearGraceTimer();
        this.doFlush();
    }

    /**
     * Internal flush - sends buffer to callback and clears it.
     */
    doFlush() {
        const utterances = this.getOrderedUtterances();
        this.buffer = [];

        console.log(`[ConversationBuffer] Flushing ${utterances.length} utterance(s)`);

        if (this.flushCallback) {
            this.flushCallback(utterances);
        }

        this.evaluateState('flush complete');
    }

    /**
     * Start cooldown period.
     * Called after AI response plays to prevent rapid back-to-back responses.
     */
    startCooldown() {
        console.log(`[ConversationBuffer] Starting cooldown (${this.config.cooldownPeriod}ms)`);
        this.clearGraceTimer();
        this.clearCooldownTimer();
        this.transitionTo(BufferState.COOLDOWN, 'cooldown started');

        this.cooldownTimer = setTimeout(() => {
            console.log('[ConversationBuffer] Cooldown complete');
            this.cooldownTimer = null;
            this.transitionTo(BufferState.IDLE, 'cooldown complete');
            this.evaluateState('cooldown complete');
        }, this.config.cooldownPeriod);
    }

    /**
     * Clear cooldown timer.
     */
    clearCooldownTimer() {
        if (this.cooldownTimer) {
            clearTimeout(this.cooldownTimer);
            this.cooldownTimer = null;
        }
    }

    /**
     * Switch buffering mode.
     * @param {Object} config - { gracePeriod, cooldownPeriod, pendingAsrTimeout }
     */
    setMode(config) {
        const nextConfig = { ...this.config, ...config };
        console.log(`[ConversationBuffer] Mode change: grace=${nextConfig.gracePeriod}ms, cooldown=${nextConfig.cooldownPeriod}ms`);
        this.config = nextConfig;

        if (this.state === BufferState.GRACE) {
            this.startGraceTimer({ restart: true });
        }
    }

    /**
     * Get current buffer state (for status commands).
     */
    getState() {
        return {
            state: this.state,
            utteranceCount: this.buffer.length,
            isUserSpeaking: this.activeSpeakers.size > 0,
            isReady: this.state !== BufferState.COOLDOWN,
            gracePending: this.graceTimer !== null,
            cooldownPending: this.cooldownTimer !== null,
            activeSpeakerCount: this.activeSpeakers.size,
            pendingAsrCount: this.pendingASR.size,
            activeSpeakers: Array.from(this.activeSpeakers),
            pendingAsrSpeakers: Array.from(this.pendingASR)
        };
    }

    /**
     * Clear all state.
     */
    clear() {
        this.buffer = [];
        this.nextInsertionOrder = 0;
        this.activeSpeakers.clear();
        this.pendingASR.clear();
        this.pendingAsrCounts.clear();
        this.pendingAsrReasons.clear();
        this.clearGraceTimer();
        this.clearCooldownTimer();
        this.clearPendingAsrTimers();
        this.transitionTo(BufferState.IDLE, 'clear');
    }

    /**
     * Set debug mode (immediate flush).
     */
    setDebug(enabled) {
        this.debugMode = enabled;
    }

    normalizeUserId(userId) {
        if (userId === undefined || userId === null || userId === '') {
            return null;
        }
        return String(userId);
    }

    normalizeTranscription(utterance) {
        return String(utterance.transcription || utterance.text || '').trim();
    }

    getOrderedUtterances() {
        return [...this.buffer].sort((a, b) => {
            const aTime = this.getUtteranceSortTime(a);
            const bTime = this.getUtteranceSortTime(b);
            const timeDiff = aTime - bTime;
            if (Number.isFinite(timeDiff) && timeDiff !== 0) {
                return timeDiff;
            }

            return (a.insertionOrder ?? 0) - (b.insertionOrder ?? 0);
        });
    }

    getUtteranceSortTime(utterance) {
        const fields = [
            utterance.speechStartedAt,
            utterance.speechEndedAt,
            utterance.asrCompletedAt || utterance.timestamp
        ];

        for (const field of fields) {
            const parsed = this.parseTimestamp(field);
            if (Number.isFinite(parsed)) {
                return parsed;
            }
        }

        return Number.MAX_SAFE_INTEGER;
    }

    parseTimestamp(value) {
        if (typeof value === 'number') {
            return value;
        }

        const parsed = Date.parse(value);
        return Number.isNaN(parsed) ? NaN : parsed;
    }

    describeUser(userId, utterance = {}) {
        if (utterance.speaker && userId) return `${utterance.speaker} (${userId})`;
        if (utterance.speaker) return utterance.speaker;
        return userId || 'unknown user';
    }

    markAsrPending(userId, metadata = {}) {
        const normalizedUserId = this.normalizeUserId(userId);
        if (!normalizedUserId) return;

        const reason = typeof metadata === 'string'
            ? metadata
            : metadata.reason || 'receiver candidate';
        const nextCount = (this.pendingAsrCounts.get(normalizedUserId) || 0) + 1;

        this.pendingAsrCounts.set(normalizedUserId, nextCount);
        this.pendingAsrReasons.set(normalizedUserId, reason);
        this.pendingASR.add(normalizedUserId);

        const timeoutMs = this.config.pendingAsrTimeout;
        if (!timeoutMs || timeoutMs <= 0) {
            this.evaluateState('ASR pending');
            return;
        }

        this.armPendingAsrTimer(normalizedUserId, timeoutMs);
        console.log(`[ConversationBuffer] ASR pending for ${normalizedUserId} (${reason}); count=${nextCount}, active=${this.activeSpeakers.size}, pendingASR=${this.pendingASR.size}`);
        this.evaluateState('ASR pending');
    }

    armPendingAsrTimer(userId, timeoutMs = this.config.pendingAsrTimeout) {
        if (!timeoutMs || timeoutMs <= 0) {
            return;
        }

        this.clearPendingAsrTimer(userId);

        const timer = setTimeout(() => {
            this.pendingAsrTimers.delete(userId);
            if (!this.pendingASR.delete(userId)) {
                return;
            }

            const stuckCount = this.pendingAsrCounts.get(userId) || 1;
            const stuckReason = this.pendingAsrReasons.get(userId) || 'unknown';
            this.pendingAsrCounts.delete(userId);
            this.pendingAsrReasons.delete(userId);
            console.log(`[ConversationBuffer] WARNING: ASR pending timeout after ${timeoutMs}ms for user ${userId}; clearing ${stuckCount} stuck entr${stuckCount === 1 ? 'y' : 'ies'} (last reason: ${stuckReason})`);
            this.evaluateState('pending ASR timeout');
        }, timeoutMs);

        this.pendingAsrTimers.set(userId, timer);
    }

    markAsrComplete(userId) {
        const normalizedUserId = this.normalizeUserId(userId);

        if (normalizedUserId && this.pendingASR.has(normalizedUserId)) {
            const nextCount = Math.max(0, (this.pendingAsrCounts.get(normalizedUserId) || 1) - 1);
            if (nextCount > 0) {
                this.pendingAsrCounts.set(normalizedUserId, nextCount);
                this.armPendingAsrTimer(normalizedUserId);
                console.log(`[ConversationBuffer] ASR completed for ${normalizedUserId}; ${nextCount} pending entr${nextCount === 1 ? 'y' : 'ies'} remain`);
                return;
            }

            this.pendingASR.delete(normalizedUserId);
            this.pendingAsrCounts.delete(normalizedUserId);
            this.pendingAsrReasons.delete(normalizedUserId);
            this.clearPendingAsrTimer(normalizedUserId);
            return;
        }

        if (!normalizedUserId && this.pendingASR.size === 1) {
            const [pendingUserId] = Array.from(this.pendingASR);
            this.pendingASR.delete(pendingUserId);
            this.pendingAsrCounts.delete(pendingUserId);
            this.pendingAsrReasons.delete(pendingUserId);
            this.clearPendingAsrTimer(pendingUserId);
            console.log(`[ConversationBuffer] WARNING: ASR result had no userId; matched sole pending user ${pendingUserId}`);
            return;
        }

        if (normalizedUserId) {
            console.log(`[ConversationBuffer] ASR completed for ${normalizedUserId} with no pending entry`);
        } else if (this.pendingASR.size > 0) {
            console.log(`[ConversationBuffer] WARNING: ASR result had no userId and ${this.pendingASR.size} pending speakers remain`);
        }
    }

    clearPendingAsrTimer(userId) {
        const timer = this.pendingAsrTimers.get(userId);
        if (timer) {
            clearTimeout(timer);
            this.pendingAsrTimers.delete(userId);
        }
    }

    clearPendingAsrTimers() {
        for (const timer of this.pendingAsrTimers.values()) {
            clearTimeout(timer);
        }
        this.pendingAsrTimers.clear();
    }

    evaluateState(reason) {
        this.isUserSpeaking = this.activeSpeakers.size > 0;

        if (this.state === BufferState.COOLDOWN) {
            this.isReady = false;
            return;
        }

        this.isReady = true;

        if (this.activeSpeakers.size > 0) {
            this.clearGraceTimer();
            this.transitionTo(BufferState.USER_SPEAKING, reason);
            return;
        }

        if (this.pendingASR.size > 0) {
            this.clearGraceTimer();
            this.transitionTo(BufferState.AWAITING_ASR, reason);
            return;
        }

        if (this.buffer.length > 0) {
            this.transitionTo(BufferState.GRACE, reason);
            this.startGraceTimer();
            return;
        }

        this.clearGraceTimer();
        this.transitionTo(BufferState.IDLE, reason);
    }

    transitionTo(nextState, reason) {
        if (this.state !== nextState) {
            console.log(`[ConversationBuffer] State ${this.state} -> ${nextState}${reason ? ` (${reason})` : ''}`);
        }

        this.state = nextState;
        this.isUserSpeaking = this.activeSpeakers.size > 0;
        this.isReady = this.state !== BufferState.COOLDOWN;
    }
}

/**
 * Chatty mode: Fast responses, short grace period.
 * Good for banter, quick exchanges.
 */
const CHATTY_MODE = {
    gracePeriod: 700,       // wait briefly after ASR lands in case speech resumes
    cooldownPeriod: 2000    // 2s cooldown after AI response
};

/**
 * Buffered mode: Slower, more deliberate.
 * Good for storytelling, monologues.
 */
const BUFFERED_MODE = {
    gracePeriod: 10000,     // 10s grace after ASR lands
    cooldownPeriod: 15000   // 15s cooldown after AI response
};

module.exports = { ConversationBuffer, CHATTY_MODE, BUFFERED_MODE, BufferState };
