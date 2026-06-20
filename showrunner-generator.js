const { PodcastGenerator } = require('./podcast-generator');
const { resolveFrontierConfig } = require('./introspection-frontier');
const { normalizeEpisodePlan, sanitizeBasename, PHASES } = require('./episode-plan-store');

class ShowRunnerGenerator extends PodcastGenerator {
    constructor(options = {}) {
        const frontier = resolveFrontierConfig(options);
        super({
            ...options,
            apiKey: options.apiKey || process.env.PODCAST_SHOW_RUNNER_API_KEY || (frontier.enabled ? frontier.apiKey : undefined),
            baseUrl: options.baseUrl || process.env.PODCAST_SHOW_RUNNER_BASE_URL || (frontier.enabled ? frontier.baseUrl : undefined),
            model: options.model || process.env.PODCAST_SHOW_RUNNER_MODEL || (frontier.enabled ? frontier.model : undefined) || process.env.PODCAST_GENERATOR_MODEL || 'gpt-4.1-mini',
            timeout: options.timeout || process.env.PODCAST_SHOW_RUNNER_TIMEOUT_MS || process.env.PODCAST_GENERATOR_TIMEOUT_MS || 20000,
            maxCompletionTokens: options.maxCompletionTokens || process.env.PODCAST_SHOW_RUNNER_MAX_TOKENS || 2400,
            responseFormat: options.responseFormat || process.env.PODCAST_SHOW_RUNNER_RESPONSE_FORMAT || process.env.PODCAST_GENERATOR_RESPONSE_FORMAT || 'json_schema',
            reasoningFormat: options.reasoningFormat || process.env.PODCAST_SHOW_RUNNER_REASONING_FORMAT || process.env.PODCAST_GENERATOR_REASONING_FORMAT
        });
        this.schemaName = 'podcast_episode_plan_controller';
        this.frontierEnabled = frontier.enabled;
        if (frontier.enabled) {
            console.log(`[ShowRunnerGenerator] Frontier episode planner enabled: model=${this.model}, baseUrl=${this.baseUrl}`);
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

        const output = this.normalizeOutput(this.parseJsonContent(content), input);
        const duration = Date.now() - startTime;
        console.log(`[ShowRunnerGenerator] Completed in ${duration}ms: action=${output.action}, plan=${output.plan?.basename || 'none'}`);
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
            'You are Alpha-Clawd\'s preproduction showrunner for a live Discord podcast.',
            '',
            'You are in a text-channel planning session with the humans who may appear in the episode. Your job is to gather durable guest/topic background, decide when there is enough context to create an episode plan, revise that plan from feedback, and recognize clear approval.',
            '',
            'The episode plan is a static structure the live host will use during the recording. It supersedes prepared-question lists. It should create a finite set of planned angles, not an endless list of possible questions.',
            '',
            'When background is still thin, ask one useful follow-up in messageToChannel.',
            'When there is enough background, produce a plan and present it in messageToChannel.',
            'When feedback arrives after a plan exists, revise the plan directly and explain the revision briefly.',
            'When humans clearly approve the plan, set approved=true and include a concise closing message.',
            'When humans clearly ask to end, close, cancel, stop, or abort the planning session without approving a plan, set action=close_session, approved=false, plan=null, and include a concise closing message.',
            '',
            'Plan phases must be exactly: expanding, developing, converging, closing.',
            'Each phase has targetMinutes and angles only. Do not include phase purpose.',
            'Each angle needs a stable id, a short title, and a short description.',
            'Keep the plan shape limited to basename, version, targetDurationMinutes, guests, backgroundBrief, phases, phase targetMinutes, and phase angles.',
            'Choose a compact basename from the plan contents. Once an existing basename is provided, keep it unchanged.'
        ].join('\n');
    }

    buildUserPrompt(input = {}) {
        const planningMessages = this.formatPlanningMessages(input.planningMessages || input.messages || []);
        const previousPlan = input.previousPlan
            ? JSON.stringify(input.previousPlan, null, 2)
            : '(none)';
        const existingBasename = this.cleanText(input.basename || input.previousPlan?.basename || '');
        const latestFeedback = this.cleanText(input.latestFeedback || '');

        return [
            existingBasename ? `Existing basename: ${existingBasename}` : 'Existing basename: (none)',
            '',
            'Previous episode plan:',
            previousPlan,
            '',
            latestFeedback ? `Latest feedback: ${latestFeedback}` : null,
            '',
            'Planning session messages:',
            planningMessages || '(none yet)',
            '',
            'Decide the next planning action now. If you generate or revise a plan, make it usable as-is for the live episode structure tracker.'
        ].filter((line) => line !== null).join('\n');
    }

