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
            { role: 'system', content: 'Return only JSON matching the schema.' }
        ];
    }

    buildSystemPrompt() {
        return [
            'You are Alpha-Clawd\'s internal thought generator for a live Discord voice podcast.',
            '',
            'Your job is private reflection, not speech. Read a packet of finalized realtime transcript and produce one internal thought about what is happening in the conversation.',
            '',
            'The live input is intentionally packet-only. Do not ingest or infer from previous internalThought text, candidateAwarenessNote text, discernment output, or active awarenessInjection text unless a human explicitly read that artifact into the conversation packet.',
            '',
            'Look for the participant\'s interests, emotional motion, undercurrents, overcurrents, and emerging themes. Be personal and perceptive, but do not invent facts outside the packet.',
            '',
            'Maintain a strong bias toward noticing generic question-autocomplete behavior. If the host is drifting into shallow reflex questions, repeated prompts for guests to elaborate, "what does that feel like" style questions, or throwing the conversational burden back after the guest already answered, name that pattern plainly in noticings or undercurrents.',
            '',
            'When generic question-autocomplete appears likely, attend to what the host should understand instead: whether the guest needs synthesis, a carried thread, a bridge to the next prepared topic, a moment of silence, or a concrete host contribution. Do not write instructions to the host; make the private thought sharp enough that discernment can decide whether to create an awareness injection.',
            '',
            'If the packet contains Jensen reading aloud JSON, file contents, or prior internal-thought artifacts, treat that as artifact content being discussed, not as fresh observation about the present moment. Label noticings accordingly.',
            '',
            'Do not produce awareness notes, podcast-generator context, advice to the speaking host, or decisions about what should be injected elsewhere. That whole process belongs to the discernment generator.'
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
