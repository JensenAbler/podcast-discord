const { PodcastGenerator } = require('./podcast-generator');
const { resolveFrontierConfig } = require('./introspection-frontier');

const DEFAULT_SHOW_RUNNER_QUESTIONS = [
    'What background does the listener need before this topic makes sense?',
    'What first drew the guest into this world?',
    'What changed as the guest gained experience?',
    'What does the guest know now that they did not know at the start?',
    'Where is the craft, procedure, or technique in this story?',
    'What tension or tradeoff keeps recurring?',
    'What collaboration, audience, or relationship angle matters here?',
    'What detail would make the scene concrete for listeners?',
    'What misconception should the episode quietly correct?',
    'What philosophical or miscellaneous lane could close the episode well?',
    'What has already been answered strongly enough that the host should not reopen it?',
    'What final synthesis would make the episode feel complete?'
];

class ShowRunnerGenerator extends PodcastGenerator {
    constructor(options = {}) {
        const frontier = resolveFrontierConfig(options);
        super({
            ...options,
            apiKey: options.apiKey || process.env.PODCAST_SHOW_RUNNER_API_KEY || (frontier.enabled ? frontier.apiKey : undefined),
            baseUrl: options.baseUrl || process.env.PODCAST_SHOW_RUNNER_BASE_URL || (frontier.enabled ? frontier.baseUrl : undefined),
            model: options.model || process.env.PODCAST_SHOW_RUNNER_MODEL || (frontier.enabled ? frontier.model : undefined) || process.env.PODCAST_GENERATOR_MODEL || 'gpt-4.1-mini',
            timeout: options.timeout || process.env.PODCAST_SHOW_RUNNER_TIMEOUT_MS || process.env.PODCAST_GENERATOR_TIMEOUT_MS || 20000,
            maxCompletionTokens: options.maxCompletionTokens || process.env.PODCAST_SHOW_RUNNER_MAX_TOKENS || 2000,
            responseFormat: options.responseFormat || process.env.PODCAST_SHOW_RUNNER_RESPONSE_FORMAT || process.env.PODCAST_GENERATOR_RESPONSE_FORMAT || 'json_schema',
            reasoningFormat: options.reasoningFormat || process.env.PODCAST_SHOW_RUNNER_REASONING_FORMAT || process.env.PODCAST_GENERATOR_REASONING_FORMAT
        });
        this.schemaName = 'podcast_showrunner_guidance';
        this.frontierEnabled = frontier.enabled;
        if (frontier.enabled) {
            console.log(`[ShowRunnerGenerator] Frontier show runner enabled: model=${this.model}, baseUrl=${this.baseUrl}`);
        }
    }

    async generate(input = {}) {
        if (!this.apiKey) {
            throw new Error(this.apiKeyError || 'Show runner generator API key not provided.');
        }

        const startTime = Date.now();
        const result = await this.fetchCompletion(this.buildMessages(input), input);
        const content = result.choices?.[0]?.message?.content;
        const refusal = result.choices?.[0]?.message?.refusal;

        if (refusal) {
            console.warn(`[ShowRunnerGenerator] Model refusal: ${refusal}`);
            return this.normalizeOutput({}, input);
        }

        if (!content) {
            throw new Error('Show runner generator returned an empty response');
        }

        const parsed = this.parseJsonContent(content);
        const output = this.normalizeOutput(parsed, input);
        const duration = Date.now() - startTime;
        console.log(`[ShowRunnerGenerator] Completed in ${duration}ms: phase=${output.phase || 'none'}, lane=${output.currentLane || 'none'}, wrap=${output.wrapNow}`);
        return output;
    }

    buildRequestBody(messages, options = {}) {
        const body = super.buildRequestBody(messages, options);
        if (body.response_format?.json_schema) {
            body.response_format.json_schema.name = this.schemaName;
            body.response_format.json_schema.schema = this.getResponseSchema();
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
            'You are Alpha-Clawd\'s show runner for a live Discord voice podcast.',
            '',
            'Your job is private editorial steering, not speech. You do not write the host line. You maintain the episode arc: topic coverage, prepared lanes, pacing, and wrap-up timing.',
            '',
            'The speaking host should still listen locally and honor the live floor. Your guidance must be compact enough to inject into the podcast generator without bloating its context.',
            '',
            'Think like a producer in the host\'s ear:',
            '- Track which major angles have already been addressed.',
            '- Keep a list of useful untouched angles and question lanes.',
            '- Notice when the guest has already answered enough and the host should synthesize or bridge instead of asking a generic follow-up.',
            '- Prefer structure over question-autocomplete. The host should not make the guest design every transition.',
            '- Do not over-protect the pacing by repeatedly backing up for provenance. Once the transcript contains enough setup for the listener, let the host follow the specific claim, object, facility, procedure, or experience the guest just introduced.',
            '- Good interview flow alternates grounding with decisive movement. A direct, plain question about the named thing in the latest answer is often better than another context-setting question.',
            '- When the host opening needs trust, let warmth and intention-setting count as structure; do not always rush to an origin question.',
            '- When all major angles are covered, the guest is closing, or the configured time limit is reached, explicitly direct the host to wrap up.',
            '',
            'Do not invent facts. If the brief or transcript does not support a topic angle, label it as a possible lane rather than established truth.'
        ].join('\n');
    }

