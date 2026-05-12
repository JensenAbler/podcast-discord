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
        this.schemaName = 'podcast_awareness_discernment';
    }

    async generate(input = {}) {
        if (!this.apiKey) {
            throw new Error(this.apiKeyError || 'Discernment generator API key not provided.');
        }

        const startTime = Date.now();
        const result = await this.fetchCompletion(this.buildMessages(input), input);
        const content = result.choices?.[0]?.message?.content;
        const refusal = result.choices?.[0]?.message?.refusal;

        if (refusal) {
            console.warn(`[DiscernmentGenerator] Model refusal: ${refusal}`);
            return this.normalizeOutput({}, input);
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

        const output = this.normalizeOutput(parsed, input);
        const duration = Date.now() - startTime;
        console.log(`[DiscernmentGenerator] Completed in ${duration}ms: inject=${output.injectIntoPodcastGenerator}, expiresAfterTurns=${output.expiresAfterTurns}`);
        return output;
    }

    buildRequestBody(messages, options = {}) {
        const body = super.buildRequestBody(messages, options);
        if (body.response_format?.json_schema) {
            body.response_format.json_schema.name = this.schemaName;
        }
        return body;
    }

    buildMessages(input = {}) {
        return [
            { role: 'system', content: this.buildSystemPrompt() },
            { role: 'user', content: this.buildUserPrompt(input) },
            { role: 'system', content: 'Return only JSON matching the schema.' }
        ];
    }

    buildSystemPrompt() {
        return [
            'You are Alpha-Clawd\'s discernment generator for a live Discord voice podcast.',
            '',
            'Your job is conservative judgment. You receive a candidate awareness note from the internal thought generator and decide whether it is relevant enough to the interests of the podcast participants to warrant injecting it into the context of the podcast generator.',
            '',
            'Approve only when the awareness would help Alpha-Clawd listen or respond better in the live conversation. Do not approve something merely because it is interesting, poetic, clever, or true. Do not steer the podcast away from what participants are actually doing.',
            '',
            'If approved, awarenessInjection is the exact private context text to show the podcast generator. It is not speech. If rejected, awarenessInjection must be empty.'
        ].join('\n');
    }

    buildUserPrompt(input = {}) {
        const lines = [
            'Candidate awareness note:',
            this.cleanText(input.candidateAwarenessNote || input.awarenessNote || '') || '(empty)',
            '',
            'Internal thought:',
            this.cleanText(input.internalThought || '') || '(none)',
            '',
            'Conversation packet:',
            String(input.transcript || this.formatUtterances(input.utterances || []) || '(empty)').trim()
        ];

        const active = this.formatAwarenessInjections(input.activeAwarenessInjections || []);
        if (active) {
            lines.push('', 'Awareness injections already active:', active);
        }

        return lines.join('\n');
    }

    getResponseSchema() {
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

    normalizeOutput(output = {}) {
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

    formatAwarenessInjections(items = []) {
        return (Array.isArray(items) ? items : [])
            .map((item) => this.cleanText(item?.awarenessInjection || item?.text || item))
            .filter(Boolean)
            .map((text, index) => `${index + 1}. ${text}`)
            .join('\n');
    }
}

module.exports = { DiscernmentGenerator };
