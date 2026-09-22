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
        manager.recordingMetadata = new Map();
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

for (const pauseAt of ['synthesis', 'playback']) {
    test('last-human hangup during ' + pauseAt + ' retains final thought and blocks new turns', async t => {
        const { b } = harness();
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'finish-thought-'));
        t.after(() => fs.rmSync(root, { recursive: true, force: true }));
        const dir = path.join(root, 'episode-2026-09-22T01-00-00-000Z'); fs.mkdirSync(dir);
        const vm = Object.create(VoiceManager.prototype), events = [];
        Object.assign(vm, {
            recordingPaths: new Map([['g', dir]]), transcriptSaveStops: new Map(), recordingMetadata: new Map(),
            observeQuartzTranscript() {}, isConnected: () => true,
            transmitters: new Map([['g', { stop() { assert.fail('Must not cut off final thought'); } }]]),
            async stopRecording() {
                events.push('recording-stop');
                const rows = fs.readFileSync(path.join(dir, 'transcript.jsonl'), 'utf8');
                assert.match(rows, /That is what was synthesized/);
                fs.writeFileSync(path.join(dir, 'episode-complete.json'),
                    JSON.stringify({ guildId: 'g', stoppedAt: timing.playbackEndedAt }));
                return { recordingPath: dir };
            },
            async leaveChannel() { events.push('disconnect'); }
        });
        fs.writeFileSync(path.join(dir, 'resume-identity.json'), JSON.stringify({ ownerId: 'u', guildId: 'g' }));
        Object.assign(b, {
            voiceManager: vm, recordingState: new Map([['g', 'RECORDING']]),
            RecordingState: { RECORDING: 'RECORDING', STOPPING: 'STOPPING' },
            recordingTextChannels: new Map(), consentWaiters: new Map(), sessionHostModes: new Map(),
            discordContextProcessing: new Map(), disabledCronJobs: [], episodePlanTrackers: new Map(),
            stopIdleDecisionLoop(g, options) { events.push(options?.preserveInFlight ? 'new-turns-stop' : 'idle-stop'); },
            async stopGeminiLiveSession() {}, async endInternalThoughtSession() {},
            saveEpisodePlanProgress: AlphaClawdVoiceBot.prototype.saveEpisodePlanProgress,
            applyEpisodePlanResponse: AlphaClawdVoiceBot.prototype.applyEpisodePlanResponse,
            podcastGenerator: { rememberAssistantResponse() {}, endSession() { events.push('generator-stop'); } }
        });
        b.startEpisodePlanTracker('g', { plan: { basename: 'la-no-car', version: 'v001',
            phases: { developing: { angles: ['Van'] } } } }, { recordingPath: dir });
        fs.writeFileSync(path.join(dir, 'episode-plan.json'), JSON.stringify(b.episodePlanTrackers.get('g').plan));
        // Keep the final response's real delivery/persistence code; replace only providers.
        let release, entered;
        const enteredPromise = new Promise(r => entered = r);
        const gate = new Promise(r => release = r);
        const original = pauseAt === 'synthesis' ? b.synthesizeLiveTTS : b.playTtsAndRecord;
        b[pauseAt === 'synthesis' ? 'synthesizeLiveTTS' : 'playTtsAndRecord'] = async function (...args) {
            entered(); await gate; return original.apply(this, args);
        };
        const r = response();
        r.completed = Promise.resolve({ shouldRespond: true, speech: 'Generator final text.',
            chosenAngle: 'van', podcastLeave: { requested: true, reason: 'done' } });
        const turn = b.speakDirectGeneratorResponse('g', r, opts);
        await enteredPromise;
        const leaving = b.leavePodcastSession('g', { reason: 'last_participant_left' });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(b.recordingState.get('g'), 'RECORDING');
        assert.equal(vm.isTranscriptSavingStopped('g'), false);
        assert(!events.includes('recording-stop'));
        assert.deepEqual(await b.handleDirectGeneratorFlush('g', [], 'new turn', null), { played: false });
        assert.deepEqual(await b.handleIdleDecisionTick('g'), { played: false });
        assert.equal((await b.dispatchBigBrainTurn('g', { bigBrain: { requested: true } })).reason, 'session_ending');
        release();
        await turn; await leaving;
        assert.equal(events.at(-1), 'disconnect');
        assert(events.indexOf('new-turns-stop') < events.indexOf('recording-stop'));
        const source = require('./podcast-resume').loadResumeSource(root, null, 'u', 'g');
        assert.equal(source.entries.at(-1).text, 'That is what was synthesized.');
        assert.equal(source.entries.at(-1).playbackStatus, 'completed');
        assert.equal(source.planProgress.state.lastChosenAngle, 'van');
        assert.equal(b.activeHostTurns.size, 0);
    });
}

const { ConversationBuffer } = require('./conversation-buffer');
const { PodcastGenerator } = require('./podcast-generator');

