const test = require('node:test');
const assert = require('node:assert/strict');
const { ConversationAdmission, assess, responseEffect, agreement } = require('./conversation-admission');
const { AlphaClawdVoiceBot } = require('./bot');
const at = n => new Date(n).toISOString();
const strong = { voicedMs: 600, maxRunMs: 300, audioDurationMs: 1000 };
const weak = { voicedMs: 20, maxRunMs: 20, audioDurationMs: 2000 };
function utterance(text, evidence = strong, start = Date.now() - 1000) {
    return { userId: 'a', speaker: 'Guest', transcription: text, acousticEvidence: evidence,
        speechStartedAt: at(start), speechEndedAt: at(start + 200),
        asrStartedAt: at(start + 400), asrCompletedAt: at(start + 900) };
}
function bot() {
    const b = Object.create(AlphaClawdVoiceBot.prototype);
    b.conversationAdmissions = new Map();
    b.participantActivityVersion = new Map();
    b.directResponseInFlight = new Set(['g']);
    b.lastParticipantSpeechAt = new Map();
    b.latestParticipantTurnIdIntent = new Map();
    b.isRecordingActive = () => true;
    b.hasCurrentParticipantFloor = () => false;
    b.admissionHostContext = () => ({ singleSpeaker: true });
    b.getHostPlaybackContext = () => ({});
    b.getParticipantSignalState = () => null;
    b.getPendingUnconfirmedParticipantSignals = () => [];
    b.clearConversationBufferAsrPendingIfPresent = () => {};
    b.clearCompletedParticipantSignalState = () => {};
    b.getParticipantSignalProfile = () => ({ recordSignal: () => ({ strictnessLevel: 0 }),
        getPrePlaybackEvidenceWaitMs: () => 150 });
    b.buildGeneratorTurnIdIntent = () => 'new-turn';
    b.observeInternalThoughtTranscriptEntry = () => {};
    b.observeShowRunnerTranscriptEntry = () => {};
    b.conversationBuffer = { entries: [], addUtterance(u) { this.entries.push(u); } };
    b.voiceManager = { handleUtterance: (g, u) => b.handleParticipantUtterance(g, u) };
    b.wsClient = {};
    return b;
}
function acoustic(b, u) {
    b.confirmParticipantActivity('g', u.userId, 'speech evidence', { firstSpeechAtMs: Date.parse(u.speechStartedAt) });
}

test('controlled PCM bursts distinguish sparse noise from sustained voice evidence', () => {
    const { SilenceDetector } = require('./silence-detector');
    function measure(pattern) {
        const d = new SilenceDetector();
        const loud = Buffer.alloc(d.bytesPerFrame), quiet = Buffer.alloc(d.bytesPerFrame);
        for (let i = 0; i < loud.length; i += 2) loud.writeInt16LE(10000, i);
        pattern.forEach(voiced => d.processAudio(voiced ? loud : quiet));
        const stats = d.getStats();
        const evidence = { voicedMs: stats.speakingFrames * 20, maxRunMs: stats.maxSpeakingRunFrames * 20,
            audioDurationMs: pattern.length * 20 };
        d.reset();
        assert.equal(d.getStats().maxSpeakingRunFrames, 0);
        return evidence;
    }
    assert.equal(assess(utterance('Alpha, explain the result.', measure(Array.from({ length: 100 }, (_, i) => i % 20 === 0)))).status, 'candidate');
    assert.equal(assess(utterance('Alpha, explain the result.', measure(Array.from({ length: 100 }, (_, i) => i < 40)))).status, 'accepted');
});

test('brief supported acknowledgments survive without Live and language switches need evidence', () => {
    const brief = { voicedMs: 80, maxRunMs: 60, audioDurationMs: 500 };
    assert.equal(assess(utterance('yeah', brief)).status, 'accepted');
    assert.equal(assess(utterance('谢谢', brief), { previousText: 'English context' }).status, 'candidate');
    assert.equal(assess(utterance('谢谢', strong), { previousText: 'English context' }).status, 'accepted');
    assert.equal(assess(utterance('a legitimate longer quiet continuation', brief), {
        previousText: 'the previous clause', gapMs: 500 }).status, 'accepted');
    assert.equal(assess(utterance('a longer hallucinated statement', weak)).status, 'candidate');
});

