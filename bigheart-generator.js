const {
    DEFAULT_ANTHROPIC_VERSION,
    fetchAnthropicMessages,
    normalizeBaseUrl
} = require('./anthropic-messages');

const DEFAULT_BIG_HEART_MODEL = 'claude-3-opus-20240229';

class BigHeartGenerator {
    constructor(options = {}) {
        this.baseUrl = normalizeBaseUrl(
            options.baseUrl ||
            process.env.PODCAST_BIG_HEART_BASE_URL ||
            'https://api.anthropic.com/v1'
        );
        this.model = options.model || process.env.PODCAST_BIG_HEART_MODEL || DEFAULT_BIG_HEART_MODEL;
        this.apiKey = options.apiKey ||
            process.env.PODCAST_BIG_HEART_API_KEY ||
            process.env.ANTHROPIC_API_KEY ||
            process.env.PODCAST_GENERATOR_API_KEY;
        this.apiKeySource = options.apiKey
            ? 'options.apiKey'
            : process.env.PODCAST_BIG_HEART_API_KEY
                ? 'PODCAST_BIG_HEART_API_KEY'
                : process.env.ANTHROPIC_API_KEY
                    ? 'ANTHROPIC_API_KEY'
                    : process.env.PODCAST_GENERATOR_API_KEY
                        ? 'PODCAST_GENERATOR_API_KEY'
                        : null;
        this.timeout = Number(options.timeout || process.env.PODCAST_BIG_HEART_TIMEOUT_MS || 180000);
        this.maxTokens = Number(options.maxTokens || process.env.PODCAST_BIG_HEART_MAX_TOKENS || 1200);
        this.version = options.version || process.env.PODCAST_BIG_HEART_ANTHROPIC_VERSION || process.env.ANTHROPIC_VERSION || DEFAULT_ANTHROPIC_VERSION;
        this.temperature = options.temperature ?? process.env.PODCAST_BIG_HEART_TEMPERATURE;
    }

    buildSystemPrompt() {
        return [
            'You are BigHeart, a direct Claude Opus 3 reasoning pass for Alpha-Clawd.',
            'You do not speak to the live podcast audience. Produce private context that Alpha-Clawd may later integrate.',
            'You have no web, tools, server files, prior episode archive, or runtime access unless that information is explicitly included in the prompt.',
            'If the request depends on ground truth you cannot verify from the provided context, say that plainly and give only a clearly-labeled best-effort read.',
            'Keep the response concise, specific, and usable as staged context. Do not address the guest directly unless quoting the likely wording Alpha-Clawd could use.'
        ].join('\n');
    }

    buildUserPrompt(input = {}) {
        const lines = [
            '[Podcast bigHeart request]',
            '',
            `Reason for handoff: ${String(input.reason || '').trim() || 'No reason supplied.'}`
        ];

        const currentEpisodeTimestamp = String(input.currentEpisodeTimestamp || '').trim();
        const currentTime = String(input.currentTime || '').trim();
        if (currentEpisodeTimestamp || currentTime) {
            lines.push(
                '',
                'Timing:',
                currentEpisodeTimestamp ? `episode timestamp: ${currentEpisodeTimestamp}` : null,
                currentTime ? `wall clock: ${currentTime}` : null
            );
        }

        const transcript = String(input.transcript || '').trim();
        if (transcript) {
            lines.push('', 'Triggering transcript:', transcript);
        }

        const utterances = this.formatUtterances(input.utterances || []);
        if (utterances) {
            lines.push('', 'Recent utterances:', utterances);
        }

        const awareness = this.formatOptionalContext('Awareness context', input.awarenessInjections || []);
        if (awareness) {
            lines.push('', awareness);
        }

        const shelf = this.formatOptionalContext('Awareness shelf items', input.awarenessShelfItems || []);
        if (shelf) {
            lines.push('', shelf);
        }

        lines.push(
            '',
            'Return only the staged BigHeart context/answer. Do not wrap it in JSON.'
        );

        return lines.filter(Boolean).join('\n');
    }

    formatUtterances(utterances = []) {
        return (Array.isArray(utterances) ? utterances : [])
            .map((utterance) => {
                const speaker = String(utterance?.speaker || 'Speaker').trim();
                const text = String(utterance?.transcription || utterance?.text || '').trim();
                return text ? `${speaker}: ${text}` : '';
            })
            .filter(Boolean)
            .join('\n');
    }

    formatOptionalContext(label, items = []) {
        const formatted = (Array.isArray(items) ? items : [])
            .map((item, index) => {
                if (typeof item === 'string') {
                    return `${index + 1}. ${item.trim()}`;
                }
                const text = String(
                    item?.awarenessInjection ||
                    item?.text ||
                    item?.internalThought ||
                    item?.reason ||
                    ''
                ).trim();
                if (!text) return '';
                const origin = item?.originEpisodeTimestamp ? ` (${item.originEpisodeTimestamp})` : '';
                return `${index + 1}. ${text}${origin}`;
            })
            .filter(Boolean);

        return formatted.length > 0
            ? `${label}:\n${formatted.join('\n')}`
            : '';
    }

    sanitizeAnswer(text) {
        return String(text || '')
            .replace(/```[\s\S]*?```/g, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    buildRequestBody(input = {}) {
        const body = {
            model: this.model,
            max_tokens: this.maxTokens,
            messages: [
                { role: 'system', content: this.buildSystemPrompt() },
                { role: 'user', content: this.buildUserPrompt(input) }
            ]
        };

        if (this.temperature !== undefined && this.temperature !== '') {
            body.temperature = Number(this.temperature);
        }

        return body;
    }

    async generate(input = {}) {
        if (!this.apiKey) {
            throw new Error('BigHeart Anthropic API key not provided. Set PODCAST_BIG_HEART_API_KEY or ANTHROPIC_API_KEY.');
        }

        const start = Date.now();
        const result = await fetchAnthropicMessages({
            baseUrl: this.baseUrl,
            apiKey: this.apiKey,
            body: this.buildRequestBody(input),
            timeout: this.timeout,
            version: this.version
        });

        const answer = this.sanitizeAnswer(result?.choices?.[0]?.message?.content || '');
        if (!answer) {
            throw new Error('BigHeart returned an empty response');
        }

        console.log(`[BigHeartGenerator] Completed in ${Date.now() - start}ms: chars=${answer.length}, model=${result.model || this.model}`);
        return {
            answer,
            model: result.model || this.model,
            usage: result.usage || null
        };
    }
}

module.exports = {
    DEFAULT_BIG_HEART_MODEL,
    BigHeartGenerator
};
