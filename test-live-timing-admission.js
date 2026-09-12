const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LiveTranscriptClock } = require('./live-transcript-clock');
const { ConversationAdmission } = require('./conversation-admission');
const { AlphaClawdVoiceBot } = require('./bot');
const { VoiceManager } = require('./voice-manager');

test('session timing follows a thirty-minute drifting stream and retains delayed intervals', () => {
    const clock = new LiveTranscriptClock();
    const origin = 1700000000000;
    for (let end = 200; end <= 1800000; end += 200) {
        const arrival = origin + end * 1.03 + (end % 1000 === 0 ? 600 : 0);
        const m = clock.map(end - 200, end, arrival);
        assert.equal(m.timing.status, 'estimated');
        assert.ok(Math.abs(m.audioEndedAt - (origin + end * 1.03)) <= 310);
    }
    const before = clock.frontier;
    const delayed = clock.map(1797800, 1798000, origin + 1800000 * 1.03 + 500);
    assert.equal(clock.frontier, before);
    assert.ok(delayed.audioEndedAt < origin + 1799000 * 1.03);
    assert.equal(clock.map(0, 200, origin + 1800000 * 1.03).timing.status, 'unavailable');
    assert.equal(clock.map(NaN, 200).timing.status, 'unavailable');
});

test('delivery jitter does not drag a delayed fragment into the current turn', () => {
    const clock = new LiveTranscriptClock();
    clock.map(0, 200, 10200);
    clock.map(200, 400, 10400);
    const late = clock.map(100, 200, 12200);
    assert.equal(late.audioEndedAt, 10200);
    assert.equal(clock.map(100, 200, 18000).timing.status, 'unavailable');
    assert.equal(clock.map(400, 600, 10600).audioEndedAt, 10600);
});

test('idle time starts after Alpha playback and uses the existing check interval', () => {
    const bot = Object.create(AlphaClawdVoiceBot.prototype);
    const now = Date.now();
    bot.lastParticipantSpeechAt = new Map([['g', now - 21000]]);
    bot.hostPlaybackState = new Map([['g', { endedAt: now - 570 }]]);
    bot.idleDecisionIntervalMs = 5000;
    bot.isLiveAlphaSession = () => false;
    bot.useGatewayGenerator = () => false;
    bot.isRecordingActive = () => true;
    bot.directResponseInFlight = new Set();
    bot.conversationBuffer = { getState: () => ({ state: 'IDLE', utteranceCount: 0, activeSpeakerCount: 0, pendingAsrCount: 0 }) };
    bot.voiceManager = { getPlaybackStatus: () => ({ isPlaying: false, queueLength: 0 }) };
    assert.equal(bot.getIdleStartedAt('g'), now - 570);
    assert.equal(bot.canRunIdleDecision('g'), false);
    bot.hostPlaybackState.get('g').endedAt = now - 5100;
    assert.equal(bot.canRunIdleDecision('g'), true);
    bot.lastParticipantSpeechAt.set('g', now - 100);
    assert.equal(bot.getIdleStartedAt('g'), now - 100);
});

test('withheld and promoted admission records survive without phantom markers or audio buffers', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'admission-test-'));
    try {
        const vm = Object.create(VoiceManager.prototype);
        vm.recordingPaths = new Map([['g', dir]]);
        vm.transcriptSaveStops = new Map();
        vm.observeQuartzTranscript = () => {};
        const raw = 'The name of the gym is Cliffs of Id.';
        vm.saveTranscriptEntry('g', { transcription: '', rawTranscription: raw,
            admission: { id: 'same', status: 'candidate', effect: 'none' }, audioBuffer: Buffer.alloc(1000) });
        vm.saveTranscriptEntry('g', { transcription: raw, rawTranscription: raw,
            admission: { id: 'same', status: 'accepted' }, source: 'admission_promotion' });
        const rows = fs.readFileSync(path.join(dir, 'transcript.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
        assert.equal(rows.length, 2);
        assert.equal(rows[0].text, '');
        assert.equal(rows[0].rawTranscription, raw);
        assert.equal(rows[0].admission.id, rows[1].admission.id);
        assert.ok(rows.every(r => !('audioBuffer' in r)));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('recorded gym correction is corroborated after the final Live fragment', () => {
 const fragments = [{"text": " Hmm", "startMs": 916600, "endMs": 916800, "observedAt": "2026-09-12T18:23:46.496Z"}, {"text": " The", "startMs": 918000, "endMs": 918200, "observedAt": "2026-09-12T18:23:47.948Z"}, {"text": " the", "startMs": 918200, "endMs": 918400, "observedAt": "2026-09-12T18:23:48.136Z"}, {"text": " name", "startMs": 918400, "endMs": 918600, "observedAt": "2026-09-12T18:23:48.343Z"}, {"text": " of the", "startMs": 918600, "endMs": 918800, "observedAt": "2026-09-12T18:23:48.542Z"}, {"text": " gym", "startMs": 918800, "endMs": 919000, "observedAt": "2026-09-12T18:23:48.753Z"}, {"text": " is", "startMs": 919000, "endMs": 919200, "observedAt": "2026-09-12T18:23:48.917Z"}, {"text": " Cliffs", "startMs": 919800, "endMs": 920000, "observedAt": "2026-09-12T18:23:49.736Z"}, {"text": ". Of", "startMs": 920400, "endMs": 920600, "observedAt": "2026-09-12T18:23:50.315Z"}, {"text": " Id", "startMs": 921000, "endMs": 921200, "observedAt": "2026-09-12T18:23:50.931Z"}];
 const clock = new LiveTranscriptClock(), policy = new ConversationAdmission();
 const start = Date.parse('2026-09-12T18:23:46.766Z');
 const u = { userId: 'g', transcription: 'The name of the gym is Cliffs of Id.',
     speechStartedAt: new Date(start).toISOString(), speechEndedAt: '2026-09-12T18:23:50.022Z',
     asrStartedAt: '2026-09-12T18:23:50.633Z', asrCompletedAt: '2026-09-12T18:23:50.920Z',
     acousticEvidence: { voicedMs: 2100, maxRunMs: 400, speechSpanMs: 3276 } };
 policy.recent.set('g', { transcription: '嗯，呃。' });
 for (const e of fragments) {
     const mapped = { ...e, ...clock.map(e.startMs, e.endMs, Date.parse(e.observedAt)) };
     policy.observeLive(mapped);
 }
 const result = policy.evaluate(u);
 assert.equal(result.status, 'accepted');
 assert.equal(result.evidence.corroborationRequired, true);
 assert.equal(result.evidence.liveMatchScore, 1);
});

test('a long delivery stall cannot reanchor old speech to the present', () => {
    const clock = new LiveTranscriptClock();
    clock.map(0, 200, 10200);
    assert.equal(clock.map(20000, 20200, 60200).timing.status, 'unavailable');
    assert.equal(clock.map(50000, 50200, 60200).audioEndedAt, 60200);
});
