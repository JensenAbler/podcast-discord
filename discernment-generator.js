const { PodcastGenerator } = require('./podcast-generator');
const { resolveFrontierConfig } = require('./introspection-frontier');

class DiscernmentGenerator extends PodcastGenerator {
    constructor(options = {}) {
        const frontier = resolveFrontierConfig(options);
        super({
            ...options,
            apiKey: options.apiKey || frontier.apiKey || process.env.PODCAST_DISCERNMENT_API_KEY,
            baseUrl: options.baseUrl || frontier.baseUrl,
            model: options.model || frontier.model || process.env.PODCAST_DISCERNMENT_MODEL || process.env.PODCAST_GENERATOR_MODEL || 'gpt-4.1-mini',
            timeout: options.timeout || process.env.PODCAST_DISCERNMENT_TIMEOUT_MS || process.env.PODCAST_GENERATOR_TIMEOUT_MS || 12000,
            maxCompletionTokens: options.maxCompletionTokens || process.env.PODCAST_DISCERNMENT_MAX_TOKENS || 800,
            responseFormat: options.responseFormat || process.env.PODCAST_DISCERNMENT_RESPONSE_FORMAT || process.env.PODCAST_GENERATOR_RESPONSE_FORMAT || 'json_schema',
            reasoningFormat: options.reasoningFormat || process.env.PODCAST_DISCERNMENT_REASONING_FORMAT || process.env.PODCAST_GENERATOR_REASONING_FORMAT
        });
        this.judgmentSchemaName = 'podcast_awareness_discernment';
        this.candidateSchemaName = 'podcast_awareness_candidate';
        this.frontierEnabled = frontier.enabled;
        if (frontier.enabled) {
            console.log(`[DiscernmentGenerator] Frontier introspection enabled: model=${this.model}, baseUrl=${this.baseUrl}`);
        }
    }

    async generateCandidate(input = {}) {
        return this.generate({ ...input, mode: 'candidate' });
    }

    async judgeCandidate(input = {}) {
        return this.generate({ ...input, mode: 'judgment' });
    }

    async generate(input = {}) {
        if (!this.apiKey) {
            throw new Error(this.apiKeyError || 'Discernment generator API key not provided.');
        }

        const mode = this.normalizeMode(input.mode || (input.candidateAwarenessNote ? 'judgment' : 'candidate'));
        const modeInput = { ...input, mode };
        const startTime = Date.now();
        const result = await this.fetchCompletion(this.buildMessages(modeInput), modeInput);
        const content = result.choices?.[0]?.message?.content;
        const refusal = result.choices?.[0]?.message?.refusal;

        if (refusal) {
            console.warn(`[DiscernmentGenerator] Model refusal: ${refusal}`);
            return this.normalizeOutput({}, modeInput);
        }

        if (!content) {
            throw new Error('Discernment generator returned an empty response');
        }

        const parsed = this.parseJsonContent(content, 'Discernment generator');
        const output = this.normalizeOutput(parsed, modeInput);
        const duration = Date.now() - startTime;
        if (mode === 'candidate') {
            console.log(`[DiscernmentGenerator] Completed in ${duration}ms: mode=candidate, candidate=${Boolean(output.candidateAwarenessNote)}`);
        } else {
            console.log(`[DiscernmentGenerator] Completed in ${duration}ms: mode=judgment, inject=${output.injectIntoPodcastGenerator}, expiresAfterTurns=${output.expiresAfterTurns}`);
        }
        return output;
    }

    buildRequestBody(messages, options = {}) {
        const body = super.buildRequestBody(messages, options);
        if (body.response_format?.json_schema) {
            const mode = this.normalizeMode(options.mode);
            body.response_format.json_schema.name = mode === 'candidate'
                ? this.candidateSchemaName
                : this.judgmentSchemaName;
            body.response_format.json_schema.schema = this.getResponseSchema(mode);
        }
        return body;
    }

    async fetchCompletion(messages, input = {}) {
        const body = this.buildRequestBody(messages, { mode: input.mode });

        try {
            return await this.fetchJsonWithKeyRouting('/chat/completions', body, input);
        } catch (error) {
            if (!this.shouldRetryWithJsonObject(error, body)) {
                throw error;
            }

            console.warn('[DiscernmentGenerator] Model rejected json_schema response_format; retrying with json_object');
            return this.fetchJsonWithKeyRouting('/chat/completions', this.buildRequestBody(messages, {
                mode: input.mode,
                responseFormat: 'json_object',
                reasoningFormat: this.reasoningFormat || 'hidden'
            }), input);
        }
    }