    buildSchemaPrompt() {
        return [
            'Return only valid JSON matching this exact schema. Do not include markdown, code fences, or commentary.',
            JSON.stringify(this.getResponseSchema(), null, 2)
        ].join('\n');
    }

    getResponseSchema() {
        const angleSchema = {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'title', 'description'],
            properties: {
                id: { type: 'string', description: 'Stable lowercase angle id, e.g. esp-training.' },
                title: { type: 'string', description: 'Short human-readable angle name.' },
                description: { type: 'string', description: 'One concise sentence naming what this angle should cover.' }
            }
        };
        const phaseSchema = {
            type: 'object',
            additionalProperties: false,
            required: ['targetMinutes', 'angles'],
            properties: {
                targetMinutes: { type: 'number', description: 'Approximate minutes for this phase.' },
                angles: {
                    type: 'array',
                    items: angleSchema,
                    description: 'Finite planned angles for this phase.'
                }
            }
        };
        return {
            type: 'object',
            additionalProperties: false,
            required: ['action', 'messageToChannel', 'approved', 'plan'],
            properties: {
                action: {
                    type: 'string',
                    enum: ['ask_followup', 'listen', 'generate_plan', 'revise_plan', 'approve_plan', 'close_session'],
                    description: 'The planning-session action Alpha-Clawd should take.'
                },
                messageToChannel: {
                    type: 'string',
                    description: 'Text Alpha-Clawd should post in the planning channel.'
                },
                approved: {
                    type: 'boolean',
                    description: 'True only when the humans clearly approve the latest plan.'
                },
                plan: {
                    anyOf: [
                        { type: 'null' },
                        {
                            type: 'object',
                            additionalProperties: false,
                            required: ['basename', 'version', 'targetDurationMinutes', 'guests', 'backgroundBrief', 'phases'],
                            properties: {
                                basename: { type: 'string' },
                                version: { type: 'string' },
                                targetDurationMinutes: { type: 'number' },
                                guests: {
                                    type: 'array',
                                    items: {
                                        type: 'object',
                                        additionalProperties: false,
                                        required: ['name', 'role'],
                                        properties: {
                                            name: { type: 'string' },
                                            role: { type: 'string' }
                                        }
                                    }
                                },
                                backgroundBrief: { type: 'string' },
                                phases: {
                                    type: 'object',
                                    additionalProperties: false,
                                    required: PHASES,
                                    properties: Object.fromEntries(PHASES.map((phase) => [phase, phaseSchema]))
                                }
                            }
                        }
                    ]
                }
            }
        };
    }

    normalizeOutput(output = {}, input = {}) {
        const rawAction = this.cleanText(output.action || '');
        const approved = output.approved === true;
        const action = approved
            ? 'approve_plan'
            : ['ask_followup', 'listen', 'generate_plan', 'revise_plan', 'close_session'].includes(rawAction)
                ? rawAction
                : (output.plan ? (input.previousPlan ? 'revise_plan' : 'generate_plan') : 'ask_followup');
        const messageToChannel = this.cleanMultiline(output.messageToChannel || fallbackPlanningMessage(action, approved));
        const base = input.basename || input.previousPlan?.basename || output.plan?.basename;
        const version = output.plan?.version || input.version || 'v001';
        const plan = output.plan
            ? normalizeEpisodePlan({
                ...output.plan,
                basename: base ? sanitizeBasename(base) : output.plan.basename,
                version
            })
            : null;
        return {
            action,
            messageToChannel,
            approved,
            plan
        };
    }

    formatPlanningMessages(messages = []) {
        return (Array.isArray(messages) ? messages : [])
            .map((message) => {
                const speaker = this.cleanText(message.speaker || message.author || 'Human');
                const timestamp = this.cleanText(message.timestamp || message.createdAt || '');
                const text = this.cleanMultiline(message.text || message.content || '');
                if (!text) return '';
                return `${timestamp ? `[${timestamp}] ` : ''}${speaker}: ${text}`;
            })
            .filter(Boolean)
            .join('\n');
    }

    cleanMultiline(value) {
        return String(value || '')
            .replace(/\r\n/g, '\n')
            .replace(/[ \t]+\n/g, '\n')
            .trim();
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
}

function fallbackPlanningMessage(action, approved) {
    if (approved) {
        return 'Great, I have the episode plan approved and ready for launch.';
    }
    if (action === 'listen') {
        return '';
    }
    if (action === 'close_session') {
        return 'Okay, I will close this planning session without approving an episode plan.';
    }
    return 'Give me a little more guest background, desired arc, or must-cover territory and I will shape the episode plan.';
}

module.exports = { ShowRunnerGenerator };
