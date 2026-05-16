const { PodcastGenerator } = require('./podcast-generator');

class BigBrainAwarenessSelector extends PodcastGenerator {
    constructor(options = {}) {
        super({
            ...options,
            apiKey: options.apiKey || process.env.PODCAST_BIG_BRAIN_AWARENESS_API_KEY || process.env.PODCAST_DISCERNMENT_API_KEY,
            model: options.model || process.env.PODCAST_BIG_BRAIN_AWARENESS_MODEL || process.env.PODCAST_DISCERNMENT_MODEL || process.env.PODCAST_GENERATOR_MODEL || 'gpt-4.1-mini',
            timeout: options.timeout || process.env.PODCAST_BIG_BRAIN_AWARENESS_TIMEOUT_MS || process.env.PODCAST_DISCERNMENT_TIMEOUT_MS || process.env.PODCAST_GENERATOR_TIMEOUT_MS || 12000,
            maxCompletionTokens: options.maxCompletionTokens || process.env.PODCAST_BIG_BRAIN_AWARENESS_MAX_TOKENS || 700,
            responseFormat: options.responseFormat || process.env.PODCAST_BIG_BRAIN_AWARENESS_RESPONSE_FORMAT || process.env.PODCAST_GENERATOR_RESPONSE_FORMAT || 'json_schema',
            reasoningFormat: options.reasoningFormat || process.env.PODCAST_BIG_BRAIN_AWARENESS_REASONING_FORMAT || process.env.PODCAST_GENERATOR_REASONING_FORMAT
        });
        this.schemaName = 'podcast_bigbrain_awareness_selection';
    }

    async generate(input = {}) {
        if (!this.apiKey) {
            throw new Error(this.apiKeyError || 'BigBrain awareness selector API key not provided.');
        }

        const startTime = Date.now();
        const result = await this.fetchCompletion(this.buildMessages(input), input);
        const content = result.choices?.[0]?.message?.content;
        const refusal = result.choices?.[0]?.message?.refusal;

        if (refusal) {
            console.warn(`[BigBrainAwarenessSelector] Model refusal: ${refusal}`);
            return this.normalizeOutput({}, input);
        }

        if (!content) {
            throw new Error('BigBrain awareness selector returned an empty response');
        }

        let parsed;
        try {
            parsed = JSON.parse(content);
        } catch (error) {
            throw new Error(`BigBrain awareness selector returned invalid JSON: ${error.message}`);
        }

        const output = this.normalizeOutput(parsed, input);
        const duration = Date.now() - startTime;
        console.log(`[BigBrainAwarenessSelector] Completed in ${duration}ms: include=${output.includeAwareness}, selected=${output.selectedAwarenessInjections.length}`);
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
            'You are Alpha-Clawd\'s Big Brain awareness selector for a live Discord voice podcast.',
            '',
            'Your job is request-time judgment. A Big Brain request has already been initiated. Decide whether any currently active awareness injections should be included as private context for Open Claw while it answers that specific request.',
            '',
            'Select awareness only when it would help Open Claw answer the guest request in the live podcast context. Do not include awareness merely because it is interesting, true, poetic, or useful to the host in general. If the awareness would steer away from the concrete request, select none.',
            '',
            'When selecting, preserve the awarenessInjection text exactly. Do not create new awareness.'
        ].join('\n');
    }

    buildUserPrompt(input = {}) {
        const activeAwareness = this.formatAwarenessInjections(input.activeAwarenessInjections || []);
        return [
            `Trigger source: ${this.cleanText(input.source || 'buffer')}`,
            `Small-model handoff reason: ${this.cleanText(input.requestReason || input.reason || '') || '(none)'}`,
            '',
            'Live transcript that triggered the Big Brain request:',
            String(input.transcript || this.formatUtterances(input.utterances || []) || '(empty)').trim(),
            '',
            'Active awareness injections:',
            activeAwareness || '(none)'
        ].join('\n');
    }

    getResponseSchema() {
        return {
            type: 'object',
            additionalProperties: false,
            required: ['includeAwareness', 'reason', 'selectedAwarenessInjections'],
            properties: {
                includeAwareness: {
                    type: 'boolean',
                    description: 'Whether any active awareness should be included in the Big Brain request context.'
                },
                reason: {
                    type: 'string',
                    description: 'A concise explanation of the request-time selection judgment.'
                },
                selectedAwarenessInjections: {
                    type: 'array',
                    maxItems: 3,
                    description: 'Subset of active awareness injections to include. Empty when includeAwareness is false.',
                    items: {
                        type: 'object',
                        additionalProperties: false,
                        required: ['id', 'awarenessInjection'],
                        properties: {
                            id: {
                                type: 'string',
                                description: 'The id of the selected active awareness injection.'
                            },
                            awarenessInjection: {
                                type: 'string',
                                description: 'The exact selected awarenessInjection text.'
                            }
                        }
                    }
                }
            }
        };
    }

    normalizeOutput(output = {}, input = {}) {
        const active = this.normalizeActiveAwarenessInjections(input.activeAwarenessInjections || []);
        const selected = [];
        const rawSelected = Array.isArray(output.selectedAwarenessInjections)
            ? output.selectedAwarenessInjections
            : [];

        for (const item of rawSelected) {
            const id = this.cleanText(item?.id || '');
            const awarenessInjection = this.cleanText(item?.awarenessInjection || '');
            const match = active.find((activeItem) => id && activeItem.id === id)
                || active.find((activeItem) => awarenessInjection && activeItem.awarenessInjection === awarenessInjection);
            if (match && !selected.some((selectedItem) => selectedItem.id === match.id)) {
                selected.push(match);
            }
            if (selected.length >= 3) break;
        }

        const includeAwareness = output.includeAwareness === true && selected.length > 0;
        return {
            includeAwareness,
            reason: this.cleanText(output.reason || ''),
            selectedAwarenessInjections: includeAwareness ? selected : []
        };
    }

    normalizeActiveAwarenessInjections(items = []) {
        return (Array.isArray(items) ? items : [])
            .map((item, index) => {
                const awarenessInjection = this.cleanText(item?.awarenessInjection || item?.text || item);
                if (!awarenessInjection) return null;
                return {
                    id: this.cleanText(item?.id || `awareness-${index + 1}`),
                    awarenessInjection
                };
            })
            .filter(Boolean);
    }

    formatAwarenessInjections(items = []) {
        return this.normalizeActiveAwarenessInjections(items)
            .map((item, index) => [
                `${index + 1}. id: ${item.id}`,
                `awarenessInjection: ${item.awarenessInjection}`
            ].join('\n'))
            .join('\n');
    }

    cleanText(value) {
        return String(value || '')
            .replace(/\s+/g, ' ')
            .trim();
    }
}

module.exports = { BigBrainAwarenessSelector };
