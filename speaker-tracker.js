/**
 * Speaker Tracker - Track who spoke and conversation history
 * 
 * Maintains conversation context, tracks which speakers have spoken,
 * and manages turn-taking for the AI interviewer.
 */

class SpeakerTracker {
    constructor(options = {}) {
        this.options = {
            maxHistoryLength: options.maxHistoryLength || 50, // Keep last 50 utterances
            maxContextLength: options.maxContextLength || 10, // Last 10 for context
            responseEveryNUtterances: options.responseEveryNUtterances || 2, // Respond every 2 utterances
            ...options
        };

        // Conversation history
        this.history = []; // All utterances
        
        // Speaker statistics
        this.speakerStats = new Map(); // speakerName -> { utterances, totalDuration, lastSpoke }
        
        // Turn management
        this.utteranceCount = 0;
        this.lastResponseAt = 0;
        
        // Topic tracking
        this.currentTopic = null;
        this.topics = [];
    }

    /**
     * Add an utterance to the conversation history
     * @param {Object} utterance - Utterance data
     */
    addUtterance(utterance) {
        const entry = {
            id: this.generateId(),
            timestamp: new Date().toISOString(),
            speaker: utterance.speaker,
            speakerRole: utterance.speakerRole || 'guest',
            userId: utterance.userId,
            duration: utterance.duration || 0,
            transcription: utterance.transcription || null,
            transcriptionConfidence: utterance.transcriptionConfidence || null,
            words: utterance.words || [], // Full word-level data with timing/confidence
            language: utterance.language || null,
            audioBuffer: null // Don't store audio in history to save memory
        };

        // Add to history
        this.history.push(entry);
        
        // Trim history if too long
        if (this.history.length > this.options.maxHistoryLength) {
            this.history = this.history.slice(-this.options.maxHistoryLength);
        }

        // Update speaker stats
        this.updateSpeakerStats(entry);

        // Increment utterance count
        this.utteranceCount++;

        console.log(`[SpeakerTracker] Added utterance from ${entry.speaker} (${this.history.length} total)`);

        return entry;
    }

    /**
     * Update statistics for a speaker
     * @param {Object} entry - Utterance entry
     */
    updateSpeakerStats(entry) {
        const speaker = entry.speaker;
        
        if (!this.speakerStats.has(speaker)) {
            this.speakerStats.set(speaker, {
                name: speaker,
                utterances: 0,
                totalDuration: 0,
                firstSpoke: entry.timestamp,
                lastSpoke: entry.timestamp
            });
        }

        const stats = this.speakerStats.get(speaker);
        stats.utterances++;
        stats.totalDuration += entry.duration;
        stats.lastSpoke = entry.timestamp;
    }

    /**
     * Update transcription for an utterance
     * @param {string} utteranceId - Utterance ID
     * @param {string} transcription - Transcribed text
     */
    updateTranscription(utteranceId, transcription) {
        const entry = this.history.find(u => u.id === utteranceId);
        if (entry) {
            entry.transcription = transcription;
            return true;
        }
        return false;
    }

    /**
     * Get conversation history
     * @param {number} limit - Number of utterances to return
     * @returns {Array}
     */
    getHistory(limit = null) {
        if (limit) {
            return this.history.slice(-limit);
        }
        return [...this.history];
    }

    /**
     * Get recent context for AI processing
     * @returns {Array}
     */
    getContext() {
        return this.history.slice(-this.options.maxContextLength);
    }

    /**
     * Get context formatted as a conversation string
     * @returns {string}
     */
    getContextAsString() {
        return this.getContext()
            .map(u => `${u.speaker}: ${u.transcription || '[processing...]'}`)
            .join('\n');
    }

    /**
     * Get context formatted for LLM prompt
     * @returns {string}
     */
    getContextForPrompt() {
        return this.getContext()
            .map(u => {
                const role = u.speakerRole === 'host' ? 'Host' : 'Guest';
                return `[${role}] ${u.speaker}: ${u.transcription || '[speaking...]'}`;
            })
            .join('\n');
    }