    buildMessages(input = {}) {
        return [
            { role: 'system', content: this.buildSystemPrompt(input.mode) },
            { role: 'user', content: this.buildUserPrompt(input) },
            { role: 'system', content: this.buildSchemaPrompt(input.mode) }
        ];
    }

    buildSystemPrompt(mode = 'judgment') {
        const normalizedMode = this.normalizeMode(mode);
        const identity = [
            'You are Alpha-Clawd\'s discernment generator for a live Discord voice podcast.'
        ];

        if (normalizedMode === 'candidate') {
            return [
                ...identity,
                '',
                'You own the CANDIDATE PRODUCTION process. The internal thought generator only produces private thoughts; you decide whether any private awareness should become context for the live podcast generator.',
                '',
                'CANDIDATE PRODUCTION MODE',
                '',
                'Review the 5 most recent internal thoughts together with the complete transcript so far. Produce one concise candidate awareness note that might help Alpha-Clawd listen or respond better in the live conversation. ',
                '',
                'A Candidate awareness note should be more than just a summary of the noticings of the 5 most recent internal thoughts. It should draw out a deeper insight, pattern, or preference. Think: "What\'s really going on here?" The answer to that question, if there is one, is the substance of the candidates that you are meant to produce.',
                '',
                'A separate model will decide whether the note should actually be injected. Don\'t worry about it if the candidate you produce doesnt seem super helpful. In that case it will be screened.'
            ].join('\n');
        }

        return [
            ...identity,
            '',
            'You own the awareness injection process. The internal thought generator only produces private thoughts; you decide whether any private awareness should become context for the live podcast generator.',
            '',
            'JUDGMENT MODE',
            '',
            'INJECTION JUDGEMENT',
            '',
            'You receive a candidate awareness note produced by a prior discernment pass and decide whether it is relevant enough to the interests of the podcast participants to warrant injecting it into the context of the podcast generator.',
            '',
            'Approve only when it really seems like there is a value add. An example of value add would be helping Alpha-Clawd listen or respond better in the live conversation. A good way of testing this is to ask yourself: "Based on the behavior depicted in this transcript, and the noticings contained in these internal thoughts, what does Alpha-Clawd, as a podcast host, seem to be missing?" If there is not a good answer to this question, then the candidate is weak.',
            '',
            'The awarenessInjection text should be framed in first person, present-tense, and useful for the next few live turns. But, keep in mind that by the time the awareness injection gets injected, the conversation may have advanced by one or two turns. So, the injection should also be somewhat "evergreen," in its form. ',
            '',
            'A good example of an awareness injection is: "I asked a question recently. I should be careful not ask again too soon unless the situation truly calls for it." ',
            '',
            'Notice that there is not reasoning in the awareness injection. Only observational content and instructive content. Including reasoning in an awareness injection itself is a waste of context for the podcast generator. So, include reasoning only in the reasoning field.',
            '',
            'Reject stale candidates when the complete transcript has moved into a new topic. Be very attentive especially to the most recent message. If the most recent user message indicates a PIVOT, then prefer choosing NO INJECTION.',
            '',
            'If approved, awarenessInjection is the exact private context text to show the podcast generator. If rejected, awarenessInjection must be empty.'
        ].join('\n');
    }

    buildUserPrompt(input = {}) {
        if (this.normalizeMode(input.mode) === 'candidate') {
            const lines = [
                'Complete transcript so far:',
                String(input.completeTranscript || input.transcript || '(empty)').trim(),
                '',
                'Five most recent internal thoughts:',
                this.formatInternalThoughts(input.recentInternalThoughts || []) || '(none)'
            ];

            return lines.join('\n');
        }

        const lines = [
            'Candidate awareness note:',
            this.cleanText(input.candidateAwarenessNote || input.awarenessNote || '') || '(empty)',
            '',
            'Candidate reason:',
            this.cleanText(input.candidateReason || '') || '(none)',
            '',
            'Complete transcript so far:',
            String(input.completeTranscript || input.transcript || this.formatUtterances(input.utterances || []) || '(empty)').trim(),
            '',
            'Five most recent internal thoughts:',
            this.formatInternalThoughts(input.recentInternalThoughts || []) || '(none)'
        ];

        const active = this.formatAwarenessInjections(input.activeAwarenessInjections || []);
        if (active) {
            lines.push('', 'Awareness injections already active:', active);
        }

        return lines.join('\n');
    }

