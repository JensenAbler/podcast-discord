/**
 * ConversationBuffer - ASR-aware utterance accumulation.
 *
 * The settling timer starts only after all active speakers have stopped and
 * all receiver-announced ASR candidates have completed. This is an operational
 * synchronization delay for receiver state, ASR completion, holds, cooldown,
 * and stale-response requeues. It is not a duration-based turn inference
 * heuristic.
 *
 * States:
 * - IDLE: ready, no active speakers, no pending ASR, empty buffer
 * - USER_SPEAKING: at least one speaker is actively talking
 * - AWAITING_ASR: everyone stopped, but one or more ASR jobs are still pending
 * - GRACE: legacy state name; buffered text is in the fixed settling delay
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
const DEFAULT_SETTLING_DELAY = 50;      // fixed operational post-ASR settling delay
const DEFAULT_COOLDOWN_PERIOD = 50;     // hold after a host turn before another response

function parseFiniteEnv(raw) {
    if (raw == null || raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
}

class ConversationBuffer {
    constructor(config = {}) {
        const envSettlingDelay = parseFiniteEnv(process.env.CONVERSATION_BUFFER_SETTLING_DELAY_MS);
        const legacyEnvGracePeriod = parseFiniteEnv(process.env.CONVERSATION_BUFFER_GRACE_PERIOD_MS);
        const envCooldownPeriod = parseFiniteEnv(process.env.CONVERSATION_BUFFER_COOLDOWN_PERIOD_MS);

        const explicitSettlingDelay = Object.prototype.hasOwnProperty.call(config, 'settlingDelay');
        const explicitLegacyGracePeriod = Object.prototype.hasOwnProperty.call(config, 'gracePeriod');

        // settlingDelay: explicit arg wins, then current env, then deprecated
        // grace env alias, then default.
        const settlingDelay = explicitSettlingDelay
            ? config.settlingDelay
            : (explicitLegacyGracePeriod
                ? config.gracePeriod
                : (envSettlingDelay !== null
                    ? envSettlingDelay
                    : (legacyEnvGracePeriod !== null ? legacyEnvGracePeriod : DEFAULT_SETTLING_DELAY)));

        this.config = {
            settlingDelay,
            gracePeriod: settlingDelay,
            cooldownPeriod: Object.prototype.hasOwnProperty.call(config, 'cooldownPeriod')
                ? config.cooldownPeriod
                : (envCooldownPeriod !== null ? envCooldownPeriod : DEFAULT_COOLDOWN_PERIOD),
            pendingAsrTimeout: Object.prototype.hasOwnProperty.call(config, 'pendingAsrTimeout')
                ? config.pendingAsrTimeout
                : DEFAULT_PENDING_ASR_TIMEOUT
        };

        this.buffer = []; // Stores {userId, speaker, transcription, timestamp, ...}
        this.flushCallback = null;
        this.timers = config.timers || {
            setTimeout,
            clearTimeout
        };

        // Explicit state machine state and per-user tracking.
        this.state = BufferState.IDLE;
        this.activeSpeakers = new Set();
        // endpointingSpeakers: receiver has signaled the user stopped but is
        // still inside the debounce window. Treated like an active speaker for
        // gating purposes (idle + flush) but distinct in the receiver's eyes.
        this.endpointingSpeakers = new Set();
        this.pendingASR = new Set();
        this.pendingAsrCounts = new Map();
        this.pendingAsrReasons = new Map();
        this.pendingAsrTimers = new Map();
        this.flushHolds = new Set();
        this.nextInsertionOrder = 0;

        this.settlingTimer = null;
        this.cooldownTimer = null;
        this.lastSettlingDelay = this.config.settlingDelay;

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
     * Called when the fixed settling delay expires and buffer has content.
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
            this.clearSettlingTimer();
        } else {
            this.activeSpeakers.delete(userId);
            console.log(`[ConversationBuffer] User ${userId} stopped; active=${this.activeSpeakers.size}, pendingASR=${this.pendingASR.size}`);
        }

        this.evaluateState(isSpeaking ? 'speaker started' : 'speaker stopped');
    }

    /**
     * Start the fixed operational settling timer.
     * The timer is valid only after ASR has completed for every stopped speaker.
     */
    startSettlingTimer(options = {}) {
        const restart = Boolean(options.restart);

        if (this.state === BufferState.COOLDOWN) {
            return;
        }

        if (
            this.activeSpeakers.size > 0 ||
            this.endpointingSpeakers.size > 0 ||
            this.pendingASR.size > 0 ||
            this.flushHolds.size > 0 ||
            this.buffer.length === 0
        ) {
            this.clearSettlingTimer();
            return;
        }

        if (this.settlingTimer && !restart) {
            return;
        }

        this.clearSettlingTimer();

        const settlingDelay = this.calculateSettlingDelay();
        console.log(`[ConversationBuffer] Starting operational settling delay after ASR completion (${settlingDelay}ms)`);
        this.settlingTimer = this.timers.setTimeout(() => {
            console.log('[ConversationBuffer] Operational settling delay expired');
            this.settlingTimer = null;
            this.attemptFlush();
        }, settlingDelay);
    }

    /**
     * Clear the fixed operational settling timer.
     */
    clearSettlingTimer() {
        if (this.settlingTimer) {
            this.timers.clearTimeout(this.settlingTimer);
            this.settlingTimer = null;
        }
    }

    /**
     * Attempt to flush the buffer after the settling delay expires.
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

        if (this.flushHolds.size > 0) {
            console.log(`[ConversationBuffer] Flush held by: ${Array.from(this.flushHolds).join(', ')}`);
            this.evaluateState('flush blocked by hold');
            return false;
        }

        if (this.activeSpeakers.size > 0 || this.endpointingSpeakers.size > 0) {
            console.log('[ConversationBuffer] User still speaking or endpointing, delaying flush');
            this.evaluateState('flush blocked by active/endpointing speaker');
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
        this.clearSettlingTimer();
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
     * Put previously flushed utterances back in the buffer.
     * Used when a host response becomes stale because a participant resumed
     * before playback started. This does not touch ASR state or transcript files.
     */
    requeueUtterances(utterances = [], reason = 'requeue') {
        const restored = [];

        for (const utterance of utterances) {
            const transcription = this.normalizeTranscription(utterance);
            if (!transcription) continue;

            restored.push({
                ...utterance,
                transcription,
                insertionOrder: this.nextInsertionOrder++
            });
        }

        if (restored.length === 0) {
            return this.buffer.length;
        }

        this.buffer.push(...restored);
        console.log(`[ConversationBuffer] Requeued ${restored.length} utterance(s) (${reason}). Buffer: ${this.buffer.length} utterance(s)`);
        this.evaluateState(reason);
        return this.buffer.length;
    }

    /**
     * Start cooldown period.
     * Called after AI response plays to prevent rapid back-to-back responses.
     */
    startCooldown() {
        console.log(`[ConversationBuffer] Starting cooldown (${this.config.cooldownPeriod}ms)`);
        this.clearSettlingTimer();
        this.clearCooldownTimer();
        this.transitionTo(BufferState.COOLDOWN, 'cooldown started');

        this.cooldownTimer = this.timers.setTimeout(() => {
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
            this.timers.clearTimeout(this.cooldownTimer);
            this.cooldownTimer = null;
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
            isReady: this.state !== BufferState.COOLDOWN && this.flushHolds.size === 0,
            settlingPending: this.settlingTimer !== null,
            settlingDelay: this.lastSettlingDelay,
            gracePending: this.settlingTimer !== null,
            gracePeriod: this.lastSettlingDelay,
            cooldownPending: this.cooldownTimer !== null,
            activeSpeakerCount: this.activeSpeakers.size,
            endpointingSpeakerCount: this.endpointingSpeakers.size,
            pendingAsrCount: this.pendingASR.size,
            flushHoldCount: this.flushHolds.size,
            activeSpeakers: Array.from(this.activeSpeakers),
            endpointingSpeakers: Array.from(this.endpointingSpeakers),
            pendingAsrSpeakers: Array.from(this.pendingASR),
            flushHolds: Array.from(this.flushHolds)
        };
    }

    /**
     * Clear all state.
     */
    clear() {
        this.buffer = [];
        this.nextInsertionOrder = 0;
        this.activeSpeakers.clear();
        this.endpointingSpeakers.clear();
        this.pendingASR.clear();
        this.pendingAsrCounts.clear();
        this.pendingAsrReasons.clear();
        this.flushHolds.clear();
        this.clearSettlingTimer();
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

    calculateSettlingDelay() {
        this.lastSettlingDelay = this.config.settlingDelay;
        return this.lastSettlingDelay;
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
        if (typeof value === 'number' && Number.isFinite(value)) {
            return value;
        }

        if (value === undefined || value === null || value === '') {
            return null;
        }

        const parsed = Date.parse(value);
        return Number.isNaN(parsed) ? null : parsed;
    }

    describeUser(userId, utterance = {}) {
        if (utterance.speaker && userId) return `${utterance.speaker} (${userId})`;
        if (utterance.speaker) return utterance.speaker;
        return userId || 'unknown user';
    }

    /**
     * Mark a user as endpointing (Discord-stop debounce window in the receiver).
     * Treated like an active speaker for gating: blocks idle decisions and
     * delays flush. No safety timeout — the receiver guarantees the window
     * expires quickly and will then either dispatch ASR or, if the user
     * resumed, clear endpointing via this same setter.
     */
    markEndpointing(userId, isEndpointing) {
        const normalizedUserId = this.normalizeUserId(userId);
        if (!normalizedUserId) return;

        if (isEndpointing) {
            this.endpointingSpeakers.add(normalizedUserId);
            console.log(`[ConversationBuffer] Endpointing for ${normalizedUserId}; active=${this.activeSpeakers.size}, endpointing=${this.endpointingSpeakers.size}, pendingASR=${this.pendingASR.size}`);
            this.clearSettlingTimer();
            this.evaluateState('endpointing started');
            return;
        }

        if (this.endpointingSpeakers.delete(normalizedUserId)) {
            console.log(`[ConversationBuffer] Endpointing complete for ${normalizedUserId}; active=${this.activeSpeakers.size}, endpointing=${this.endpointingSpeakers.size}, pendingASR=${this.pendingASR.size}`);
            this.evaluateState('endpointing ended');
        }
    }

    /**
     * Hold buffered utterances while an external host action is in progress.
     * This preserves ASR text without launching overlapping generator turns.
     */
    setFlushHold(reason, isHeld) {
        const key = String(reason || '').trim();
        if (!key) return;

        if (isHeld) {
            this.flushHolds.add(key);
            this.clearSettlingTimer();
            this.evaluateState(`${key} hold started`);
            return;
        }

        if (this.flushHolds.delete(key)) {
            this.evaluateState(`${key} hold cleared`);
        }
    }

    /**
     * Mark a user's audio as actually dispatched to the ASR backend.
     * The 8s pendingAsrTimeout is a real network safety net for hung Fish calls.
     */
    markAsrPending(userId, metadata = {}) {
        const normalizedUserId = this.normalizeUserId(userId);
        if (!normalizedUserId) return;

        const reason = typeof metadata === 'string'
            ? metadata
            : metadata.reason || 'asr dispatched';
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

        const timer = this.timers.setTimeout(() => {
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
            this.timers.clearTimeout(timer);
            this.pendingAsrTimers.delete(userId);
        }
    }

    clearPendingAsrTimers() {
        for (const timer of this.pendingAsrTimers.values()) {
            this.timers.clearTimeout(timer);
        }
        this.pendingAsrTimers.clear();
    }

    evaluateState(reason) {
        this.isUserSpeaking = this.activeSpeakers.size > 0;

        if (this.state === BufferState.COOLDOWN) {
            this.isReady = false;
            return;
        }

        this.isReady = this.flushHolds.size === 0;

        if (this.activeSpeakers.size > 0 || this.endpointingSpeakers.size > 0) {
            this.clearSettlingTimer();
            this.transitionTo(BufferState.USER_SPEAKING, reason);
            return;
        }

        if (this.pendingASR.size > 0) {
            this.clearSettlingTimer();
            this.transitionTo(BufferState.AWAITING_ASR, reason);
            return;
        }

        if (this.buffer.length > 0) {
            this.transitionTo(BufferState.GRACE, reason);
            this.startSettlingTimer();
            return;
        }

        this.clearSettlingTimer();
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

module.exports = { ConversationBuffer, BufferState };
