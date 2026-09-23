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

function shouldUseAnthropicPromptCache(baseUrl = '') {
    return isAnthropicBaseUrl(baseUrl) && getAnthropicCompatibleProvider(baseUrl) === 'anthropic';
}

// Callers can attach [CACHE_SEGMENTS] to a message: an array of { text, cache }
// whose texts concatenate to exactly message.content. Segments marked cache get
// an Anthropic cache breakpoint. Symbol keys never reach JSON.stringify, so
// OpenAI-compatible routes keep sending the plain string unchanged.
const CACHE_SEGMENTS = Symbol.for('podcast-discord.anthropicCacheSegments');
const MAX_CACHE_BREAKPOINTS = 4;

function sliceSegments(segments, start, end) {
    const sliced = [];
    let position = 0;
    for (const segment of segments) {
        const segmentStart = position;
        const segmentEnd = position + segment.text.length;
        position = segmentEnd;
        const from = Math.max(segmentStart, start);
        const to = Math.min(segmentEnd, end);
        if (to > from) {
            sliced.push({
                text: segment.text.slice(from - segmentStart, to - segmentStart),
                cache: segment.cache
            });
        }
    }
    return sliced;
}

function readMessageSegments(message = {}) {
    const content = String(message.content || '');
    const raw = Array.isArray(message[CACHE_SEGMENTS]) ? message[CACHE_SEGMENTS] : null;
    const segments = raw && raw.map((segment) => String(segment?.text || '')).join('') === content
        ? raw.map((segment) => ({ text: String(segment?.text || ''), cache: Boolean(segment?.cache) }))
        : [{ text: content, cache: false }];

    // Same edges as trim() on the whole message.
    const start = content.length - content.trimStart().length;
    const end = content.trimEnd().length;
    if (end <= start) {
        return [];
    }

    // Anthropic rejects whitespace-only text blocks, so fold them backward.
    const folded = [];
    for (const segment of sliceSegments(segments, start, end)) {
        const previous = folded[folded.length - 1];
        if (previous && !segment.text.trim()) {
            previous.text += segment.text;
            previous.cache = previous.cache || segment.cache;
        } else {
            folded.push(segment);
        }
    }
    return folded;
}

function mergeAdjacentMessages(messages = []) {
    const merged = [];
    for (const message of messages) {
        if (!message?.content) continue;
        const role = message.role === 'assistant' ? 'assistant' : 'user';
        const segments = readMessageSegments(message);
        if (segments.length === 0) continue;

        const previous = merged[merged.length - 1];
        if (previous?.role === role) {
            segments[0] = { ...segments[0], text: `\n\n${segments[0].text}` };
            previous.segments.push(...segments);
        } else {
            merged.push({ role, segments });
        }
    }
    return merged;
}

function renderAnthropicMessages(merged = [], options = {}) {
    const flagged = [];
    merged.forEach((message, messageIndex) => {
        message.segments.forEach((segment, segmentIndex) => {
            if (segment.cache) flagged.push(`${messageIndex}:${segmentIndex}`);
        });
    });
    const allowed = options.cacheControl ? Math.max(0, Number(options.maxBreakpoints) || 0) : 0;
    // Later breakpoints cover longer prefixes, so keep the last ones.
    const kept = new Set(allowed > 0 ? flagged.slice(-allowed) : []);

    return merged.map((message, messageIndex) => {
        const keys = message.segments.map((_, segmentIndex) => `${messageIndex}:${segmentIndex}`);
        if (!keys.some((key) => kept.has(key))) {
            return { role: message.role, content: message.segments.map((segment) => segment.text).join('') };
        }
        return {
            role: message.role,
            content: message.segments.map((segment, segmentIndex) => {
                const block = { type: 'text', text: segment.text };
                if (kept.has(keys[segmentIndex])) {
                    block.cache_control = { type: 'ephemeral' };
                }
                return block;
            })
        };
    });
}

function buildAnthropicSystem(systemParts = [], options = {}) {
    const parts = systemParts
        .map((part) => String(part || '').trim())
        .filter(Boolean);
    if (parts.length === 0) {
        return null;
    }

    if (!options.cacheControl) {
        return parts.join('\n\n');
    }

    return parts.map((text, index) => {
        const block = { type: 'text', text };
        if (index === parts.length - 1) {
            block.cache_control = { type: 'ephemeral' };
        }
        return block;
    });
}

function buildAnthropicMessagesBody(body = {}, options = {}) {
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

    const systemBreakpoints = options.cacheControl && systemParts.length > 0 ? 1 : 0;
    const messages = renderAnthropicMessages(mergeAdjacentMessages(conversationMessages), {
        cacheControl: Boolean(options.cacheControl),
        maxBreakpoints: MAX_CACHE_BREAKPOINTS - systemBreakpoints
    });
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
        anthropicBody.system = buildAnthropicSystem(systemParts, options);
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
            body: JSON.stringify(buildAnthropicMessagesBody(body, {
                cacheControl: shouldUseAnthropicPromptCache(baseUrl)
            })),
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
    CACHE_SEGMENTS,
    DEFAULT_ANTHROPIC_VERSION,
    buildAnthropicMessagesBody,
    buildAnthropicSystem,
    fetchAnthropicMessages,
    getAnthropicCompatibleProvider,
    isAnthropicBaseUrl,
    normalizeBaseUrl,
    normalizeAnthropicResponse,
    shouldUseAnthropicPromptCache
};