test('agreement preserves word order and cannot supply participant identity in a group', () => {
    assert.equal(agreement('red blue green', 'green blue red'), false);
    const p = new ConversationAdmission(), u = utterance('Can you explain?', weak);
    p.observeLive({ text: u.transcription, audioStartedAt: Date.parse(u.speechStartedAt),
        audioEndedAt: Date.parse(u.speechEndedAt) });
    assert.equal(p.evaluate(u, { singleSpeaker: false }).status, 'candidate');
    assert.equal(p.evaluate(u, { singleSpeaker: true }).status, 'accepted');
    assert.equal(assess({ ...u, providerError: {} }, { liveMatch: true }).status, 'candidate');
});

test('possible host echo plus weak audio stays uncertain even with Live agreement', () => {
    assert.equal(assess(utterance('the answer is seven', weak), {
        duringHostPlayback: true, hostText: 'the answer is seven', liveMatch: true }).status, 'candidate');
});

test('acknowledgments and repeated requests preserve; corrections and new details supersede', () => {
    for (const text of ['yeah', 'mhm', 'thank you', "that's all", "and that's it", 'please continue'])
        assert.equal(responseEffect(text), 'preserve', text);
    assert.equal(responseEffect('Explain the result?', ['Explain the result.']), 'preserve');
    for (const text of ['yes, but change the date', 'actually no', 'wait', 'My budget is fifty', 'yes that was yesterday'])
        assert.equal(responseEffect(text), 'supersede', text);
});

test('candidate never enters the buffer; raw forensic text and pending answer survive', async () => {
    const b = bot(), u = utterance('a suspicious long fragment', weak);
    acoustic(b, u);
    await b.handleParticipantUtterance('g', u);
    assert.equal(u.admission.status, 'candidate');
    assert.equal(u.transcription, '');
    assert.equal(u.rawTranscription, 'a suspicious long fragment');
    assert.equal(b.conversationBuffer.entries.length, 0);
    assert.equal(b.didParticipantResumeSince('g', 0), false);
});

test('acoustics park the answer until an acknowledgment releases it without cancellation', async () => {
    const b = bot(), u = utterance('yeah');
    acoustic(b, u);
    assert.equal(b.didParticipantResumeSince('g', 0), false);
    let ended = false;
    const waiting = b.preserveDirectResponseWhileUncertain('g', { participantActivityBaseline: 0 })
        .then(() => { ended = true; });
    await new Promise(r => setTimeout(r, 30));
    assert.equal(ended, false);
    await b.handleParticipantUtterance('g', u);
    await waiting;
    assert.equal(b.didParticipantResumeSince('g', 0), false);
    assert.equal(b.conversationBuffer.entries.length, 0);
    assert.deepEqual(b.getConversationAdmission('g').supplements, ['Guest: yeah']);
});

test('accepted correction cancels atomically before an asynchronous debug injection', async () => {
    const b = bot(), u = utterance('Actually, use the other example.');
    acoustic(b, u);
    let finish;
    b.debugInject = true;
    b.wsClient = { isAuthenticated: true, canInjectMessages: () => true,
        injectMessage: () => new Promise(r => { finish = r; }) };
    const handled = b.handleParticipantUtterance('g', u);
    assert.equal(b.didParticipantResumeSince('g', 0), true);
    assert.equal(b.conversationBuffer.entries.length, 1);
    finish();
    await handled;
});

test('empty and failed ASR resolve the completed pause without pretending speech was accepted', async () => {
    for (const providerError of [undefined, { message: 'provider failed' }]) {
        const b = bot(), u = { ...utterance(''), providerError };
        acoustic(b, u);
        const waiting = b.preserveDirectResponseWhileUncertain('g', { participantActivityBaseline: 0 });
        await b.handleParticipantUtterance('g', u);
        await waiting;
        assert.equal(u.admission.status, 'candidate');
        assert.equal(b.didParticipantResumeSince('g', 0), false);
    }
});

test('late corroboration promotes once, but not after a newer accepted turn or episode close', async () => {
    const b = bot(), u = utterance('Can you explain?', weak);
    await b.handleParticipantUtterance('g', u);
    const event = { text: 'Can you explain?', audioStartedAt: Date.parse(u.speechStartedAt),
        audioEndedAt: Date.parse(u.speechEndedAt) };
    b.observeAdmissionLive('g', event);
    b.observeAdmissionLive('g', event);
    assert.equal(b.conversationBuffer.entries.length, 1);
    assert.equal(b.didParticipantResumeSince('g', 0), true);
    const old = utterance('Another uncertain question?', weak, Date.now() - 2000);
    await b.handleParticipantUtterance('g', old);
    b.observeAdmissionLive('g', { ...event, text: 'Another uncertain question?',
        audioStartedAt: Date.parse(old.speechStartedAt), audioEndedAt: Date.parse(old.speechEndedAt) });
    assert.equal(b.conversationBuffer.entries.length, 1);
    b.isRecordingActive = () => false;
    b.observeAdmissionLive('g', event);
    assert.equal(b.conversationBuffer.entries.length, 1);
});

