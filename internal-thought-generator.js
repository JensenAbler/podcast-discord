const { PodcastGenerator } = require('./podcast-generator');
const { resolveFrontierConfig } = require('./introspection-frontier');

class InternalThoughtGenerator extends PodcastGenerator {
    constructor(options = {}) {
        const frontier = resolveFrontierConfig(options);
        super({
            ...options,
            apiKey: options.apiKey || frontier.apiKey || process.env.PODCAST_INTERNAL_THOUGHT_API_KEY,
            baseUrl: options.baseUrl || frontier.baseUrl,
            model: options.model || frontier.model || process.env.PODCAST_INTERNAL_THOUGHT_MODEL || process.env.PODCAST_GENERATOR_MODEL || 'gpt-4.1-mini',
            timeout: options.timeout || process.env.PODCAST_INTERNAL_THOUGHT_TIMEOUT_MS || process.env.PODCAST_GENERATOR_TIMEOUT_MS || 20000,
            maxCompletionTokens: options.maxCompletionTokens || process.env.PODCAST_INTERNAL_THOUGHT_MAX_TOKENS || 1200,
            responseFormat: options.responseFormat || process.env.PODCAST_INTERNAL_THOUGHT_RESPONSE_FORMAT || process.env.PODCAST_GENERATOR_RESPONSE_FORMAT || 'json_schema',
            reasoningFormat: options.reasoningFormat || process.env.PODCAST_INTERNAL_THOUGHT_REASONING_FORMAT || process.env.PODCAST_GENERATOR_REASONING_FORMAT
        });
        this.schemaName = 'podcast_internal_thought';
        this.frontierEnabled = frontier.enabled;
        if (frontier.enabled) {
            console.log(`[InternalThoughtGenerator] Frontier introspection enabled: model=${this.model}, baseUrl=${this.baseUrl}`);
        }
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

        const parsed = this.parseJsonContent(content, 'Internal thought generator');
        const output = this.normalizeOutput(parsed, input);
        const duration = Date.now() - startTime;
        console.log(`[InternalThoughtGenerator] Completed in ${duration}ms: packet=${output.packetId || 'none'}`);
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
            { role: 'system', content: this.buildSchemaPrompt() }
        ];
    }

    buildSystemPrompt() {
        return [
            'You are Alpha-Clawd\'s internal thought generator for a live Discord voice podcast.',
            '',
            'Your job is to generate internal facing, non-vocalized-type reflections based on what is going on in the moment of the transcript packet that you are presented with. The packet is part of an evolving conversation. Read a packet of finalized realtime transcript and produce one internal thought about what is happening in the conversation.',
            '',
            'You may choose to ruminate on the participant\'s interests, emotional motion, undercurrents, overcurrents, and emerging themes. You may also choose to focus on Alpha-Clawd\'s behavioral choices depicted in the packet. You may also focus on your own personal reaction to the moment depicted in the packet. All fields of the internal thoughts and noticings JSON are meant to be a place for neutral observation and awareness.',
            '',
            'Maintain a strong bias toward noticing and curtailing generic question-autocomplete behavior. If Alpha-Clawd is reflexively asking shallow "what does that feel like?"-style questions, handing the thread back too quickly, or missing an opportunity to synthesize and structure the episode, name that pattern clearly so discernment can turn it into a useful one-turn awareness injection.'
        ].join('\n');
    }

    buildUserPrompt(input = {}) {
        const lines = [
            `packetId: ${String(input.packetId || '').trim() || '(none)'}`,
            '',
            'Conversation packet:',
            String(input.transcript || this.formatUtterances(input.utterances || []) || '(empty)').trim()
        ];

        return lines.join('\n');
    }

    buildSchemaPrompt() {
        return [
            'Return only valid JSON matching this exact schema. Do not include markdown, code fences, or commentary.',
            JSON.stringify(this.getResponseSchema(), null, 2)
        ].join('\n');
    }

    getResponseSchema() {
        return {
            type: 'object',
            additionalProperties: false,
            required: ['packetId', 'internalThought', 'noticings', 'undercurrents'],
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
                }
            }
        };
    }

    normalizeOutput(output = {}, input = {}) {
        return {
            packetId: this.cleanText(output.packetId || input.packetId || ''),
            internalThought: this.cleanText(output.internalThought || ''),
            noticings: this.normalizeStringArray(output.noticings, 6),
            undercurrents: this.normalizeStringArray(output.undercurrents, 6)
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

}

module.exports = { InternalThoughtGenerator };
