const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AlphaClawdVoiceBot } = require('./bot');
const { VoiceManager } = require('./voice-manager');
const { AudioTransmitter } = require('./audio-transmitter');
const { captureSynthesisInput, deliveryRecord } = require('./speech-delivery');
const timing = { playbackRequestedAt: '2026-09-12T00:00:00.000Z',
    playbackStartedAt: '2026-09-12T00:00:01.000Z',
    playbackEndedAt: '2026-09-12T00:00:02.000Z' };

function harness({ interrupted = false, underrun = false, playbackError = false, synthesisError = false } = {}) {
    const b = Object.create(AlphaClawdVoiceBot.prototype);
    const entries = [], remembered = [];
    Object.assign(b, {
        directResponseInFlight: new Set(),
        stopBigBrainToolTone() {}, async waitForParticipantFloorToSettle() {},
        async preserveDirectResponseWhileUncertain() {}, discardStaleDirectResponse: () => false,
        markIdleDecisionHandled() {}, formatAwarenessInjectionsForTranscript: () => [],
        formatAwarenessShelfItemsForTranscript: () => [],
        observeInternalThoughtTranscriptEntry() {}, observeShowRunnerTranscriptEntry() {},
        applyEpisodePlanResponse() {}, resetConsecutiveGeneratorSilences() {},
        conversationBuffer: { setFlushHold() {}, startCooldown() {} },
        voiceManager: { saveTranscriptEntry(g, e) { entries.push(e); } },
        podcastGenerator: { rememberAssistantResponse(r) { remembered.push(r); } },
        async synthesizeLiveTTS(source) {
            if (typeof source !== 'string') for await (const chunk of source) {
                if (synthesisError) throw new Error('TTS socket failed');
            }
            return Buffer.from('audio');
        },
        async playTtsAndRecord(g, audio, options) {
            options.onStart(timing);
            if (playbackError) {
                options.onError(new Error('player failed'), { ...timing, playbackEndedAt: null,
                    playbackErrorAt: timing.playbackEndedAt });
                throw new Error('player failed');
            }
            const t = { ...timing, playbackInterrupted: interrupted };
            options.onFinish(t);
            return { playback: { timing: t }, playbackTiming: t, playbackUnderrunDetected: underrun };
        }
    });
    return { b, entries, remembered };
}
function response(finalSpeech = 'Generator final text.', fail = false) {
    const completed = fail ? Promise.reject(new Error('Streaming provider error: api_error - Internal server error')) :
        Promise.resolve({ speech: finalSpeech, shouldRespond: true });
    completed.catch(() => {});
    return { shouldRespond: true, isStreaming: true, completed,
        speechStream: (async function* () { yield 'That is '; yield 'what was synthesized.'; })() };
}
const opts = { playFiller: false, rememberAssistant: true };

