const DEFAULT_ANTHROPIC_VERSION = '2023-06-01';

function isAnthropicBaseUrl(baseUrl = '') {
    try {
        const url = new URL(String(baseUrl));
        const host = url.hostname.toLowerCase();
        const pathname = url.pathname.replace(/\/+$/, '');
        return host === 'api.anthropic.com' ||
            host.endsWith('.anthropic.com') ||
            (host === 'api.kimi.com' && pathname === '/coding/v1');
    } catch {
        return false;
    }
}

function getAnthropicCompatibleProvider(baseUrl = '') {
    try {
        const host = new URL(String(baseUrl)).hostname.toLowerCase();
        if (host === 'api.kimi.com') {
            return 'kimi';
        }
    } catch {}
    return 'anthropic';
}

function normalizeBaseUrl(baseUrl = '') {
    return String(baseUrl || '').trim().replace(/\/+$/, '');
}

function mergeAdjacentMessages(messages = []) {
    const merged = [];
    for (const message of messages) {
        if (!message?.content) continue;
        const role = message.role === 'assistant' ? 'assistant' : 'user';
        const content = String(message.content || '').trim();
        if (!content) continue;

        const previous = merged[merged.length - 1];
        if (previous?.role === role) {
            previous.content = `${previous.content}\n\n${content}`;
        } else {
            merged.push({ role, content });
        }
    }
    return merged;
}

function buildAnthropicMessagesBody(body = {}) {
    const systemParts = [];
    const conversationMessages = [];

    for (const message of body.messages || []) {
        if (message?.role === 'system') {
            const content = String(message.content || '').trim();
            if (content) {
                systemParts.push(content);
            }
        } else {
            conversationMessages.push(message);
        }
    }

    const messages = mergeAdjacentMessages(conversationMessages);
    if (messages.length === 0) {
        messages.push({
            role: 'user',
            content: 'Respond to the system instructions.'
        });
    }

    const anthropicBody = {
        model: body.model,
        max_tokens: Number(body.max_tokens || body.max_completion_tokens || 1024),
        messages
    };

    if (systemParts.length > 0) {
        anthropicBody.system = systemParts.join('\n\n');
    }

    if (body.temperature !== undefined && Number.isFinite(Number(body.temperature))) {
        anthropicBody.temperature = Number(body.temperature);
    }

    const schema = body.response_format?.json_schema?.schema;
    if (body.response_format?.type === 'json_schema' && schema) {
        anthropicBody.output_config = {
            format: {
                type: 'json_schema',
                schema
            }
        };
    }

    return anthropicBody;
}

function extractTextContent(content = []) {
    if (!Array.isArray(content)) {
        return '';
    }
    return content
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('');
}

function extractResponseHeaders(headers) {
    if (!headers || typeof headers.get !== 'function') {
        return {};
    }

    const names = [
        'retry-after',
        'anthropic-ratelimit-requests-limit',
        'anthropic-ratelimit-requests-remaining',
        'anthropic-ratelimit-requests-reset',
        'anthropic-ratelimit-tokens-limit',
        'anthropic-ratelimit-tokens-remaining',
        'anthropic-ratelimit-tokens-reset'
    ];

    return names.reduce((acc, name) => {
        const value = headers.get(name);
        if (value !== null && value !== undefined) {
            acc[name] = value;
        }
        return acc;
    }, {});
}

function normalizeAnthropicResponse(json = {}, headers = {}, baseUrl = '') {
    const content = extractTextContent(json.content);
    const usage = json.usage || {};
    return {
        id: json.id,
        model: json.model,
        provider: getAnthropicCompatibleProvider(baseUrl),
        choices: [{
            message: {
                role: 'assistant',
                content
            },
            finish_reason: json.stop_reason || null
        }],
        usage: {
            prompt_tokens: Number(usage.input_tokens || 0),
            completion_tokens: Number(usage.output_tokens || 0),
            input_token_details: {
                cache_read: Number(usage.cache_read_input_tokens || 0),
                cache_creation: Number(usage.cache_creation_input_tokens || 0)
            }
        },
        _anthropic: json,
        _responseHeaders: headers
    };
}

async function fetchAnthropicMessages({
    baseUrl,
    apiKey,
    body,
    timeout,
    version = process.env.ANTHROPIC_VERSION || process.env.PODCAST_ANTHROPIC_VERSION || DEFAULT_ANTHROPIC_VERSION
}) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
        const response = await fetch(`${normalizeBaseUrl(baseUrl)}/messages`, {
            method: 'POST',
            headers: {
                'x-api-key': apiKey,
                'anthropic-version': version,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(buildAnthropicMessagesBody(body)),
            signal: controller.signal
        });

        const headers = extractResponseHeaders(response.headers);
        if (!response.ok) {
            const errorText = await response.text();
            const error = new Error(`Anthropic API error: ${response.status} - ${errorText}`);
            error.status = response.status;
            error.headers = headers;
            error.bodyText = errorText;
            try {
                error.body = JSON.parse(errorText);
            } catch {
                error.body = null;
            }
            throw error;
        }

        const json = await response.json();
        return normalizeAnthropicResponse(json, headers, baseUrl);
    } finally {
        clearTimeout(timeoutId);
    }
}

module.exports = {
    DEFAULT_ANTHROPIC_VERSION,
    buildAnthropicMessagesBody,
    fetchAnthropicMessages,
    getAnthropicCompatibleProvider,
    isAnthropicBaseUrl,
    normalizeBaseUrl,
    normalizeAnthropicResponse
};