    /**
     * Get all speakers in conversation
     * @returns {Array}
     */
    getSpeakers() {
        const speakers = new Set();
        for (const entry of this.history) {
            speakers.add(entry.speaker);
        }
        return Array.from(speakers);
    }

    /**
     * Get speaker statistics
     * @returns {Object}
     */
    getSpeakerStats() {
        const stats = {};
        for (const [name, data] of this.speakerStats) {
            stats[name] = { ...data };
        }
        return stats;
    }

    /**
     * Determine if AI should respond now
     * @returns {boolean}
     */
    shouldRespond() {
        // Count utterances since last response
        const utterancesSinceResponse = this.utteranceCount - this.lastResponseAt;
        
        // Respond every N utterances
        return utterancesSinceResponse >= this.options.responseEveryNUtterances;
    }

    /**
     * Mark that AI has responded
     */
    markResponseGiven() {
        this.lastResponseAt = this.utteranceCount;
    }

    /**
     * Add AI response to history
     * @param {string} text - AI response text
     * @param {Object} metadata - Additional metadata
     */
    addAIResponse(text, metadata = {}) {
        const entry = {
            id: this.generateId(),
            timestamp: new Date().toISOString(),
            speaker: 'Alpha-Clawd',
            speakerRole: 'host',
            userId: 'bot',
            duration: metadata.duration || 0,
            transcription: text,
            isAI: true
        };

        this.history.push(entry);
        
        if (this.history.length > this.options.maxHistoryLength) {
            this.history = this.history.slice(-this.options.maxHistoryLength);
        }

        this.markResponseGiven();

        console.log(`[SpeakerTracker] Added AI response (${text.length} chars)`);

        return entry;
    }

    /**
     * Get the last speaker
     * @returns {string|null}
     */
    getLastSpeaker() {
        if (this.history.length === 0) return null;
        
        // Find last non-AI speaker
        for (let i = this.history.length - 1; i >= 0; i--) {
            if (!this.history[i].isAI) {
                return this.history[i].speaker;
            }
        }
        return null;
    }

    /**
     * Get the last utterance
     * @returns {Object|null}
     */
    getLastUtterance() {
        if (this.history.length === 0) return null;
        return this.history[this.history.length - 1];
    }

    /**
     * Set current topic
     * @param {string} topic - Topic name
     */
    setTopic(topic) {
        if (this.currentTopic && this.currentTopic !== topic) {
            this.topics.push({
                name: this.currentTopic,
                endedAt: new Date().toISOString()
            });
        }
        this.currentTopic = topic;
    }

    /**
     * Get current topic
     * @returns {string|null}
     */
    getTopic() {
        return this.currentTopic;
    }

    /**
     * Get conversation summary
     * @returns {Object}
     */
    getSummary() {
        return {
            totalUtterances: this.history.length,
            speakers: this.getSpeakerStats(),
            currentTopic: this.currentTopic,
            topics: this.topics,
            duration: this.calculateDuration()
        };
    }

    /**
     * Calculate total conversation duration
     * @returns {number}
     */
    calculateDuration() {
        if (this.history.length < 2) return 0;
        
        const first = new Date(this.history[0].timestamp);
        const last = new Date(this.history[this.history.length - 1].timestamp);
        
        return (last - first) / 1000; // seconds
    }

    /**
     * Generate unique ID
     * @returns {string}
     */
    generateId() {
        return `utt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    /**
     * Clear all history
     */
    clear() {
        this.history = [];
        this.speakerStats.clear();
        this.utteranceCount = 0;
        this.lastResponseAt = 0;
        this.currentTopic = null;
        this.topics = [];
    }

    /**
     * Export conversation to JSON
     * @returns {Object}
     */
    export() {
        return {
            history: this.history,
            stats: this.getSpeakerStats(),
            summary: this.getSummary(),
            exportedAt: new Date().toISOString()
        };
    }
}

module.exports = { SpeakerTracker };
