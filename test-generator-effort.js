const test = require('node:test');
const assert = require('node:assert/strict');
const { PodcastGenerator } = require('./podcast-generator');
const { buildAnthropicMessagesBody } = require('./anthropic-messages');

const request = {
    model: 'test-model',
    max_completion_tokens: 1500,
    messages: [{ role: 'user', content: 'hello' }],
    response_format: { type: 'json_schema', json_schema: { schema: { type: 'object' } } }
};

test('effort is sent only when configured, alongside the structured-output format', () => {
    assert.equal('effort' in buildAnthropicMessagesBody(request).output_config, false);
    assert.equal('effort' in buildAnthropicMessagesBody(request, { effort: 'turbo' }).output_config, false);
    const withEffort = buildAnthropicMessagesBody(request, { effort: ' Low ' });
    assert.equal(withEffort.output_config.effort, 'low');
    assert.deepEqual(withEffort.output_config.format, { type: 'json_schema', schema: { type: 'object' } });
    assert.deepEqual(buildAnthropicMessagesBody({ ...request, response_format: undefined }, { effort: 'medium' }).output_config, { effort: 'medium' });
});

test('the configured effort reaches streaming and non-streaming Anthropic requests', async () => {
    const host = new PodcastGenerator({ apiKey: 'k', baseUrl: 'https://api.anthropic.com/v1', model: 'm', effort: 'low' });
    const streaming = host.buildStreamingRequest(host.buildRequestBody([{ role: 'user', content: 'hello' }]));
    assert.equal(streaming.body.output_config.effort, 'low');

    let sent;
    const realFetch = global.fetch;
    global.fetch = async (_url, init) => {
        sent = JSON.parse(init.body);
        return new Response(JSON.stringify({ content: [{ type: 'text', text: '{}' }], stop_reason: 'end_turn', usage: {} }), { status: 200 });
    };
    try {
        await host.fetchJson('/chat/completions', host.buildRequestBody([{ role: 'user', content: 'hello' }]));
    } finally {
        global.fetch = realFetch;
    }
    assert.equal(sent.output_config.effort, 'low');

    const unset = new PodcastGenerator({ apiKey: 'k', baseUrl: 'https://api.anthropic.com/v1', model: 'm' });
    const plain = unset.buildStreamingRequest(unset.buildRequestBody([{ role: 'user', content: 'hello' }]));
    assert.equal('effort' in plain.body.output_config, false);
});