for (const chooseSilence of [false, true]) {
    test('real hangup path releases parked answer, drains final ASR, and records final choice: ' + chooseSilence,
        { timeout: 5000 }, async () => {
        const { b, entries } = harness();
        const events = [], inputs = [];
        const cb = new ConversationBuffer();
        const finalWords = { userId: 'u', speaker: 'Jensen', transcription: 'My final words.',
            speechStartedAt: new Date().toISOString() };
        const oldWords = { userId: 'u', speaker: 'Jensen', transcription: 'Earlier words.' };
        const promptGenerator = new PodcastGenerator();
        Object.assign(b, {
            recordingState: new Map([['g', 'RECORDING']]),
            RecordingState: { RECORDING: 'RECORDING', STOPPING: 'STOPPING' },
            recordingTextChannels: new Map(), consentWaiters: new Map(), sessionHostModes: new Map(),
            discordContextProcessing: new Map(), disabledCronJobs: [],
            conversationBuffer: cb,
            conversationAdmissions: new Map(),
            participantAcousticActivity: new Map([['g', new Map([['["u",1]', [1]]])]]),
            participantActivityVersion: new Map([['g', 1]]),
            participantSignalStates: new Map(),
            useGatewayGenerator: () => false, isGeminiLiveSession: () => false, isLiveAlphaSession: () => false,
            isRecordingActive: () => b.recordingState.get('g') === 'RECORDING',
            waitForParticipantFloorToSettle: AlphaClawdVoiceBot.prototype.waitForParticipantFloorToSettle,
            preserveDirectResponseWhileUncertain: AlphaClawdVoiceBot.prototype.preserveDirectResponseWhileUncertain,
            discardStaleDirectResponse: AlphaClawdVoiceBot.prototype.discardStaleDirectResponse,
            getParticipantActivityConfirmDelayMs: () => 0,
            getPendingUnconfirmedParticipantSignals: () => [],
            getParticipantSignalProfile: () => ({ getPrePlaybackEvidenceWaitMs: () => 150 }),
            buildGeneratorTurnIdIntent: () => null,
            getAwarenessInjectionsForGeneratorTurn: async () => [],
            getGeneratorCallTiming: () => ({}),
            getAwarenessShelfItemsForGenerator: () => [],
            getEpisodePlanStructureForGenerator: () => '',
            getStagedBigBrainForGenerator: () => [], getPendingBigBrainForGenerator: () => [],
            getStagedBigHeartForGenerator: () => [], getPendingBigHeartForGenerator: () => [],
            getRecentInternalThoughtsForGenerator: () => [],
            getConsecutiveGeneratorSilences: () => 0,
            hasPendingBigBrain: () => false, hasPendingBigHeart: () => false,
            shouldSuppressDuplicateBigBrainStall: () => false, shouldSuppressDuplicateBigHeartStall: () => false,
            consumeStagedBigBrainFromResponse() {}, consumeStagedBigHeartFromResponse() {},
            recordGeneratorSilence() { events.push('silence'); },
            stopIdleDecisionLoop() {}, stopGeminiLiveSession: async () => {},
            saveEpisodePlanProgress() {}, endEpisodePlanTracker() {}, endInternalThoughtSession: async () => {},
            podcastGenerator: {
                supportsStreaming: () => false,
                async generate(input) {
                    inputs.push(input);
                    assert.equal(events.includes('asr-drained'), true);
                    const prompt = promptGenerator.buildUserPrompt(input.transcript, null, input);
                    assert.match(prompt, /No human participants remain/);
                    assert.match(prompt, /My final words/);
                    assert.match(prompt, /Earlier words/);
                    assert.match(prompt, /choose silence/);
                    return { shouldRespond: !chooseSilence, speech: chooseSilence ? '' : 'A final thought for the recording.' };
                },
                rememberTurn() {}, endSession() { events.push('session-ended'); }
            }
        });
        Object.assign(b.voiceManager, {
            isConnected: () => true,
            receivers: new Map([['g', {
                async flushAll() { await new Promise(r => setTimeout(r, 10)); cb.addUtterance(finalWords); events.push('asr-drained'); },
                cleanupUser() { assert(events.includes('asr-drained')); events.push('receiver-cleaned'); }
            }]]),
            stopTranscriptSaving() { events.push('transcript-stopped'); },
            async stopRecording() { events.push('recording-stopped'); return {}; },
            async leaveChannel() { events.push('left'); }
        });
        const playback = b.playTtsAndRecord;
        b.playTtsAndRecord = async function(g, audio, options) {
            await options.preparePlaybackStart();
            assert.equal(options.shouldAbortPlaybackStart(), false);
            events.push('played');
            return playback.call(this, g, audio, options);
        };
        const oldTurn = b.speakDirectGeneratorResponse('g', { shouldRespond: true, speech: 'Stale prepared answer.' },
            { playFiller: false, participantActivityBaseline: 0, flushedUtterances: [oldWords] });
        await new Promise(r => setTimeout(r, 35));
        assert.equal(entries.length, 0, 'answer must really be parked before hangup');
        const leaving = b.leavePodcastSession('g', { reason: 'last_participant_left', userId: 'u' });
        assert.equal(leaving, b.leavePodcastSession('g', { reason: 'slash_command' }));
        await leaving;
        assert.equal((await oldTurn).stale, true);
        assert.equal(inputs.length, 1);
        assert.equal(inputs[0].participantPresence.humansPresent, 0);
        assert.equal(entries.length, chooseSilence ? 0 : 1);
        if (!chooseSilence) assert.equal(entries[0].transcription, 'A final thought for the recording.');
        assert(events.indexOf(chooseSilence ? 'silence' : 'played') < events.indexOf('transcript-stopped'));
        assert.equal(events.at(-1), 'left');
        assert.equal(b.activeHostTurns.size, 0);
        assert.equal(b.participantDepartures.size, 0);
        cb.clear();
    });
}

test('expired Discord acknowledgement still executes leave exactly once', async () => {
    const b = Object.create(AlphaClawdVoiceBot.prototype);
    let leaves = 0;
    b.leavePodcastSession = async (guild, opts) => {
        assert.equal(guild, 'g'); assert.equal(opts.reason, 'slash_command'); leaves++; return { message: 'done' };
    };
    await b.handleLeaveCommand({
        guildId: 'g',
        async deferReply() { throw Object.assign(new Error('Unknown interaction'), { code: 10062 }); },
        async editReply() { assert.fail('Expired interaction cannot be edited'); }
    });
    assert.equal(leaves, 1);
});