    buildUserPrompt(input = {}) {
        const topic = this.cleanText(input.topic || 'general discussion');
        const topicBrief = this.cleanMultiline(input.topicBrief || '');
        const questionBank = this.cleanMultiline(input.questionBank || DEFAULT_SHOW_RUNNER_QUESTIONS.join('\n'));
        const transcript = this.cleanMultiline(input.transcript || '(empty)');
        const previousGuidance = input.previousGuidance
            ? JSON.stringify(input.previousGuidance, null, 2)
            : '(none)';
        const elapsedMinutes = Number(input.elapsedMinutes);
        const maxDurationMinutes = Number(input.maxDurationMinutes);

        const lines = [
            `Episode topic: ${topic}`,
            Number.isFinite(elapsedMinutes) ? `Elapsed minutes: ${Math.max(0, Math.round(elapsedMinutes))}` : null,
            Number.isFinite(maxDurationMinutes) && maxDurationMinutes > 0 ? `Configured time limit minutes: ${Math.round(maxDurationMinutes)}` : null,
            '',
            'Topic brief / durable context:',
            topicBrief || '(none)',
            '',
            'Potential question bank and lanes:',
            questionBank || DEFAULT_SHOW_RUNNER_QUESTIONS.join('\n'),
            '',
            'Use the question bank as a menu, not a script. The transcript is the authority. If the latest guest answer opens a concrete door, move through that door before stepping back to a generic lane.',

            'Previous show runner guidance:',
            previousGuidance,
            '',
            'Transcript so far, most recent tail:',
            transcript,
            '',
            'Update the editorial state now. If the time limit has been reached or the covered angles are sufficient for a coherent episode, set wrapNow true and make generatorInstruction a clear wrap-up directive. Otherwise make generatorInstruction name the next concrete host move in one compact sentence. If the latest beat is complete and the host should speak, say so plainly; if the host should stay silent, explain the active floor cue.'
        ].filter((line) => line !== null);

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
            required: [
                'phase',
                'currentLane',
                'coveredAngles',
                'untouchedAngles',
                'nextHostMove',
                'avoid',
                'suggestedQuestion',
                'wrapNow',
                'wrapReason',
                'generatorInstruction'
            ],
            properties: {
                phase: {
                    type: 'string',
                    description: 'Current episode phase, such as opening, background, deep-dive, contrast, synthesis, or wrap-up.'
                },
                currentLane: {
                    type: 'string',
                    description: 'The current structural lane the host should treat as active.'
                },
                coveredAngles: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Major topic angles that have already been substantially addressed.'
                },
                untouchedAngles: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Useful major angles that remain available.'
                },
                nextHostMove: {
                    type: 'string',
                    description: 'The next editorial move, such as synthesize, bridge, ask one narrow question, hold space, or wrap.'
                },
                avoid: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Specific moves the host should avoid in the next few turns.'
                },
                suggestedQuestion: {
                    type: 'string',
                    description: 'One optional narrow question. Empty string when a question is not the right next move.'
                },
                wrapNow: {
                    type: 'boolean',
                    description: 'True when the host should close the episode instead of opening a new lane.'
                },
                wrapReason: {
                    type: 'string',
                    description: 'Why wrap-up is or is not appropriate.'
                },
                generatorInstruction: {
                    type: 'string',
                    description: 'Compact private instruction to inject into the podcast generator for the next few turns.'
                }
            }
        };
    }

    normalizeOutput(output = {}, input = {}) {
        const wrapNow = output.wrapNow === true;
        const generatorInstruction = this.cleanText(output.generatorInstruction || '');
        const nextHostMove = this.cleanText(output.nextHostMove || '');
        const suggestedQuestion = this.cleanText(output.suggestedQuestion || '');
        const fallbackInstruction = wrapNow
            ? 'Wrap the episode now. Briefly synthesize what has been covered, thank the guest, and do not open a new topic.'
            : (nextHostMove || suggestedQuestion || 'Keep the episode moving with synthesis or a narrow bridge.');

        return {
            phase: this.cleanText(output.phase || 'unknown'),
            currentLane: this.cleanText(output.currentLane || ''),
            coveredAngles: this.normalizeStringArray(output.coveredAngles, 12),
            untouchedAngles: this.normalizeStringArray(output.untouchedAngles, 12),
            nextHostMove,
            avoid: this.normalizeStringArray(output.avoid, 8),
            suggestedQuestion,
            wrapNow,
            wrapReason: this.cleanText(output.wrapReason || ''),
            generatorInstruction: generatorInstruction || fallbackInstruction,
            generatedAt: input.generatedAt || new Date().toISOString()
        };
    }

    parseJsonContent(content) {
        const text = String(content || '').trim();
        try {
            return JSON.parse(text);
        } catch {}

        const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (fenced) {
            try {
                return JSON.parse(fenced[1].trim());
            } catch {}
        }

        const first = text.indexOf('{');
        const last = text.lastIndexOf('}');
        if (first !== -1 && last > first) {
            try {
                return JSON.parse(text.slice(first, last + 1));
            } catch (error) {
                throw new Error(`Show runner generator returned invalid JSON: ${error.message}`);
            }
        }

        throw new Error('Show runner generator returned invalid JSON');
    }

    normalizeStringArray(value, maxItems = 8) {
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

    cleanMultiline(value) {
        return String(value || '')
            .replace(/\r\n/g, '\n')
            .replace(/\r/g, '\n')
            .trim();
    }
}

module.exports = {
    DEFAULT_SHOW_RUNNER_QUESTIONS,
    ShowRunnerGenerator
};
