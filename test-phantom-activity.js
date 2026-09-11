const test = require('node:test');
const assert = require('node:assert/strict');
const { AlphaClawdVoiceBot } = require('./bot');

function bot() {
    const b = Object.create(AlphaClawdVoiceBot.prototype);
    b.participantActivityVersion = new Map();
    b.isRecordingActive = () => true;
    b.hasCurrentParticipantFloor = () => false;
    b.getHostPlaybackContext = () => ({});
    b.getParticipantSignalProfile = () => ({ recordSignal: () => ({ strictnessLevel: 0 }) });
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
