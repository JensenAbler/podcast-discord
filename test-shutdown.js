const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { startStandaloneBot, SHUTDOWN_TIMEOUT_MS } = require('./standalone-shutdown');

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

function fixture({ start = () => Promise.resolve(), stop = () => Promise.resolve() } = {}) {
    const processRef = new EventEmitter();
    const exits = [];
    const logs = [];
    const timers = new Set();
    let now = 0;
    let stopCalls = 0;
    let timerCalls = 0;
    processRef.exit = (code) => exits.push(code);
    const bot = {
        start,
        stop() {
            stopCalls++;
            return stop.call(this);
        }
    };
    const startup = startStandaloneBot(bot, {
        processRef,
        log: (message, level = 'INFO') => logs.push({ message, level }),
        setTimeoutFn(callback, delay) {
            timerCalls++;
            const timer = {
                callback,
                due: now + delay,
                unref() { assert.fail('Shutdown deadline must remain referenced'); }
            };
            timers.add(timer);
            return timer;
        },
        clearTimeoutFn: (timer) => timers.delete(timer)
    });
    return {
        bot, processRef, exits, logs, timers, startup,
        get stopCalls() { return stopCalls; },
        get timerCalls() { return timerCalls; },
        tick(ms) {
            now += ms;
            for (const timer of [...timers]) {
                if (timer.due <= now) {
                    timers.delete(timer);
                    timer.callback();
                }
            }
        }
    };
}

const flushPromises = async () => {
    await Promise.resolve();
    await Promise.resolve();
};

