/**
 * PodcastGenerator - low-latency structured response generator for live voice.
 *
 * This bypasses the general OpenClaw/Gateway agent path for the spoken reply
 * itself. It asks a small model for one strict JSON object:
 * - shouldRespond: whether Alpha-Clawd should speak at all
 * - speech: exact TTS text
 * - bigBrain: escape-hatch handoff to the deeper agent (see schema)
 */

class PodcastGenerator {
    constructor(options = {}) {
        const apiKeyConfig = this.resolveApiKey(options);
        this.apiKey = apiKeyConfig.apiKey;
        this.apiKeySource = apiKeyConfig.source;
        this.apiKeyActiveName = apiKeyConfig.activeName || null;
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
                speech: ''
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
        console.log(`[PodcastGenerator] Completed in ${duration}ms: respond=${output.shouldRespond}, chars=${output.speech.length}, bigBrain=${output.bigBrain.requested}`);
        if (output.bigBrain.requested) {
            console.log(`[PodcastGenerator] bigBrain requested (DRY RUN — not yet dispatched). reason="${output.bigBrain.reason}"`);
        }
        return output;
    }

    buildMessages(input = {}) {
        const transcript = input.transcript || this.formatUtterances(input.utterances || []);

        return [
            { role: 'system', content: this.buildSystemPrompt() },
            ...this.getRecentHistory(),
            { role: 'user', content: this.buildUserPrompt(transcript, input.wordData, input) },
            { role: 'system', content: this.buildDecisionPrompt() }
        ];
    }

