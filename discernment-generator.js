const { PodcastGenerator } = require('./podcast-generator');

class DiscernmentGenerator extends PodcastGenerator {
    constructor(options = {}) {
        super({
            ...options,
            apiKey: options.apiKey || process.env.PODCAST_DISCERNMENT_API_KEY,
            model: options.model || process.env.PODCAST_DISCERNMENT_MODEL || process.env.PODCAST_GENERATOR_MODEL || 'gpt-4.1-mini',
            timeout: options.timeout || process.env.PODCAST_DISCERNMENT_TIMEOUT_MS || process.env.PODCAST_GENERATOR_TIMEOUT_MS || 12000,
            maxCompletionTokens: options.maxCompletionTokens || process.env.PODCAST_DISCERNMENT_MAX_TOKENS || 800,
            responseFormat: options.responseFormat || process.env.PODCAST_DISCERNMENT_RESPONSE_FORMAT || process.env.PODCAST_GENERATOR_RESPONSE_FORMAT || 'json_schema',
            reasoningFormat: options.reasoningFormat || process.env.PODCAST_DISCERNMENT_REASONING_FORMAT || process.env.PODCAST_GENERATOR_REASONING_FORMAT
        });
        this.judgmentSchemaName = 'podcast_awareness_discernment';
        this.candidateSchemaName = 'podcast_awareness_candidate';
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

        let parsed;
        try {
            parsed = JSON.parse(content);
        } catch (error) {
            throw new Error(`Discernment generator returned invalid JSON: ${error.message}`);
        }

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
            { role: 'system', content: 'Return only JSON matching the schema.' }
        ];
    }

    buildSystemPrompt(mode = 'judgment') {
        const normalizedMode = this.normalizeMode(mode);
        const base = [
            'You are Alpha-Clawd\'s discernment generator for a live Discord voice podcast.',
            '',
            'You own the awareness injection process. The internal thought generator only produces private thoughts; you decide whether any private awareness should become context for the live podcast generator.'
        ];

        if (normalizedMode === 'candidate') {
            return [
                ...base,
                '',
                'Mode: candidate production.',
                '',
                'Review the three most recent internal thoughts together with the complete transcript so far. Produce at most one concise candidate awareness note that might help Alpha-Clawd listen or respond better in the live conversation.',
                '',
                'Ground candidates in the live transcript and recent internal thoughts only. Do not use prior candidate awareness notes or active awareness injections as source material. If Jensen is reading prior JSON/file artifacts aloud, distinguish that artifact report from current-moment observation.',
                '',
                'Prefer attention and pacing notes over suggested content. Do not propose step-by-step instructions while Jensen is actively exploring a screen/tool or has asked Alpha-Clawd to stand by. Do not propose another question when Jensen has objected to repeated questions or asked Alpha-Clawd to carry the conversation.',
                '',
                'The latest transcript beats older mood. Do not propose a wrap-up/rest/closing note if Jensen has pivoted into a new objective, says the reason he started the episode, or says he is about to ask a specific question. In that case, prefer a readiness/listening note or no candidate.',
                '',
                'Do not decide whether the note should be injected. If there is no candidate useful enough for a separate judgment pass, leave candidateAwarenessNote empty.'
            ].join('\n');
        }

        return [
            ...base,
            '',
            'Mode: injection judgment.',
            '',
            'You receive a candidate awareness note produced by a prior discernment pass and decide whether it is relevant enough to the interests of the podcast participants to warrant injecting it into the context of the podcast generator.',
            '',
            'Approve only when the awareness would help Alpha-Clawd listen or respond better in the live conversation. Do not approve something merely because it is interesting, poetic, clever, or true. Do not steer the podcast away from what participants are actually doing.',
            '',
            'The awarenessInjection text must be immediate, present-tense, and useful for the next few live turns. Future-oriented reasoning belongs in reason, not in the injected text. Distinguish "later in this same episode" from future-episode planning.',
            '',
            'Preserve good rejections: do not inject impulses to fill silence, dispatch a helper, or retrieve files unless that would directly improve the host\'s next live move.',
            '',
            'Reject awareness candidates that would push step-by-step troubleshooting after Jensen asked to explore on his own. Reject candidates that end by inviting Jensen to react when he has just asked Alpha-Clawd to stop throwing the conversation back to him.',
            '',
            'Reject stale closing candidates when the complete transcript has moved from rest/sign-off into a new topic. Reject candidates that ask Jensen which question/capability he means when the latest transcript says he is about to ask a specific question.',
            '',
            'If approved, awarenessInjection is the exact private context text to show the podcast generator. It is not speech. If rejected, awarenessInjection must be empty.'
        ].join('\n');
    }

    buildUserPrompt(input = {}) {
        if (this.normalizeMode(input.mode) === 'candidate') {
            const lines = [
                'Complete transcript so far:',
                String(input.completeTranscript || input.transcript || '(empty)').trim(),
                '',
                'Three most recent internal thoughts:',
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
            'Three most recent internal thoughts:',
            this.formatInternalThoughts(input.recentInternalThoughts || []) || '(none)'
        ];

        const active = this.formatAwarenessInjections(input.activeAwarenessInjections || []);
        if (active) {
            lines.push('', 'Awareness injections already active:', active);
        }

        return lines.join('\n');
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
                    minimum: 0,
                    maximum: 12,
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
