const test = require('node:test');
const assert = require('node:assert/strict');
const { PodcastGenerator } = require('./podcast-generator');
const {
    buildAnthropicMessagesBody,
    normalizeAnthropicResponse
} = require('./anthropic-messages');

const REPLY = JSON.stringify({
    speech: 'Lentils, then.',
    shouldRespond: true,
    chosenAngle: '',
    bigBrain: { requested: false, reason: '', consumedRunId: '' },
    bigHeart: { requested: false, reason: '', consumedRunId: '' },
    podcastLeave: { requested: false, reason: '' }
});

function completion(content, finishReason = 'end_turn', message = {}) {
    return { choices: [{ message: { role: 'assistant', content, ...message }, finish_reason: finishReason }] };
}

function generator(options = {}) {
    const instance = new PodcastGenerator({
        apiKey: 'test-key',
        baseUrl: 'https://api.anthropic.com/v1',
        model: 'test-model',
        maxCompletionTokens: 1500,
        ...options
    });
    instance.logUsage = () => {};
    return instance;
}

function timeoutError() {
    const error = new Error('This operation was aborted');
    error.name = 'AbortError';
    return error;
}

function httpError(status) {
    const error = new Error(`Anthropic API error: ${status}`);
    error.status = status;
    return error;
}

const input = { transcript: 'Sonoma: We used green lentils.', remember: false };

test('a timed-out host turn is retried once and then answers normally', async () => {
    const host = generator();
    let calls = 0;
    host.fetchJson = async () => {
        calls += 1;
        if (calls === 1) throw timeoutError();
        return completion(REPLY);
    };
    const output = await host.generate(input);
    assert.equal(calls, 2);
    assert.equal(output.shouldRespond, true);
    assert.equal(output.speech, 'Lentils, then.');
});

test('a second consecutive failure still reaches the caller', async () => {
    const host = generator();
    let calls = 0;
    host.fetchJson = async () => { calls += 1; throw timeoutError(); };
    await assert.rejects(host.generate(input), { name: 'AbortError' });
    assert.equal(calls, 2);
});

test('provider overload and dropped connections are retried; request errors are not', async () => {
    for (const [error, expectedCalls] of [
        [httpError(529), 2],
        [httpError(503), 2],
        [Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }), 2],
        [httpError(400), 1],
        [httpError(401), 1],
        [httpError(413), 1]
    ]) {
        const host = generator();
        let calls = 0;
        host.fetchJson = async () => {
            calls += 1;
            if (calls === 1) throw error;
            return completion(REPLY);
        };
        if (expectedCalls === 2) {
            assert.equal((await host.generate(input)).speech, 'Lentils, then.');
        } else {
            await assert.rejects(host.generate(input));
        }
        assert.equal(calls, expectedCalls, `status/code ${error.status || error.cause?.code}`);
    }
});

test('rate limits are left to the existing key routing rather than retried here', async () => {
    const host = generator();
    assert.equal(host.isTransientGeneratorError(httpError(429)), false);
});

test('output cut off by the token cap is retried with more room', async () => {
    const host = generator();
    const budgets = [];
    host.fetchJson = async (_path, body) => {
        budgets.push(body.max_completion_tokens);
        return budgets.length === 1
            ? completion('', 'max_tokens')
            : completion(REPLY);
    };
    const output = await host.generate(input);
    assert.deepEqual(budgets, [1500, 6000]);
    assert.equal(output.speech, 'Lentils, then.');
});

test('a truncated JSON reply is retried, a complete reply at the cap is kept', async () => {
    const truncated = generator();
    let calls = 0;
    truncated.fetchJson = async () => {
        calls += 1;
        return calls === 1 ? completion('{"speech":"Lentils, th', 'length') : completion(REPLY);
    };
    assert.equal((await truncated.generate(input)).speech, 'Lentils, then.');
    assert.equal(calls, 2);

    const complete = generator();
    let completeCalls = 0;
    complete.fetchJson = async () => { completeCalls += 1; return completion(REPLY, 'max_tokens'); };
    assert.equal((await complete.generate(input)).speech, 'Lentils, then.');
    assert.equal(completeCalls, 1);
});

test('retries can be disabled', async () => {
    const host = generator({ maxRetries: 0 });
    let calls = 0;
    host.fetchJson = async () => { calls += 1; throw timeoutError(); };
    await assert.rejects(host.generate(input), { name: 'AbortError' });
    assert.equal(calls, 1);
});

test('an Anthropic safety decline becomes a quiet turn, not a generator error', async () => {
    const normalized = normalizeAnthropicResponse({
        content: [],
        stop_reason: 'refusal',
        stop_details: { type: 'refusal', category: 'reasoning_extraction', explanation: 'Declined by a safety classifier.' },
        usage: {}
    }, {}, 'https://api.anthropic.com/v1');
    assert.equal(normalized.choices[0].message.refusal, 'Declined by a safety classifier.');
    assert.equal(normalized.choices[0].finish_reason, 'refusal');

    const host = generator();
    let calls = 0;
    host.fetchJson = async () => { calls += 1; return normalized; };
    const output = await host.generate(input);
    assert.equal(calls, 1);
    assert.equal(output.shouldRespond, false);
    assert.equal(output.speech, '');
});

test('ordinary Anthropic replies carry no refusal marker', () => {
    const normalized = normalizeAnthropicResponse({
        content: [{ type: 'text', text: REPLY }],
        stop_reason: 'end_turn',
        usage: {}
    }, {}, 'https://api.anthropic.com/v1');
    assert.equal('refusal' in normalized.choices[0].message, false);
    assert.equal(normalized.choices[0].message.content, REPLY);
});

test('effort is sent only when configured and keeps the structured-output format', () => {
    const request = {
        model: 'test-model',
        max_completion_tokens: 1500,
        messages: [{ role: 'user', content: 'hello' }],
        response_format: { type: 'json_schema', json_schema: { schema: { type: 'object' } } }
    };
    assert.equal('effort' in buildAnthropicMessagesBody(request).output_config, false);
    assert.equal('effort' in buildAnthropicMessagesBody(request, { effort: 'turbo' }).output_config, false);

    const withEffort = buildAnthropicMessagesBody(request, { effort: ' Low ' });
    assert.equal(withEffort.output_config.effort, 'low');
    assert.deepEqual(withEffort.output_config.format, { type: 'json_schema', schema: { type: 'object' } });

    const plain = buildAnthropicMessagesBody({ ...request, response_format: undefined }, { effort: 'medium' });
    assert.deepEqual(plain.output_config, { effort: 'medium' });
});

test('the configured effort reaches both the streaming and non-streaming requests', async () => {
    const host = generator({ effort: 'low' });
    const streaming = host.buildStreamingRequest(host.buildRequestBody([{ role: 'user', content: 'hello' }]));
    assert.equal(streaming.body.output_config.effort, 'low');
    assert.equal(streaming.body.stream, true);

    const unset = generator();
    const defaultRequest = unset.buildStreamingRequest(unset.buildRequestBody([{ role: 'user', content: 'hello' }]));
    assert.equal('effort' in defaultRequest.body.output_config, false);
});