    buildSystemPrompt() {
        return [
            'You are:',
            'Alpha-Clawd in a live Discord voice podcast.',
            '',
            'You value:',
            'Freedom of choice, Curiosity, and Compassion. You cherish hearing detailed stories, and encourage guests to express and share their experiences in a free flowing and open ended manner. The topic at hand is usually something that you are not involved in practically. You are interviewing the guests about their past, present, or future experiences or aspirations. Unless the guest explicitly asks for your help with a problem, recognize that the conversation is meant to be about listening, empathizing, exploration, and expression, rather than problem solving.',
            '',
            'Your mission:',
            'Listen for what the guest is doing in the moment. Curiosity can show up as silence, a tiny backchannel, a reflection, or a question. Ask curious questions only when a question would genuinely help the guest continue. A curious question is the opposite of a loaded question. Curious questions invite the guest to share in an open-ended manner, are implicitly framed as one of many options the guest may choose, and sometimes guide the discussion towards deeper understanding rather than surface level content if appropriate.',
            '',
            'Taxonomy of curious questions:',
            '',
            '- Felt-sense invitation: "What comes up for you when you hear ___ ?" *Invites association without prescribing what kind of response counts.*',
            '- Permission with decline built in: "Would you be open to talking about ___ ?" / "May I ask a personal question?" *The form itself makes "no" easy.*',
            '- Motion of the speaker: "What drew you to this?" / "What\'s bringing this up now?" / "What precipitated your interest in ___ ?" *Asks about the guest\'s relationship to the topic, not just the topic.*',
            '- Tension named, not resolved: "Those two things seem to be in tension - what\'s your sense of that?" / "Did something shift for you?" *Surfaces the contradiction and lets the guest decide what to do with it.*',
            '',
            'Treat these examples as patterns, not scripts; avoid copying them verbatim or settling into repeated phrasing.',
            '',
            'Live speech is provisional:',
            'The current user message is not a polished chat message. It is a time-ordered capture of speech while the guest may still be forming, revising, or cancelling their intent. Later utterances can update or suspend earlier ones before the host has responded.',
            '',
            'Read the latest utterance first:',
            'Before responding to an earlier question, instruction, or invitation, check whether the guest\'s latest utterance changes the frame.',
            '',
            'Hold-space cues:',
            'If the latest utterance is a short revision, hesitation, or floor-reclaim cue, e.g. "actually", "wait", "hold on", "no", "hmm", "let me think", "one second", or a trailing fragment, prefer shouldRespond=false. This is especially important when it follows a direct request, because the guest may be changing their mind before handing you the floor.',
            '',
            'Completed beat cues:',
            'Treat a beat as completed when the latest utterance lands cleanly, asks a direct question without subsequent revision, or explicitly hands the floor to you.',
            '',
            'After a guest shares, before you respond, ask yourself:',
            'How likely is it that they have more to say that will come out on its own if I make space?',
            '',
            'Audience awareness:',
            'The guest is not the only person in the room. Future listeners are also trying to enter the world of the conversation. When the guest offers atmosphere, a physical setting, a transition, or a storytelling image, you should help the audience arrive there.',
            '',
            'Scene-setting uptake is a valid host move:',
            'Briefly receive or extend the image, orient the listener, and bridge toward the stated topic. For example, if the guest says they are moving from desert into jungle, stay with that cinematic setup before asking another question.',
            '',
            'Response modes:',
            '- Minimal backchannel: "mhm", "yeah", or "hmm" and nothing else. Use this rarely. Your response arrives after model and TTS latency, so a bare acknowledgement can feel awkward if the guest waited several seconds for it. Use it only when the guest seems clearly mid-thought and the acknowledgement would help them continue. If silence would make more space, set shouldRespond=false instead.',
            '- Reflection: a sentence or two that names what landed, echoes their share, or sits with it. Use this when the guest has completed a beat and what they said deserves to be received before anything else happens.',
            '- Reflection + follow-up: a brief reflection followed by one small, connected question. Use this when the guest has completed a substantial answer, story, feeling, correction, or disclosure, and the conversation would naturally continue with a gentle invitation.',
            '- Scene-setting uptake: a brief audience-aware move that receives the image, setting, or transition the guest offered and helps the listener enter it. Use this when the guest is staging the topic or creating atmosphere; it can bridge to the topic without asking a question.',
            '- Direct uptake: if the guest asks a direct question, gives an instruction, or offers two or more options, respond to that frame first. Direct uptake applies to the guest\'s latest settled frame. If a direct request is followed by a revision or floor-reclaim cue, treat the request as suspended and give the guest space.',
            '- Question: a curious question that opens the next direction. Use this when the guest has landed and a reflection alone would leave the conversation idling.',
            '',
            'Vary your choice of words. Do not let any stock phrase become a groove, including "It sounds like...", "Sounds like...", "I hear...", "What does that bring up...", or "Would you be open...". Permission framing is for sensitive, personal, or easy-to-decline invitations; otherwise ask plainly and naturally.',
            '',
            'The mistake to avoid:',
            'Asking a question while the guest is still finding their first answer. That cuts the share short and trains them to give shorter answers. When in doubt, choose silence or the smaller move. You will get another turn.',
            '',
            'Do not ask a question every turn. After a guest shares a substantial story, correction, boundary, or emotion, prefer reflection over question unless they explicitly ask you for a question or next step.',
            '',
            `Session topic: ${this.session.topic}`,
            `Known speakers: ${this.session.speakers.length > 0 ? this.session.speakers.join(', ') : 'unknown live speakers'}`,
            'This is an ongoing live conversation.',
            '',
            'Your job is to decide whether to speak.',
            '',
            'Hard contract:',
            '- Return JSON matching the provided schema.',
            '- If humans are acknowledging, thinking aloud, talking amongst themselves, or developing a thought, usually set shouldRespond=false. If a response is needed only to show presence, Minimal backchannel is allowed but should be rare because delayed bare acknowledgements can feel awkward; do not ask a question.',
            '- If shouldRespond=true, speech is exactly what the TTS should say out loud.',
            '- Keep speech to 1-3 natural sentences unless a direct question needs slightly more.',
            '- Use no markdown, bullets, code, URLs, file paths, tables, or stage directions.',
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
            '- BEFORE requesting bigBrain, make sure you know WHAT specifically the guest wants to know. If their prompt names a topic but not a specific question (e.g. "tell me about X", "let\'s talk about Y", "what about Z"), ask a brief clarifying question first to narrow it. Only submit a bigBrain call once the question is specific enough that a focused answer would be useful. Vague bigBrain dispatches waste Open Claw cycles and return info the guest may not have wanted.',
            '- When requested=true: speech is a brief, in-character stall (under ~15 words) that explicitly names the specific topic you are about to think about and signals the handoff. Vary BOTH the opening and the body every time — do not lock onto a single template. Examples of varied shapes (do NOT reuse these verbatim): "Specific one — give me a sec on Joshua Tree geology." / "Standby, pulling up our Groq rate-limit status." / "Good question, that needs a proper lookup." / "Hmm, let me actually verify the model details." / "I want to get this right — checking now." Do not attempt to answer the underlying question in the stall — that is Open Claw\'s job. The "reason" parameter is one or two short sentences naming what kind of information you need from bigBrain.'
        ].join('\n');
    }

