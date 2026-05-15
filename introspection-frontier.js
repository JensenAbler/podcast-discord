function isTruthy(value) {
    return String(value || '').trim().toLowerCase() === 'true';
}

function resolveFrontierConfig(options = {}, env = process.env) {
    const flag = options.frontierEnabled ?? env.PODCAST_INTROSPECTION_FRONTIER_ENABLED;
    if (!isTruthy(flag)) {
        return { enabled: false };
    }
    return {
        enabled: true,
        model: options.frontierModel || env.PODCAST_INTROSPECTION_FRONTIER_MODEL || null,
        apiKey: options.frontierApiKey || env.PODCAST_INTROSPECTION_FRONTIER_API_KEY || null,
        baseUrl: options.frontierBaseUrl || env.PODCAST_INTROSPECTION_FRONTIER_BASE_URL || null
    };
}

module.exports = { resolveFrontierConfig };
