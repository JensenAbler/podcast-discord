const test = require('node:test');
const assert = require('node:assert/strict');
const { AlphaClawdVoiceBot } = require('./bot');

function bot() {
    const b = Object.create(AlphaClawdVoiceBot.prototype);
    b.participantActivityVersion = new Map();
    b.isRecordingActive = () => true;
    b.hasCurrentParticipantFloor = () => false;
    b.getHostPlaybackContext = () => ({});
    b.getParticipantSignalProfile = () => ({ recordSignal: () => ({ strictnessLevel: 0 }), getPrePlaybackEvidenceWaitMs: () => 150 });
    return b;
}
const at = n => new Date(n).toISOString();
const evidence = (b, user, start) => b.confirmParticipantActivity('g', user, 'speech evidence', { firstSpeechAtMs: start });
const resolve = (b, user, start, type = 'phantom_utterance', extra = {}) =>
    b.recordParticipantSignal('g', user, type, { speechStartedAt: at(start), ...extra });

test('resolved phantom cannot invalidate the pending answer at playback start', () => {
    const b = bot();
    const baseline = b.confirmParticipantActivity('g', 'a', 'transcript');
    evidence(b, 'a', 1000);
    assert.equal(b.didParticipantResumeSince('g', baseline), true);
    resolve(b, 'a', 1000);
    assert.equal(b.getParticipantActivityVersion('g'), baseline);
    assert.equal(b.discardStaleDirectResponse('g', { participantActivityBaseline: baseline }, 'at playback start'), false);
    assert.equal(b.confirmParticipantActivity('g', 'a', 'transcript'), 3, 'never reuse revoked version');
    assert.equal(b.didParticipantResumeSince('g', baseline), true);
});

test('phantom resolution preserves other guests and later real speech', () => {
    for (const other of ['a', 'b']) {
        const b = bot(), baseline = b.getParticipantActivityVersion('g');
        evidence(b, 'a', 1000);
        evidence(b, other, 2000);
        resolve(b, other, 2000, 'real_transcript');
        resolve(b, 'a', 1000);
        assert.equal(b.didParticipantResumeSince('g', baseline), true);
        assert.equal(b.discardStaleDirectResponse('g', { participantActivityBaseline: baseline }), true);
    }
});

test('out-of-order phantom results revoke only matching utterance versions', () => {
    const b = bot();
    evidence(b, 'a', 1000);
    const baseline = b.getParticipantActivityVersion('g');
    evidence(b, 'a', 2000);
    resolve(b, 'a', 1000);
    assert.equal(b.didParticipantResumeSince('g', baseline), true);
    resolve(b, 'a', 2000);
    assert.equal(b.didParticipantResumeSince('g', baseline), false);
});

test('all continuation evidence for one phantom is revoked, unrelated evidence is not', () => {
    const b = bot();
    evidence(b, 'a', 1000);
    evidence(b, 'a', 1000);
    resolve(b, 'a', 999);
    assert.equal(b.didParticipantResumeSince('g', 0), true);
    resolve(b, 'a', 1000);
    assert.equal(b.didParticipantResumeSince('g', 0), false);
});

test('empty ASR and failed ASR are not treated as confirmed phantoms', () => {
    const b = bot();
    evidence(b, 'a', 1000);
    resolve(b, 'a', 1000, 'empty_asr');
    resolve(b, 'a', 1000, 'phantom_utterance', { providerError: { message: 'failed' } });
    assert.equal(b.didParticipantResumeSince('g', 0), true);
});

test('current guest floor still blocks playback after an older phantom is rejected', () => {
    const b = bot();
    evidence(b, 'a', 1000);
    resolve(b, 'a', 1000);
    b.hasCurrentParticipantFloor = () => true;
    assert.equal(b.discardStaleDirectResponse('g', { participantActivityBaseline: 0, includeCurrentFloor: true }), true);
});


test('pending answer waits for late phantom classification and remains valid', async () => {
    const b = bot();
    evidence(b, 'a', 1000);
    let finished = false;
    const waiting = b.preserveDirectResponseWhileUncertain('g', { participantActivityBaseline: 0 }).then(() => { finished = true; });
    await new Promise(r => setTimeout(r, 40));
    assert.equal(finished, false);
    resolve(b, 'a', 1000);
    await waiting;
    assert.equal(b.discardStaleDirectResponse('g', { participantActivityBaseline: 0 }), false);
});

test('real transcript ends preservation and invalidates the old answer', async () => {
    const b = bot();
    evidence(b, 'a', 1000);
    const waiting = b.preserveDirectResponseWhileUncertain('g', { participantActivityBaseline: 0 });
    resolve(b, 'a', 1000, 'real_transcript');
    await waiting;
    assert.equal(b.discardStaleDirectResponse('g', { participantActivityBaseline: 0 }), true);
});

