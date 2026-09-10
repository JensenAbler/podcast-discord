const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AlphaClawdVoiceBot } = require('./bot');

function deferred() {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

function fixture() {
    const bot = Object.create(AlphaClawdVoiceBot.prototype);
    const completed = deferred();
    const started = deferred();
    const calls = [];
    const message = { id: 'upload', guildId: 'guild', channelId: 'channel', content: '',
        author: { bot: false }, attachments: new Map([['image', { name: 'image.png' }]]) };
    bot.discordContextEnabled = true;
    bot.discordContextProcessing = new Map();
    bot.RecordingState = { RECORDING: 'RECORDING', IDLE: 'IDLE' };
    bot.recordingState = new Map([['guild', 'RECORDING']]);
    bot.recordingTextChannels = new Map([['guild', 'channel']]);
    bot.internalThoughtManager = { sessions: new Map([['guild', { recordingPath: '/recording/one' }]]) };
    bot.getActiveRecordingPath = () => '/recording/one';
    bot.buildDiscordContextBaseInput = () => ({ attachments: [{ name: 'image.png' }], messageText: '', messageId: 'upload' });
    bot.archiveDiscordContextImages = async () => { calls.push('archive'); return []; };
    bot.discordContextInterpreter = { interpret: async () => { calls.push('interpret'); started.resolve(); return completed.promise; } };
    bot.addPendingDiscordAttachmentAwarenessItem = () => { calls.push('pending'); return { id: 'pending-upload' }; };
    bot.addDiscordContextAwarenessItem = () => { calls.push('add'); return { id: 'upload', text: 'reading' }; };
    bot.updateDiscordContextAwarenessItem = () => { calls.push('update'); return { id: 'upload', text: 'reading' }; };
    bot.markDiscordContextIngestionFailed = () => { calls.push('failed'); };
    bot.truncateForLog = value => value;
    return { bot, message, calls, completed, started };
}

test('a current recording receives the completed interpretation through its existing pending shelf item', async () => {
    const f = fixture();
    const work = f.bot.enqueueDiscordContextIngestion(f.message);
    assert.deepEqual(f.calls, ['pending']);
    await f.started.promise;
    f.completed.resolve({ awarenessText: 'A[N/M]', confidence: 'low', caveats: 'Last glyph is ambiguous.' });
    await work;
    assert.deepEqual(f.calls, ['pending', 'archive', 'interpret', 'update']);
});

for (const change of ['ended', 'channel', 'path', 'session', 'shutdown']) {
    test(`a slow interpretation cannot update stale episode context after ${change}`, async () => {
        const f = fixture();
        const work = f.bot.enqueueDiscordContextIngestion(f.message);
        await f.started.promise;
        if (change === 'ended') f.bot.recordingState.set('guild', 'IDLE');
        if (change === 'channel') f.bot.recordingTextChannels.set('guild', 'other');
        if (change === 'path') f.bot.getActiveRecordingPath = () => '/recording/two';
        if (change === 'session') f.bot.internalThoughtManager.sessions.set('guild', {});
        if (change === 'shutdown') f.bot.discordContextClosing = true;
        f.completed.resolve({ awarenessText: 'old reading' });
        assert.equal(await work, null);
        assert.ok(!f.calls.some(call => ['add', 'update', 'failed'].includes(call)));
    });
}

test('an upload queued behind another interpretation is discarded when its episode changes before it starts', async () => {
    const f = fixture();
    const blocker = deferred();
    f.bot.discordContextProcessing.set('guild', blocker.promise);
    const work = f.bot.enqueueDiscordContextIngestion(f.message);
    f.bot.getActiveRecordingPath = () => '/recording/two';
    blocker.resolve();
    assert.equal(await work, null);
    assert.deepEqual(f.calls, ['pending']);
});

test('an interpretation failure cannot mark a replacement episode shelf item as failed', async () => {
    const f = fixture();
    const work = f.bot.enqueueDiscordContextIngestion(f.message);
    await f.started.promise;
    f.bot.internalThoughtManager.sessions.set('guild', {});
    f.completed.reject(new Error('fixture timeout'));
    await work;
    assert.ok(!f.calls.includes('failed'));
});

test('a failure during the same episode still resolves its pending item through existing handling', async () => {
    const f = fixture();
    const work = f.bot.enqueueDiscordContextIngestion(f.message);
    await f.started.promise;
    f.completed.reject(new Error('fixture timeout'));
    await work;
    assert.equal(f.calls.filter(call => call === 'failed').length, 1);
});

test('shutdown stops new context ingestion immediately', () => {
    const f = fixture();
    f.bot.discordContextClosing = true;
    assert.equal(f.bot.enqueueDiscordContextIngestion(f.message), null);
    assert.deepEqual(f.calls, []);
});

function stoppingBot(close) {
    const bot = Object.create(AlphaClawdVoiceBot.prototype);
    const calls = [];
    bot.discordContextInterpreter = { close: () => { calls.push('context-close'); return close(); } };
    bot.geminiLiveHosts = new Map([['gemini', {}]]);
    bot.stopGeminiLiveSession = async () => { calls.push('gemini-stop'); };
    bot.voiceManager = { connections: new Map([['voice', {}]]), leaveChannel: async () => { calls.push('voice-leave'); } };
    bot.conversationBuffer = { clear: () => { calls.push('buffer-clear'); } };
    bot.wsClient = { disconnect: () => { calls.push('ws-disconnect'); } };
    bot.gatewayBridge = { destroy: () => { calls.push('gateway-destroy'); } };
    bot.client = { destroy: async () => { calls.push('discord-destroy'); } };
    return { bot, calls };
}

test('context cancellation proceeds alongside the existing voice cleanup and is awaited before stop resolves', async () => {
    const closing = deferred();
    const f = stoppingBot(() => closing.promise);
    let stopped = false;
    const work = f.bot.stop().then(() => { stopped = true; });
    for (let i = 0; i < 8; i++) await Promise.resolve();
    assert.equal(f.bot.discordContextClosing, true);
    assert.equal(stopped, false);
    assert.equal(f.calls.filter(call => call === 'context-close').length, 1);
    assert.deepEqual(f.calls.filter(call => call !== 'context-close'), [
        'gemini-stop', 'voice-leave', 'buffer-clear', 'ws-disconnect', 'gateway-destroy', 'discord-destroy'
    ]);
    closing.resolve();
    await work;
    assert.equal(stopped, true);
});

for (const mode of ['throw', 'reject']) {
    test(`context close ${mode} does not prevent recording and Discord cleanup`, async () => {
        const f = stoppingBot(() => {
            if (mode === 'throw') throw new Error('fixture close failure');
            return Promise.reject(new Error('fixture close failure'));
        });
        await f.bot.stop();
        assert.ok(f.calls.includes('voice-leave'));
        assert.ok(f.calls.includes('discord-destroy'));
    });
}
