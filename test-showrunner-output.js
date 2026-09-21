'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ShowRunnerGenerator } = require('./showrunner-generator');
const valid = JSON.stringify({action:'ask_followup', messageToChannel:'What changed this week?', approved:false, plan:null});
function generator(options = {}) {
    return new ShowRunnerGenerator({apiKey:'test', baseUrl:'https://api.anthropic.com/v1', model:'test-model', ...options});
}
function response(content = valid, finish_reason = 'end_turn') {
    return {choices:[{message:{content},finish_reason}],usage:{completion_tokens:2400}};
}
test('planner uses model maximum and ignores legacy application token budgets', async () => {
    const g = generator({maxCompletionTokens:2400});
    let lookups = 0;
    g.fetchModelOutputLimit = async () => { lookups++; return 128000; };
    g.fetchCompletion = async messages => {
        assert.equal(g.buildRequestBody(messages).max_completion_tokens,128000);
        return response();
    };
    await g.generate(); await g.generate();
    assert.equal(lookups,1);
});
test('non-Anthropic planner leaves output budget to the provider', async () => {
    const g = generator({baseUrl:'https://api.openai.com/v1',maxCompletionTokens:2400});
    g.fetchCompletion = async messages => {
        assert(!Object.hasOwn(g.buildRequestBody(messages),'max_completion_tokens'));
        return response();
    };
    await g.generate();
});
for (const [name, first] of [
    ['truncated JSON',response('{"action":"generate_plan",','max_tokens')],
    ['length finish reason despite parseable text',response(valid,'length')],
    ['malformed JSON',response('{"broken":]')],
]) test('retries '+name+' with original planning context', async () => {
    const g = generator();g.fetchModelOutputLimit=async()=>128000;
    const requests=[];
    g.fetchCompletion=async messages=>{requests.push(JSON.stringify(messages));return requests.length===1?first:response();};
    const result=await g.generate({planningMessages:[{speaker:'Jensen',text:'Keep all my context.'}]});
    assert.equal(result.action,'ask_followup');
    assert.equal(requests.length,2);assert.equal(requests[0],requests[1]);
    assert(requests[1].includes('Keep all my context.'));
});
test('repeated invalid output fails without accepting partial plans or retrying forever', async () => {
    const g=generator();g.fetchModelOutputLimit=async()=>128000;
    let calls=0;g.fetchCompletion=async()=>{calls++;return response('{"plan":');};
    await assert.rejects(g.generate(),/invalid JSON/);assert.equal(calls,2);
});
test('model metadata lookup failure can recover on the next request without a hidden budget', async () => {
    const g=generator();let calls=0;
    g.fetchModelOutputLimit=async()=>{if(++calls===1)throw Error('metadata unavailable');return 128000;};
    g.fetchCompletion=async()=>response();
    await assert.rejects(g.generate(),/metadata unavailable/);
    await g.generate();assert.equal(g.modelOutputLimit,128000);assert.equal(calls,2);
});
test('concurrent planner requests share model metadata lookup', async () => {
    const g=generator();let calls=0;
    g.fetchModelOutputLimit=async()=>{calls++;await new Promise(r=>setTimeout(r,5));return 128000;};
    g.fetchCompletion=async()=>response();
    await Promise.all([g.generate(),g.generate()]);assert.equal(calls,1);
});