test('raw VAD that becomes a phantom preserves the answer throughout', async () => {
    const b = bot();
    let raw = true;
    b.getPendingUnconfirmedParticipantSignals = () => raw ? [{}] : [];
    const waiting = b.preserveDirectResponseWhileUncertain('g', { participantActivityBaseline: 0 });
    evidence(b, 'a', 1000);
    raw = false;
    await new Promise(r => setTimeout(r, 40));
    resolve(b, 'a', 1000);
    await waiting;
    assert.equal(b.didParticipantResumeSince('g', 0), false);
});

test('unresolved activity times out conservatively and stopping cancels the wait', async () => {
    const b = bot();
    evidence(b, 'a', 1000);
    await b.preserveDirectResponseWhileUncertain('g', { participantActivityBaseline: 0 });
    assert.equal(b.didParticipantResumeSince('g', 0), true);
    const waiting = b.preserveDirectResponseWhileUncertain('g', { participantActivityBaseline: 0 });
    b.isRecordingActive = () => false;
    await waiting;
    assert.equal(b.discardStaleDirectResponse('g', {}), true);
});

test('post-handoff phantom wait preserves the exact audio and playback lease', async () => {
    const { VoiceManager } = require('./voice-manager');
    for (const phantom of [true, false]) {
        const b = bot();
        const audio = Buffer.from('original answer');
        let played = null, releases = 0, finishes = 0;
        const manager = Object.create(VoiceManager.prototype);
        manager.transmitters = new Map([['g', { play: async (value, options) => {
            played = value;
            options.onStart();
            options.onFinish();
        } }]]);
        manager.quartzBackchannels = new Map([['g', { acquireAlpha: async () => {
            evidence(b, 'a', 1000);
            return () => { releases++; };
        } }]]);
        const pending = manager.speakWithTiming('g', audio, {
            beforePlayback: async () => {
                await b.preserveDirectResponseWhileUncertain('g', { participantActivityBaseline: 0 });
                return !b.discardStaleDirectResponse('g', { participantActivityBaseline: 0, includeCurrentFloor: true });
            },
            onFinish: () => { finishes++; }
        });
        await new Promise(r => setTimeout(r, 40));
        assert.equal(played, null, 'no audio begins while classification is pending');
        assert.equal(releases, 0);
        resolve(b, 'a', 1000, phantom ? 'phantom_utterance' : 'real_transcript');
        const playback = await pending;
        const timing = await playback.finished;
        assert.equal(played, phantom ? audio : null);
        assert.equal(Boolean(timing.playbackStartedAt), phantom);
        assert.equal(finishes, 1);
        assert.equal(releases, 1);
    }
});

test('weak raw flaps exhaust one short budget without vetoing the answer or renewing the wait', async () => {
    const b = bot(), options = { participantActivityBaseline: 0 };
    b.getPendingUnconfirmedParticipantSignals = () => [{ userId: 'a' }];
    const started = Date.now();
    await b.preserveDirectResponseWhileUncertain('g', options);
    assert.ok(Date.now() - started < 500);
    assert.equal(options.activityResolutionExpired, true);
    assert.equal(b.discardDirectResponseForPendingRawVad('g', options), false);
    const deadline = options.activityResolutionDeadline;
    await b.preserveDirectResponseWhileUncertain('g', options);
    assert.equal(options.activityResolutionDeadline, deadline);
    evidence(b, 'a', 1000);
    assert.equal(b.discardStaleDirectResponse('g', options), true, 'strong speech still blocks after raw budget expires');
});

test('isolated loud frames cannot accumulate speech authority, sustained speech can', () => {
    const { SilenceDetector } = require('./silence-detector');
    const { AudioReceiver } = require('./audio-receiver');
    const detector = new SilenceDetector();
    const buffer = { detector, chunks: [], segmentStartStats: null };
    let confirmed = 0;
    const receiver = Object.create(AudioReceiver.prototype);
    receiver.getSpeechEvidenceFrameThreshold = () => 5;
    receiver.getBufferedAudioBytes = () => 0;
    receiver.options = { onSpeechEvidence: () => confirmed++ };
    const loud = Buffer.alloc(detector.bytesPerFrame);
    for (let i = 0; i < loud.length; i += 2) loud.writeInt16LE(10000, i);
    const silent = Buffer.alloc(detector.bytesPerFrame);
    for (let i = 0; i < 20; i++) {
        detector.processAudio(loud);
        receiver.maybeEmitSpeechEvidence('a', buffer);
        detector.processAudio(silent);
    }
    assert.equal(confirmed, 0);
    for (let i = 0; i < 5; i++) {
        detector.processAudio(loud);
        receiver.maybeEmitSpeechEvidence('a', buffer);
    }
    assert.equal(confirmed, 1);
    detector.reset();
    assert.equal(detector.getStats().consecutiveSpeakingFrames, 0);
});
