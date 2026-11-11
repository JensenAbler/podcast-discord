const test = require('node:test');
const assert = require('node:assert/strict');
const { PodcastGenerator } = require('./podcast-generator');

const QUARTZ = 'GPT Live, using the Quartz voice';

test('the host prompt describes Quartz only when it is running', () => {
    const host = new PodcastGenerator({ apiKey: 'k' });
    assert.ok(host.buildSystemPrompt().includes(QUARTZ), 'kept by default');

    host.startSession({ quartzBackchannel: true });
    const withQuartz = host.buildSystemPrompt();
    assert.ok(withQuartz.includes(QUARTZ));

    host.startSession({ quartzBackchannel: false });
    const without = host.buildSystemPrompt();
    assert.ok(!without.includes(QUARTZ));
    assert.ok(!without.includes('\n\n\n'), 'no doubled blank line left behind');
    assert.equal(withQuartz.replace(/GPT Live, using the Quartz voice[^\n]*\n\n/, ''), without);
});
