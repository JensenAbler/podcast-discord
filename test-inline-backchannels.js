const test = require('node:test');
const assert = require('node:assert/strict');
const { PlayedBackchannelTranscript } = require('./played-backchannel-transcript');
const { PodcastGenerator } = require('./podcast-generator');
function fixture() {
    let now = 10000;
    const entries = [];
    const tracker = new PlayedBackchannelTranscript(e => entries.push(e), { now: () => now });
    return { entries, tracker, settle() { now += 600; tracker.flush(); } };
}
const part = (text, startMs, endMs, sessionId = 's') => ({ text, startMs, endMs, sessionId });
test('joins played text fragments, handles late text and deduplicates', () => {
    const f = fixture();
    f.tracker.consume(part('', 0, 400), 1000);
    f.tracker.transcript(part(' Mm-h', 0, 200));
    f.tracker.transcript(part('mm.', 200, 400));
    f.tracker.transcript(part('mm.', 200, 400));
    f.settle();
    assert.equal(f.entries.length, 1);
    assert.equal(f.entries[0].transcription, 'Mm-hmm.');
    assert.equal(f.entries[0].playbackStatus, 'completed');
    f.tracker.close();
});
test('generated text never counts as playback, even if text arrived unmuted', () => {
    const f = fixture();
    f.tracker.transcript({ ...part(' Okay.', 0, 200), playbackBlocked: false });
    f.tracker.close();
    assert.equal(f.entries[0].transcription, '');
    assert.equal(f.entries[0].playbackStatus, 'not_started');
});
test('text received while muted can describe earlier successfully played audio', () => {
    const f = fixture();
    f.tracker.consume(part('', 0, 200));
    f.tracker.transcript({ ...part(' Mm.', 0, 200), playbackBlocked: true });
    f.settle();
    assert.equal(f.entries[0].transcription, 'Mm.');
    f.tracker.close();
});
test('partial playback quotes only a fully covered prefix and preserves generated text separately', () => {
    const f = fixture();
    f.tracker.consume(part('', 0, 250));
    f.tracker.transcript(part('Still', 0, 200));
    f.tracker.transcript(part(' thinking.', 200, 400));
    f.tracker.close();
    assert.equal(f.entries[0].transcription, 'Still…');
    assert.equal(f.entries[0].generatedTranscription, 'Still thinking.');
    assert.equal(f.entries[0].playbackStatus, 'incomplete');
});
test('a hole in consumed PCM or different session is not complete coverage', () => {
    for (const otherSession of [false, true]) {
        const f = fixture();
        f.tracker.consume(part('', 0, 100));
        f.tracker.consume(part('', otherSession ? 100 : 150, 200, otherSession ? 'other' : 's'));
        f.tracker.transcript(part('Okay.', 0, 200));
        f.tracker.close();
        assert.equal(f.entries[0].transcription, '');
        assert.equal(f.entries[0].playbackStatus, 'incomplete');
    }
});
test('text before playback waits for consumption', () => {
    const f = fixture();
    f.tracker.transcript(part('Mm.', 0, 200));
    f.settle();
    assert.equal(f.entries.length, 0);
    f.tracker.consume(part('', 0, 200));
    assert.equal(f.entries[0].transcription, 'Mm.');
    f.tracker.close();
});
function entry(speaker, text, ms, source) {
    return { speaker, transcription: text, speechStartedAt: new Date(ms).toISOString(),
        speechEndedAt: new Date(ms + 200).toISOString(), source };
}
test('latest-episode regression: acknowledgment is inline before the guest asks about it', () => {
    const g = new PodcastGenerator({ apiKey: 'fixture' });
    const first = entry('Jensen', 'Testing the prompt.', 1000);
    const question = entry('Jensen', 'You said hmm okay?', 3000);
    g.observeSpokenTranscript(first);
    g.observeSpokenTranscript(question); // ASR and output text can arrive out of order
    g.observeSpokenTranscript(entry('Alpha-Clawd', 'Mm. Okay.', 2000, 'quartz'));
    g.rememberTurn('Jensen: Testing the prompt.', { shouldRespond: false });
    const messages = g.buildMessages({ utterances: [question] });
    const content = messages.find(m => m.role === 'user').content;
    assert.ok(content.indexOf('Testing the prompt.') < content.indexOf('Alpha-Clawd: Mm. Okay.'));
    assert.ok(content.indexOf('Alpha-Clawd: Mm. Okay.') < content.indexOf('You said hmm okay?'));
    assert.equal(content.match(/You said hmm okay/g).length, 1);
    assert.doesNotMatch(content, /Quartz|quartz|playbackStatus|chose silence|output-pcm/);
    assert.equal(messages.filter(m => m.role === 'assistant').length, 0);
    const unchanged = JSON.stringify(messages);
    g.observeSpokenTranscript(entry('Alpha-Clawd', 'Mm.', 4000, 'quartz'));
    assert.equal(JSON.stringify(messages), unchanged, 'in-flight snapshot stays immutable');
    assert.match(g.buildMessages({ utterances: [] }).find(m => m.role === 'user').content, /Alpha-Clawd: Mm\./);
});
test('passive transcript does not alter history, cooldown directives, or retain failed output', () => {
    const g = new PodcastGenerator({ apiKey: 'fixture' });
    g.questionMoratoriumTurns = 3;
    g.observeSpokenTranscript({ ...entry('Alpha-Clawd', 'Never played', 1, 'quartz'), playbackStatus: 'not_started' });
    g.observeSpokenTranscript({ ...entry('Jensen', 'anomaly', 2), admission: { status: 'candidate' } });
    assert.equal(g.spokenTranscript.length, 0);
    g.observeSpokenTranscript(entry('Alpha-Clawd', 'Mm.', 3, 'quartz'));
    assert.equal(g.history.length, 0);
    assert.equal(g.questionMoratoriumTurns, 3);
    g.endSession();
    assert.equal(g.spokenTranscript.length, 0);
    assert.equal(g.hasBackchannels, false);
});

