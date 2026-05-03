/**
 * PodcastGenerator - low-latency structured response generator for live voice.
 *
 * This bypasses the general OpenClaw/Gateway agent path for the spoken reply
 * itself. It asks a small model for one strict JSON object:
 * - shouldRespond: whether Alpha-Clawd should speak at all
 * - speech: exact TTS text
 * - mode: optional buffer mode change
 * - confidence: model confidence in speaking now
 */

class PodcastGenerator {
    constructor(options = {}) {
        this.apiKey = options.apiKey || process.env.OPENAI_API_KEY;
        this.baseUrl = options.baseUrl || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
        this.model = options.model || process.env.PODCAST_GENERATOR_MODEL || 'gpt-4.1-mini';
        this.timeout = Number(options.timeout || process.env.PODCAST_GENERATOR_TIMEOUT_MS || 15000);
        this.maxCompletionTokens = Number(options.maxCompletionTokens || process.env.PODCAST_GENERATOR_MAX_TOKENS || 1500);
        this.maxHistoryTurns = Number(options.maxHistoryTurns || process.env.PODCAST_GENERATOR_HISTORY_TURNS || 8);
        this.maxSpeechChars = Number(options.maxSpeechChars || process.env.PODCAST_GENERATOR_MAX_SPEECH_CHARS || 520);
        this.temperature = process.env.PODCAST_GENERATOR_TEMPERATURE;
        this.history = [];
        this.session = {
            topic: 'general discussion',
            recording: false,
            speakers: []
        };
    }

    startSession(options = {}) {
        this.history = [];
        this.session = {
            topic: options.topic || 'general discussion',
            recording: options.recording !== false,
            speakers: options.speakers || []
        };
        console.log(`[PodcastGenerator] Session started: topic="${this.session.topic}"`);
    }

    endSession() {
        this.history = [];
        this.session.recording = false;
        console.log('[PodcastGenerator] Session ended');
    }

    async generate(input = {}) {
        if (!this.apiKey) {
            throw new Error('OpenAI API key not provided. Set OPENAI_API_KEY or use PODCAST_GENERATOR=gateway.');
        }

        const transcript = input.transcript || this.formatUtterances(input.utterances || []);
        const messages = this.buildMessages(input);

        const body = {
            model: this.model,
            messages,
            max_completion_tokens: this.maxCompletionTokens,
            response_format: {
                type: 'json_schema',
                json_schema: {
                    name: 'podcast_voice_turn',
                    strict: true,
                    schema: this.getResponseSchema()
                }
            }
        };

        if (this.temperature !== undefined && this.temperature !== '') {
            body.temperature = Number(this.temperature);
        }

        const startTime = Date.now();
        const result = await this.fetchJson('/chat/completions', body);
        const duration = Date.now() - startTime;
        const choice = result.choices?.[0];
        const content = choice?.message?.content;
        const refusal = choice?.message?.refusal;

        if (refusal) {
            console.warn(`[PodcastGenerator] Model refusal: ${refusal}`);
            return this.normalizeOutput({
                shouldRespond: false,
                speech: '',
                mode: 'unchanged',
                confidence: 0
            });
        }

        if (!content) {
            throw new Error('Podcast generator returned an empty response');
        }

        let parsed;
        try {
            parsed = JSON.parse(content);
        } catch (error) {
            throw new Error(`Podcast generator returned invalid JSON: ${error.message}`);
        }

        const output = this.normalizeOutput(parsed);
        if (input.remember !== false) {
            this.rememberTurn(transcript, output);
        }
        console.log(`[PodcastGenerator] Completed in ${duration}ms: respond=${output.shouldRespond}, mode=${output.mode}, chars=${output.speech.length}`);
        return output;
    }

    buildMessages(input = {}) {
        const transcript = input.transcript || this.formatUtterances(input.utterances || []);
        const currentMode = input.currentMode || 'chatty';

        return [
            { role: 'system', content: this.buildSystemPrompt() },
            ...this.getRecentHistory(),
            { role: 'user', content: this.buildUserPrompt(transcript, currentMode, input.wordData, input) },
            { role: 'system', content: this.buildDecisionPrompt() }
        ];
    }

    buildSystemPrompt() {
        return [
            'You are Alpha-Clawd in a live Discord voice podcast.',
            `Session topic: ${this.session.topic}`,
            `Known speakers: ${this.session.speakers.length > 0 ? this.session.speakers.join(', ') : 'unknown live speakers'}`,
            'This is an ongoing live conversation. Do not wrap up, sign off, or thank guests for joining unless explicitly told the session is ending.',
            '',
            'Your job is to decide whether to speak now and, if so, produce one short spoken reply.',
            '',
            'Hard contract:',
            '- Return JSON matching the provided schema.',
            '- If humans are acknowledging, thinking aloud, crossing over each other, or developing a thought, set shouldRespond=false.',
            '- If shouldRespond=true, speech is exactly what the TTS should say out loud.',
            '- Keep speech to 1-3 natural sentences unless a direct question needs slightly more.',
            '- Use no markdown, bullets, code, URLs, file paths, tables, or stage directions.',
            '- Do not include action directives in speech. Use the mode field instead.',
            '- Use mode=chatty for quick banter and mode=buffered for story/monologue pacing. Otherwise use mode=unchanged.',
            '- Silence is valid. A good live host does not answer every utterance.'
        ].join('\n');
    }