test('late generator failure retains completed synthesis in transcript and assistant history', async () => {
    const { b, entries, remembered } = harness();
    await b.speakDirectGeneratorResponse('g', response('', true), opts);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].transcription, 'That is what was synthesized.');
    assert.equal(entries[0].synthesisText, entries[0].transcription);
    assert.equal(entries[0].synthesisInputComplete, true);
    assert.equal(entries[0].playbackStatus, 'completed');
    assert.equal(entries[0].providerError.stage, 'generator');
    assert.match(entries[0].providerError.message, /Internal server error/);
    assert.equal(remembered[0].speech, entries[0].synthesisText);
});
test('successful final result remains separate from exact synthesis input', async () => {
    const { b, entries } = harness();
    await b.speakDirectGeneratorResponse('g', response(), opts);
    assert.equal(entries[0].generatedTranscription, 'Generator final text.');
    assert.equal(entries[0].transcription, 'That is what was synthesized.');
});
for (const mode of ['interrupted', 'underrun', 'playbackError', 'synthesisError']) {
    test(mode + ' retains forensic text without claiming complete delivery', async () => {
        const { b, entries, remembered } = harness({ [mode]: true });
        const work = b.speakDirectGeneratorResponse('g', response(), opts);
        if (mode.endsWith('Error')) await assert.rejects(work);
        else await work;
        assert.equal(entries.length, 1);
        assert.notEqual(entries[0].playbackStatus, 'completed');
        assert.notEqual(entries[0].transcription, entries[0].synthesisText);
        assert.ok(entries[0].synthesisText.startsWith('That is '));
        assert.equal(remembered.length, 0);
        assert.equal(b.directResponseInFlight.size, 0);
        if (mode.endsWith('Error')) assert.ok(entries[0].providerError.message);
    });
}
test('input capture retains only consumed chunks and reports producer failure', async () => {
    const capture = captureSynthesisInput((async function* () {
        yield 'First chunk.'; throw new Error('producer failed');
    })());
    await assert.rejects(async () => { for await (const chunk of capture.source) {} }, /producer failed/);
    assert.equal(capture.text, 'First chunk.');
    assert.equal(capture.complete, false);
    assert.equal(deliveryRecord(capture, { timing }).playbackStatus, 'incomplete');
});
test('intentional transmitter stop survives the VoiceManager timing wrapper', async () => {
    const transmitter = new AudioTransmitter();
    const manager = Object.create(VoiceManager.prototype);
    manager.speak = async (g, audio, options) => {
        transmitter.currentPlayback = { options };
        options.onStart();
    };
    const playback = await manager.speakWithTiming('g', Buffer.from('audio'));
    transmitter.stop();
    const result = await playback.finished;
    assert.equal(result.playbackInterrupted, true);
    assert.ok(result.playbackEndedAt);
});
test('JSONL persistence keeps delivery text, status and error alongside safe transcript text', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-delivery-'));
    try {
        const manager = Object.create(VoiceManager.prototype);
        manager.recordingPaths = new Map([['g', dir]]);
        manager.transcriptSaveStops = new Map();
        manager.observeQuartzTranscript = () => {};
        const record = deliveryRecord(captureSynthesisInput('A full synthesized answer.'), {
            timing: { ...timing, playbackInterrupted: true },
            finalResponse: { speech: 'Final generated answer.', providerError: { stage: 'generator', message: 'api_error' } }
        });
        manager.saveTranscriptEntry('g', { speaker: 'Alpha-Clawd', speakerRole: 'host', ...timing, ...record });
        const saved = JSON.parse(fs.readFileSync(path.join(dir, 'transcript.jsonl'), 'utf8'));
        assert.equal(saved.synthesisText, 'A full synthesized answer.');
        assert.equal(saved.generatedTranscription, 'Final generated answer.');
        assert.equal(saved.playbackStatus, 'incomplete');
        assert.equal(saved.playbackInterrupted, true);
        assert.equal(saved.providerError.message, 'api_error');
        assert.match(saved.text, /incomplete/);
        assert.ok(!saved.text.includes(saved.synthesisText));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('unplayed diagnostic rows do not tell Live that Alpha spoke', () => {
    const manager = Object.create(VoiceManager.prototype);
    const contexts = [], turns = [];
    manager.quartzBackchannels = new Map([['g', { client: { started: true },
        turnController: { observe: event => turns.push(event) },
        appendConversation: (...args) => contexts.push(args) }]]);
    for (const playbackStatus of ['not_started', 'failed']) {
        manager.observeQuartzTranscript('g', { speakerRole: 'host', playbackStatus,
            transcription: '[Host response did not start playback; synthesis text retained.]' });
    }
    assert.equal(contexts.length, 0);
    assert.equal(turns.length, 0);
    manager.observeQuartzTranscript('g', { speakerRole: 'host', playbackStatus: 'completed',
        transcription: 'Actual synthesis input.', providerError: { stage: 'generator', message: 'api_error' } });
    assert.equal(contexts.length, 1);
    assert.ok(contexts[0][1].includes('Actual synthesis input.'));
});
test('premature audio stream closure is retained as a synthesis error', async () => {
    const { PassThrough } = require('stream');
    const b = Object.create(AlphaClawdVoiceBot.prototype);
    const audio = new PassThrough();
    const capture = b.teeAudioForRecording(audio);
    audio.write(Buffer.from('partial audio'));
    audio.destroy();
    await capture.completion;
    assert.equal(capture.providerError.stage, 'synthesis');
    assert.match(capture.providerError.message, /closed before end/);
});
