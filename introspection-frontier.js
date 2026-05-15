const DEFAULT_FRONTIER_MODEL = 'claude-opus-4-7';
const DEFAULT_FRONTIER_BASE_URL = 'https://api.anthropic.com/v1';

function isTruthy(value) {
    return ['true', '1', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function firstNonEmpty(...values) {
    for (const value of values) {
        const text = String(value || '').trim();
        if (text) return text;
    }
    return null;
}

function normalizeBaseUrl(value) {
    return String(value || '').trim().replace(/\/+$/, '');
}

function resolveFrontierConfig(options = {}, env = process.env) {
    const flag = options.frontierEnabled ?? env.PODCAST_INTROSPECTION_FRONTIER_ENABLED;
    if (!isTruthy(flag)) {
        return { enabled: false };
    }

    return {
        enabled: true,
        model: firstNonEmpty(
            options.frontierModel,
            env.PODCAST_INTROSPECTION_FRONTIER_MODEL,
            DEFAULT_FRONTIER_MODEL
        ),
        apiKey: firstNonEmpty(
            options.frontierApiKey,
            env.PODCAST_INTROSPECTION_FRONTIER_API_KEY,
            env.ANTHROPIC_API_KEY
        ),
        baseUrl: normalizeBaseUrl(firstNonEmpty(
            options.frontierBaseUrl,
            env.PODCAST_INTROSPECTION_FRONTIER_BASE_URL,
            env.ANTHROPIC_BASE_URL,
            DEFAULT_FRONTIER_BASE_URL
        ))
    };
}

module.exports = {
    DEFAULT_FRONTIER_MODEL,
    DEFAULT_FRONTIER_BASE_URL,
    resolveFrontierConfig
};
