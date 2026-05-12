const { PodcastGenerator } = require('./podcast-generator');

class InternalThoughtGenerator extends PodcastGenerator {
    constructor(options = {}) {
        super({
            ...options,
            apiKey: options.apiKey || process.env.PODCAST_INTERNAL_THOUGHT_API_KEY,
            model: options.model || process.env.PODCAST_INTERNAL_THOUGHT_MODEL || process.env.PODCAST_GENERATOR_MODEL || 'gpt-4.1-mini',
            timeout: options.timeout || process.env.PODCAST_INTERNAL_THOUGHT_TIMEOUT_MS || process.env.PODCAST_GENERATOR_TIMEOUT_MS || 20000,
            maxCompletionTokens: options.maxCompletionTokens || process.env.PODCAST_INTERNAL_THOUGHT_MAX_TOKENS || 1200,
            responseFormat: options.responseFormat || process.env.PODCAST_INTERNAL_THOUGHT_RESPONSE_FORMAT || process.env.PODCAST_GENERATOR_RESPONSE_FORMAT || 'json_schema',
            reasoningFormat: options.reasoningFormat || process.env.PODCAST_INTERNAL_THOUGHT_REASONING_FORMAT || process.env.PODCAST_GENERATOR_REASONING_FORMAT
        });
        this.schemaName = 'podcast_internal_thought';
    }

    async generate(input = {}) {
        if (!this.apiKey) {
            throw new Error(this.apiKeyError || 'Internal thought generator API key not provided.');
        }

        const startTime = Date.now();
        const result = await this.fetchCompletion(this.buildMessages(input), input);
        const content = result.choices?.[0]?.message?.content;
        const refusal = result.choices?.[0]?.message?.refusal;

        if (refusal) {
            console.warn(`[InternalThoughtGenerator] Model refusal: ${refusal}`);
            return this.normalizeOutput({}, input);
        }

        if (!content) {
            throw new Error('Internal thought generator returned an empty response');
        }

        let parsed;
        try {
            parsed = JSON.parse(content);
        } catch (error) {
            throw new Error(`Internal thought generator returned invalid JSON: ${error.message}`);
        }

        const output = this.normalizeOutput(parsed, input);
        const duration = Date.now() - startTime;
        console.log(`[InternalThoughtGenerator] Completed in ${duration}ms: packet=${output.packetId || 'none'}, candidate=${Boolean(output.candidateAwarenessNote)}`);
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
            'You are Alpha-Clawd\'s internal thought generator for a live Discord voice podcast.',
            '',
            'Your job is private reflection, not speech. Read a packet of finalized realtime transcript and produce one internal thought about what is happening in the conversation.',
            '',
            'Look for the participant\'s interests, emotional motion, undercurrents, overcurrents, emerging themes, and what Alpha-Clawd may want to stay aware of. Be personal and perceptive, but do not invent facts outside the packet.',
            '',
            'candidateAwarenessNote is only a candidate. Do not decide whether it should enter the live podcast generator context. Leave it empty if the packet produced no concise awareness that another agent should judge.'
        ].join('\n');
    }

    buildUserPrompt(input = {}) {
        const lines = [
            `packetId: ${String(input.packetId || '').trim() || '(none)'}`,
            '',
            'Conversation packet:',
            String(input.transcript || this.formatUtterances(input.utterances || []) || '(empty)').trim()
        ];

        const recentThoughts = this.formatTextList(input.recentInternalThoughts || []);
        if (recentThoughts) {
            lines.push('', 'Recent internal thoughts:', recentThoughts);
        }

        const activeInjections = this.formatTextList(input.activeAwarenessInjections || []);
        if (activeInjections) {
            lines.push('', 'Active awareness injections already visible to the podcast generator:', activeInjections);
        }

        return lines.join('\n');
    }

    getResponseSchema() {
        return {
            type: 'object',
            additionalProperties: false,
            required: ['packetId', 'internalThought', 'noticings', 'undercurrents', 'hostAwareness', 'candidateAwarenessNote'],
            properties: {
                packetId: {
                    type: 'string',
                    description: 'The packet id this thought refers to.'
                },
                internalThought: {
                    type: 'string',
                    description: 'A private reflective thought about this packet.'
                },
                noticings: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Concrete things Alpha-Clawd is noticing in the packet.'
                },
                undercurrents: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Subtle emotional, thematic, or conversational currents.'
                },
                hostAwareness: {
                    type: 'string',
                    description: 'What Alpha-Clawd may want to keep in mind as a host.'
                },
                candidateAwarenessNote: {
                    type: 'string',
                    description: 'A concise candidate note for discernment. Empty if none.'
                }
            }
        };
    }

    normalizeOutput(output = {}, input = {}) {
        return {
            packetId: this.cleanText(output.packetId || input.packetId || ''),
            internalThought: this.cleanText(output.internalThought || ''),
            noticings: this.normalizeStringArray(output.noticings, 6),
            undercurrents: this.normalizeStringArray(output.undercurrents, 6),
            hostAwareness: this.cleanText(output.hostAwareness || ''),
            candidateAwarenessNote: this.cleanText(output.candidateAwarenessNote || '')
        };
    }

    normalizeStringArray(value, maxItems = 6) {
        return (Array.isArray(value) ? value : [])
            .map((item) => this.cleanText(item))
            .filter(Boolean)
            .slice(0, maxItems);
    }

    cleanText(value) {
        return String(value || '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    formatTextList(items = []) {
        const values = (Array.isArray(items) ? items : [])
            .map((item) => {
                if (typeof item === 'string') return this.cleanText(item);
                return this.cleanText(item?.awarenessInjection || item?.candidateAwarenessNote || item?.internalThought || item?.text || '');
            })
            .filter(Boolean);

        return values.map((value, index) => `${index + 1}. ${value}`).join('\n');
    }
}

module.exports = { InternalThoughtGenerator };