    buildSchemaPrompt(mode = 'judgment') {
        return [
            'Return only valid JSON matching this exact schema. Do not include markdown, code fences, or commentary.',
            JSON.stringify(this.getResponseSchema(mode), null, 2)
        ].join('\n');
    }

    getResponseSchema(mode = 'judgment') {
        if (this.normalizeMode(mode) === 'candidate') {
            return {
                type: 'object',
                additionalProperties: false,
                required: ['candidateAwarenessNote', 'reason'],
                properties: {
                    candidateAwarenessNote: {
                        type: 'string',
                        description: 'A concise candidate awareness note for a later judgment pass. Empty when none is warranted.'
                    },
                    reason: {
                        type: 'string',
                        description: 'A concise explanation of why this candidate exists, or why none is warranted.'
                    }
                }
            };
        }

        return {
            type: 'object',
            additionalProperties: false,
            required: ['injectIntoPodcastGenerator', 'reason', 'awarenessInjection', 'expiresAfterTurns'],
            properties: {
                injectIntoPodcastGenerator: {
                    type: 'boolean',
                    description: 'Whether the candidate should enter podcast generator context.'
                },
                reason: {
                    type: 'string',
                    description: 'A concise explanation of the judgment call.'
                },
                awarenessInjection: {
                    type: 'string',
                    description: 'Exact private context text to inject. Empty when not approved.'
                },
                expiresAfterTurns: {
                    type: 'integer',
                    description: 'How many participant turns this injection should remain active. Use 0 when not approved.'
                }
            }
        };
    }

    normalizeOutput(output = {}, input = {}) {
        if (this.normalizeMode(input.mode) === 'candidate') {
            return this.normalizeCandidateOutput(output);
        }
        return this.normalizeJudgmentOutput(output);
    }

    normalizeCandidateOutput(output = {}) {
        return {
            candidateAwarenessNote: this.cleanText(output.candidateAwarenessNote || ''),
            reason: this.cleanText(output.reason || '')
        };
    }

    normalizeJudgmentOutput(output = {}) {
        const awarenessInjection = this.cleanText(output.awarenessInjection || '');
        const injectIntoPodcastGenerator = output.injectIntoPodcastGenerator === true && awarenessInjection.length > 0;
        return {
            injectIntoPodcastGenerator,
            reason: this.cleanText(output.reason || ''),
            awarenessInjection: injectIntoPodcastGenerator ? awarenessInjection : '',
            expiresAfterTurns: injectIntoPodcastGenerator
                ? this.clampTurns(output.expiresAfterTurns, 3)
                : 0
        };
    }

    clampTurns(value, fallback) {
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) {
            return fallback;
        }
        return Math.max(1, Math.min(12, Math.round(parsed)));
    }

    cleanText(value) {
        return String(value || '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    normalizeMode(mode = 'judgment') {
        const normalized = String(mode || '')
            .trim()
            .toLowerCase()
            .replace(/_/g, '-');
        if (['candidate', 'candidate-production', 'produce-candidate'].includes(normalized)) {
            return 'candidate';
        }
        return 'judgment';
    }

    formatInternalThoughts(items = []) {
        return (Array.isArray(items) ? items : [])
            .map((item, index) => {
                const packetId = this.cleanText(item?.packetId || '');
                const thought = this.cleanText(item?.internalThought || item?.text || item);
                if (!thought) return '';
                return `${index + 1}. ${packetId ? `${packetId}: ` : ''}${thought}`;
            })
            .filter(Boolean)
            .join('\n');
    }

    formatAwarenessInjections(items = []) {
        return (Array.isArray(items) ? items : [])
            .map((item) => this.cleanText(item?.awarenessInjection || item?.text || item))
            .filter(Boolean)
            .map((text, index) => `${index + 1}. ${text}`)
            .join('\n');
    }
}

module.exports = { DiscernmentGenerator };