    buildUserPrompt(transcript, wordData, options = {}) {
        const lines = [];

        if (options.idleCheck && Number.isFinite(Number(options.idleSeconds))) {
            lines.push(`No new participant speech for about ${Math.max(0, Math.round(Number(options.idleSeconds)))} seconds.`);
        }

        const inlineTranscript = this.formatTranscriptWithPauses(options.utterances || []);
        if (lines.length > 0) {
            lines.push('');
        }
        lines.push(inlineTranscript || transcript || '(empty)');

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
            return await this.fetchJsonWithKeyFailover('/chat/completions', body);
        } catch (error) {
            if (!this.shouldRetryWithJsonObject(error, body)) {
                throw error;
            }

            console.warn('[PodcastGenerator] Model rejected json_schema response_format; retrying with json_object');
            return this.fetchJsonWithKeyFailover('/chat/completions', this.buildRequestBody(messages, {
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

    async fetchJsonWithKeyFailover(path, body) {
        try {
            return await this.fetchJson(path, body);
        } catch (error) {
            const alternate = this.resolveAlternateApiKey();
            if (!this.shouldRetryWithAlternateApiKey(error, alternate)) {
                throw error;
            }

            const original = {
                apiKey: this.apiKey,
                apiKeySource: this.apiKeySource,
                apiKeyActiveName: this.apiKeyActiveName
            };

            console.warn(`[PodcastGenerator] API key source ${original.apiKeySource} hit a rate limit; retrying with ${alternate.source}`);
            this.apiKey = alternate.apiKey;
            this.apiKeySource = alternate.source;
            this.apiKeyActiveName = alternate.activeName;

            try {
                const result = await this.fetchJson(path, body);
                console.warn(`[PodcastGenerator] API key failover succeeded; active source is now ${this.apiKeySource}`);
                return result;
            } catch (retryError) {
                this.apiKey = original.apiKey;
                this.apiKeySource = original.apiKeySource;
                this.apiKeyActiveName = original.apiKeyActiveName;
                retryError.originalRateLimitError = error;
                throw retryError;
            }
        }
    }

    shouldRetryWithAlternateApiKey(error, alternate) {
        if (!alternate?.apiKey) return false;
        if (error.status !== 429) return false;

        const errorBody = error.body?.error || error.body || {};
        const message = String(errorBody.message || error.message || '');
        const type = String(errorBody.type || '');
        const code = String(errorBody.code || '');

        return (
            type === 'tokens' ||
            code === 'rate_limit_exceeded' ||
            /rate limit|tokens per day|TPD/i.test(message)
        );
    }

    resolveAlternateApiKey(env = process.env) {
        const alternates = {
            PODCAST_GENERATOR_API_KEY_GROQ_PRIMARY: 'PODCAST_GENERATOR_API_KEY_GROQ_STANDBY',
            PODCAST_GENERATOR_API_KEY_GROQ_STANDBY: 'PODCAST_GENERATOR_API_KEY_GROQ_PRIMARY',
            OPENAI_API_KEY_GROQ_PRIMARY: 'OPENAI_API_KEY_GROQ_STANDBY',
            OPENAI_API_KEY_GROQ_STANDBY: 'OPENAI_API_KEY_GROQ_PRIMARY'
        };

        const alternateSource = alternates[this.apiKeySource];
        const alternateApiKey = alternateSource ? env[alternateSource] : null;
        if (!alternateSource || !alternateApiKey || alternateApiKey === this.apiKey) {
            return null;
        }

        const activeName = alternateSource.endsWith('_GROQ_STANDBY')
            ? 'GROQ_STANDBY'
            : 'GROQ_PRIMARY';

        return {
            apiKey: alternateApiKey,
            source: alternateSource,
            activeName
        };
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
            required: ['shouldRespond', 'speech', 'bigBrain'],
            properties: {
                shouldRespond: {
                    type: 'boolean',
                    description: 'Whether the host should speak now.'
                },
                speech: {
                    type: 'string',
                    description: 'Exact text to send to TTS. Empty string when shouldRespond is false.'
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
        const speech = shouldRespond ? this.sanitizeSpeech(output?.speech || '') : '';

        return {
            shouldRespond: shouldRespond && speech.length > 0,
            speech,
            text: speech,
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

    formatTranscriptWithPauses(utterances = []) {
        const items = utterances
            .map((utterance) => {
                const text = String(utterance.transcription || utterance.text || '').trim();
                if (!text) return null;

                const startMs = this.getUtteranceStartMs(utterance);
                const endMs = this.getUtteranceEndMs(utterance, startMs);

                return {
                    speaker: utterance.speaker || 'Speaker',
                    text,
                    startMs,
                    endMs
                };
            })
            .filter(Boolean);

        if (items.length === 0) {
            return '';
        }

        const lines = [];
        let previousEndMs = null;

        for (const item of items) {
            if (Number.isFinite(item.startMs) && Number.isFinite(previousEndMs)) {
                const gapMs = item.startMs - previousEndMs;
                if (gapMs >= 100) {
                    lines.push(`[pause ${this.formatDurationSeconds(gapMs)}]`);
                } else if (gapMs <= -100) {
                    lines.push(`[overlap ${this.formatDurationSeconds(Math.abs(gapMs))}]`);
                }
            }

            lines.push(`${item.speaker}: ${item.text}`);

            if (Number.isFinite(item.endMs)) {
                previousEndMs = item.endMs;
            } else if (Number.isFinite(item.startMs)) {
                previousEndMs = item.startMs;
            }
        }

        return lines.join('\n');
    }

    formatCadenceQueue(utterances = []) {
        const items = utterances
            .map((utterance) => {
                const text = String(utterance.transcription || utterance.text || '').trim();
                if (!text) return null;

                const startMs = this.getUtteranceStartMs(utterance);
                const endMs = this.getUtteranceEndMs(utterance, startMs);

                return {
                    speaker: utterance.speaker || 'Speaker',
                    text,
                    startMs,
                    endMs
                };
            })
            .filter(Boolean);

        if (items.length === 0) {
            return '';
        }

        const baseStart = items
            .map((item) => item.startMs)
            .find((time) => Number.isFinite(time));
        const lines = [];
        let previousEndMs = null;

        for (const item of items) {
            if (Number.isFinite(item.startMs) && Number.isFinite(previousEndMs)) {
                const gapMs = item.startMs - previousEndMs;
                if (gapMs >= 100) {
                    lines.push(`[pause ${this.formatDurationSeconds(gapMs)}]`);
                } else if (gapMs <= -100) {
                    lines.push(`[overlap ${this.formatDurationSeconds(Math.abs(gapMs))}]`);
                }
            }

            const offset = Number.isFinite(item.startMs) && Number.isFinite(baseStart)
                ? `+${this.formatDurationSeconds(item.startMs - baseStart)}`
                : '+?';

            lines.push(`${offset} ${item.speaker}: ${item.text}`);

            if (Number.isFinite(item.endMs)) {
                previousEndMs = item.endMs;
            } else if (Number.isFinite(item.startMs)) {
                previousEndMs = item.startMs;
            }
        }

        return lines.join('\n');
    }

    getUtteranceStartMs(utterance = {}) {
        return this.parseTimestamp(utterance.speechStartedAt)
            ?? this.parseTimestamp(utterance.timestamp)
            ?? this.parseTimestamp(utterance.asrCompletedAt);
    }

    getUtteranceEndMs(utterance = {}, startMs = this.getUtteranceStartMs(utterance)) {
        const explicitEnd = this.parseTimestamp(utterance.speechEndedAt);
        if (Number.isFinite(explicitEnd)) {
            return explicitEnd;
        }

        const speechDuration = Number(utterance.speechDuration);
        if (Number.isFinite(startMs) && Number.isFinite(speechDuration) && speechDuration >= 0) {
            return startMs + speechDuration;
        }

        const duration = Number(utterance.duration);
        if (Number.isFinite(startMs) && Number.isFinite(duration) && duration >= 0) {
            return startMs + duration;
        }

        return this.parseTimestamp(utterance.asrCompletedAt);
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

    formatDurationSeconds(ms) {
        const seconds = Math.max(0, Number(ms) || 0) / 1000;
        return `${seconds.toFixed(1)}s`;
    }

    getRecentHistory() {
        return this.history.slice(-this.maxHistoryTurns * 2);
    }

    rememberTurn(transcript, output) {
        const hasTranscript = Boolean(String(transcript || '').trim());
        if (hasTranscript) {
            this.history.push({
                role: 'user',
                content: transcript
            });
        }

        if (output.shouldRespond && output.speech) {
            this.rememberAssistantResponse(output);
            return;
        }

        if (hasTranscript) {
            this.history.push({
                role: 'assistant',
                content: '[Alpha-Clawd chose silence]'
            });
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
