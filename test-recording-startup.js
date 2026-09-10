const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AlphaClawdVoiceBot } = require('./bot');

for (const engine of ['current', 'gemini-live']) {
    for (const fails of [false, true]) {
        test(engine + ' initializes after announcement ' + (fails ? 'failure' : 'success'), async () => {
            const bot = Object.create(AlphaClawdVoiceBot.prototype);
            const calls = [];
            Object.assign(bot, {
                normalizeSessionHostMode: x => x,
                recordingState: new Map(), RecordingState: { RECORDING: 'RECORDING' },
                sessionHostModes: new Map(), recordingTextChannels: new Map(),
                consentWaiters: new Map([['g', {}]]), speakerMap: {},
                resetConsecutiveGeneratorSilences() {},
                gatewayBridge: { async disableAllCronJobs() { return []; } },
                voiceManager: { startRecording(g, prefix, metadata) {
                    assert.equal(metadata.consentGiven, true);
                    calls.push('record'); return {};
                } },
                startInternalThoughtSession() {}, startEpisodePlanTracker() {},
                podcastGenerator: { startSession() { calls.push('session'); } },
                async speakRecordingStart() {
                    calls.push('announce');
                    if (fails) throw new Error('write EPIPE');
                },
                startIdleDecisionLoop() { calls.push('idle'); },
                async startGeminiLiveSession() { calls.push('gemini'); },
                shouldConnectGatewayWs: () => true,
                voiceProvider: { mode: 'fish', tts: {} },
                wsClient: {
                    isAuthenticated: true, canInjectMessages: () => true,
                    async injectPodcastEvent(event) {
                        assert.equal(event.event, 'session_start'); calls.push('notify');
                    }
                }
            });
            await bot.grantConsent('g', 'test', engine);
            assert.deepEqual(calls, ['record', 'session', 'announce',
                engine === 'current' ? 'idle' : 'gemini', 'notify']);
            assert.equal(bot.recordingState.get('g'), 'RECORDING');
            assert.equal(bot.consentWaiters.has('g'), false);
        });
    }
}
