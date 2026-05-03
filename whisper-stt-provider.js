/**
 * Whisper STT Provider - Speech-to-Text using OpenAI Whisper
 * 
 * Cost-effective alternative to ElevenLabs STT.
 * - Free tier: $5 credit for new accounts
 * - Pricing: ~$0.006 per minute (much cheaper than ElevenLabs)
 * - Quality: Excellent, especially for English
 * 
 * Also supports local Whisper if you want completely free (requires local setup).
 */

class WhisperSTTProvider {
    constructor(options = {}) {
        this.apiKey = options.apiKey || process.env.OPENAI_API_KEY;
        this.baseUrl = options.baseUrl || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
        this.model = options.model || process.env.WHISPER_MODEL || 'whisper-1';
        this.language = options.language || process.env.WHISPER_LANGUAGE || 'en';
        this.timeout = options.timeout || 30000;
        
        // Response format: json, text, srt, verbose_json, or vtt
        this.responseFormat = options.responseFormat || 'verbose_json';
    }

    /**
     * Speech-to-Text transcription using OpenAI Whisper
     * 
     * @param {Buffer} audioBuffer - Audio file buffer (WAV, MP3, etc.)
     * @param {Object} options - Transcription options
     * @returns {Promise<Object>} - Transcription result
     */
    async transcribe(audioBuffer, options = {}) {
        const startTime = Date.now();
        
        console.log(`[Whisper STT] Transcribing ${audioBuffer.length} bytes...`);

        if (!this.apiKey) {
            throw new Error('OpenAI API key not provided. Set OPENAI_API_KEY environment variable.');
        }

        try {
            // Create form data
            const form = new FormData();
            
            // Create blob from buffer
            const blob = new Blob([audioBuffer], { type: 'audio/wav' });
            form.append('file', blob, options.filename || 'audio.wav');
            form.append('model', this.model);
            
            // Language hint (optional but improves accuracy)
            if (options.language || this.language) {
                form.append('language', options.language || this.language);
            }
            
            // Response format
            form.append('response_format', options.responseFormat || this.responseFormat);
            
            // Timestamp granularity (optional)
            if (options.timestampGranularities) {
                options.timestampGranularities.forEach(g => {
                    form.append('timestamp_granularities[]', g);
                });
            }

            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), this.timeout);

            try {
                const response = await fetch(`${this.baseUrl}/audio/transcriptions`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${this.apiKey}`
                    },
                    body: form,
                    signal: controller.signal
                });

                clearTimeout(timeout);

                if (!response.ok) {
                    const errorText = await response.text();
                    throw new Error(`Whisper API error: ${response.status} - ${errorText}`);
                }

                const result = await response.json();
                const duration = Date.now() - startTime;
                
                console.log(`[Whisper STT] Transcription complete in ${duration}ms`);

                // Normalize response to match ElevenLabs format
                return {
                    text: result.text || '',
                    language: result.language || options.language || this.language,
                    confidence: this.estimateConfidence(result),
                    words: this.extractWords(result),
                    duration: duration,
                    raw: result
                };

            } catch (fetchError) {
                clearTimeout(timeout);
                throw fetchError;
            }

        } catch (error) {
            console.error('[Whisper STT] Transcription error:', error);
            throw error;
        }
    }

    /**
     * Estimate confidence score from Whisper response
     * Whisper doesn't provide per-word confidence, so we estimate
     * @param {Object} result - Whisper API response
     * @returns {number} - Estimated confidence (0-1)
     */
    estimateConfidence(result) {
        // Whisper doesn't provide confidence scores directly
        // Return a high default since Whisper is generally accurate
        if (!result.text || result.text.trim().length === 0) {
            return 0;
        }
        
        // If we have word-level data with no_fill_probability, use that
        if (result.words && result.words.length > 0) {
            const avgProb = result.words.reduce((sum, w) => {
                return sum + (w.probability || w.no_speech_prob || 0.9);
            }, 0) / result.words.length;
            return Math.min(1, Math.max(0, avgProb));
        }
        
        return 0.85; // Default high confidence
    }

    /**
     * Extract word-level data from Whisper response
     * @param {Object} result - Whisper API response
     * @returns {Array} - Array of word objects
     */
    extractWords(result) {
        if (result.words && Array.isArray(result.words)) {
            return result.words.map(w => ({
                text: w.word || w.text,
                start: w.start,
                end: w.end,
                confidence: w.probability || w.no_speech_prob || 0.9
            }));
        }
        
        // If no word-level data, create single word entry
        if (result.text) {
            return [{
                text: result.text,
                start: 0,
                end: result.duration || 0,
                confidence: 0.85
            }];
        }
        
        return [];
    }

    /**
     * Validate API key by making a test request
     * @returns {Promise<boolean>}
     */
    async validateApiKey() {
        if (!this.apiKey || typeof this.apiKey !== 'string') {
            return false;
        }
        
        // OpenAI keys start with 'sk-' and are reasonably long
        if (!this.apiKey.startsWith('sk-') || this.apiKey.length < 20) {
            return false;
        }
        
        try {
            // Make a lightweight API call to validate
            const response = await fetch(`${this.baseUrl}/models`, {
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`
                },
                signal: AbortSignal.timeout(5000)
            });
            
            return response.ok;
        } catch (error) {
            console.error('[Whisper STT] Validation error:', error.message);
            return false;
        }
    }

    /**
     * Get supported languages
     * @returns {Array<{code: string, name: string}>}
     */
    getSupportedLanguages() {
        // Whisper supports 99 languages
        // Common ones listed here
        return [
            { code: 'en', name: 'English' },
            { code: 'es', name: 'Spanish' },
            { code: 'fr', name: 'French' },
            { code: 'de', name: 'German' },
            { code: 'it', name: 'Italian' },
            { code: 'pt', name: 'Portuguese' },
            { code: 'nl', name: 'Dutch' },
            { code: 'ja', name: 'Japanese' },
            { code: 'zh', name: 'Chinese' },
            { code: 'ko', name: 'Korean' },
            { code: 'ru', name: 'Russian' },
            { code: 'ar', name: 'Arabic' },
            { code: 'hi', name: 'Hindi' },
            { code: 'pl', name: 'Polish' },
            { code: 'tr', name: 'Turkish' },
            { code: 'vi', name: 'Vietnamese' },
        ];
    }
}

module.exports = { WhisperSTTProvider };