test('other guests and newer speech remain authoritative when older uncertain audio resolves', async () => {
    const b = bot(), old = utterance('uncertain words here', weak, Date.now() - 2000);
    const correction = { ...utterance('Actually change that'), userId: 'b' };
    acoustic(b, old); acoustic(b, correction);
    await b.handleParticipantUtterance('g', correction);
    await b.handleParticipantUtterance('g', old);
    assert.equal(b.didParticipantResumeSince('g', 0), true);
});

test('experimental mode retains its existing admission and turn policy', async () => {
    const b = bot(), u = utterance('weak but existing behavior', weak);
    b.sessionHostModes = new Map([['g', 'live-alpha']]);
    await b.handleParticipantUtterance('g', u);
    assert.equal(u.admission, undefined);
    assert.equal(b.conversationBuffer.entries.length, 1);
    assert.equal(b.didParticipantResumeSince('g', 0), true);
});

test('VoiceManager waits for admission before saving and publishing transcript context', async () => {
    const { VoiceManager } = require('./voice-manager');
    const v = Object.create(VoiceManager.prototype), u = utterance('uncertain text', weak);
    let finish, saved;
    v.isRecording = new Map([['g', true]]);
    v.onUtterance = async () => { await new Promise(r => { finish = r; }); u.transcription = ''; };
    v.saveTranscriptEntry = (_, value) => { saved = value.transcription; };
    const handling = v.handleUtterance('g', u);
    assert.equal(saved, undefined);
    finish(); await handling;
    assert.equal(saved, '');
});

test('endpoint padding cannot erase a genuine short acknowledgment', () => {
    const e = { voicedMs: 80, maxRunMs: 80, speechSpanMs: 80, audioDurationMs: 2300 };
    assert.equal(assess(utterance('yeah', e)).status, 'accepted');
});

test('closing the admission session releases a parked answer and makes it stale', async () => {
    const b = bot(), u = utterance('still processing');
    acoustic(b, u);
    const options = { participantActivityBaseline: 0 };
    const waiting = b.waitForAdmittedParticipantFloor('g', options);
    b.getConversationAdmission('g').close();
    await waiting;
    assert.equal(b.discardStaleDirectResponse('g', options), true);
});

test('candidate retention drops PCM and completed host playback prevents an obsolete promotion', async () => {
    const b = bot(), u = { ...utterance('Can you explain?', weak), audioBuffer: Buffer.alloc(100) };
    await b.handleParticipantUtterance('g', u);
    assert.equal([...b.getConversationAdmission('g').candidates.values()][0].audioBuffer, undefined);
    b.hostPlaybackState = new Map([['g', { startedAt: Date.now() }]]);
    b.observeAdmissionLive('g', { text: 'Can you explain?', audioStartedAt: Date.parse(u.speechStartedAt),
        audioEndedAt: Date.parse(u.speechEndedAt) });
    assert.equal(b.conversationBuffer.entries.length, 0);
});

test('receiver evidence reaches admission before speaker history; accepted speech still records normally', async () => {
    const { AudioReceiver } = require('./audio-receiver');
    for (const supported of [false, true]) {
        const b = bot();
        let observed;
        const r = new AudioReceiver({
            stt: { transcribe: async () => ({ text: 'Alpha, explain that result.', confidence: 0.8 }) },
            onUtterance: async u => { observed = u; await b.handleParticipantUtterance('g', u); },
            onError: e => { throw e; }
        });
        const start = Date.now() - 2000;
        await r.processUtteranceSnapshot({
            userId: 'a', speakerInfo: { name: 'Guest', role: 'guest' },
            audioBuffer: Buffer.alloc(384000), startTime: start, duration: 2000, timestamp: at(start),
            speechStartedAt: at(start), speechEndedAt: at(start + (supported ? 800 : 20)),
            speechDuration: supported ? 800 : 20,
            detectorStats: { speakingFrames: supported ? 40 : 1, maxSpeakingRunFrames: supported ? 20 : 1,
                totalFrames: 100 }
        });
        assert.equal(observed.admission.status, supported ? 'accepted' : 'candidate');
        assert.equal(observed.acousticEvidence.maxRunMs, supported ? 400 : 20);
        assert.equal(r.speakerTracker.history.length, supported ? 1 : 0);
        assert.equal(b.conversationBuffer.entries.length, supported ? 1 : 0);
    }
});