test('startup alone does not stop or exit the bot', async () => {
    const f = fixture();
    await f.startup;
    assert.equal(f.processRef.listenerCount('SIGTERM'), 1);
    assert.equal(f.processRef.listenerCount('SIGINT'), 1);
    assert.equal(f.stopCalls, 0);
    assert.equal(f.timerCalls, 0);
    assert.deepEqual(f.exits, []);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
    test(`${signal} awaits asynchronous cleanup before a successful exit`, async () => {
        const cleanup = deferred();
        let cleaned = false;
        const f = fixture({ stop: async () => { await cleanup.promise; cleaned = true; } });
        f.processRef.emit(signal);
        assert.equal(f.stopCalls, 1);
        assert.equal(cleaned, false);
        assert.deepEqual(f.exits, []);
        assert.equal(f.timers.size, 1);

        cleanup.resolve();
        await flushPromises();
        assert.equal(cleaned, true);
        assert.deepEqual(f.exits, [0]);
        assert.equal(f.timers.size, 0);
        assert.ok(f.logs.some(({ message }) => message.includes(`${signal}: cleanup complete`)));
        f.tick(SHUTDOWN_TIMEOUT_MS);
        assert.deepEqual(f.exits, [0]);
    });

    test(`${signal} and repeated/mixed signals share one cleanup and deadline`, async () => {
        const cleanup = deferred();
        const f = fixture({ stop: () => cleanup.promise });
        f.processRef.emit(signal);
        f.tick(10_000);
        f.processRef.emit(signal);
        f.processRef.emit(signal === 'SIGTERM' ? 'SIGINT' : 'SIGTERM');
        assert.equal(f.stopCalls, 1);
        assert.equal(f.timerCalls, 1);
        assert.deepEqual(f.exits, []);

        cleanup.resolve();
        await flushPromises();
        f.processRef.emit(signal);
        assert.equal(f.stopCalls, 1);
        assert.deepEqual(f.exits, [0]);
    });
}

for (const mode of ['throw', 'reject']) {
    test(`cleanup ${mode} reports the error and exits unsuccessfully once`, async () => {
        const error = new Error('fixture cleanup failure');
        const f = fixture({
            stop: () => {
                if (mode === 'throw') throw error;
                return Promise.reject(error);
            }
        });
        f.processRef.emit('SIGTERM');
        await flushPromises();
        assert.deepEqual(f.exits, [1]);
        assert.equal(f.timers.size, 0);
        assert.ok(f.logs.some(({ message, level }) =>
            level === 'ERROR' && message.includes('cleanup failed') && message.includes(error.message)));
        f.processRef.emit('SIGINT');
        f.tick(SHUTDOWN_TIMEOUT_MS);
        assert.equal(f.stopCalls, 1);
        assert.deepEqual(f.exits, [1]);
    });
}

for (const outcome of ['resolve', 'reject']) {
    test(`hung cleanup times out once even if it later ${outcome}s`, async () => {
        assert.equal(SHUTDOWN_TIMEOUT_MS, 25_000);
        assert.ok(SHUTDOWN_TIMEOUT_MS < 30_000);
        const cleanup = deferred();
        const f = fixture({ stop: () => cleanup.promise });
        f.processRef.emit('SIGINT');
        f.tick(SHUTDOWN_TIMEOUT_MS - 1);
        assert.deepEqual(f.exits, []);
        f.processRef.emit('SIGTERM');
        f.tick(1);
        assert.deepEqual(f.exits, [1]);
        assert.equal(f.stopCalls, 1);
        assert.equal(f.timerCalls, 1);
        assert.equal(f.timers.size, 0);
        assert.ok(f.logs.some(({ message, level }) =>
            level === 'ERROR' && message.includes('SIGINT') && message.includes('timed out after 25000ms')));
        cleanup[outcome](new Error('late cleanup failure'));
        await flushPromises();
        assert.deepEqual(f.exits, [1]);
        assert.ok(!f.logs.some(({ message }) => message.includes('cleanup complete')));
    });
}

test('startup rejection during shutdown cannot bypass pending cleanup', async () => {
    const start = deferred();
    const cleanup = deferred();
    const f = fixture({ start: () => start.promise, stop: () => cleanup.promise });
    f.processRef.emit('SIGTERM');
    start.reject(new Error('fixture startup failure'));
    await f.startup;
    assert.deepEqual(f.exits, []);
    assert.equal(f.stopCalls, 1);
    cleanup.resolve();
    await flushPromises();
    assert.deepEqual(f.exits, [1]);
    assert.ok(f.logs.some(({ message, level }) =>
        level === 'FATAL' && message.includes('fixture startup failure')));
});

test('startup failure retains its unsuccessful exit when no signal arrived', async () => {
    const f = fixture({ start: () => Promise.reject(new Error('fixture startup failure')) });
    await f.startup;
    assert.deepEqual(f.exits, [1]);
    assert.equal(f.stopCalls, 0);
    assert.equal(f.timers.size, 0);
});

test('existing bot cleanup order is preserved and Discord destruction is awaited', async () => {
    // Importing the class does not construct a bot or connect to any provider.
    const { AlphaClawdVoiceBot } = require('./bot');
    const bot = Object.create(AlphaClawdVoiceBot.prototype);
    const events = [];
    const recording = deferred();
    const discord = deferred();
    bot.geminiLiveHosts = new Map([['guild', {}]]);
    bot.stopGeminiLiveSession = async () => events.push('gemini');
    bot.voiceManager = {
        connections: new Map([['guild', {}]]),
        async leaveChannel(guildId) {
            assert.equal(guildId, 'guild');
            events.push('recording started');
            await recording.promise;
            events.push('recording and voice complete');
        }
    };
    bot.conversationBuffer = { clear: () => events.push('buffer') };
    bot.wsClient = { disconnect: () => events.push('websocket') };
    bot.gatewayBridge = { destroy: () => events.push('gateway') };
    bot.client = {
        async destroy() {
            events.push('discord started');
            await discord.promise;
            events.push('discord complete');
        }
    };
    const stopped = bot.stop();
    let finished = false;
    stopped.then(() => { finished = true; });
    await flushPromises();
    assert.deepEqual(events, ['gemini', 'recording started']);
    assert.equal(finished, false);
    recording.resolve();
    await flushPromises();
    assert.deepEqual(events, [
        'gemini', 'recording started', 'recording and voice complete',
        'buffer', 'websocket', 'gateway', 'discord started'
    ]);
    assert.equal(finished, false);
    discord.resolve();
    await stopped;
    assert.equal(finished, true);
    assert.equal(events.at(-1), 'discord complete');
});
