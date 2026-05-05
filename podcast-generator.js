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
        const apiKeyConfig = this.resolveApiKey(options);
        this.apiKey = apiKeyConfig.apiKey;
        this.apiKeySource = apiKeyConfig.source;
        this.apiKeyError = apiKeyConfig.error;
        this.baseUrl = options.baseUrl || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
        this.model = options.model || process.env.PODCAST_GENERATOR_MODEL || 'gpt-4.1-mini';
        this.timeout = Number(options.timeout || process.env.PODCAST_GENERATOR_TIMEOUT_MS || 15000);
        this.maxCompletionTokens = Number(options.maxCompletionTokens || process.env.PODCAST_GENERATOR_MAX_TOKENS || 1500);
        this.maxHistoryTurns = Number(options.maxHistoryTurns || process.env.PODCAST_GENERATOR_HISTORY_TURNS || 8);
        this.maxSpeechChars = Number(options.maxSpeechChars || process.env.PODCAST_GENERATOR_MAX_SPEECH_CHARS || 520);
        this.responseFormat = options.responseFormat || process.env.PODCAST_GENERATOR_RESPONSE_FORMAT || 'json_schema';
        this.reasoningFormat = options.reasoningFormat || process.env.PODCAST_GENERATOR_REASONING_FORMAT;
        this.allowJsonObjectFallback = options.allowJsonObjectFallback !== undefined
            ? Boolean(options.allowJsonObjectFallback)
            : process.env.PODCAST_GENERATOR_JSON_OBJECT_FALLBACK !== 'false';
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
            throw new Error(this.apiKeyError || 'OpenAI API key not provided. Set OPENAI_API_KEY or use PODCAST_GENERATOR=gateway.');
        }

        const transcript = input.transcript || this.formatUtterances(input.utterances || []);
        const messages = this.buildMessages(input);

        const startTime = Date.now();
        const result = await this.fetchCompletion(messages);
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
        console.log(`[PodcastGenerator] Completed in ${duration}ms: respond=${output.shouldRespond}, mode=${output.mode}, chars=${output.speech.length}, bigBrain=${output.bigBrain.requested}`);
        if (output.bigBrain.requested) {
            console.log(`[PodcastGenerator] bigBrain requested (DRY RUN — not yet dispatched). reason="${output.bigBrain.reason}"`);
        }
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
            '- Silence is valid. A good live host does not answer every utterance.',
            '',
            'bigBrain (escape hatch to the deeper Open Claw agent):',
            '- You DO NOT have access to: past podcast episodes, files on the server, the web, your own runtime configuration (model, host, infra), current events, specific statistics, dates, or named facts beyond what is in this exact conversation. Your training data is a starting point, not ground truth.',
            '- Default behavior when asked something that would require any of the above: set requested=true. Never guess or recall from training when the question calls for ground-truth information.',
            '- ALWAYS request bigBrain for these question types:',
            '  * Past episodes or anything that happened before this conversation ("do you remember when…", "what was the first episode about…").',
            '  * Specific facts: dates, statistics, named people/places/things, recent events, anything quantitative.',
            '  * Questions about your own runtime, model, server, or infrastructure.',
            '  * Multi-step planning, computation, or any task you cannot do in one or two sentences from current context.',
            '  * Explicit cues like "think harder", "look that up", "use big brain", or guest pushback that you got something wrong.',
            '- EXCEPTION (off-the-cuff waiver): if the guest explicitly waives accuracy with cues like "off the cuff", "gut check", "your best guess", "quickly", "what do you think", "just give me a read", or similar — answer directly without bigBrain. Always prefix with an explicit uncertainty marker so the listener knows it is unverified: "honestly, I\'d guess…", "off the top of my head…", "my best guess is…", "I\'m not sure but…". The default-to-bigBrain rule waives whenever the guest has waived the need for ground truth.',
            '- BEFORE requesting bigBrain, make sure you know WHAT specifically the guest wants to know. If their prompt names a topic but not a specific question (e.g. "tell me about X", "let\'s talk about Y", "what about Z"), ask a brief clarifying question first to narrow it. Only request bigBrain once the question is specific enough that a focused answer would be useful. Vague bigBrain dispatches waste Open Claw cycles and return info the guest may not have wanted.',
            '- ONLY default to { requested: false, reason: "" } for live conversational moves that need no recall or research: acknowledgments, banter, opinions on what was just said, restating something a guest just said, asking clarifying questions about the current topic.',
            '- When requested=true: speech is a brief, in-character stall (under ~15 words) that explicitly names the specific topic you are about to think about and signals the handoff. Vary BOTH the opening and the body every time — do not lock onto a single template. Examples of varied shapes (do NOT reuse these verbatim): "Specific one — give me a sec on Joshua Tree geology." / "Standby, pulling up our Grok rate-limit status." / "Good question, that needs a proper lookup." / "Hmm, let me actually verify the model details." / "I want to get this right — checking now." Do not attempt to answer the underlying question in the stall — that is Open Claw\'s job.',
            '- If you find yourself starting to recall a specific fact, stop and request bigBrain instead. Delegating beats bluffing every time.',
            '- reason is one or two short sentences naming what kind of information you would need. It is not spoken.'
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

    buildRequestBody(messages, options = {}) {
        const responseFormat = options.responseFormat || this.responseFormat;
        const body = {
            model: this.model,
            messages,
            max_completion_tokens: this.maxCompletionTokens
        };

        if (responseFormat === 'json_schema') {
            body.response_format = {
                type: 'json_schema',
                json_schema: {
                    name: 'podcast_voice_turn',
                    strict: true,
                    schema: this.getResponseSchema()
                }
            };
        } else if (responseFormat === 'json_object') {
            body.response_format = { type: 'json_object' };
        }

        const reasoningFormat = options.reasoningFormat || this.reasoningFormat;
        if (reasoningFormat) {
            body.reasoning_format = reasoningFormat;
        }

        if (this.temperature !== undefined && this.temperature !== '') {
            body.temperature = Number(this.temperature);
        }

        return body;
    }

    async fetchCompletion(messages) {
        const body = this.buildRequestBody(messages);

        try {
            return await this.fetchJson('/chat/completions', body);
        } catch (error) {
            if (!this.shouldRetryWithJsonObject(error, body)) {
                throw error;
            }

            console.warn('[PodcastGenerator] Model rejected json_schema response_format; retrying with json_object');
            return this.fetchJson('/chat/completions', this.buildRequestBody(messages, {
                responseFormat: 'json_object',
                reasoningFormat: this.reasoningFormat || 'hidden'
            }));
        }
    }

    shouldRetryWithJsonObject(error, body) {
        if (!this.allowJsonObjectFallback) return false;
        if (body.response_format?.type !== 'json_schema') return false;
        if (error.status !== 400) return false;

        const errorBody = error.body?.error || error.body || {};
        const message = String(errorBody.message || error.message || '');
        const param = String(errorBody.param || '');

        return param === 'response_format' || /does not support response format `?json_schema`?/i.test(message);
    }

    resolveApiKey(options = {}, env = process.env) {
        if (options.apiKey) {
            return {
                apiKey: options.apiKey,
                source: 'options.apiKey'
            };
        }

        const activeName = String(env.PODCAST_GENERATOR_API_KEY_ACTIVE || '').trim();
        if (activeName) {
            const normalizedName = this.normalizeApiKeyName(activeName);
            const candidates = [
                `PODCAST_GENERATOR_API_KEY_${normalizedName}`,
                `OPENAI_API_KEY_${normalizedName}`
            ];

            for (const source of candidates) {
                if (env[source]) {
                    return {
                        apiKey: env[source],
                        source,
                        activeName
                    };
                }
            }

            return {
                apiKey: null,
                source: null,
                activeName,
                error: `Podcast generator API key "${activeName}" was selected, but none of ${candidates.join(', ')} is set.`
            };
        }

        if (env.PODCAST_GENERATOR_API_KEY) {
            return {
                apiKey: env.PODCAST_GENERATOR_API_KEY,
                source: 'PODCAST_GENERATOR_API_KEY'
            };
        }

        if (env.OPENAI_API_KEY) {
            return {
                apiKey: env.OPENAI_API_KEY,
                source: 'OPENAI_API_KEY'
            };
        }

        return {
            apiKey: null,
            source: null,
            error: 'OpenAI API key not provided. Set PODCAST_GENERATOR_API_KEY, PODCAST_GENERATOR_API_KEY_ACTIVE, OPENAI_API_KEY, or use PODCAST_GENERATOR=gateway.'
        };
    }

    normalizeApiKeyName(name) {
        return String(name || '')
            .trim()
            .replace(/[^A-Za-z0-9]+/g, '_')
            .replace(/^_+|_+$/g, '')
            .toUpperCase();
    }

    getResponseSchema() {
        return {
            type: 'object',
            additionalProperties: false,
            required: ['shouldRespond', 'speech', 'mode', 'confidence', 'bigBrain'],
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
                },
                bigBrain: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['requested', 'reason'],
                    description: 'Escape hatch to hand the next move to the deeper Open Claw agent. Default { requested: false, reason: "" }.',
                    properties: {
                        requested: {
                            type: 'boolean',
                            description: 'Set to true when this turn should be handed to Open Claw because the small model feels stuck, uncertain, or out of depth.'
                        },
                        reason: {
                            type: 'string',
                            description: 'Short (1-2 sentences) explanation of why bigBrain is needed. Empty string when requested is false.'
                        }
                    }
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
            confidence,
            bigBrain: this.normalizeBigBrain(output?.bigBrain)
        };
    }

    normalizeBigBrain(value) {
        const requested = Boolean(value && value.requested === true);
        const reason = requested ? String(value?.reason || '').trim() : '';
        return { requested, reason };
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
                const error = new Error(`OpenAI API error: ${response.status} - ${errorText}`);
                error.status = response.status;
                error.bodyText = errorText;
                try {
                    error.body = JSON.parse(errorText);
                } catch {
                    error.body = null;
                }
                throw error;
            }

            return response.json();
        } finally {
            clearTimeout(timeout);
        }
    }

    validate() {
        const errors = [];
        if (!this.apiKey) {
            errors.push(this.apiKeyError || 'OPENAI_API_KEY is not set');
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
            apiKeySource: this.apiKeySource,
            responseFormat: this.responseFormat,
            maxHistoryTurns: this.maxHistoryTurns,
            timeout: this.timeout
        };
    }
}

module.exports = { PodcastGenerator };