test('saved backchannel reaches the shared transcript without reentering Live or guest scheduling', () => {
    const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
    const { VoiceManager } = require('./voice-manager');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backchannel-transcript-'));
    const g = new PodcastGenerator({ apiKey: 'fixture' });
    const vm = {
        recordingPaths: new Map([['g', dir]]), transcriptSaveStops: new Map(),
        quartzBackchannels: new Map([['g', { client: { started: true },
            appendConversation() { assert.fail('must not echo Live output back to Live'); } }]]),
        observeQuartzTranscript: VoiceManager.prototype.observeQuartzTranscript,
        onSavedTranscript: (_guild, e) => g.observeSpokenTranscript(e)
    };
    try {
        const e = { ...entry('Alpha-Clawd', 'Mm. Okay.', 2000, 'quartz'),
            playbackStatus: 'completed', backchannelEvidence: { method: 'output-pcm-consumption' } };
        VoiceManager.prototype.saveTranscriptEntry.call(vm, 'g', e);
        const saved = JSON.parse(fs.readFileSync(path.join(dir, 'transcript.jsonl'), 'utf8').trim());
        assert.equal(saved.text, 'Mm. Okay.');
        assert.equal(saved.speaker, 'Alpha-Clawd');
        assert.equal(saved.backchannelEvidence.method, 'output-pcm-consumption');
        assert.equal(g.spokenTranscript.length, 1);
        assert.equal(g.history.length, 0);
        assert.doesNotMatch(g.buildMessages({}).find(m => m.role === 'user').content, /output-pcm|quartz/i);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('receipt correlation tolerates text/PCM clock drift and waits for queued playback', () => {
    let now = 100000;
    const entries = [];
    const t = new PlayedBackchannelTranscript(e => entries.push(e), { now: () => now });
    const audio = { startMs: 290000, endMs: 290200, sessionId: 's', receivedAt: 100200 };
    const text = { ...part('Okay.', 292000, 292200), correlation: 'receipt',
        audioStartedAt: 100000, audioEndedAt: 100200 };
    t.receive(Buffer.alloc(6400, 50), audio);
    t.transcript(text);
    now += 1000; t.flush();
    assert.equal(entries.length, 0, 'queued audio is unresolved, not absent');
    t.consume(audio, 101000);
    assert.equal(entries[0].transcription, 'Okay.');
    assert.equal(entries[0].playbackStartedAt, new Date(101000).toISOString());
    assert.equal(entries[0].backchannelEvidence.timingStatus, 'estimated');
    t.close();
});
test('receipt correlation excludes silence, muted speech and incomplete vocalizations', () => {
    for (const kind of ['silence', 'muted', 'partial']) {
        let now = 100000; const entries = [];
        const t = new PlayedBackchannelTranscript(e => entries.push(e), { now: () => now });
        const audio = { startMs: 290000, endMs: 290200, sessionId: 's', receivedAt: 100200, blocked: kind === 'muted' };
        t.receive(Buffer.alloc(6400, kind === 'silence' ? 0 : 50), audio);
        if (kind === 'silence') t.consume(audio);
        if (kind === 'partial') {
            t.consume({ ...audio, endMs: 290100 });
            t.discard({ ...audio, startMs: 290100 });
        }
        t.transcript({ ...part('Okay.', 292000, 292200), correlation: 'receipt',
            audioStartedAt: 100000, audioEndedAt: 100200 });
        now += 1000; t.flush();
        assert.equal(entries[0].transcription, '', kind);
        assert.equal(entries[0].playbackStatus, kind === 'partial' ? 'incomplete' : 'not_started');
        t.close();
    }
});