    buildUserPrompt(transcript, currentMode, wordData, options = {}) {
        const lines = [
            `Recording: ${this.session.recording ? 'on' : 'off'}`,
            `Current buffer mode: ${currentMode}`
        ];

        if (options.idleCheck && Number.isFinite(Number(options.idleSeconds))) {
            lines.push(`No new participant speech for about ${Math.max(0, Math.round(Number(options.idleSeconds)))} seconds.`);
        }

        lines.push('', transcript || '(empty)');

        if (wordData) {
            lines.push('', 'STT confidence hints:', wordData);
        }

        return lines.join('\n');
    }

    buildDecisionPrompt() {
        return 'Decide whether Alpha-Clawd should speak now.';
    }

    getResponseSchema() {
        return {
            type: 'object',
            additionalProperties: false,
            required: ['shouldRespond', 'speech', 'mode', 'confidence'],
            properties: {
                shouldRespond: {
                    type: 'boolean',
                    description: 'Whether the host should speak now.'
                },
                speech: {
                    type: 'string',
                    description: 'Exact text to send to TTS. Empty string when shouldRespond is false.'
                },
                mode: {
                    type: 'string',
                    enum: ['unchanged', 'chatty', 'buffered'],
                    description: 'Requested conversation buffer mode after this turn.'
                },
                confidence: {
                    type: 'number',
                    description: 'Confidence that this is the right turn-taking decision.'
                }
            }
        };
    }

    normalizeOutput(output) {
        const shouldRespond = Boolean(output?.shouldRespond);
        const mode = ['chatty', 'buffered', 'unchanged'].includes(output?.mode)
            ? output.mode
            : 'unchanged';
        const confidence = Number.isFinite(Number(output?.confidence))
            ? Math.min(1, Math.max(0, Number(output.confidence)))
            : 0;
        const speech = shouldRespond ? this.sanitizeSpeech(output?.speech || '') : '';

        return {
            shouldRespond: shouldRespond && speech.length > 0,
            speech,
            text: speech,
            mode,
            confidence
        };
    }

    sanitizeSpeech(text) {
        let cleaned = String(text || '')
            .replace(/```[\s\S]*?```/g, '')
            .replace(/\[ACTION:mode:[^\]]+\]/gi, '')
            .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/gi, '$1')
            .replace(/https?:\/\/\S+/gi, '')
            .replace(/`([^`]+)`/g, '$1')
            .replace(/^\s*[-*+]\s+/gm, '')
            .replace(/^\s{0,3}#{1,6}\s+/gm, '')
            .replace(/[*_~>]+/g, '')
            .replace(/\s+/g, ' ')
            .trim();

        if (cleaned.length <= this.maxSpeechChars) {
            return cleaned;
        }

        const clipped = cleaned.slice(0, this.maxSpeechChars);
        const sentenceEnd = Math.max(
            clipped.lastIndexOf('.'),
            clipped.lastIndexOf('!'),
            clipped.lastIndexOf('?')
        );

        if (sentenceEnd > Math.floor(this.maxSpeechChars * 0.45)) {
            return clipped.slice(0, sentenceEnd + 1).trim();
        }

        return `${clipped.replace(/\s+\S*$/, '').trim()}...`;
    }

    formatUtterances(utterances) {
        return utterances
            .map(u => `${u.speaker || 'Speaker'}: ${u.transcription || u.text || ''}`.trim())
            .filter(Boolean)
            .join('\n');
    }

    getRecentHistory() {
        return this.history.slice(-this.maxHistoryTurns * 2);
    }

    rememberTurn(transcript, output) {
        if (String(transcript || '').trim()) {
            this.history.push({
                role: 'user',
                content: transcript
            });
        }

        if (output.shouldRespond && output.speech) {
            this.rememberAssistantResponse(output);
            return;
        }

        this.trimHistory();
    }

    rememberAssistantResponse(output) {
        if (!output?.shouldRespond || !output.speech) {
            return;
        }

        this.history.push({
            role: 'assistant',
            content: output.speech
        });

        this.trimHistory();
    }

    trimHistory() {
        const maxMessages = this.maxHistoryTurns * 2;
        if (this.history.length > maxMessages) {
            this.history = this.history.slice(-maxMessages);
        }
    }

    async fetchJson(path, body) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.timeout);

        try {
            const response = await fetch(`${this.baseUrl}${path}`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(body),
                signal: controller.signal
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`OpenAI API error: ${response.status} - ${errorText}`);
            }

            return response.json();
        } finally {
            clearTimeout(timeout);
        }
    }

    validate() {
        const errors = [];
        if (!this.apiKey) {
            errors.push('OPENAI_API_KEY is not set');
        }
        if (!this.model) {
            errors.push('PODCAST_GENERATOR_MODEL is empty');
        }
        return {
            valid: errors.length === 0,
            provider: 'openai-direct',
            model: this.model,
            errors
        };
    }

    getInfo() {
        return {
            provider: 'openai-direct',
            model: this.model,
            maxHistoryTurns: this.maxHistoryTurns,
            timeout: this.timeout
        };
    }
}

module.exports = { PodcastGenerator };
