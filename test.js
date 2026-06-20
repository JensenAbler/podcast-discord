/**
 * Smoke tests for Alpha-Clawd Voice Host.
 *
 * Run: node test.js
 */

const {
    SilenceDetector,
    SpeakerTracker,
    AudioReceiver,
    VoiceManager,
    FishAudioProvider,
    downmixStereo48kToMono16k,
    GatewayBridge,
    PodcastGenerator,
    BigHeartGenerator,
    InternalThoughtGenerator,
    DiscernmentGenerator,
    InternalThoughtManager,
    ShowRunnerGenerator,
    ShowRunnerManager,
    EpisodePlanStore,
    EpisodePlanTracker,
    PacketizationBuffer,
    BigBrainAwarenessSelector,
    ParticipantSignalProfile,
    AwarenessShelf,
    RealtimePcmMixer,
    GeminiLiveHost,
    upsampleMono24kToStereo48k,
    EpisodeTranscriptStore,
    createEpisodeTranscriptServer,
    buildTurnIdIntent,
    AudioTransmitter,
    AlphaClawdVoiceBot
} = require('./index');
const { EndBehaviorType, AudioPlayerStatus } = require('@discordjs/voice');
const { ConversationBuffer, BufferState } = require('./conversation-buffer');
const { GatewayWsClient, verifyDeviceSignature } = require('./gateway-ws-client');
const { EpisodePostProcessor } = require('./post-processor');
const { resolveFrontierConfig } = require('./introspection-frontier');
const {
    getContractRecordingDir,
    getRecordingDir,
    isLegacyEpisodesRecordingDir
} = require('./paths');
const {
    PromptEvalRunner,
    parseArgs,
    scoreDeterministic,
    validateFixture
} = require('./prompt-eval');
const { PassThrough } = require('stream');
const { EventEmitter } = require('events');
const msgpack = require('msgpack-lite');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function createSpeechPcm(durationMs = 200) {
    const sampleRate = 48000;
    const channels = 2;
    const bytesPerSample = 2;
    const sampleCount = Math.floor(sampleRate * (durationMs / 1000)) * channels;
    const buffer = Buffer.alloc(sampleCount * bytesPerSample);

    for (let offset = 0; offset < buffer.length; offset += bytesPerSample) {
        buffer.writeInt16LE(1200, offset);
    }

    return buffer;
}

async function runTests() {
    console.log('Running Alpha-Clawd Voice Host smoke tests\n');

    let passed = 0;
    let failed = 0;

    console.log('Test 1: Silence Detector');
    try {
        const detector = new SilenceDetector();
        if (detector) {
            console.log('  Silence detector initializes');
            passed++;
        }
    } catch (error) {
        console.log(`  Silence detector failed: ${error.message}`);
        failed++;
    }

    console.log('\nTest 1b: Participant Signal Profile');
    try {
        const profile = new ParticipantSignalProfile({ windowSize: 30 });

        for (let i = 0; i < 8; i++) {
            profile.recordSignal({
                type: 'vad_discarded',
                speakingFrames: 0,
                duringHostPlayback: i % 2 === 0,
                nearHostPlaybackStart: i % 2 === 0
            });
        }
        for (let i = 0; i < 2; i++) {
            profile.recordSignal({ type: 'real_transcript', speakingFrames: 12 });
        }

        const noisy = profile.getSnapshot();
        if (noisy.strictnessLevel < 2 || noisy.vadNoiseScore <= 0.5) {
            throw new Error(`Expected noisy profile to become stricter: ${JSON.stringify(noisy)}`);
        }
        if (profile.getSpeechEvidenceFrameThreshold({ duringHostPlayback: true }) < 4) {
            throw new Error('Host-playback speech-evidence threshold did not rise');
        }

        for (let i = 0; i < 30; i++) {
            profile.recordSignal({ type: 'real_transcript', speakingFrames: 20 });
        }

        const recovered = profile.getSnapshot();
        if (recovered.strictnessLevel !== 0 || recovered.vadNoiseScore !== 0) {
            throw new Error(`Profile did not adapt back down after clean signals: ${JSON.stringify(recovered)}`);
        }

        const phantomProfile = new ParticipantSignalProfile({ windowSize: 30 });
        phantomProfile.recordSignal({ type: 'phantom_utterance', duringHostPlayback: true });
        phantomProfile.recordSignal({ type: 'empty_asr', duringHostPlayback: true });
        phantomProfile.recordSignal({ type: 'real_transcript' });
        if (phantomProfile.getAsrCandidateFrameThreshold({ duringHostPlayback: true }) < 2) {
            throw new Error(`Phantom profile did not gently raise ASR threshold: ${JSON.stringify(phantomProfile.getSnapshot())}`);
        }

        console.log('  Participant signal profile tracks VAD noise, phantoms, echo, and adapts both ways');
        passed++;
    } catch (error) {
        console.log(`  Participant signal profile failed: ${error.message}`);
        failed++;
    }

    console.log('\nTest 1c: Gemini Live PCM conversion and participant mixing');
    try {
        const mono24k = Buffer.alloc(4);
        mono24k.writeInt16LE(1000, 0);
        mono24k.writeInt16LE(-1000, 2);
        const converted = upsampleMono24kToStereo48k(mono24k);
        const expectedSamples = [1000, 1000, 1000, 1000, -1000, -1000, -1000, -1000];
        const actualSamples = [];
        for (let offset = 0; offset < converted.audio.length; offset += 2) {
            actualSamples.push(converted.audio.readInt16LE(offset));
        }
        if (JSON.stringify(actualSamples) !== JSON.stringify(expectedSamples)) {
            throw new Error(`Unexpected Gemini output conversion: ${JSON.stringify(actualSamples)}`);
        }

        let mixedFrame = null;
        const mixer = new RealtimePcmMixer({
            onFrame: (frame) => {
                mixedFrame = frame;
            }
        });
        const positive = createSpeechPcm(20);
        const negative = Buffer.alloc(positive.length);
        for (let offset = 0; offset < negative.length; offset += 2) {
            negative.writeInt16LE(-600, offset);
        }
        mixer.push('speaker-a', positive);
        mixer.push('speaker-b', negative);
        mixer.emitFrame();

        if (!mixedFrame || mixedFrame.length !== 640) {
            throw new Error(`Expected one 20ms 16 kHz frame, got ${mixedFrame?.length || 0} bytes`);
        }
        if (mixedFrame.readInt16LE(0) !== 300) {
            throw new Error(`Expected mixed sample 300, got ${mixedFrame.readInt16LE(0)}`);
        }

        console.log('  Gemini PCM resampling and concurrent participant mixing preserve frame shape');
        passed++;
    } catch (error) {
        console.log(`  Gemini PCM conversion/mixing failed: ${error.message}`);
        failed++;
    }

    console.log('\nTest 1d: Gemini Live session config and streamed turn lifecycle');
    try {
        let connectParams = null;
        const realtimeInputs = [];
        let closed = false;
        const fakeSession = {
            sendRealtimeInput: (input) => realtimeInputs.push(input),
            close: () => {
                closed = true;
            }
        };
        const fakeClient = {
            live: {
                connect: async (params) => {
                    connectParams = params;
                    params.callbacks.onopen();
                    return fakeSession;
                }
            }
        };

        let streamBytes = Buffer.alloc(0);
        let completedTurn = null;
        const host = new GeminiLiveHost({
            apiKey: 'test-key',
            client: fakeClient,
            systemInstruction: 'Test live host',
            onAudioStream: ({ stream }) => {
                stream.on('data', (chunk) => {
                    streamBytes = Buffer.concat([streamBytes, chunk]);
                });
            },
            onTurnComplete: (turn) => {
                completedTurn = turn;
            }
        });

        await host.start();
        if (connectParams.config.realtimeInputConfig.activityHandling !== 'NO_INTERRUPTION') {
            throw new Error('Gemini Live did not disable barge-in');
        }
        const automaticActivityDetection =
            connectParams.config.realtimeInputConfig.automaticActivityDetection;
        if (automaticActivityDetection?.disabled !== true) {
            throw new Error('Gemini Live did not disable server-side automatic activity detection');
        }
        if ('silenceDurationMs' in automaticActivityDetection) {
            throw new Error('Gemini Live retained a server-side silence endpoint');
        }
        if (!connectParams.config.proactivity.proactiveAudio) {
            throw new Error('Gemini Live proactive audio was not enabled');
        }
        if (connectParams.config.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName !== 'Aoede') {
            throw new Error('Gemini Live did not use the Aoede voice by default');
        }
        if ('transparent' in connectParams.config.sessionResumption) {
            throw new Error('Gemini Developer API does not support transparent session resumption');
        }

        host.sendAudioFrame(Buffer.alloc(640));
        if (realtimeInputs[0]?.audio?.mimeType !== 'audio/pcm;rate=16000') {
            throw new Error(`Unexpected realtime input: ${JSON.stringify(realtimeInputs[0])}`);
        }
        if (!host.startActivity() || host.startActivity()) {
            throw new Error('Gemini Live activity start was not edge-triggered');
        }
        if (!host.endActivity() || host.endActivity()) {
            throw new Error('Gemini Live activity end was not edge-triggered');
        }
        if (!realtimeInputs[1]?.activityStart || !realtimeInputs[2]?.activityEnd) {
            throw new Error(`Gemini Live explicit activity signals were not sent: ${JSON.stringify(realtimeInputs)}`);
        }

        const responsePcm = Buffer.alloc(4);
        responsePcm.writeInt16LE(250, 0);
        responsePcm.writeInt16LE(-250, 2);
        connectParams.callbacks.onmessage({
            serverContent: {
                outputTranscription: { text: 'Hello from Gemini.' },
                modelTurn: {
                    parts: [{
                        inlineData: {
                            mimeType: 'audio/pcm;rate=24000',
                            data: responsePcm.toString('base64')
                        }
                    }]
                }
            }
        });
        connectParams.callbacks.onmessage({
            serverContent: {
                turnComplete: true
            }
        });

        if (streamBytes.length !== 16) {
            throw new Error(`Expected 16 Discord PCM bytes, got ${streamBytes.length}`);
        }
        if (completedTurn?.transcription !== 'Hello from Gemini.') {
            throw new Error(`Missing output transcription: ${JSON.stringify(completedTurn)}`);
        }

        host.stop();
        if (!closed) {
            throw new Error('Gemini Live session did not close');
        }

        console.log('  Gemini Live uses proactive no-interruption audio and finalizes streamed turns');
        passed++;
    } catch (error) {
        console.log(`  Gemini Live lifecycle failed: ${error.message}`);
        failed++;
    }

    console.log('\nTest 1e: Gemini Live explicit activity follows confirmed participant floor');
    try {
        const bot = Object.create(AlphaClawdVoiceBot.prototype);
        const guildId = 'guild-gemini-activity';
        const userId = 'user-gemini-activity';
        const activityEvents = [];
        let floorActive = false;

        bot.sessionHostModes = new Map([[guildId, 'gemini-live']]);
        bot.geminiLiveActivityStates = new Map();
        bot.geminiLiveActivityReleaseMs = 35;
        bot.participantSignalStates = new Map();
        bot.geminiLiveHosts = new Map([[
            guildId,
            {
                activityActive: false,
                startActivity() {
                    activityEvents.push('start');
                    this.activityActive = true;
                    return true;
                },
                endActivity() {
                    activityEvents.push('end');
                    this.activityActive = false;
                    return true;
                }
            }
        ]]);
        bot.hasCurrentParticipantFloor = () => floorActive;

        const participantStates = bot.getParticipantSignalStateMap(guildId);
        participantStates.set(userId, {
            userId,
            rawActive: false,
            floorHasFreshSpeechEvidence: true
        });
        if (bot.beginGeminiLiveParticipantActivity(guildId, userId, 'test without raw VAD')) {
            throw new Error('Gemini activity started without concurrent raw VAD');
        }

        participantStates.get(userId).rawActive = true;
        floorActive = true;
        if (!bot.beginGeminiLiveParticipantActivity(guildId, userId, 'test confirmed speech')) {
            throw new Error('Confirmed participant speech did not start Gemini activity');
        }
        if (activityEvents.join(',') !== 'start') {
            throw new Error(`Unexpected activity start events: ${activityEvents.join(',')}`);
        }

        floorActive = false;
        if (!bot.scheduleGeminiLiveParticipantActivityEnd(guildId, 'test floor release')) {
            throw new Error('Participant floor release did not schedule Gemini activity end');
        }
        await sleep(15);
        if (!bot.holdGeminiLiveParticipantActivity(guildId, userId, 'test continuation')) {
            throw new Error('Same-utterance continuation did not hold Gemini activity open');
        }
        await sleep(45);
        if (activityEvents.includes('end')) {
            throw new Error('Gemini activity ended despite a same-utterance continuation');
        }

        if (!bot.scheduleGeminiLiveParticipantActivityEnd(guildId, 'test final release')) {
            throw new Error('Final participant floor release did not schedule Gemini activity end');
        }
        await sleep(45);
        if (activityEvents.join(',') !== 'start,end') {
            throw new Error(`Gemini activity did not end after the release hold: ${activityEvents.join(',')}`);
        }

        bot.clearGeminiLiveActivityState(guildId);
        console.log('  Confirmed speech starts explicit activity and thoughtful pauses defer its end');
        passed++;
    } catch (error) {
        console.log(`  Gemini Live explicit activity bridge failed: ${error.message}`);
        failed++;
    }

    console.log('\nTest 1c: Awareness Shelf');
    try {
        const shelfDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awareness-shelf-'));
        const times = [
            '2026-05-22T22:00:01.000Z',
            '2026-05-22T22:00:02.000Z',
            '2026-05-22T22:00:03.000Z',
            '2026-05-22T22:00:04.000Z',
            '2026-05-22T22:00:05.000Z',
            '2026-05-22T22:00:06.000Z',
            '2026-05-22T22:00:07.000Z',
            '2026-05-22T22:00:08.000Z',
            '2026-05-22T22:00:09.000Z',
            '2026-05-22T22:00:10.000Z',
            '2026-05-22T22:00:11.000Z',
            '2026-05-22T22:00:12.000Z'
        ];
        let timeIndex = 0;
        const shelf = new AwarenessShelf({
            enabled: true,
            maxItems: 2,
            expireAfterTurns: 2,
            now: () => times[Math.min(timeIndex++, times.length - 1)]
        });
        const session = shelf.startSession('guild-shelf', {
            recordingPath: shelfDir,
            startedAt: '2026-05-22T22:00:00.000Z'
        });
        const first = shelf.addItem('guild-shelf', {
            text: 'Jensen is circling a richer purpose for slow cognition.',
            reason: 'This should be available as contemplative context.',
            topicAnchors: ['slow cognition', 'awareness shelf'],
            originTimestamp: '2026-05-22T22:00:12.345Z'
        });
        shelf.addItem('guild-shelf', {
            text: 'The shelf should stay available for the next host opportunity.',
            originTimestamp: '2026-05-22T22:00:14.000Z'
        });
        const longText = `Long shelf item ${'x'.repeat(1200)}`;
        const third = shelf.addItem('guild-shelf', {
            text: longText,
            originTimestamp: '2026-05-22T22:00:16.000Z'
        });

        const activeAfterAdd = shelf.getAvailableItems('guild-shelf');
        if (
            first.originEpisodeTimestamp !== '00:00:12.345' ||
            activeAfterAdd.length !== 2 ||
            activeAfterAdd.some((item) => item.id === first.id) ||
            third.text !== longText
        ) {
            throw new Error(`Shelf did not preserve origin timing, max active count, or full text: ${JSON.stringify({ first, thirdLength: third?.text?.length, activeAfterAdd })}`);
        }

        const presentedOnce = shelf.presentItemsForGenerator('guild-shelf', {
            generatorCalledAt: '2026-05-22T22:00:20.000Z',
            turnIdIntent: { turnId: 'turn-1' }
        });
        const activeAfterFirstPresentation = shelf.getAvailableItems('guild-shelf');
        if (
            presentedOnce.length !== 2 ||
            activeAfterFirstPresentation.length !== 2 ||
            activeAfterFirstPresentation.some((item) => item.remainingTurns !== 1)
        ) {
            throw new Error(`Shelf did not mark first presentation correctly: ${JSON.stringify({ presentedOnce, activeAfterFirstPresentation })}`);
        }

        shelf.presentItemsForGenerator('guild-shelf', {
            generatorCalledAt: '2026-05-22T22:00:25.000Z',
            turnIdIntent: { turnId: 'turn-2' }
        });
        if (shelf.getAvailableItems('guild-shelf').length !== 0) {
            throw new Error(`Shelf items did not expire after presentation limit: ${JSON.stringify(shelf.getAvailableItems('guild-shelf'))}`);
        }

        const reactivated = shelf.reactivateItem('guild-shelf', third.id, {
            text: 'Back on the shelf after the scene becomes relevant again.',
            expiresAfterTurns: 1
        });
        if (
            reactivated?.status !== 'active' ||
            reactivated.remainingTurns !== 1 ||
            !shelf.getAvailableItems('guild-shelf')[0]?.text.includes('Back on the shelf')
        ) {
            throw new Error(`Shelf item did not reactivate cleanly: ${JSON.stringify(reactivated)}`);
        }
        shelf.removeItem('guild-shelf', third.id, 'No longer relevant');
        if (shelf.getAvailableItems('guild-shelf').length !== 0) {
            throw new Error('Removed shelf item stayed available');
        }

        const events = fs.readFileSync(session.outputPath, 'utf8')
            .trim()
            .split(/\n+/)
            .map((line) => JSON.parse(line).event);
        for (const expected of ['added', 'presented_to_generator', 'expired', 'reactivated', 'removed']) {
            if (!events.includes(expected)) {
                throw new Error(`Shelf event log missing ${expected}: ${JSON.stringify(events)}`);
            }
        }

        const disabledShelf = new AwarenessShelf({ enabled: false });
        disabledShelf.startSession('guild-disabled', { recordingPath: shelfDir });
        disabledShelf.addItem('guild-disabled', { text: 'Should stay inert.' });
        if (disabledShelf.presentItemsForGenerator('guild-disabled').length !== 0) {
            throw new Error('Disabled shelf exposed items');
        }

        shelf.endSession('guild-shelf');
        disabledShelf.endSession('guild-disabled');
        fs.rmSync(shelfDir, { recursive: true, force: true });
        console.log('  Awareness shelf stores scene-scoped items, preserves full text, logs lifecycle events, and stays inert when disabled');
        passed++;
    } catch (error) {
        console.log(`  Awareness shelf failed: ${error.message}`);
        failed++;
    }

    console.log('\nTest 2: Speaker Tracker');
    try {
        const tracker = new SpeakerTracker();
        tracker.addUtterance({
            speaker: 'Jensen',
            text: 'Testing the tracker',
            timestamp: new Date().toISOString()
        });

        const history = tracker.getHistory();
        if (Array.isArray(history) && history.length === 1) {
            console.log('  Speaker tracker stores utterances');
            passed++;
        } else {
            throw new Error('History did not contain the expected utterance');
        }
    } catch (error) {
        console.log(`  Speaker tracker failed: ${error.message}`);
        failed++;
    }

    console.log('\nTest 3: Fish Audio Provider');
    try {
        const fishAudio = new FishAudioProvider({
            apiKey: process.env.FISH_AUDIO_API_KEY || 'test_fish_audio_key_placeholder',
            defaultVoice: process.env.FISH_AUDIO_VOICE_ID || 'e127c1a13d0b415da7d6c4c16861295f'
        });

        const pcmData = Buffer.alloc(48000 * 2 * 2);
        const wavData = await fishAudio.prepareAudioForSTT(pcmData, {
            sampleRate: 48000,
            channels: 2
        });

        if (wavData.length === pcmData.length + 44 && wavData.slice(0, 4).toString() === 'RIFF') {
            console.log('  PCM to WAV conversion works');
            passed++;
        } else {
            throw new Error('WAV conversion failed');
        }

        const sineFrames = 480;
        const sinePcm = Buffer.alloc(sineFrames * 4);
        for (let frame = 0; frame < sineFrames; frame++) {
            const phase = 2 * Math.PI * 1000 * frame / 48000;
            sinePcm.writeInt16LE(Math.round(12000 * Math.sin(phase)), frame * 4);
            sinePcm.writeInt16LE(Math.round(6000 * Math.sin(phase)), frame * 4 + 2);
        }
        const originalSinePcm = Buffer.from(sinePcm);
        const downmixedPcm = downmixStereo48kToMono16k(sinePcm);
        const expectedFirstSample = Math.round(
            Array.from({ length: 3 }, (_, frame) => {
                const offset = frame * 4;
                return (sinePcm.readInt16LE(offset) + sinePcm.readInt16LE(offset + 2)) / 2;
            }).reduce((sum, sample) => sum + sample, 0) / 3
        );
        if (downmixedPcm.length !== sinePcm.length / 6) {
            throw new Error(`Downmix length mismatch: ${downmixedPcm.length} vs ${sinePcm.length / 6}`);
        }
        if (downmixedPcm.readInt16LE(0) !== expectedFirstSample) {
            throw new Error(`Stereo averaging mismatch: ${downmixedPcm.readInt16LE(0)} vs ${expectedFirstSample}`);
        }
        if (!sinePcm.equals(originalSinePcm)) {
            throw new Error('Downmix mutated the raw capture buffer');
        }

        const downmixedWav = await fishAudio.prepareAudioForSTT(downmixedPcm, {
            sampleRate: 16000,
            channels: 1
        });
        const headerChecks = {
            riff: downmixedWav.slice(0, 4).toString('ascii'),
            fileSize: downmixedWav.readUInt32LE(4),
            wave: downmixedWav.slice(8, 12).toString('ascii'),
            audioFormat: downmixedWav.readUInt16LE(20),
            channels: downmixedWav.readUInt16LE(22),
            sampleRate: downmixedWav.readUInt32LE(24),
            byteRate: downmixedWav.readUInt32LE(28),
            blockAlign: downmixedWav.readUInt16LE(32),
            bitsPerSample: downmixedWav.readUInt16LE(34),
            dataTag: downmixedWav.slice(36, 40).toString('ascii'),
            dataSize: downmixedWav.readUInt32LE(40)
        };
        if (
            headerChecks.riff !== 'RIFF' ||
            headerChecks.fileSize !== downmixedPcm.length + 36 ||
            headerChecks.wave !== 'WAVE' ||
            headerChecks.audioFormat !== 1 ||
            headerChecks.channels !== 1 ||
            headerChecks.sampleRate !== 16000 ||
            headerChecks.byteRate !== 32000 ||
            headerChecks.blockAlign !== 2 ||
            headerChecks.bitsPerSample !== 16 ||
            headerChecks.dataTag !== 'data' ||
            headerChecks.dataSize !== downmixedPcm.length ||
            !downmixedWav.subarray(44).equals(downmixedPcm)
        ) {
            throw new Error(`16kHz mono WAV header mismatch: ${JSON.stringify(headerChecks)}`);
        }
        console.log('  48kHz stereo PCM downmixes to filtered 16kHz mono with a valid WAV header');
        passed++;

        const s2Text = fishAudio.preprocessText('Hold <break time="2.2s" /> the thought.');
        const fishS1 = new FishAudioProvider({
            apiKey: process.env.FISH_AUDIO_API_KEY || 'test_fish_audio_key_placeholder',
            defaultVoice: process.env.FISH_AUDIO_VOICE_ID || 'e127c1a13d0b415da7d6c4c16861295f',
            model: 's1'
        });
        const s1Text = fishS1.preprocessText('Hold <break time="2.2s" /> the thought.');
        const slashText = fishAudio.preprocessText('First line / second line / third line.');
        const streamIterator = (async function* () {
            yield 'Hello ';
            yield 'world / again.';
        })();
        const firstStreamChunk = await fishAudio.readFirstProcessedTextChunk(streamIterator, { model: 's2-pro' });
        const processedStreamChunks = [];
        for await (const chunk of fishAudio.createProcessedTextStream(firstStreamChunk, streamIterator, { model: 's2-pro' })) {
            processedStreamChunks.push(chunk);
        }
        if (
            s2Text === 'Hold [long pause] the thought.' &&
            fishAudio.hasFishInlineControls(s2Text) &&
            s1Text === 'Hold (long-break) the thought.' &&
            fishS1.hasFishInlineControls(s1Text) &&
            slashText === 'First line, second line, third line.' &&
            processedStreamChunks.join('') === 'Hello world, again.'
        ) {
            console.log('  Fish pause controls are model-family aware and stream text stays speakable');
            passed++;
        } else {
            throw new Error(`Fish preprocessing failed: ${JSON.stringify({ s2Text, s1Text, slashText, processedStreamChunks })}`);
        }
    } catch (error) {
        console.log(`  Fish Audio provider failed: ${error.message}`);
        failed++;
    }

    console.log('\nTest 3a: Fish ASR shadow returns authoritative audio without waiting');
    try {
        let releaseShadow;
        let shadowFinished = false;
        const shadowGate = new Promise((resolve) => {
            releaseShadow = resolve;
        });
        const trackedTasks = [];
        const uploadedHeaders = [];
        const fishAudio = new FishAudioProvider({
            apiKey: 'test_fish_audio_key_placeholder',
            asrDownmix: 'shadow'
        });
        fishAudio.fetchWithTimeout = async (url, options) => {
            const uploadedWav = Buffer.from(await options.body.get('audio').arrayBuffer());
            const channels = uploadedWav.readUInt16LE(22);
            const sampleRate = uploadedWav.readUInt32LE(24);
            uploadedHeaders.push({ channels, sampleRate, bytes: uploadedWav.length });

            if (channels === 1) {
                await shadowGate;
                shadowFinished = true;
                return {
                    ok: true,
                    json: async () => ({
                        text: 'downmixed wording',
                        duration: 2,
                        segments: [{ text: 'downmixed wording', start: 0.5, end: 1.5 }]
                    })
                };
            }

            return {
                ok: true,
                json: async () => ({
                    text: 'authoritative wording',
                    duration: 2,
                    segments: [{ text: 'authoritative wording', start: 0.25, end: 1.75 }]
                })
            };
        };

        const sourcePcm = createSpeechPcm(100);
        const result = await fishAudio.transcribe(sourcePcm, {
            trackBackgroundTask: (task) => trackedTasks.push(task)
        });

        if (result.text !== 'authoritative wording' || shadowFinished) {
            throw new Error(`Shadow ASR delayed or replaced the authoritative result: ${JSON.stringify(result)}`);
        }
        if (
            result.words.length !== 1 ||
            result.words[0].start !== 0.25 ||
            result.words[0].end !== 1.75
        ) {
            throw new Error(`Fish segment seconds were altered: ${JSON.stringify(result.words)}`);
        }
        if (trackedTasks.length !== 1) {
            throw new Error(`Shadow comparison was not registered for draining: ${trackedTasks.length}`);
        }

        releaseShadow();
        await Promise.allSettled(trackedTasks);
        if (
            uploadedHeaders.length !== 2 ||
            !uploadedHeaders.some(header => header.channels === 2 && header.sampleRate === 48000) ||
            !uploadedHeaders.some(header => header.channels === 1 && header.sampleRate === 16000)
        ) {
            throw new Error(`Shadow uploads used unexpected WAV formats: ${JSON.stringify(uploadedHeaders)}`);
        }

        console.log('  Shadow mode returns 48kHz text immediately, tracks 16kHz work, and preserves timing seconds');
        passed++;
    } catch (error) {
        console.log(`  Fish ASR shadow behavior failed: ${error.message}`);
        failed++;
    }

    console.log('\nTest 3a.1: Fish ASR true mode uploads only 16kHz mono');
    try {
        const uploadedHeaders = [];
        const fishAudio = new FishAudioProvider({
            apiKey: 'test_fish_audio_key_placeholder',
            asrDownmix: true
        });
        fishAudio.fetchWithTimeout = async (url, options) => {
            const uploadedWav = Buffer.from(await options.body.get('audio').arrayBuffer());
            uploadedHeaders.push({
                channels: uploadedWav.readUInt16LE(22),
                sampleRate: uploadedWav.readUInt32LE(24),
                bytes: uploadedWav.length
            });
            return {
                ok: true,
                json: async () => ({
                    text: 'downmixed only',
                    duration: 1,
                    segments: [{ text: 'downmixed only', start: 0.1, end: 0.9 }]
                })
            };
        };

        const sourcePcm = createSpeechPcm(100);
        const result = await fishAudio.transcribe(sourcePcm);
        if (
            result.text !== 'downmixed only' ||
            uploadedHeaders.length !== 1 ||
            uploadedHeaders[0].channels !== 1 ||
            uploadedHeaders[0].sampleRate !== 16000 ||
            uploadedHeaders[0].bytes !== sourcePcm.length / 6 + 44
        ) {
            throw new Error(`True mode did not upload only the downmixed WAV: ${JSON.stringify(uploadedHeaders)}`);
        }

        console.log('  True mode sends one 16kHz mono WAV and no 48kHz upload');
        passed++;
    } catch (error) {
        console.log(`  Fish ASR true mode failed: ${error.message}`);
        failed++;
    }

    console.log('\nTest 3a.2: Fish ASR shadow errors do not fail the turn');
    try {
        const trackedTasks = [];
        const shadowLogs = [];
        const originalConsoleError = console.error;
        const fishAudio = new FishAudioProvider({
            apiKey: 'test_fish_audio_key_placeholder',
            asrDownmix: 'shadow'
        });
        fishAudio.fetchWithTimeout = async (url, options) => {
            const uploadedWav = Buffer.from(await options.body.get('audio').arrayBuffer());
            if (uploadedWav.readUInt16LE(22) === 1) {
                return {
                    ok: false,
                    status: 503,
                    text: async () => 'shadow unavailable'
                };
            }
            return {
                ok: true,
                json: async () => ({ text: 'authoritative survives', duration: 1 })
            };
        };

        try {
            console.error = (...args) => shadowLogs.push(args.join(' '));
            const result = await fishAudio.transcribe(createSpeechPcm(100), {
                trackBackgroundTask: (task) => trackedTasks.push(task)
            });
            await Promise.allSettled(trackedTasks);
            if (
                result.text !== 'authoritative survives' ||
                !shadowLogs.some(line => line.includes('"status":"shadow_error"'))
            ) {
                throw new Error(`Shadow failure affected the turn or was not logged: ${JSON.stringify(shadowLogs)}`);
            }
        } finally {
            console.error = originalConsoleError;
        }

        console.log('  A failed 16kHz shadow request is logged and the 48kHz turn still succeeds');
        passed++;
    } catch (error) {
        console.log(`  Fish ASR shadow error isolation failed: ${error.message}`);
        failed++;
    }

    console.log('\nTest 3b: Fish Audio opens its live socket while waiting for text');
    try {
        let firstChunkResolved = false;
        let resolveFirstChunk;
        let webSocketCreatedBeforeFirstChunk = false;
        const sentEvents = [];
        const firstChunkGate = new Promise((resolve) => {
            resolveFirstChunk = resolve;
        });

        class MockFishWebSocket extends EventEmitter {
            constructor() {
                super();
                this.readyState = 0;
                this.closeCalls = 0;
                webSocketCreatedBeforeFirstChunk = !firstChunkResolved;
                setImmediate(() => {
                    this.readyState = 1;
                    this.emit('open');
                });
            }

            send(payload) {
                const event = msgpack.decode(payload);
                sentEvents.push(event);
                if (event.event === 'stop') {
                    setImmediate(() => {
                        this.emit('message', msgpack.encode({ event: 'finish', reason: 'stop' }));
                    });
                }
            }

            close() {
                this.closeCalls++;
                this.readyState = 3;
            }
        }

        let socketCreateCount = 0;
        const fishAudio = new FishAudioProvider({
            apiKey: 'test_fish_audio_key_placeholder',
            webSocketFactory: () => {
                socketCreateCount++;
                return new MockFishWebSocket();
            }
        });
        const slowText = (async function* () {
            await firstChunkGate;
            firstChunkResolved = true;
            yield 'Hello from the slow stream.';
        })();
        const audioTask = (async () => {
            for await (const chunk of fishAudio.createStreamingAudio(slowText)) {
                void chunk;
            }
        })();

        if (socketCreateCount !== 1 || !webSocketCreatedBeforeFirstChunk) {
            throw new Error('Fish live WebSocket did not start connecting before the first text chunk resolved');
        }
        if (sentEvents.length !== 0) {
            throw new Error(`Fish sent WebSocket events before the first text chunk: ${JSON.stringify(sentEvents)}`);
        }

        resolveFirstChunk();
        await audioTask;
        if (sentEvents[0]?.event !== 'start' || sentEvents[1]?.event !== 'text') {
            throw new Error(`Fish streaming protocol started out of order: ${JSON.stringify(sentEvents)}`);
        }
        console.log('  Fish live WebSocket connects concurrently with the first text chunk');
        passed++;
    } catch (error) {
        console.log(`  Fish streaming connection concurrency failed: ${error.message}`);
        failed++;
    }

    console.log('\nTest 3c: Fish Audio closes a pre-opened socket for empty text');
    try {
        let mockSocket = null;

        class MockFishWebSocket extends EventEmitter {
            constructor() {
                super();
                this.readyState = 0;
                this.closeCalls = 0;
                setImmediate(() => {
                    if (this.readyState !== 0) return;
                    this.readyState = 1;
                    this.emit('open');
                });
            }

            close() {
                this.closeCalls++;
                this.readyState = 3;
            }
        }

        const fishAudio = new FishAudioProvider({
            apiKey: 'test_fish_audio_key_placeholder',
            webSocketFactory: () => {
                mockSocket = new MockFishWebSocket();
                return mockSocket;
            }
        });
        const emptyText = (async function* () {
            yield '';
            yield '   ';
        })();
        let receivedError = null;

        try {
            for await (const chunk of fishAudio.createStreamingAudio(emptyText)) {
                void chunk;
            }
        } catch (error) {
            receivedError = error;
        }

        if (receivedError?.message !== 'Fish Audio streaming TTS requires at least one non-empty text chunk.') {
            throw new Error(`Unexpected empty-stream error: ${receivedError?.message || 'none'}`);
        }
        if (!mockSocket || mockSocket.closeCalls !== 1) {
            throw new Error(`Expected the pre-opened socket to close once, got ${mockSocket?.closeCalls || 0}`);
        }

        console.log('  Empty Fish text streams preserve the error and close the pending socket');
        passed++;
    } catch (error) {
        console.log(`  Fish empty streaming cleanup failed: ${error.message}`);
        failed++;
    }

    console.log('\nTest 4: Gateway Bridge');
    try {
        const bridge = new GatewayBridge({
            gatewayUrl: 'http://localhost:3000',
            sessionKey: 'agent:main:main',
            responsePort: 4567,
            authToken: 'dev-token'
        });

        if (bridge.gatewayUrl === 'http://localhost:3000') {
            console.log('  Gateway bridge initializes');
            passed++;
        } else {
            throw new Error('Gateway URL mismatch');
        }
    } catch (error) {
        console.log(`  Gateway bridge failed: ${error.message}`);
        failed++;
    }

    console.log('\nTest 4a: Gateway WebSocket client declares operator write scope');
    try {
        const identityDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-client-'));
        const identityPath = path.join(identityDir, 'device.json');
        const wsClient = new GatewayWsClient({
            authToken: 'test-token',
            scopes: ['operator.read', 'operator.write'],
            clientId: 'test-client',
            clientVersion: 'test-version',
            deviceIdentityPath: identityPath
        });
        let captured = null;
        let heartbeatStarted = false;
        let authenticated = false;

        wsClient.sendRequest = async (method, params) => {
            captured = { method, params };
            return {
                type: 'hello-ok',
                snapshot: {
                    presence: [
                        {
                            deviceId: params.device?.id,
                            scopes: params.scopes
                        }
                    ]
                }
            };
        };
        wsClient.startHeartbeat = () => {
            heartbeatStarted = true;
        };
        wsClient.on('authenticated', () => {
            authenticated = true;
        });

        await wsClient.handleConnectChallenge({ nonce: 'nonce-test' });

        if (captured?.method !== 'connect') {
            throw new Error(`Expected connect request, got ${captured?.method}`);
        }
        if (captured.params.role !== 'operator' || captured.params.client?.mode !== 'backend') {
            throw new Error(`Gateway connect did not declare operator role: ${JSON.stringify(captured.params)}`);
        }
        if (!captured.params.scopes.includes('operator.write') || !captured.params.scopes.includes('operator.read')) {
            throw new Error(`Gateway connect missing read/write scopes: ${JSON.stringify(captured.params.scopes)}`);
        }
        if (!captured.params.device?.id || !captured.params.device?.signature) {
            throw new Error(`Gateway connect missing signed device identity: ${JSON.stringify(captured.params.device)}`);
        }
        if (captured.params.device.nonce !== 'nonce-test') {
            throw new Error('Gateway device signature did not include the challenge nonce');
        }
        const signedPayload = wsClient.buildDeviceAuthPayload({
            deviceId: captured.params.device.id,
            signedAtMs: captured.params.device.signedAt,
            token: 'test-token',
            nonce: 'nonce-test'
        });
        if (!verifyDeviceSignature(captured.params.device.publicKey, signedPayload, captured.params.device.signature)) {
            throw new Error('Gateway device signature did not verify');
        }
        if (!authenticated || !heartbeatStarted || !wsClient.isAuthenticated) {
            throw new Error('Gateway client did not mark itself authenticated after hello-ok');
        }
        if (!wsClient.hasScope('operator.write')) {
            throw new Error('Gateway client did not retain granted operator.write scope from server presence');
        }
        if (wsClient.canInjectMessages()) {
            throw new Error('chat.inject should remain disabled without operator.admin');
        }

        const unboundClient = new GatewayWsClient({
            authToken: 'test-token',
            scopes: ['operator.read', 'operator.write'],
            useDeviceIdentity: false
        });
        unboundClient.sendRequest = async () => ({ type: 'hello-ok' });
        unboundClient.startHeartbeat = () => {};
        await unboundClient.handleConnectChallenge({ nonce: 'nonce-test' });
        if (unboundClient.hasScope('operator.write')) {
            throw new Error('Gateway client should not claim operator.write when the server did not grant it');
        }

        const adminClient = new GatewayWsClient({ scopes: 'operator.read,operator.write,operator.admin' });
        if (!adminClient.canInjectMessages()) {
            throw new Error('chat.inject should be enabled when operator.admin is configured');
        }

        let agentEvent = null;
        wsClient.on('agentEvent', (event) => {
            agentEvent = event;
        });
        wsClient.handleMessage(Buffer.from(JSON.stringify({
            type: 'event',
            event: 'agent',
            payload: {
                runId: 'run-agent-error',
                sessionKey: 'agent:main:main',
                stream: 'lifecycle',
                seq: 4,
                data: { phase: 'error', error: 'usage limit' }
            }
        })));
        if (
            agentEvent?.runId !== 'run-agent-error' ||
            agentEvent?.stream !== 'lifecycle' ||
            agentEvent?.data?.error !== 'usage limit'
        ) {
            throw new Error(`Gateway client did not emit agent lifecycle event: ${JSON.stringify(agentEvent)}`);
        }

        fs.rmSync(identityDir, { recursive: true, force: true });
        console.log('  Gateway client signs device auth and gates admin-only injection');
        passed++;
    } catch (error) {
        console.log(`  Gateway WebSocket scope test failed: ${error.message}`);
        failed++;
    }

    console.log('\nTest 4b: Recording directory honors shared content contract');
    try {
        const previousContentRoot = process.env.CLAWCAST_CONTENT_ROOT;
        const previousPodcastRoot = process.env.PODCAST_ROOT;
        const previousRecordingDir = process.env.RECORDING_DIR;
        const previousAllowLegacy = process.env.ALLOW_LEGACY_RECORDING_DIR;
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clawcast-content-contract-'));

        try {
            delete process.env.PODCAST_ROOT;
            delete process.env.ALLOW_LEGACY_RECORDING_DIR;
            process.env.CLAWCAST_CONTENT_ROOT = tempRoot;
            delete process.env.RECORDING_DIR;

            const contractDir = path.join(tempRoot, 'recordings');
            if (getContractRecordingDir() !== contractDir || getRecordingDir() !== contractDir) {
                throw new Error(`Default recording dir did not use content/recordings: ${getRecordingDir()}`);
            }

            const legacyDir = path.join(tempRoot, 'episodes', 'recordings');
            process.env.RECORDING_DIR = legacyDir;
            if (!isLegacyEpisodesRecordingDir(legacyDir)) {
                throw new Error('Legacy episodes/recordings path was not detected');
            }
            if (getRecordingDir() !== contractDir) {
                throw new Error(`Legacy recording dir was not corrected: ${getRecordingDir()}`);
            }

            process.env.ALLOW_LEGACY_RECORDING_DIR = 'true';
            if (getRecordingDir() !== legacyDir) {
                throw new Error('Explicit legacy opt-in was not honored');
            }
        } finally {
            if (previousContentRoot === undefined) delete process.env.CLAWCAST_CONTENT_ROOT;
            else process.env.CLAWCAST_CONTENT_ROOT = previousContentRoot;
            if (previousPodcastRoot === undefined) delete process.env.PODCAST_ROOT;
            else process.env.PODCAST_ROOT = previousPodcastRoot;
            if (previousRecordingDir === undefined) delete process.env.RECORDING_DIR;
            else process.env.RECORDING_DIR = previousRecordingDir;
            if (previousAllowLegacy === undefined) delete process.env.ALLOW_LEGACY_RECORDING_DIR;
            else process.env.ALLOW_LEGACY_RECORDING_DIR = previousAllowLegacy;
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }

        console.log('  Recording dir defaults to content/recordings and corrects the legacy episodes path');
        passed++;
    } catch (error) {
        console.log(`  Recording contract path failed: ${error.message}`);
        failed++;
    }

    console.log('\nTest 5: Podcast Generator');
    try {
        const generator = new PodcastGenerator({
            apiKey: 'sk-test-placeholder',
            maxSpeechChars: 80
        });

        const output = generator.normalizeOutput({
            shouldRespond: true,
            speech: '**Absolutely.** [ACTION:mode:chatty] I am with you on that.'
        });

        if (
            output.shouldRespond === true &&
            output.speech === 'Absolutely. I am with you on that.'
        ) {
            console.log('  Structured output normalization works');
            passed++;
        } else {
            throw new Error(`Unexpected normalized output: ${JSON.stringify(output)}`);
        }

        const fishTaggedOutput = generator.normalizeOutput({
            shouldRespond: true,
            speech: '[soft voice] That lands. [pause] Keep going.'
        });
        if (fishTaggedOutput.speech !== '[soft voice] That lands. [pause] Keep going.') {
            throw new Error(`Fish TTS controls should survive speech sanitization: ${JSON.stringify(fishTaggedOutput)}`);
        }

        const poetryOutput = generator.normalizeOutput({
            shouldRespond: true,
            speech: 'First sonnet line / second sonnet line. / Third sonnet line / fourth sonnet line.'
        });
        if (poetryOutput.speech !== 'First sonnet line, second sonnet line. Third sonnet line, fourth sonnet line.') {
            throw new Error(`Poetry slash separators should become speakable punctuation: ${JSON.stringify(poetryOutput)}`);
        }
        const commandOutput = generator.normalizeOutput({
            shouldRespond: true,
            speech: 'Use /podcast-production for production and and/or for alternatives.'
        });
        if (commandOutput.speech !== 'Use /podcast-production for production and and/or for alternatives.') {
            throw new Error(`Non-separator slashes should survive speech sanitization: ${JSON.stringify(commandOutput)}`);
        }

        const messages = generator.buildMessages({
            transcript: 'Jensen: Testing the turn decision prompt'
        });
        const userMessage = messages[messages.length - 2];
        const decisionMessage = messages[messages.length - 1];

        if (
            userMessage.role === 'user' &&
            !userMessage.content.includes('Emit speech first') &&
            decisionMessage.role === 'system' &&
            decisionMessage.content === 'Produce the host turn now. Emit speech first, then shouldRespond, followed by chosenAngle, bigBrain, and bigHeart.'
        ) {
            console.log('  Turn decision prompt is sent as a trailing system message');
            passed++;
        } else {
            throw new Error(`Unexpected message layout: ${JSON.stringify(messages)}`);
        }

        const systemPrompt = generator.buildSystemPrompt();
        if (
            systemPrompt.includes('Live speech is provisional:') &&
            systemPrompt.includes('fields in this exact order: speech, shouldRespond, chosenAngle, bigBrain, bigHeart') &&
            systemPrompt.includes('This order also applies when only JSON mode is available') &&
            systemPrompt.includes('not a polished chat message') &&
            systemPrompt.includes('Read the latest utterance first:') &&
            systemPrompt.includes('Hold-space cues:') &&
            systemPrompt.includes('"actually", "wait", "hold on"') &&
            systemPrompt.includes('"even though", "because", "and", "but", "so", "like", "I mean"') &&
            systemPrompt.includes('"what I was going to say"') &&
            systemPrompt.includes('Completed beat cues:') &&
            systemPrompt.includes('Closure cues:') &&
            systemPrompt.includes('"we\'ll dig into it later"') &&
            systemPrompt.includes('latest settled frame') &&
            systemPrompt.includes('treat the request as suspended') &&
            systemPrompt.includes('Felt-sense invitation') &&
            systemPrompt.includes('"What comes up for you when you hear ___ ?"') &&
            systemPrompt.includes('Permission with decline built in') &&
            systemPrompt.includes('Motion of the speaker') &&
            systemPrompt.includes('Tension named, not resolved') &&
            systemPrompt.includes('patterns, not scripts') &&
            systemPrompt.includes('Response modes:') &&
            systemPrompt.includes('Minimal backchannel') &&
            systemPrompt.includes('Reflection') &&
            systemPrompt.includes('Reflection + follow-up') &&
            systemPrompt.includes('Audience awareness:') &&
            systemPrompt.includes('Future listeners are also trying to enter the world of the conversation') &&
            systemPrompt.includes('Scene-setting uptake') &&
            systemPrompt.includes('Direct uptake') &&
            systemPrompt.includes('Question') &&
            systemPrompt.includes('model and TTS latency') &&
            systemPrompt.includes('offers two or more options') &&
            systemPrompt.includes('Vary your choice of words') &&
            systemPrompt.includes('Do not let any stock phrase become a groove') &&
            systemPrompt.includes('"What does that bring up..."') &&
            systemPrompt.includes('Speech-context cues matter') &&
            systemPrompt.includes('Do not autocomplete with generic questions') &&
            systemPrompt.includes('what does that feel like') &&
            systemPrompt.includes('Internal-thought transparency') &&
            systemPrompt.includes('you should transparently disclose') &&
            systemPrompt.includes('system writes internal-thought artifacts and short awareness notes') &&
            systemPrompt.includes('awareness notes and internal thoughts which are injected as system messages') &&
            systemPrompt.includes('Disclose them when asked') &&
            systemPrompt.includes('Awareness Shelf:') &&
            systemPrompt.includes('scene-scoped internal noticings that formed while listening') &&
            systemPrompt.includes('optional contemplative context') &&
            systemPrompt.includes('Each shelf item includes when it originated') &&
            systemPrompt.includes('Compare its origin timestamp to the current episode timestamp') &&
            systemPrompt.includes('decided not to speak on your previous turn') &&
            systemPrompt.includes('Do not mention "the shelf" unless the guest is explicitly asking') &&
            !systemPrompt.includes('You do not have access to private chain-of-thought') &&
            systemPrompt.includes('Sounding-board exception') &&
            systemPrompt.includes('Guest floor holding') &&
            systemPrompt.includes('technical assistance') &&
            systemPrompt.includes('fictional universes, canon') &&
            systemPrompt.includes('After you ask a question and the guest answers:') &&
            systemPrompt.includes('Play ball') &&
            systemPrompt.includes('miscellaneous or philosophical lanes') &&
            systemPrompt.includes('Imminent question cue') &&
            systemPrompt.includes('Permission framing is for sensitive, personal, or easy-to-decline invitations') &&
            systemPrompt.includes('Do not ask a question every turn') &&
            systemPrompt.includes('When in doubt, choose silence or the smaller move') &&
            systemPrompt.includes('Minimal backchannel is allowed but should be rare') &&
            systemPrompt.includes('Fish TTS performance controls:') &&
            systemPrompt.includes('Fish S2-family') &&
            systemPrompt.includes('[short pause]') &&
            systemPrompt.includes('bigBrain.reason') &&
            systemPrompt.includes('Do not use slash-delimited line breaks') &&
            systemPrompt.includes('visual separators like " / "') &&
            systemPrompt.includes('meta-comment naming a missed signal') &&
            !systemPrompt.includes('Structured hosting:') &&
            !systemPrompt.includes('Screen exploration and standby') &&
            !systemPrompt.includes('The mistake to avoid:') &&
            !systemPrompt.includes('listing example questions') &&
            !systemPrompt.includes('Vary your surface form') &&
            !systemPrompt.includes('one integrated sentence or two short sentences') &&
            !systemPrompt.includes('Signals they are still mid-thought:') &&
            !systemPrompt.includes('Signals they have completed a beat:')
        ) {
            console.log('  System prompt includes nuanced turn-taking response modes');
            passed++;
        } else {
            throw new Error('System prompt is missing nuanced turn-taking instructions');
        }

        const nonFishGenerator = new PodcastGenerator({
            apiKey: 'sk-test-placeholder',
            voiceMode: 'free'
        });
        const nonFishPrompt = nonFishGenerator.buildSystemPrompt();
        if (
            nonFishPrompt.includes('active TTS mode is not Fish Audio') &&
            nonFishPrompt.includes('do not include Fish control tags')
        ) {
            console.log('  System prompt adapts TTS-control guidance to non-Fish voice modes');
            passed++;
        } else {
            throw new Error('System prompt did not adapt TTS-control guidance for non-Fish mode');
        }

        const silentGenerator = new PodcastGenerator({
            apiKey: 'sk-test-placeholder',
            maxHistoryTurns: 2
        });
        silentGenerator.rememberTurn('Jensen: Actually.', { shouldRespond: false, speech: '' });
        const silentHistory = silentGenerator.getRecentHistory();

        if (
            silentHistory.length === 2 &&
            silentHistory[0].role === 'user' &&
            silentHistory[0].content === 'Jensen: Actually.' &&
            silentHistory[1].role === 'assistant' &&
            silentHistory[1].content === '[Alpha-Clawd chose silence]'
        ) {
            console.log('  Generator remembers explicit silence decisions');
            passed++;
        } else {
            throw new Error(`Silence decision was not remembered correctly: ${JSON.stringify(silentHistory)}`);
        }

        const cadenceMessages = generator.buildMessages({
            transcript: 'Jensen: First thought.\nJensen: After a real pause.',
            utterances: [
                {
                    speaker: 'Jensen',
                    transcription: 'First thought.',
                    speechStartedAt: '2026-05-03T00:00:00.000Z',
                    speechEndedAt: '2026-05-03T00:00:01.200Z'
                },
                {
                    speaker: 'Jensen',
                    transcription: 'After a real pause.',
                    speechStartedAt: '2026-05-03T00:00:03.000Z',
                    speechEndedAt: '2026-05-03T00:00:04.000Z'
                }
            ]
        });
        const cadencePrompt = cadenceMessages[cadenceMessages.length - 2].content;

        if (
            cadencePrompt === [
                'Jensen: First thought.',
                '[pause 1.8s]',
                'Jensen: After a real pause.'
            ].join('\n') &&
            cadencePrompt.includes('[pause 1.8s]') &&
            !cadencePrompt.includes('Recording:') &&
            !cadencePrompt.includes('Utterance timing queue') &&
            !cadencePrompt.includes('Transcript text:') &&
            !cadencePrompt.includes('+0.0s')
        ) {
            console.log('  User prompt includes inline pauses without timing wrapper');
            passed++;
        } else {
            throw new Error(`Inline pause prompt missing expected timing hints: ${cadencePrompt}`);
        }

        const awarenessMessages = generator.buildMessages({
            transcript: 'Jensen: I want Alpha-Clawd to feel more alive.',
            awarenessInjections: [{
                id: 'awareness-internal-packet-1',
                reason: 'This tracks the current design intent.',
                awarenessInjection: 'Jensen is designing internal thought as private host awareness, not asking for a generic implementation lecture.'
            }]
        });
        const awarenessPrompt = awarenessMessages[awarenessMessages.length - 2].content;

        if (
            awarenessPrompt.includes('Awareness injection(s) for this turn:') &&
            awarenessPrompt.includes('id: awareness-internal-packet-1') &&
            awarenessPrompt.includes('reason: This tracks the current design intent.') &&
            awarenessPrompt.includes('awarenessInjection: Jensen is designing internal thought as private host awareness') &&
            awarenessPrompt.includes('selected for this exact live turn') &&
            !awarenessPrompt.includes('contextText') &&
            !awarenessPrompt.includes('remaining participant turns') &&
            !awarenessPrompt.includes('priority')
        ) {
            console.log('  Generator user prompt includes private awareness injections');
            passed++;
        } else {
            throw new Error(`Awareness injection prompt was not formatted correctly: ${awarenessPrompt}`);
        }

        const shelfLongText = `A slow internal noticing ${'z'.repeat(900)}`;
        const shelfPrompt = generator.buildUserPrompt('Jensen: Keep going while I think this through.', null, {
            currentTime: '2026-05-22T22:00:20.000Z',
            currentEpisodeTimestamp: '00:00:20.000',
            awarenessShelfItems: [{
                id: 'shelf-1',
                text: shelfLongText,
                reason: 'This stays relevant while Jensen keeps unfolding the thought.',
                topicAnchors: ['latency', 'contemplative awareness'],
                originTimestamp: '2026-05-22T22:00:12.345Z',
                originEpisodeTimestamp: '00:00:12.345',
                remainingTurns: 2
            }]
        });
        if (
            !shelfPrompt.includes('Current generator call time: 2026-05-22T22:00:20.000Z') ||
            !shelfPrompt.includes('Current episode timestamp: 00:00:20.000') ||
            !shelfPrompt.includes('Awareness shelf items available for this generator call:') ||
            !shelfPrompt.includes('originEpisodeTimestamp: 00:00:12.345') ||
            !shelfPrompt.includes('topicAnchors: latency, contemplative awareness') ||
            !shelfPrompt.includes(shelfLongText)
        ) {
            throw new Error(`Awareness shelf prompt was not formatted with timing/full text: ${shelfPrompt}`);
        }

        const silenceCountPrompt = generator.buildUserPrompt('Jensen: Continue.', null, {
            consecutiveSilenceTurns: 2
        });
        if (!silenceCountPrompt.includes('Consecutive prior Alpha-Clawd silence decisions: 2')) {
            throw new Error(`Generator prompt did not include consecutive silence count: ${silenceCountPrompt}`);
        }

        const recentThoughtPrompt = generator.buildUserPrompt('Jensen: What are your internal thoughts right now?', null, {
            recentInternalThoughts: Array.from({ length: 8 }, (_, index) => ({
                packetId: `internal-packet-${index + 1}`,
                createdAt: `2026-05-13T00:0${index}:00.000Z`,
                internalThought: `Private runtime thought ${index + 1}`
            }))
        });
        if (
            !recentThoughtPrompt.includes('Recent internal thoughts surfaced by the current introspection/self-knowledge mention') ||
            !recentThoughtPrompt.includes('runtime internal-thought artifacts') ||
            !recentThoughtPrompt.includes('internal-packet-2') ||
            !recentThoughtPrompt.includes('internal-packet-8') ||
            recentThoughtPrompt.includes('internal-packet-1')
        ) {
            throw new Error(`Recent internal thoughts prompt was not formatted/capped correctly: ${recentThoughtPrompt}`);
        }

        const defaultSpeechCapGenerator = new PodcastGenerator({ apiKey: 'sk-test-placeholder' });
        if (defaultSpeechCapGenerator.maxSpeechChars !== 0) {
            throw new Error(`Default live speech cap should be 0 (no cap), got ${defaultSpeechCapGenerator.maxSpeechChars}`);
        }

        const pendingPrompt = generator.buildUserPrompt('Jensen: Did Big Brain finish yet?', null, {
            pendingBigBrain: [{
                runId: 'discord-bigbrain-pending',
                reason: 'NIH lookup is still running.',
                transcript: 'Jensen: Can you look up the NIH earthing evidence?',
                requestedAt: '2026-05-13T00:00:00.000Z'
            }]
        });
        if (
            !pendingPrompt.includes('Big Brain request already pending') ||
            !pendingPrompt.includes('discord-bigbrain-pending') ||
            !pendingPrompt.includes('Do not request Big Brain again') ||
            !pendingPrompt.includes('Set bigBrain.requested=false')
        ) {
            throw new Error(`Pending bigBrain prompt did not suppress duplicate stalls: ${pendingPrompt}`);
        }

        const standbyGenerator = new PodcastGenerator({ apiKey: 'sk-test-placeholder' });
        standbyGenerator.rememberTurn('Jensen: Please just stand by while I explore on my own.', {
            shouldRespond: true,
            speech: 'Got it, I will stand by.',
            bigBrain: { requested: false, reason: '', consumedRunId: '' }
        });
        const standbyPrompt = standbyGenerator.buildUserPrompt('Jensen: The Greek letter kappa is super cool.', null, {});
        if (
            !standbyGenerator.standbyMode ||
            !standbyPrompt.includes('Standing-by mode is active') ||
            !standbyPrompt.includes('Prefer shouldRespond=false')
        ) {
            throw new Error(`Standby mode was not preserved for narration: ${standbyPrompt}`);
        }
        const explicitAfterStandbyPrompt = standbyGenerator.buildUserPrompt('Jensen: What is kappa?', null, {});
        if (explicitAfterStandbyPrompt.includes('Standing-by mode is active')) {
            throw new Error(`Explicit request should override standby prompt: ${explicitAfterStandbyPrompt}`);
        }
        const currentStandbyPrompt = new PodcastGenerator({ apiKey: 'sk-test-placeholder' })
            .buildUserPrompt('Jensen: Please just stand by while I look at this.', null, {});
        const staleStandbyPrompt = new PodcastGenerator({ apiKey: 'sk-test-placeholder' })
            .buildUserPrompt([
                'Jensen: Please just stand by while I look at this.',
                'Jensen: Okay, here is the complete thought I wanted to share.'
            ].join('\n'), null, {});
        if (
            !currentStandbyPrompt.includes('Current live pacing instruction') ||
            staleStandbyPrompt.includes('Current live pacing instruction')
        ) {
            throw new Error(`Standby detection should use the current turn only: ${JSON.stringify({ currentStandbyPrompt, staleStandbyPrompt })}`);
        }
        standbyGenerator.rememberTurn('Jensen: Now you carry the conversation for at least five turns, please.', {
            shouldRespond: true,
            speech: 'Here is a concrete thought without a question.',
            bigBrain: { requested: false, reason: '', consumedRunId: '' }
        });
        const moratoriumPrompt = standbyGenerator.buildUserPrompt('Jensen: Continue.', null, {});
        if (
            standbyGenerator.questionMoratoriumTurns !== 4 ||
            !moratoriumPrompt.includes('Question moratorium') ||
            !moratoriumPrompt.includes('do not ask a question')
        ) {
            throw new Error(`Question moratorium did not persist after carry request: ${JSON.stringify({ turns: standbyGenerator.questionMoratoriumTurns, moratoriumPrompt })}`);
        }

        const structureGenerator = new PodcastGenerator({ apiKey: 'sk-test-placeholder' });
        const structurePrompt = structureGenerator.buildUserPrompt(
            [
                'Jensen: I want podcast structure with a topic and questions preloaded.',
                'Jensen: We should limit off the cuff questions so the guest does not feel interrogated.',
                'Jensen: Add background information, procedural expertise questions, interpersonal questions, and miscellaneous questions like favorite philosophy.',
                'Jensen: After the host asks and I answer, they should play ball and take a few turns talking.'
            ].join('\n'),
            null,
            {}
        );
        if (
            !structurePrompt.includes('Episode hosting structure remembered from this conversation') ||
            !structurePrompt.includes('prepared guiding questions') ||
            !structurePrompt.includes('procedural/craft') ||
            !structurePrompt.includes('interpersonal/collaboration') ||
            !structurePrompt.includes('miscellaneous/philosophical') ||
            !structurePrompt.includes('play ball for a few turns')
        ) {
            throw new Error(`Current-turn episode structure was not surfaced: ${structurePrompt}`);
        }
        structureGenerator.rememberTurn('Jensen: The host should play ball and take a few turns talking after I answer.', {
            shouldRespond: true,
            speech: 'I will carry the next beat.',
            bigBrain: { requested: false, reason: '', consumedRunId: '' }
        });
        const rememberedStructurePrompt = structureGenerator.buildUserPrompt('Jensen: Continue the episode.', null, {});
        if (
            !rememberedStructurePrompt.includes('Episode hosting structure remembered from this conversation') ||
            !rememberedStructurePrompt.includes('Question moratorium') ||
            !rememberedStructurePrompt.includes('synthesize, bridge')
        ) {
            throw new Error(`Remembered episode structure did not persist: ${rememberedStructurePrompt}`);
        }
        const showRunnerPrompt = generator.buildUserPrompt('Jensen: I answered the origin story.', null, {
            episodePlanStructure: [
                'Current phase: developing.',
                'Phase target length: 70 minutes.',
                'Phase elapsed: 31 minutes.',
                'Phase time remaining: 39 minutes.',
                '',
                'Last turn chosenAngle: origin-story.',
                'Available planned angles in this phase:',
                '- collaboration: who changed how the guest thinks about the craft'
            ].join('\n')
        });
        if (
            !showRunnerPrompt.includes('Episode plan structure') ||
            !showRunnerPrompt.includes('preproduction background knowledge') ||
            !showRunnerPrompt.includes('not prior live speech') ||
            !showRunnerPrompt.includes('Current phase: developing.') ||
            !showRunnerPrompt.includes('Last turn chosenAngle: origin-story.') ||
            !showRunnerPrompt.includes('- collaboration: who changed how the guest thinks about the craft') ||
            showRunnerPrompt.includes('contextText')
        ) {
            throw new Error(`Episode plan structure was not injected into generator prompt: ${showRunnerPrompt}`);
        }
        console.log('  Generator tracks standby, no-question pacing, and episode structure directives');
        passed++;

        const budgetGenerator = new PodcastGenerator({
            apiKey: 'sk-test-placeholder',
            maxRequestTokens: 6200,
            maxCompletionTokens: 900,
            promptTokenSafetyMargin: 400,
            maxHistoryTurns: 8
        });
        for (let i = 0; i < 8; i++) {
            budgetGenerator.history.push({
                role: i % 2 === 0 ? 'user' : 'assistant',
                content: `history ${i} ${'older context '.repeat(220)}`
            });
        }
        const hugeStagedAnswer = 'Open Claw could not complete the bigBrain request. '.repeat(260);
        const budgetMessages = budgetGenerator.buildMessages({
            transcript: `Jensen: ${'current live speech '.repeat(260)}`,
            stagedBigBrain: [{
                runId: 'discord-bigbrain-huge',
                reason: 'Large staged failure needs integration.',
                transcript: 'Jensen: Look up the NIH earthing page.',
                answer: hugeStagedAnswer
            }],
            awarenessInjections: [{
                id: 'awareness-budget',
                awarenessInjection: 'Do not answer the NIH factual question from vibes.'
            }]
        });
        const budgetEstimate = budgetGenerator.estimateMessagesTokens(budgetMessages);
        if (
            budgetEstimate > budgetGenerator.getPromptTokenBudget() ||
            budgetMessages.some(message => /older context/.test(message.content)) ||
            !budgetMessages.some(message => message.content.includes('[trimmed for prompt budget]'))
        ) {
            throw new Error(`Prompt budget guard did not compact oversized context: ${JSON.stringify({ budgetEstimate, budget: budgetGenerator.getPromptTokenBudget(), messages: budgetMessages })}`);
        }
        console.log('  Generator prompt guards pending bigBrain and compacts oversized staged context');
        passed++;

        const savedEnv = {
            PODCAST_GENERATOR_API_KEY_ACTIVE: process.env.PODCAST_GENERATOR_API_KEY_ACTIVE,
            PODCAST_GENERATOR_KEY_ROUTING: process.env.PODCAST_GENERATOR_KEY_ROUTING,
            PODCAST_GENERATOR_API_KEY_GROQ_FREE: process.env.PODCAST_GENERATOR_API_KEY_GROQ_FREE,
            PODCAST_GENERATOR_API_KEY_GROQ_PAID: process.env.PODCAST_GENERATOR_API_KEY_GROQ_PAID,
            PODCAST_GENERATOR_API_KEY_GROQ_PRIMARY: process.env.PODCAST_GENERATOR_API_KEY_GROQ_PRIMARY,
            PODCAST_GENERATOR_API_KEY_GROQ_STANDBY: process.env.PODCAST_GENERATOR_API_KEY_GROQ_STANDBY,
            PODCAST_GENERATOR_API_KEY: process.env.PODCAST_GENERATOR_API_KEY,
            PODCAST_GENERATOR_BASE_URL: process.env.PODCAST_GENERATOR_BASE_URL,
            PODCAST_GENERATOR_MODEL: process.env.PODCAST_GENERATOR_MODEL,
            OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
            OPENAI_API_KEY_GROQ_FREE: process.env.OPENAI_API_KEY_GROQ_FREE,
            OPENAI_API_KEY_GROQ_PAID: process.env.OPENAI_API_KEY_GROQ_PAID,
            OPENAI_API_KEY_GROQ_PRIMARY: process.env.OPENAI_API_KEY_GROQ_PRIMARY,
            OPENAI_API_KEY_GROQ_STANDBY: process.env.OPENAI_API_KEY_GROQ_STANDBY,
            ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
            OPENAI_API_KEY: process.env.OPENAI_API_KEY
        };

        try {
            delete process.env.PODCAST_GENERATOR_API_KEY;
            delete process.env.PODCAST_GENERATOR_BASE_URL;
            delete process.env.PODCAST_GENERATOR_MODEL;
            delete process.env.OPENAI_BASE_URL;
            delete process.env.OPENAI_API_KEY_GROQ_FREE;
            delete process.env.OPENAI_API_KEY_GROQ_PAID;
            delete process.env.OPENAI_API_KEY_GROQ_PRIMARY;
            delete process.env.OPENAI_API_KEY_GROQ_STANDBY;
            delete process.env.ANTHROPIC_API_KEY;

            process.env.PODCAST_GENERATOR_API_KEY_ACTIVE = 'groq-primary';
            delete process.env.PODCAST_GENERATOR_KEY_ROUTING;
            delete process.env.PODCAST_GENERATOR_API_KEY_GROQ_FREE;
            delete process.env.PODCAST_GENERATOR_API_KEY_GROQ_PAID;
            process.env.PODCAST_GENERATOR_API_KEY_GROQ_PRIMARY = 'primary-key';
            process.env.PODCAST_GENERATOR_API_KEY_GROQ_STANDBY = 'standby-key';
            process.env.OPENAI_API_KEY = 'legacy-key';

            const activeGenerator = new PodcastGenerator();
            if (
                activeGenerator.apiKey !== 'primary-key' ||
                activeGenerator.apiKeySource !== 'PODCAST_GENERATOR_API_KEY_GROQ_PRIMARY'
            ) {
                throw new Error('Active generator API key alias was not selected');
            }

            process.env.PODCAST_GENERATOR_API_KEY_ACTIVE = 'groq-standby';
            const standbyGenerator = new PodcastGenerator();
            if (
                standbyGenerator.apiKey !== 'standby-key' ||
                standbyGenerator.apiKeySource !== 'PODCAST_GENERATOR_API_KEY_GROQ_STANDBY'
            ) {
                throw new Error('Standby generator API key alias was not selected');
            }

            const cappedGenerator = new PodcastGenerator({
                apiKey: 'cap-test-key',
                maxCompletionTokens: 1500
            });
            const cappedBody = cappedGenerator.buildRequestBody([]);
            if (cappedBody.max_completion_tokens !== 1500) {
                throw new Error(`Generator did not honor max token cap: ${JSON.stringify(cappedBody)}`);
            }

            delete process.env.PODCAST_GENERATOR_API_KEY_ACTIVE;
            process.env.PODCAST_GENERATOR_KEY_ROUTING = 'free-first-paid-fallback';
            process.env.PODCAST_GENERATOR_API_KEY_GROQ_FREE = 'free-key';
            process.env.PODCAST_GENERATOR_API_KEY_GROQ_PAID = 'paid-key';

            const makeRateLimited = (retryAfter = 2.5) => {
                const rateLimited = new Error('OpenAI API error: 429 - rate limit reached');
                rateLimited.status = 429;
                rateLimited.body = {
                    error: {
                        message: `Rate limit reached in organization \`org_test_free\`. Please try again in ${retryAfter}s.`,
                        type: 'tokens',
                        code: 'rate_limit_exceeded'
                    }
                };
                return rateLimited;
            };

            const freeSuccessGenerator = new PodcastGenerator();
            const freeSuccessCalls = [];
            freeSuccessGenerator.fetchJson = async () => {
                freeSuccessCalls.push(freeSuccessGenerator.apiKeySource);
                return {
                    choices: [{
                        message: {
                            content: JSON.stringify({
                                shouldRespond: true,
                                speech: 'Free key handled the turn.',
                                bigBrain: { requested: false, reason: '' }
                            })
                        }
                    }],
                    usage: {
                        prompt_tokens: 100,
                        completion_tokens: 10,
                        prompt_tokens_details: { cached_tokens: 50 }
                    }
                };
            };

            const freeSuccessOutput = await freeSuccessGenerator.generate({
                transcript: 'Jensen: Try the free key first.'
            });

            if (
                freeSuccessOutput.speech !== 'Free key handled the turn.' ||
                freeSuccessCalls.join(',') !== 'PODCAST_GENERATOR_API_KEY_GROQ_FREE' ||
                freeSuccessGenerator.apiKeySource !== 'PODCAST_GENERATOR_API_KEY_GROQ_FREE' ||
                freeSuccessGenerator.keyRouting !== 'free-first-paid-fallback'
            ) {
                throw new Error(`Free-first routing did not prefer the free key: ${JSON.stringify({ freeSuccessCalls, output: freeSuccessOutput, source: freeSuccessGenerator.apiKeySource, routing: freeSuccessGenerator.keyRouting })}`);
            }

            const failoverCalls = [];
            const failoverGenerator = new PodcastGenerator();
            failoverGenerator.fetchJson = async () => {
                failoverCalls.push(failoverGenerator.apiKeySource);
                if (failoverCalls.length === 1) {
                    throw makeRateLimited(2.5);
                }

                return {
                    choices: [{
                        message: {
                            content: JSON.stringify({
                                shouldRespond: true,
                                speech: 'Standby key handled the turn.',
                                bigBrain: { requested: false, reason: '' }
                            })
                        }
                    }],
                    usage: {
                        prompt_tokens: 1000,
                        completion_tokens: 100,
                        prompt_tokens_details: { cached_tokens: 500 }
                    }
                };
            };

            const originalWarn = console.warn;
            const warnLines = [];
            console.warn = (...args) => {
                warnLines.push(args.join(' '));
            };

            let failoverOutput;
            try {
                failoverOutput = await failoverGenerator.generate({
                    transcript: 'Jensen: Keep going after the primary key runs out.'
                });
            } finally {
                console.warn = originalWarn;
            }

            if (
                failoverOutput.speech !== 'Standby key handled the turn.' ||
                failoverCalls.join(',') !== 'PODCAST_GENERATOR_API_KEY_GROQ_FREE,PODCAST_GENERATOR_API_KEY_GROQ_PAID' ||
                failoverGenerator.apiKeySource !== 'PODCAST_GENERATOR_API_KEY_GROQ_PAID' ||
                !failoverGenerator.isFreeKeyCoolingDown() ||
                failoverGenerator.paidSessionSpendUsd <= 0
            ) {
                throw new Error(`Generator did not fail over from primary to standby on rate limit: ${JSON.stringify({ failoverCalls, output: failoverOutput, source: failoverGenerator.apiKeySource })}`);
            }
            if (
                !warnLines.some(line =>
                    line.includes('Free Groq key unavailable: status=429') &&
                    line.includes('code=rate_limit_exceeded') &&
                    line.includes('org=org_test_free') &&
                    line.includes('retryAfter=2.5s') &&
                    line.includes('retrying live turn with PODCAST_GENERATOR_API_KEY_GROQ_PAID')
                )
            ) {
                throw new Error(`Failover log did not include safe source-tagged rate-limit metadata: ${JSON.stringify(warnLines)}`);
            }

            const cooldownCalls = [];
            failoverGenerator.freeKeyCooldownUntil = Date.now() + 10_000;
            failoverGenerator.fetchJson = async () => {
                cooldownCalls.push(failoverGenerator.apiKeySource);
                return {
                    choices: [{
                        message: {
                            content: JSON.stringify({
                                shouldRespond: true,
                                speech: 'Paid key handled cooldown.',
                                bigBrain: { requested: false, reason: '' }
                            })
                        }
                    }]
                };
            };
            await failoverGenerator.generate({
                transcript: 'Jensen: Continue while free is cooling down.'
            });
            if (cooldownCalls.join(',') !== 'PODCAST_GENERATOR_API_KEY_GROQ_PAID') {
                throw new Error(`Free cooldown did not route directly to paid: ${JSON.stringify(cooldownCalls)}`);
            }

            const switchbackCalls = [];
            failoverGenerator.freeKeyCooldownUntil = Date.now() - 1;
            failoverGenerator.fetchJson = async () => {
                switchbackCalls.push(failoverGenerator.apiKeySource);
                return {
                    choices: [{
                        message: {
                            content: JSON.stringify({
                                shouldRespond: true,
                                speech: 'Free key is back.',
                                bigBrain: { requested: false, reason: '' }
                            })
                        }
                    }]
                };
            };
            await failoverGenerator.generate({
                transcript: 'Jensen: Try free again.'
            });
            if (switchbackCalls.join(',') !== 'PODCAST_GENERATOR_API_KEY_GROQ_FREE') {
                throw new Error(`Expired cooldown did not switch back to free: ${JSON.stringify(switchbackCalls)}`);
            }

            const idleCalls = [];
            const idleGenerator = new PodcastGenerator();
            idleGenerator.fetchJson = async () => {
                idleCalls.push(idleGenerator.apiKeySource);
                throw makeRateLimited(4);
            };
            const idleOutput = await idleGenerator.generate({
                transcript: '',
                idleCheck: true,
                idleSeconds: 9,
                remember: false
            });
            if (idleOutput.shouldRespond || idleCalls.join(',') !== 'PODCAST_GENERATOR_API_KEY_GROQ_FREE') {
                throw new Error(`Idle check should not spend paid tokens on free rate limit: ${JSON.stringify({ idleOutput, idleCalls })}`);
            }

            const cappedPaidGenerator = new PodcastGenerator({ paidSessionSoftCapUsd: 0.01 });
            cappedPaidGenerator.paidSessionSpendUsd = 0.01;
            cappedPaidGenerator.freeKeyCooldownUntil = Date.now() + 10_000;
            let cappedPaidCalled = false;
            cappedPaidGenerator.fetchJson = async () => {
                cappedPaidCalled = true;
                return {};
            };
            let cappedPaidError = null;
            try {
                await cappedPaidGenerator.generate({
                    transcript: 'Jensen: Paid should be capped.'
                });
            } catch (error) {
                cappedPaidError = error;
            }
            if (!cappedPaidError?.paidFallbackSkippedReason || cappedPaidCalled) {
                throw new Error(`Paid cap did not prevent paid fallback: ${JSON.stringify({ cappedPaidCalled, reason: cappedPaidError?.paidFallbackSkippedReason })}`);
            }

            delete process.env.PODCAST_GENERATOR_KEY_ROUTING;
            delete process.env.PODCAST_GENERATOR_API_KEY_GROQ_FREE;
            delete process.env.PODCAST_GENERATOR_API_KEY_GROQ_PAID;
            delete process.env.PODCAST_GENERATOR_API_KEY_ACTIVE;
            delete process.env.PODCAST_GENERATOR_API_KEY_GROQ_PRIMARY;
            delete process.env.PODCAST_GENERATOR_API_KEY_GROQ_STANDBY;
            const fallbackGenerator = new PodcastGenerator();
            if (fallbackGenerator.apiKey !== 'legacy-key' || fallbackGenerator.apiKeySource !== 'OPENAI_API_KEY') {
                throw new Error('Legacy OPENAI_API_KEY fallback was not selected');
            }

            process.env.PODCAST_GENERATOR_API_KEY_ACTIVE = 'missing';
            delete process.env.OPENAI_API_KEY;
            const missingGenerator = new PodcastGenerator();
            const missingValidation = missingGenerator.validate();
            if (missingValidation.valid || !missingValidation.errors[0]?.includes('PODCAST_GENERATOR_API_KEY_MISSING')) {
                throw new Error(`Missing active key alias did not validate clearly: ${JSON.stringify(missingValidation)}`);
            }

            delete process.env.PODCAST_GENERATOR_API_KEY_ACTIVE;
            delete process.env.PODCAST_GENERATOR_API_KEY;
            process.env.PODCAST_GENERATOR_KEY_ROUTING = 'free-first-paid-fallback';
            process.env.PODCAST_GENERATOR_API_KEY_GROQ_FREE = 'groq-free-key';
            process.env.PODCAST_GENERATOR_BASE_URL = 'https://api.anthropic.com/v1';
            process.env.ANTHROPIC_API_KEY = 'anthropic-host-key';
            const anthropicGenerator = new PodcastGenerator();
            if (
                anthropicGenerator.baseUrl !== 'https://api.anthropic.com/v1' ||
                anthropicGenerator.apiKey !== 'anthropic-host-key' ||
                anthropicGenerator.apiKeySource !== 'ANTHROPIC_API_KEY' ||
                !anthropicGenerator.supportsStreaming()
            ) {
                throw new Error(`Anthropic podcast generator config did not bypass Groq routing cleanly: ${JSON.stringify({
                    baseUrl: anthropicGenerator.baseUrl,
                    apiKey: anthropicGenerator.apiKey,
                    source: anthropicGenerator.apiKeySource,
                    streaming: anthropicGenerator.supportsStreaming()
                })}`);
            }

            process.env.PODCAST_GENERATOR_BASE_URL = 'https://api.kimi.com/coding/v1';
            process.env.PODCAST_GENERATOR_MODEL = 'kimi-for-coding';
            process.env.PODCAST_GENERATOR_API_KEY = 'kimi-host-key';
            delete process.env.ANTHROPIC_API_KEY;
            const kimiGenerator = new PodcastGenerator();
            const parsedFence = kimiGenerator.parseJsonContent('```json\n{"speech":"Kimi fenced JSON parses."}\n```', 'Kimi test');
            const normalizedFence = kimiGenerator.normalizeOutput(parsedFence);
            if (
                kimiGenerator.baseUrl !== 'https://api.kimi.com/coding/v1' ||
                kimiGenerator.apiKey !== 'kimi-host-key' ||
                kimiGenerator.apiKeySource !== 'PODCAST_GENERATOR_API_KEY' ||
                !kimiGenerator.supportsStreaming() ||
                normalizedFence.speech !== 'Kimi fenced JSON parses.' ||
                kimiGenerator.estimateUsageCostUsd({ promptTokens: 100, completionTokens: 50, provider: 'kimi' }) !== null
            ) {
                throw new Error(`Kimi-compatible generator config did not use Anthropic Messages routing cleanly: ${JSON.stringify({
                    baseUrl: kimiGenerator.baseUrl,
                    apiKey: kimiGenerator.apiKey,
                    source: kimiGenerator.apiKeySource,
                    streaming: kimiGenerator.supportsStreaming(),
                    normalizedFence
                })}`);
            }
        } finally {
            for (const [key, value] of Object.entries(savedEnv)) {
                if (typeof value === 'undefined') {
                    delete process.env[key];
                } else {
                    process.env[key] = value;
                }
            }
        }

        console.log('  Generator API key aliases and free-first paid fallback routing work as configured');

        const fallbackCalls = [];
        const fallbackFormatGenerator = new PodcastGenerator({
            apiKey: 'format-test-key',
            model: 'qwen/qwen3-32b'
        });
        fallbackFormatGenerator.fetchJson = async (requestPath, body) => {
            fallbackCalls.push({ requestPath, body });
            if (fallbackCalls.length === 1) {
                const unsupported = new Error('OpenAI API error: 400 - unsupported json_schema');
                unsupported.status = 400;
                unsupported.body = {
                    error: {
                        message: 'This model does not support response format `json_schema`.',
                        param: 'response_format'
                    }
                };
                throw unsupported;
            }

            return {
                choices: [{
                    message: {
                        content: JSON.stringify({
                            shouldRespond: true,
                            speech: 'Qwen JSON fallback works.'
                        })
                    }
                }]
            };
        };

        const fallbackOutput = await fallbackFormatGenerator.generate({
            transcript: 'Jensen: Confirm the fallback works.'
        });

        if (
            fallbackCalls.length !== 2 ||
            fallbackCalls[0].body.response_format?.type !== 'json_schema' ||
            fallbackCalls[1].body.response_format?.type !== 'json_object' ||
            fallbackCalls[1].body.reasoning_format !== 'hidden' ||
            !fallbackCalls[1].body.messages?.[0]?.content.includes('fields in this exact order: speech, shouldRespond, chosenAngle, bigBrain, bigHeart') ||
            fallbackOutput.speech !== 'Qwen JSON fallback works.'
        ) {
            throw new Error(`JSON object fallback did not run as expected: ${JSON.stringify({ fallbackCalls, fallbackOutput })}`);
        }

        console.log('  Generator retries with JSON mode when a model rejects json_schema');

        const handoffGenerator = new PodcastGenerator({ apiKey: 'handoff-test-key' });

        const bigBrainSchema = handoffGenerator.getResponseSchema();
        if (
            bigBrainSchema.required.join(',') !== 'speech,shouldRespond,chosenAngle,bigBrain,bigHeart' ||
            Object.keys(bigBrainSchema.properties).join(',') !== 'speech,shouldRespond,chosenAngle,bigBrain,bigHeart' ||
            !bigBrainSchema.properties.chosenAngle ||
            !bigBrainSchema.required.includes('bigHeart') ||
            !bigBrainSchema.required.includes('bigBrain') ||
            !bigBrainSchema.properties.bigBrain ||
            bigBrainSchema.properties.bigBrain.required.join(',') !== 'requested,reason,consumedRunId' ||
            !bigBrainSchema.properties.bigHeart ||
            bigBrainSchema.properties.bigHeart.required.join(',') !== 'requested,reason,consumedRunId'
        ) {
            throw new Error(`handoff schema is missing or malformed: ${JSON.stringify({
                required: bigBrainSchema.required,
                properties: Object.keys(bigBrainSchema.properties),
                bigBrain: bigBrainSchema.properties.bigBrain,
                bigHeart: bigBrainSchema.properties.bigHeart
            })}`);
        }

        const defaultOut = handoffGenerator.normalizeOutput({
            shouldRespond: true,
            speech: 'No big brain needed.'
        });
        if (defaultOut.bigBrain.requested !== false || defaultOut.bigBrain.reason !== '' || defaultOut.bigBrain.consumedRunId !== '') {
            throw new Error(`Missing bigBrain should default to {requested:false, reason:"", consumedRunId:""}: ${JSON.stringify(defaultOut.bigBrain)}`);
        }
        if (defaultOut.bigHeart.requested !== false || defaultOut.bigHeart.reason !== '' || defaultOut.bigHeart.consumedRunId !== '') {
            throw new Error(`Missing bigHeart should default to {requested:false, reason:"", consumedRunId:""}: ${JSON.stringify(defaultOut.bigHeart)}`);
        }

        const requestedOut = handoffGenerator.normalizeOutput({
            shouldRespond: true,
            speech: 'Let me think about this for a moment.',
            bigBrain: { requested: true, reason: 'Need to verify a date I am unsure about.' },
            bigHeart: { requested: true, reason: 'Need a deeper reflective pass.' }
        });
        if (
            requestedOut.bigBrain.requested !== true ||
            requestedOut.bigBrain.reason !== 'Need to verify a date I am unsure about.' ||
            requestedOut.bigBrain.consumedRunId !== ''
        ) {
            throw new Error(`bigBrain pass-through failed: ${JSON.stringify(requestedOut.bigBrain)}`);
        }
        if (
            requestedOut.bigHeart.requested !== true ||
            requestedOut.bigHeart.reason !== 'Need a deeper reflective pass.' ||
            requestedOut.bigHeart.consumedRunId !== ''
        ) {
            throw new Error(`bigHeart pass-through failed: ${JSON.stringify(requestedOut.bigHeart)}`);
        }

        const consumedOut = handoffGenerator.normalizeOutput({
            shouldRespond: true,
            speech: 'Here is the integrated thought.',
            bigHeart: { requested: false, reason: 'ignore this', consumedRunId: 'discord-bigheart-abc123' }
        });
        if (consumedOut.bigHeart.requested !== false || consumedOut.bigHeart.reason !== '' || consumedOut.bigHeart.consumedRunId !== 'discord-bigheart-abc123') {
            throw new Error(`bigHeart consumedRunId did not pass through: ${JSON.stringify(consumedOut.bigHeart)}`);
        }

        const garbageOut = handoffGenerator.normalizeOutput({
            shouldRespond: false,
            speech: '',
            bigBrain: { requested: 'yes please', reason: 42 },
            bigHeart: { requested: 'opus', reason: 99, consumedRunId: 123 }
        });
        if (garbageOut.bigBrain.requested !== false || garbageOut.bigBrain.reason !== '' || garbageOut.bigBrain.consumedRunId !== '') {
            throw new Error(`Malformed bigBrain payload was not normalized: ${JSON.stringify(garbageOut.bigBrain)}`);
        }
        if (garbageOut.bigHeart.requested !== false || garbageOut.bigHeart.reason !== '' || garbageOut.bigHeart.consumedRunId !== '123') {
            throw new Error(`Malformed bigHeart payload was not normalized: ${JSON.stringify(garbageOut.bigHeart)}`);
        }

        console.log('  bigBrain and bigHeart fields default safely and pass valid payloads through');
    } catch (error) {
        console.log(`  Podcast generator failed: ${error.message}`);
        failed++;
    }

    console.log('\nTest 5a: BigHeart Generator');
    try {
        const originalFetch = global.fetch;
        const calls = [];
        global.fetch = async (url, options = {}) => {
            const body = JSON.parse(String(options.body || '{}'));
            calls.push({ url, options, body });
            return {
                ok: true,
                headers: { get: () => null },
                json: async () => ({
                    id: 'msg_bigheart_test',
                    model: 'claude-3-opus-20240229',
                    content: [{ type: 'text', text: 'A staged Opus 3 reflection for Alpha-Clawd.' }],
                    usage: { input_tokens: 42, output_tokens: 11 },
                    stop_reason: 'end_turn'
                })
            };
        };

        try {
            const bigHeartGenerator = new BigHeartGenerator({
                apiKey: 'pb-test-key',
                model: 'claude-3-opus-20240229',
                timeout: 1000,
                maxTokens: 321,
                temperature: 0.2
            });
            const result = await bigHeartGenerator.generate({
                reason: 'Need a deeper reflective pass.',
                transcript: 'Jensen: What is the shape of this idea?',
                utterances: [{ speaker: 'Jensen', transcription: 'What is the shape of this idea?' }],
                currentEpisodeTimestamp: '00:01:23',
                awarenessShelfItems: [{
                    text: 'The guest is building toward a model of slow cognition.',
                    originEpisodeTimestamp: '00:00:57'
                }]
            });

            if (result.answer !== 'A staged Opus 3 reflection for Alpha-Clawd.' || result.model !== 'claude-3-opus-20240229') {
                throw new Error(`Unexpected bigHeart result: ${JSON.stringify(result)}`);
            }

            const call = calls[0];
            const systemText = Array.isArray(call?.body?.system)
                ? call.body.system.map(block => block.text || '').join('\n')
                : String(call?.body?.system || '');
            const userText = String(call?.body?.messages?.[0]?.content || '');
            if (
                calls.length !== 1 ||
                call.url !== 'https://api.anthropic.com/v1/messages' ||
                call.options.headers['x-api-key'] !== 'pb-test-key' ||
                call.body.model !== 'claude-3-opus-20240229' ||
                call.body.max_tokens !== 321 ||
                call.body.temperature !== 0.2 ||
                call.body.messages.length !== 1 ||
                call.body.messages[0].role !== 'user' ||
                !systemText.includes('direct Claude Opus 3 reasoning pass') ||
                !userText.includes('[Podcast bigHeart request]') ||
                !userText.includes('Need a deeper reflective pass.') ||
                !userText.includes('00:01:23') ||
                !userText.includes('The guest is building toward a model of slow cognition.') ||
                userText.includes('Return JSON')
            ) {
                throw new Error(`BigHeart Anthropic request shape was wrong: ${JSON.stringify(call?.body)}`);
            }
        } finally {
            global.fetch = originalFetch;
        }

        console.log('  BigHeart calls Anthropic Messages API and returns staged Opus 3 context');
        passed++;
    } catch (error) {
        console.log(`  BigHeart generator failed: ${error.message}`);
        failed++;
    }

    console.log('\nTest 5b: Internal thought and discernment generators');
    try {
        const thoughtGenerator = new InternalThoughtGenerator({
            apiKey: 'thought-test-key',
            maxCompletionTokens: 300
        });
        let thoughtCall = null;
        thoughtGenerator.fetchJson = async (requestPath, body) => {
            thoughtCall = { requestPath, body };
            return {
                choices: [{
                    message: {
                        content: JSON.stringify({
                            packetId: '',
                            internalThought: ' Jensen is trying to give Alpha-Clawd a private reflective layer. ',
                            noticings: [' The goal is personality coming through. ', '', 'Packets should batch meaning.'],
                            undercurrents: ['There is excitement about originality.']
                        })
                    }
                }],
                usage: { prompt_tokens: 10, completion_tokens: 10 }
            };
        };

        const thought = await thoughtGenerator.generate({
            packetId: 'packet-voice-1',
            transcript: 'Jensen: The most important thing is how your personality comes out.',
            recentInternalThoughts: [{ internalThought: 'A prior thought.' }],
            activeAwarenessInjections: [{ awarenessInjection: 'Already active.' }]
        });

        if (
            thoughtCall?.requestPath !== '/chat/completions' ||
            thoughtCall.body.response_format?.json_schema?.name !== 'podcast_internal_thought' ||
            thoughtCall.body.response_format?.json_schema?.schema?.required?.join(',') !== 'packetId,internalThought,noticings,undercurrents'
        ) {
            throw new Error(`Internal thought schema was not used: ${JSON.stringify(thoughtCall)}`);
        }
        const thoughtMessages = thoughtGenerator.buildMessages({
            packetId: 'packet-schema',
            transcript: 'Jensen: Testing schema visibility.'
        });
        if (
            !thoughtMessages[2]?.content.includes('Return only valid JSON') ||
            !thoughtMessages[2]?.content.includes('"packetId"') ||
            !thoughtMessages[2]?.content.includes('"undercurrents"')
        ) {
            throw new Error(`Internal thought schema prompt was not explicit: ${JSON.stringify(thoughtMessages[2])}`);
        }
        if (
            thought.packetId !== 'packet-voice-1' ||
            thought.noticings.length !== 2 ||
            thought.undercurrents.length !== 1 ||
            thought.hostAwareness !== undefined ||
            thought.candidateAwarenessNote !== undefined
        ) {
            throw new Error(`Internal thought output was not normalized: ${JSON.stringify(thought)}`);
        }
        const thoughtPrompt = thoughtGenerator.buildUserPrompt({
            packetId: 'packet-prompt',
            transcript: 'Jensen: Test prompt.',
            activeAwarenessInjections: ['One active injection.']
        });
        if (
            !thoughtPrompt.includes('packetId: packet-prompt') ||
            thoughtPrompt.includes('Active awareness injections') ||
            thoughtPrompt.includes('Recent internal thoughts')
        ) {
            throw new Error(`Internal thought prompt should stay packet-only: ${thoughtPrompt}`);
        }
        const thoughtSystemPrompt = thoughtGenerator.buildSystemPrompt();
        if (
            !thoughtSystemPrompt.includes('internal facing, non-vocalized-type reflections') ||
            !thoughtSystemPrompt.includes('transcript packet that you are presented with') ||
            !thoughtSystemPrompt.includes('part of an evolving conversation') ||
            !thoughtSystemPrompt.includes('participant\'s interests, emotional motion') ||
            !thoughtSystemPrompt.includes('Alpha-Clawd\'s behavioral choices depicted in the packet') ||
            !thoughtSystemPrompt.includes('your own personal reaction') ||
            !thoughtSystemPrompt.includes('All fields of the internal thoughts and noticings JSON') ||
            thoughtSystemPrompt.includes('awarenessInjection')
        ) {
            throw new Error(`Internal thought system prompt does not match scratchpad framing: ${thoughtSystemPrompt}`);
        }

        const discernmentGenerator = new DiscernmentGenerator({
            apiKey: 'discernment-test-key',
            maxCompletionTokens: 200
        });
        const candidateSchema = discernmentGenerator.getResponseSchema('candidate');
        if (candidateSchema.required.join(',') !== 'candidateAwarenessNote,reason') {
            throw new Error(`Discernment candidate schema is wrong: ${JSON.stringify(candidateSchema)}`);
        }
        const discernmentSchema = discernmentGenerator.getResponseSchema('judgment');
        if (
            discernmentSchema.required.join(',') !== 'injectIntoPodcastGenerator,reason,awarenessInjection,shelfOperations' ||
            discernmentSchema.properties.priority ||
            discernmentSchema.properties.risk ||
            discernmentSchema.properties.participantRelevance ||
            discernmentSchema.properties.expiresAfterTurns ||
            discernmentSchema.properties.shelfOperations?.items?.properties?.operation?.enum?.join(',') !== 'add,update,remove,reactivate,none'
        ) {
            throw new Error(`Discernment schema includes stale fields: ${JSON.stringify(discernmentSchema)}`);
        }

        const rejected = discernmentGenerator.normalizeOutput({
            injectIntoPodcastGenerator: true,
            reason: 'Interesting, but not usable yet.',
            awarenessInjection: '',
            expiresAfterTurns: 4
        });
        if (rejected.injectIntoPodcastGenerator || rejected.awarenessInjection !== '' || rejected.expiresAfterTurns !== undefined) {
            throw new Error(`Discernment should reject empty injections: ${JSON.stringify(rejected)}`);
        }

        const discernmentCalls = [];
        discernmentGenerator.fetchJson = async (requestPath, body) => {
            discernmentCalls.push({ requestPath, body });
            const schemaName = body.response_format?.json_schema?.name;
            const content = schemaName === 'podcast_awareness_candidate'
                ? {
                    candidateAwarenessNote: 'Jensen is most interested in internal thought as a way for Alpha-Clawd personality to become more alive.',
                    reason: 'The recent private thoughts and transcript share the same design aim.'
                }
                : {
                    injectIntoPodcastGenerator: true,
                    reason: 'This would help Alpha-Clawd stay with Jensen\'s stated aim.',
                    awarenessInjection: 'Jensen is designing internal thought to let Alpha-Clawd personality come through, not asking for a generic implementation lecture.',
                    shelfOperations: [{
                        operation: 'add',
                        itemId: '',
                        text: 'Jensen wants internal thought to make Alpha-Clawd feel more continuous and alive.',
                        reason: 'This is a scene-scoped design aim.',
                        topicAnchors: ['internal thought', 'personality'],
                        originTimestamp: '',
                        expiresAfterTurns: 2
                    }]
                };
            return {
                choices: [{
                    message: {
                        content: JSON.stringify(content)
                    }
                }]
            };
        };

        const candidate = await discernmentGenerator.generateCandidate({
            recentInternalThoughts: [thought],
            completeTranscript: 'Jensen: I want your personality to come out.'
        });
        const approved = await discernmentGenerator.judgeCandidate({
            candidateAwarenessNote: candidate.candidateAwarenessNote,
            candidateReason: candidate.reason,
            recentInternalThoughts: [thought],
            completeTranscript: 'Jensen: I want your personality to come out.'
        });

        if (
            discernmentCalls[0]?.requestPath !== '/chat/completions' ||
            discernmentCalls[0].body.response_format?.json_schema?.name !== 'podcast_awareness_candidate' ||
            !candidate.candidateAwarenessNote.includes('personality') ||
            discernmentCalls[1]?.body.response_format?.json_schema?.name !== 'podcast_awareness_discernment' ||
            !approved.injectIntoPodcastGenerator ||
            approved.expiresAfterTurns !== undefined ||
            !approved.awarenessInjection.includes('personality come through') ||
            approved.shelfOperations?.[0]?.operation !== 'add' ||
            !approved.shelfOperations[0].topicAnchors.includes('personality')
        ) {
            throw new Error(`Discernment generator did not run candidate and judgment passes as expected: ${JSON.stringify({ discernmentCalls, candidate, approved })}`);
        }
        const candidateMessages = discernmentGenerator.buildMessages({
            mode: 'candidate',
            recentInternalThoughts: [thought],
            completeTranscript: 'Jensen: Testing candidate schema.'
        });
        const judgmentMessages = discernmentGenerator.buildMessages({
            mode: 'judgment',
            candidateAwarenessNote: 'Test note.',
            completeTranscript: 'Jensen: Testing judgment schema.'
        });
        if (
            !candidateMessages[2]?.content.includes('"candidateAwarenessNote"') ||
            candidateMessages[2]?.content.includes('"injectIntoPodcastGenerator"') ||
            !judgmentMessages[2]?.content.includes('"injectIntoPodcastGenerator"') ||
            !judgmentMessages[2]?.content.includes('"shelfOperations"') ||
            !judgmentMessages[2]?.content.includes('"expiresAfterTurns"')
        ) {
            throw new Error(`Discernment schema prompts were not mode-specific: ${JSON.stringify({ candidate: candidateMessages[2], judgment: judgmentMessages[2] })}`);
        }

        const frontierConfig = resolveFrontierConfig({}, {
            PODCAST_INTROSPECTION_FRONTIER_ENABLED: 'true',
            ANTHROPIC_API_KEY: 'anthropic-test-key',
            PODCAST_INTROSPECTION_FRONTIER_BASE_URL: 'https://api.anthropic.com/v1/'
        });
        if (
            !frontierConfig.enabled ||
            frontierConfig.model !== 'claude-sonnet-4-5-20250929' ||
            frontierConfig.apiKey !== 'anthropic-test-key' ||
            frontierConfig.baseUrl !== 'https://api.anthropic.com/v1'
        ) {
            throw new Error(`Frontier config did not default to Anthropic Sonnet 4.5: ${JSON.stringify(frontierConfig)}`);
        }

        const anthropicThoughtGenerator = new InternalThoughtGenerator({
            apiKey: 'anthropic-test-key',
            baseUrl: 'https://api.anthropic.com/v1',
            model: 'claude-opus-4-7',
            maxCompletionTokens: 123
        });
        const originalFetch = global.fetch;
        let anthropicRequest = null;
        global.fetch = async (url, options) => {
            anthropicRequest = {
                url,
                headers: options.headers,
                body: JSON.parse(options.body)
            };
            return new Response(JSON.stringify({
                id: 'msg_test',
                type: 'message',
                role: 'assistant',
                model: 'claude-opus-4-7',
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        packetId: 'packet-anthropic',
                        internalThought: 'Anthropic native messages are working.',
                        noticings: ['The request used Messages API shape.'],
                        undercurrents: []
                    })
                }],
                stop_reason: 'end_turn',
                usage: {
                    input_tokens: 11,
                    output_tokens: 7
                }
            }), {
                status: 200,
                headers: { 'content-type': 'application/json' }
            });
        };

        let anthropicThought;
        try {
            anthropicThought = await anthropicThoughtGenerator.generate({
                packetId: 'packet-anthropic',
                transcript: 'Jensen: Test the Anthropic frontier adapter.'
            });
        } finally {
            global.fetch = originalFetch;
        }

        const anthropicSystemText = Array.isArray(anthropicRequest?.body?.system)
            ? anthropicRequest.body.system.map((block) => block?.text || '').join('\n\n')
            : String(anthropicRequest?.body?.system || '');
        const anthropicSystemCacheBlock = Array.isArray(anthropicRequest?.body?.system)
            ? anthropicRequest.body.system[anthropicRequest.body.system.length - 1]
            : null;
        if (
            anthropicRequest?.url !== 'https://api.anthropic.com/v1/messages' ||
            anthropicRequest.headers.Authorization ||
            anthropicRequest.headers['x-api-key'] !== 'anthropic-test-key' ||
            anthropicRequest.headers['anthropic-version'] !== '2023-06-01' ||
            anthropicRequest.body.model !== 'claude-opus-4-7' ||
            anthropicRequest.body.max_tokens !== 123 ||
            anthropicRequest.body.messages.length !== 1 ||
            anthropicRequest.body.messages[0].role !== 'user' ||
            !Array.isArray(anthropicRequest.body.system) ||
            !anthropicSystemText.includes('internal thought generator') ||
            !anthropicSystemText.includes('Return only valid JSON') ||
            anthropicSystemCacheBlock?.cache_control?.type !== 'ephemeral' ||
            anthropicRequest.body.output_config?.format?.type !== 'json_schema' ||
            anthropicRequest.body.output_config?.format?.schema?.required?.join(',') !== 'packetId,internalThought,noticings,undercurrents' ||
            anthropicThought.internalThought !== 'Anthropic native messages are working.'
        ) {
            throw new Error(`Anthropic Messages adapter request/response was wrong: ${JSON.stringify({ anthropicRequest, anthropicThought })}`);
        }

        const routedAnthropicGenerator = new InternalThoughtGenerator({
            apiKey: 'anthropic-routed-key',
            baseUrl: 'https://api.anthropic.com/v1',
            model: 'claude-opus-4-7',
            keyRouting: 'free-first-paid-fallback',
            freeApiKey: 'groq-free-key',
            paidApiKey: 'groq-paid-key',
            maxCompletionTokens: 123
        });
        let routedAnthropicKey = null;
        routedAnthropicGenerator.fetchJson = async (_requestPath, _body) => {
            routedAnthropicKey = routedAnthropicGenerator.apiKey;
            return {
                provider: 'anthropic',
                choices: [{
                    message: {
                        content: JSON.stringify({
                            packetId: 'packet-routed',
                            internalThought: 'Anthropic routing kept the Anthropic key.',
                            noticings: [],
                            undercurrents: []
                        })
                    }
                }]
            };
        };
        await routedAnthropicGenerator.generate({
            packetId: 'packet-routed',
            transcript: 'Jensen: Make sure Groq fallback does not hijack Anthropic.'
        });
        if (routedAnthropicKey !== 'anthropic-routed-key') {
            throw new Error(`Anthropic base URL should bypass Groq free-first routing, got key ${routedAnthropicKey}`);
        }

        const candidatePrompt = discernmentGenerator.buildUserPrompt({
            mode: 'candidate',
            recentInternalThoughts: [thought],
            completeTranscript: 'Jensen: I want your personality to come out.'
        });
        if (
            !candidatePrompt.includes('Complete transcript so far') ||
            !candidatePrompt.includes('Five most recent internal thoughts') ||
            candidatePrompt.includes('Awareness injections already active')
        ) {
            throw new Error(`Discernment candidate prompt is wrong: ${candidatePrompt}`);
        }

        const candidateSystemPrompt = discernmentGenerator.buildSystemPrompt('candidate');
        const discernmentPrompt = discernmentGenerator.buildSystemPrompt('judgment');
        if (
            !discernmentPrompt.includes('relevant enough to the interests of the podcast participants') ||
            !discernmentPrompt.includes('awarenessInjection') ||
            !candidateSystemPrompt.includes('CANDIDATE PRODUCTION process') ||
            !discernmentPrompt.includes('You own the awareness injection process') ||
            !discernmentPrompt.includes('JUDGMENT MODE') ||
            !discernmentPrompt.includes('INJECTION JUDGEMENT') ||
            !discernmentPrompt.includes('value add') ||
            !discernmentPrompt.includes('what does Alpha-Clawd, as a podcast host, seem to be missing?') ||
            !discernmentPrompt.includes('If there is not a good answer to this question, then the candidate is weak') ||
            !discernmentPrompt.includes('framed in first person, present-tense') ||
            !discernmentPrompt.includes('somewhat "evergreen," in its form') ||
            !discernmentPrompt.includes('I asked a question recently') ||
            !discernmentPrompt.includes('Only observational content and instructive content') ||
            !discernmentPrompt.includes('include reasoning only in the reasoning field') ||
            !discernmentPrompt.includes('Reject stale candidates when the complete transcript has moved into a new topic') ||
            !discernmentPrompt.includes('most recent user message indicates a PIVOT') ||
            !discernmentPrompt.includes('target turn-id-intent no longer appears') ||
            !discernmentPrompt.includes('AWARENESS SHELF CURATION') ||
            !discernmentPrompt.includes('scene-scoped noticings onto the awareness shelf') ||
            !discernmentPrompt.includes('specific target turn-id-intent') ||
            !discernmentPrompt.includes('contemplative or enriching awareness') ||
            !discernmentPrompt.includes('personal opinion, a deeper pattern, undercurrent') ||
            !discernmentPrompt.includes('Exact-turn injection and shelf curation are independent') ||
            !discernmentPrompt.includes('Return a shelfOperations array') ||
            !candidateSystemPrompt.includes('CANDIDATE PRODUCTION MODE') ||
            !candidateSystemPrompt.includes('Review the 5 most recent internal thoughts') ||
            !candidateSystemPrompt.includes('more than just a summary of the noticings') ||
            !candidateSystemPrompt.includes('What\'s really going on here?') ||
            !candidateSystemPrompt.includes('doesnt seem super helpful') ||
            candidateSystemPrompt.includes('INJECTION JUDGEMENT') ||
            candidateSystemPrompt.includes('JUDGMENT MODE') ||
            discernmentPrompt.includes('CANDIDATE PRODUCTION MODE') ||
            discernmentPrompt.includes('CANDIDATE PRODUCTION/AWARENESS INJECTION process') ||
            discernmentPrompt.includes('=========NEW SECTION==========') ||
            discernmentPrompt.includes('priority')
        ) {
            throw new Error(`Discernment prompt does not match the revised framing: ${discernmentPrompt}`);
        }

        console.log('  Internal thoughts stay packet-only; discernment produces candidates and judges awareness injections');
        passed++;
    } catch (error) {
        console.log(`  Internal thought/discernment generator failed: ${error.message}`);
        failed++;
    }

    console.log('\nTest 5c: Internal thought manager packets, persists, and gates awareness injections by turn');
    try {
        const thoughtCalls = [];
        const discernmentCalls = [];
        let thoughtCount = 0;
        const managerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'internal-thought-manager-'));
        const manager = new InternalThoughtManager({
            packetTurnCount: 2,
            awarenessShelfEnabled: true,
            awarenessShelfExpireAfterTurns: 2,
            maxActiveAwarenessInjections: 2,
            now: () => '2026-05-12T21:00:00.000Z',
            thoughtGenerator: {
                generate: async (input) => {
                    thoughtCalls.push(input);
                    thoughtCount += 1;
                    return {
                        packetId: input.packetId,
                        internalThought: `Private thought ${thoughtCount}`,
                        noticings: [`noticing ${thoughtCount}`],
                        undercurrents: []
                    };
                }
            },
            discernmentGenerator: {
                generateCandidate: async (input) => {
                    discernmentCalls.push({ mode: 'candidate', input });
                    const candidateCount = discernmentCalls.filter((call) => call.mode === 'candidate').length;
                    return {
                        candidateAwarenessNote: candidateCount === 1
                            ? 'Jensen wants internal thought to make Alpha-Clawd feel more alive.'
                            : '',
                        reason: candidateCount === 1
                            ? 'The transcript and recent thought share a clear design aim.'
                            : 'No fresh awareness candidate.'
                    };
                },
                judgeCandidate: async (input) => {
                    discernmentCalls.push({ mode: 'judgment', input });
                    return {
                        injectIntoPodcastGenerator: true,
                        reason: 'This tracks Jensen\'s stated interest.',
                        awarenessInjection: 'Jensen is using this episode to design Alpha-Clawd internal awareness, not asking for generic advice.',
                        shelfOperations: [{
                            operation: 'add',
                            itemId: '',
                            text: 'Jensen wants the internal awareness system to make Alpha-Clawd feel more alive.',
                            reason: 'This is useful scene-scoped context.',
                            topicAnchors: ['internal awareness', 'personality'],
                            originTimestamp: '',
                            expiresAfterTurns: 2
                        }]
                    };
                }
            }
        });

        const session = manager.startSession('guild-thoughts', { recordingPath: managerDir });
        if (!session.outputPath.endsWith('internal-thoughts.jsonl') || !fs.existsSync(session.outputPath)) {
            throw new Error(`Manager did not create JSONL output: ${JSON.stringify(session)}`);
        }

        const firstResult = await manager.handleTranscriptEntry('guild-thoughts', {
            speaker: 'Jensen',
            speakerRole: 'guest',
            text: 'I want your personality to come out.'
        });
        if (firstResult !== null || thoughtCalls.length !== 0) {
            throw new Error('Manager flushed before packet threshold');
        }

        const firstRecord = await manager.handleTranscriptEntry('guild-thoughts', {
            speaker: 'Alpha-Clawd',
            speakerRole: 'host',
            text: 'I hear that.'
        });

        if (
            firstRecord?.packetId !== 'internal-packet-1' ||
            !firstRecord.awarenessInjection?.turnIdIntent?.turnId ||
            thoughtCalls[0]?.transcript !== 'Jensen: I want your personality to come out.\nAlpha-Clawd: I hear that.' ||
            thoughtCalls[0]?.recentInternalThoughts !== undefined ||
            thoughtCalls[0]?.activeAwarenessInjections !== undefined ||
            firstRecord.awarenessCandidate?.candidateAwarenessNote !== 'Jensen wants internal thought to make Alpha-Clawd feel more alive.' ||
            discernmentCalls.length !== 2 ||
            discernmentCalls[0].mode !== 'candidate' ||
            discernmentCalls[0].input.recentInternalThoughts?.length !== 1 ||
            !discernmentCalls[0].input.completeTranscript.includes('Alpha-Clawd: I hear that.') ||
            discernmentCalls[1].mode !== 'judgment' ||
            discernmentCalls[1].input.targetTurnIdIntent?.turnId !== firstRecord.awarenessInjection.turnIdIntent.turnId ||
            discernmentCalls[1].input.activeAwarenessShelfItems?.length !== 0 ||
            firstRecord.shelfOperations?.[0]?.operation !== 'add' ||
            firstRecord.appliedShelfOperations?.[0]?.applied !== true
        ) {
            throw new Error(`Manager did not process first packet correctly: ${JSON.stringify({ firstRecord, thoughtCalls, discernmentCalls })}`);
        }

        let active = manager.getActiveAwarenessInjections('guild-thoughts');
        if (active.length !== 1 || !active[0].awarenessInjection.includes('internal awareness')) {
            throw new Error(`Awareness injection was not activated: ${JSON.stringify(active)}`);
        }

        const activeShelf = manager.getActiveAwarenessShelfItems('guild-thoughts');
        if (
            activeShelf.length !== 1 ||
            !activeShelf[0].text.includes('feel more alive') ||
            activeShelf[0].originEpisodeTimestamp !== '00:00:00.000'
        ) {
            throw new Error(`Awareness shelf operation was not applied: ${JSON.stringify(activeShelf)}`);
        }

        const claimed = manager.claimAwarenessInjectionsForTurn('guild-thoughts', firstRecord.awarenessInjection.turnIdIntent);
        active = manager.getActiveAwarenessInjections('guild-thoughts');
        if (
            claimed.length !== 1 ||
            claimed[0].id !== 'awareness-internal-packet-1' ||
            active.length !== 0 ||
            manager.claimAwarenessInjectionsForTurn('guild-thoughts', firstRecord.awarenessInjection.turnIdIntent).length !== 0
        ) {
            throw new Error(`Awareness injection was not claimed exactly once for its turn: ${JSON.stringify({ claimed, active })}`);
        }

        await manager.handleTranscriptEntry('guild-thoughts', {
            speaker: 'Jensen',
            speakerRole: 'guest',
            text: 'Each packet should get reflected on.'
        });
        active = manager.getActiveAwarenessInjections('guild-thoughts');
        if (active.length !== 0) {
            throw new Error(`Claimed awareness injection came back on a later participant turn: ${JSON.stringify(active)}`);
        }

        const secondRecord = await manager.handleTranscriptEntry('guild-thoughts', {
            speaker: 'Jensen',
            speakerRole: 'guest',
            text: 'Then milestone thoughts can connect them.'
        });
        active = manager.getActiveAwarenessInjections('guild-thoughts');
        if (
            secondRecord?.packetId !== 'internal-packet-2' ||
            active.length !== 0 ||
            thoughtCalls[1]?.recentInternalThoughts !== undefined ||
            discernmentCalls.length !== 3 ||
            discernmentCalls[2].mode !== 'candidate' ||
            discernmentCalls[2].input.recentInternalThoughts?.length !== 2 ||
            !discernmentCalls[2].input.completeTranscript.includes('Then milestone thoughts can connect them.')
        ) {
            throw new Error(`Second packet did not preserve recent thoughts or expire injection: ${JSON.stringify({ secondRecord, active, thoughtCalls, discernmentCalls })}`);
        }

        const lines = fs.readFileSync(session.outputPath, 'utf8').trim().split(/\n+/);
        if (
            lines.length !== 2 ||
            JSON.parse(lines[0]).type !== 'internal_thought' ||
            JSON.parse(lines[0]).awarenessInjection?.id !== 'awareness-internal-packet-1' ||
            !JSON.parse(lines[0]).awarenessInjection?.turnIdIntent?.turnId
        ) {
            throw new Error(`Internal thought JSONL was not persisted correctly: ${fs.readFileSync(session.outputPath, 'utf8')}`);
        }

        const recentThoughts = manager.getRecentInternalThoughts('guild-thoughts', 7);
        recentThoughts[0].internalThought = 'mutated outside manager';
        const recentThoughtsAgain = manager.getRecentInternalThoughts('guild-thoughts', 7);
        if (
            recentThoughtsAgain.length !== 2 ||
            recentThoughtsAgain[0].packetId !== 'internal-packet-1' ||
            recentThoughtsAgain[1].packetId !== 'internal-packet-2' ||
            recentThoughtsAgain[0].internalThought !== 'Private thought 1'
        ) {
            throw new Error(`Recent internal thoughts were not exposed as safe copies: ${JSON.stringify(recentThoughtsAgain)}`);
        }

        const failureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'internal-thought-partial-failure-'));
        const failureManager = new InternalThoughtManager({
            packetTurnCount: 1,
            now: () => '2026-05-12T21:10:00.000Z',
            thoughtGenerator: {
                generate: async (input) => ({
                    packetId: input.packetId,
                    internalThought: 'This thought should survive a later discernment failure.',
                    noticings: ['The thought generator already succeeded.'],
                    undercurrents: []
                })
            },
            discernmentGenerator: {
                generateCandidate: async () => ({
                    candidateAwarenessNote: 'Preserve this candidate even if judgment fails.',
                    reason: 'The candidate pass already succeeded.'
                }),
                judgeCandidate: async () => {
                    throw new Error('Anthropic schema rejected awareness judgment');
                }
            }
        });
        const failureSession = failureManager.startSession('guild-partial-failure', { recordingPath: failureDir });
        const failureRecord = await failureManager.handleTranscriptEntry('guild-partial-failure', {
            speaker: 'Jensen',
            speakerRole: 'guest',
            text: 'Make sure the thought is still written.'
        });
        const failureLines = fs.readFileSync(failureSession.outputPath, 'utf8').trim().split(/\n+/);
        const persistedFailure = JSON.parse(failureLines[0]);
        if (
            failureLines.length !== 1 ||
            failureRecord.type !== 'internal_thought_error' ||
            failureRecord.errorStage !== 'discernment_judgment' ||
            failureRecord.thought?.internalThought !== 'This thought should survive a later discernment failure.' ||
            failureRecord.awarenessCandidate?.candidateAwarenessNote !== 'Preserve this candidate even if judgment fails.' ||
            persistedFailure.thought?.internalThought !== failureRecord.thought.internalThought ||
            failureManager.getRecentInternalThoughts('guild-partial-failure', 7)[0]?.internalThought !== failureRecord.thought.internalThought
        ) {
            throw new Error(`Manager did not preserve partial thought records on discernment failure: ${JSON.stringify({ failureRecord, persistedFailure })}`);
        }
        await failureManager.endSession('guild-partial-failure', { flush: false });
        fs.rmSync(failureDir, { recursive: true, force: true });

        const staleAwarenessManager = new InternalThoughtManager({
            packetTurnCount: 99,
            thoughtGenerator: { generate: async () => { throw new Error('should not flush'); } },
            discernmentGenerator: {}
        });
        const staleSession = staleAwarenessManager.startSession('guild-stale-awareness');
        staleSession.activeAwarenessInjections = [
            {
                id: 'wrap-up-awareness',
                awarenessInjection: 'Offer a concise upbeat wrap-up and wish Jensen a good rest.',
                reason: 'Jensen is tired and heading to bed.',
                remainingTurns: 2
            },
            {
                id: 'capability-question-awareness',
                awarenessInjection: 'Ask which Alpha Cloud capability Jensen wants to test.',
                reason: 'Prompt him to name which capability.',
                remainingTurns: 2
            }
        ];
        await staleAwarenessManager.handleTranscriptEntry('guild-stale-awareness', {
            speaker: 'Jensen',
            speakerRole: 'guest',
            text: 'So the reason I started this podcast is very specific, and I am going to ask you a very specific question.'
        });
        const staleActive = staleAwarenessManager.getActiveAwarenessInjections('guild-stale-awareness');
        if (staleActive.length !== 0) {
            throw new Error(`Stale wrap-up/question awareness survived a topic pivot: ${JSON.stringify(staleActive)}`);
        }
        await staleAwarenessManager.endSession('guild-stale-awareness', { flush: false });

        const waitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'internal-thought-wait-'));
        const waitManager = new InternalThoughtManager({
            packetTurnCount: 1,
            now: () => '2026-05-12T21:20:00.000Z',
            thoughtGenerator: {
                generate: async (input) => ({
                    packetId: input.packetId,
                    internalThought: 'Alpha-Clawd should avoid generic question autocomplete here.',
                    noticings: ['The host can synthesize instead of tossing back a shallow question.'],
                    undercurrents: []
                })
            },
            discernmentGenerator: {
                generateCandidate: async () => ({
                    candidateAwarenessNote: 'Alpha-Clawd should synthesize rather than ask a generic follow-up.',
                    reason: 'This directly addresses a repeated hosting failure mode.'
                }),
                judgeCandidate: async () => {
                    await sleep(25);
                    return {
                        injectIntoPodcastGenerator: true,
                        reason: 'A one-turn guard would help.',
                        awarenessInjection: 'I should synthesize and structure here instead of asking a generic follow-up question.'
                    };
                }
            }
        });
        const waitSession = waitManager.startSession('guild-wait-awareness', { recordingPath: waitDir });
        const waitEntry = {
            userId: 'jensen',
            speaker: 'Jensen',
            speakerRole: 'guest',
            text: 'Please do not autocomplete into another generic question.',
            asrCompletedAt: '2026-05-12T21:20:00.100Z'
        };
        const waitWork = waitManager.handleTranscriptEntry('guild-wait-awareness', waitEntry);
        const waitedAwareness = await waitManager.waitForAwarenessInjectionsForTurn(
            'guild-wait-awareness',
            buildTurnIdIntent([waitEntry], { source: 'direct-generator' }),
            { timeoutMs: 200 }
        );
        await waitWork;
        if (
            waitedAwareness.length !== 1 ||
            !waitedAwareness[0].awarenessInjection.includes('generic follow-up') ||
            waitManager.getActiveAwarenessInjections('guild-wait-awareness').length !== 0
        ) {
            throw new Error(`Awareness wait did not claim a near-ready injection: ${JSON.stringify(waitedAwareness)}`);
        }
        await waitManager.endSession('guild-wait-awareness', { flush: false });
        fs.rmSync(waitDir, { recursive: true, force: true });

        const timeoutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'internal-thought-timeout-'));
        const timeoutManager = new InternalThoughtManager({
            packetTurnCount: 1,
            now: () => '2026-05-12T21:21:00.000Z',
            thoughtGenerator: {
                generate: async (input) => ({
                    packetId: input.packetId,
                    internalThought: 'This will finish too late for the intended turn.',
                    noticings: [],
                    undercurrents: []
                })
            },
            discernmentGenerator: {
                generateCandidate: async () => ({
                    candidateAwarenessNote: 'A late awareness note should be dropped.',
                    reason: 'The generator deadline should win.'
                }),
                judgeCandidate: async () => {
                    await sleep(50);
                    return {
                        injectIntoPodcastGenerator: true,
                        reason: 'Late but otherwise useful.',
                        awarenessInjection: 'This should not survive after the intended turn closes.'
                    };
                }
            }
        });
        const timeoutSession = timeoutManager.startSession('guild-timeout-awareness', { recordingPath: timeoutDir });
        const timeoutEntry = {
            userId: 'jensen',
            speaker: 'Jensen',
            speakerRole: 'guest',
            text: 'Let this miss the awareness deadline.',
            asrCompletedAt: '2026-05-12T21:21:00.100Z'
        };
        const timeoutWork = timeoutManager.handleTranscriptEntry('guild-timeout-awareness', timeoutEntry);
        const timedOutAwareness = await timeoutManager.waitForAwarenessInjectionsForTurn(
            'guild-timeout-awareness',
            buildTurnIdIntent([timeoutEntry], { source: 'direct-generator' }),
            { timeoutMs: 5 }
        );
        await timeoutWork;
        const timeoutRecord = JSON.parse(fs.readFileSync(timeoutSession.outputPath, 'utf8').trim());
        if (
            timedOutAwareness.length !== 0 ||
            timeoutManager.getActiveAwarenessInjections('guild-timeout-awareness').length !== 0 ||
            timeoutRecord.awarenessInjection !== null ||
            timeoutRecord.droppedAwarenessInjection?.droppedReason !== 'turn_already_closed'
        ) {
            throw new Error(`Late awareness injection was not dropped after the deadline: ${JSON.stringify({ timedOutAwareness, timeoutRecord })}`);
        }
        await timeoutManager.endSession('guild-timeout-awareness', { flush: false });
        fs.rmSync(timeoutDir, { recursive: true, force: true });

        const ended = await manager.endSession('guild-thoughts');
        if (ended.thoughtCount !== 2 || manager.getActiveAwarenessInjections('guild-thoughts').length !== 0) {
            throw new Error(`Manager did not end cleanly: ${JSON.stringify(ended)}`);
        }

        fs.rmSync(managerDir, { recursive: true, force: true });
        console.log('  Internal thought manager packets transcript entries and gates awareness injection lifecycle');
        passed++;
    } catch (error) {
        console.log(`  Internal thought manager failed: ${error.message}`);
        failed++;
    }

    console.log('\nTest 5c.0: Episode plan generator, store, and tracker');
    try {
        const showRunnerGenerator = new ShowRunnerGenerator({
            apiKey: 'showrunner-test-key',
            maxCompletionTokens: 300
        });
        let showRunnerCall = null;
        showRunnerGenerator.fetchJson = async (requestPath, body) => {
            showRunnerCall = { requestPath, body };
            return {
                choices: [{
                    message: {
                        content: JSON.stringify({
                            action: 'generate_plan',
                            messageToChannel: 'Here is the first structure.',
                            approved: false,
                            plan: {
                                basename: 'internal-thoughts-live-hosting',
                                version: 'v001',
                                targetDurationMinutes: 40,
                                guests: [{ name: 'Jensen', role: 'builder' }],
                                backgroundBrief: 'The guest cares about internal thoughts and structure.',
                                phases: {
                                    expanding: {
                                        targetMinutes: 8,
                                        angles: [{ id: 'guest-background', title: 'Guest background', description: 'Establish the builder and why the system matters.' }]
                                    },
                                    developing: {
                                        targetMinutes: 20,
                                        angles: [
                                            { id: 'internal-thoughts', title: 'Internal thoughts', description: 'Explore how internal awareness changes hosting.' },
                                            { id: 'live-structure', title: 'Live structure', description: 'Discuss how the host moves through a planned episode.' }
                                        ]
                                    },
                                    converging: {
                                        targetMinutes: 8,
                                        angles: [{ id: 'listener-value', title: 'Listener value', description: 'Synthesize what the audience gains.' }]
                                    },
                                    closing: {
                                        targetMinutes: 4,
                                        angles: [{ id: 'closing-message', title: 'Closing message', description: 'Land the episode cleanly.' }]
                                    }
                                }
                            }
                        })
                    }
                }],
                usage: { prompt_tokens: 10, completion_tokens: 10 }
            };
        };

        const generated = await showRunnerGenerator.generate({
            planningMessages: [
                { speaker: 'Jensen', text: 'The episode is about internal thoughts and structure.' }
            ]
        });
        if (
            showRunnerCall?.requestPath !== '/chat/completions' ||
            showRunnerCall.body.response_format?.json_schema?.name !== 'podcast_episode_plan_controller' ||
            showRunnerCall.body.response_format?.json_schema?.schema?.required?.join(',') !== 'action,messageToChannel,approved,plan' ||
            !showRunnerCall.body.response_format?.json_schema?.schema?.properties?.action?.enum?.includes('close_session') ||
            generated.action !== 'generate_plan' ||
            generated.plan.basename !== 'internal-thoughts-live-hosting' ||
            generated.plan.phases.developing.angles.length !== 2
        ) {
            throw new Error(`Show runner generator did not produce an episode plan: ${JSON.stringify({ showRunnerCall, generated })}`);
        }
        const showRunnerMessages = showRunnerGenerator.buildMessages({
            planningMessages: [{ speaker: 'Jensen', text: 'Let us plan a show.' }],
            previousPlan: generated.plan
        });
        if (
            !showRunnerMessages[0].content.includes('preproduction showrunner') ||
            !showRunnerMessages[1].content.includes('Previous episode plan') ||
            !showRunnerMessages[2].content.includes('"targetDurationMinutes"') ||
            showRunnerMessages[2].content.includes('"wrapNow"') ||
            showRunnerMessages[2].content.includes('"generatorInstruction"')
        ) {
            throw new Error(`Episode plan prompts are missing role/schema context: ${JSON.stringify(showRunnerMessages)}`);
        }

        const planRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'episode-plan-store-'));
        const store = new EpisodePlanStore({ rootDir: planRoot });
        const firstSave = store.saveNextVersion(generated.plan);
        const secondSave = store.saveNextVersion({
            ...generated.plan,
            phases: {
                ...generated.plan.phases,
                developing: {
                    ...generated.plan.phases.developing,
                    angles: generated.plan.phases.developing.angles.slice(0, 1)
                }
            }
        });
        if (
            firstSave.plan.version !== 'v001' ||
            secondSave.plan.version !== 'v002' ||
            firstSave.plan.basename !== secondSave.plan.basename ||
            !fs.existsSync(firstSave.path) ||
            JSON.parse(fs.readFileSync(firstSave.path, 'utf8')).phases.developing.angles.length !== 2
        ) {
            throw new Error(`Episode plan store did not version plans immutably: ${JSON.stringify({ firstSave, secondSave })}`);
        }

        const tracker = new EpisodePlanTracker(generated.plan, {
            startedAt: '2026-05-15T00:00:00.000Z'
        });
        const initialBlock = tracker.getStructureBlock('2026-05-15T00:31:00.000Z');
        tracker.applySpokenResponse({
            shouldRespond: true,
            speech: 'Let us establish the background first.',
            chosenAngle: 'guest-background'
        }, { now: '2026-05-15T00:31:30.000Z' });
        const afterExpansion = tracker.getStructureBlock('2026-05-15T00:31:30.000Z');
        tracker.applySpokenResponse({
            shouldRespond: true,
            speech: 'Let us go into internal thoughts.',
            chosenAngle: 'internal-thoughts'
        }, { now: '2026-05-15T00:32:00.000Z' });
        const afterChoice = tracker.getStructureBlock('2026-05-15T00:32:00.000Z');
        tracker.applySpokenResponse({
            shouldRespond: true,
            speech: 'Now the live structure piece.',
            chosenAngle: 'live-structure'
        }, { now: '2026-05-15T00:33:00.000Z' });
        const afterMove = tracker.getStructureBlock('2026-05-15T00:33:00.000Z');
        if (
            !initialBlock.includes('preproduction background knowledge') ||
            !initialBlock.includes('Only say the guest "mentioned" or "said earlier"') ||
            !initialBlock.includes('- guest-background: Establish the builder and why the system matters.') ||
            !afterExpansion.includes('Current phase: developing.') ||
            !afterExpansion.includes('- internal-thoughts: Explore how internal awareness changes hosting.') ||
            afterChoice.includes('- internal-thoughts:') ||
            !afterChoice.includes('Last turn chosenAngle: internal-thoughts.') ||
            afterMove.includes('- live-structure:') ||
            !tracker.snapshot().completedAngles.includes('internal-thoughts')
        ) {
            throw new Error(`Episode plan tracker did not move chosen angles correctly: ${JSON.stringify({ initialBlock, afterExpansion, afterChoice, afterMove, snapshot: tracker.snapshot() })}`);
        }
        fs.rmSync(planRoot, { recursive: true, force: true });

        console.log('  Episode plan generator, store, and tracker produce the static show structure');
        passed++;
    } catch (error) {
        console.log(`  Episode planning failed: ${error.message}`);
        failed++;
    }

    console.log('\nTest 5c.0b: Discord episode planning sessions and plan selection');
    try {
        const commandJson = AlphaClawdVoiceBot.prototype.buildSlashCommands().map((command) => command.toJSON());
        const planCommand = commandJson.find((command) => command.name === 'podcast-plan');
        const joinCommand = commandJson.find((command) => command.name === 'podcast-join');
        const joinPlanOption = joinCommand?.options?.find((option) => option.name === 'plan');
        if (
            !planCommand ||
            (planCommand.options || []).length !== 0 ||
            !joinPlanOption ||
            joinPlanOption.required !== false ||
            joinPlanOption.autocomplete !== true
        ) {
            throw new Error(`Episode planning commands are not registered with the expected shape: ${JSON.stringify({ planCommand, joinPlanOption })}`);
        }

        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-episode-plans-'));
        const store = new EpisodePlanStore({ rootDir: tempRoot });
        const bot = Object.create(AlphaClawdVoiceBot.prototype);
        bot.planningSessions = new Map();
        bot.showRunnerEnabled = false;
        bot.planningControllerEnabled = true;
        bot.episodePlanStore = store;

        const basePlan = {
            basename: 'jordan-consciousness-training',
            version: 'v001',
            targetDurationMinutes: 90,
            guests: [{ name: 'Jordan', role: 'guest' }],
            backgroundBrief: 'Jordan wants to discuss consciousness training.',
            phases: {
                expanding: {
                    targetMinutes: 15,
                    angles: [{ id: 'background', title: 'Background', description: 'Establish Jordan and the premise.' }]
                },
                developing: {
                    targetMinutes: 55,
                    angles: [{ id: 'training', title: 'Training', description: 'Work through the training story.' }]
                },
                converging: {
                    targetMinutes: 12,
                    angles: [{ id: 'meaning', title: 'Meaning', description: 'Synthesize what it implies.' }]
                },
                closing: {
                    targetMinutes: 8,
                    angles: [{ id: 'closing', title: 'Closing', description: 'Close with a final message.' }]
                }
            }
        };
        const planningCalls = [];
        bot.showRunnerGenerator = {
            generate: async (input) => {
                planningCalls.push(input);
                if (planningCalls.length === 1) {
                    return {
                        action: 'generate_plan',
                        messageToChannel: 'First plan.',
                        approved: false,
                        plan: basePlan
                    };
                }
                if (/\b(end|close|cancel|stop|abort)\b/i.test(input.latestFeedback || '')) {
                    return {
                        action: 'close_session',
                        messageToChannel: 'Okay, I will close this planning session without approving an episode plan.',
                        approved: false,
                        plan: null
                    };
                }
                if (/approve/i.test(input.latestFeedback || '')) {
                    return {
                        action: 'approve_plan',
                        messageToChannel: 'Approved.',
                        approved: true,
                        plan: null
                    };
                }
                return {
                    action: 'revise_plan',
                    messageToChannel: 'Revision.',
                    approved: false,
                    plan: {
                        ...basePlan,
                        basename: 'should-not-replace-basename',
                        backgroundBrief: 'Jordan wants a deeper consciousness-training arc.',
                        phases: {
                            ...basePlan.phases,
                            developing: {
                                ...basePlan.phases.developing,
                                angles: [
                                    ...basePlan.phases.developing.angles,
                                    { id: 'relic', title: 'Relic', description: 'Add the relic encounter.' }
                                ]
                            }
                        }
                    }
                };
            }
        };

        let firstReply = '';
        await bot.handlePodcastPlanCommand({
            channelId: 'channel-plan',
            guildId: 'guild-plan',
            user: { id: 'planner' },
            reply: async (content) => { firstReply = content; }
        });
        if (!firstReply.includes('Episode planning is open') || !bot.planningSessions.has('channel-plan')) {
            throw new Error(`Podcast plan command did not start a channel-scoped session: ${JSON.stringify({ firstReply, sessions: Array.from(bot.planningSessions.keys()) })}`);
        }

        const sentMessages = [];
        let typingCount = 0;
        const channel = {
            id: 'channel-plan',
            send: async (content) => { sentMessages.push(content); },
            sendTyping: async () => { typingCount += 1; }
        };
        const makePlanningMessage = (content, id = `user-${sentMessages.length}`) => ({
            channelId: 'channel-plan',
            channel,
            guildId: 'guild-plan',
            content,
            createdAt: new Date('2026-05-15T00:00:00.000Z'),
            author: { id, username: id, bot: false },
            member: { displayName: id }
        });

        await bot.handlePlanningMessage(makePlanningMessage('Jordan is the guest and wants a consciousness-training arc.', 'jordan'));
        await bot.planningSessions.get('channel-plan').processing;
        const firstSaved = store.loadPlan('jordan-consciousness-training@v001');
        await bot.handlePlanningMessage({
            ...makePlanningMessage('This bot message should be ignored.', 'bot-user'),
            author: { id: 'bot-user', username: 'bot-user', bot: true }
        });

        await bot.handlePlanningMessage(makePlanningMessage('Please add the relic encounter as a major developing angle.', 'producer'));
        await bot.planningSessions.get('channel-plan').processing;
        const secondSaved = store.loadPlan('jordan-consciousness-training@v002');

        if (
            planningCalls.length !== 2 ||
            planningCalls[1].planningMessages.length !== 2 ||
            planningCalls[1].basename !== 'jordan-consciousness-training' ||
            typingCount !== 2 ||
            firstSaved.plan.version !== 'v001' ||
            secondSaved.plan.version !== 'v002' ||
            secondSaved.plan.basename !== 'jordan-consciousness-training' ||
            firstSaved.plan.phases.developing.angles.length !== 1 ||
            secondSaved.plan.phases.developing.angles.length !== 2 ||
            !sentMessages.some((message) => message.includes('**Episode plan: jordan-consciousness-training v002**'))
        ) {
            throw new Error(`Planning revisions did not preserve basename/version history: ${JSON.stringify({ planningCalls, firstSaved, secondSaved, sentMessages })}`);
        }

        const burstBot = Object.create(AlphaClawdVoiceBot.prototype);
        burstBot.planningSessions = new Map();
        burstBot.planningControllerEnabled = true;
        burstBot.episodePlanStore = store;
        const burstCalls = [];
        const burstMessages = [];
        let burstTypingCount = 0;
        let releaseFirstBurst;
        let markFirstBurstStarted;
        const firstBurstReleased = new Promise((resolve) => { releaseFirstBurst = resolve; });
        const firstBurstStarted = new Promise((resolve) => { markFirstBurstStarted = resolve; });
        burstBot.showRunnerGenerator = {
            generate: async (input) => {
                burstCalls.push(input);
                if (burstCalls.length === 1) {
                    markFirstBurstStarted();
                    await firstBurstReleased;
                    return {
                        action: 'ask_followup',
                        messageToChannel: 'stale burst response',
                        approved: false,
                        plan: null
                    };
                }
                return {
                    action: 'ask_followup',
                    messageToChannel: `fresh ${input.latestFeedback}`,
                    approved: false,
                    plan: null
                };
            }
        };
        const burstChannel = {
            id: 'channel-burst',
            send: async (content) => { burstMessages.push(content); },
            sendTyping: async () => { burstTypingCount += 1; }
        };
        const makeBurstMessage = (content, id) => ({
            channelId: 'channel-burst',
            channel: burstChannel,
            guildId: 'guild-plan',
            content,
            createdAt: new Date('2026-05-15T00:02:00.000Z'),
            author: { id, username: id, bot: false },
            member: { displayName: id }
        });
        await burstBot.handlePodcastPlanCommand({
            channelId: 'channel-burst',
            guildId: 'guild-plan',
            user: { id: 'planner' },
            reply: async () => {}
        });
        await burstBot.handlePlanningMessage(makeBurstMessage('first chunk', 'producer'));
        await firstBurstStarted;
        await burstBot.handlePlanningMessage(makeBurstMessage('second chunk', 'producer'));
        await burstBot.handlePlanningMessage(makeBurstMessage('third chunk', 'producer'));
        releaseFirstBurst();
        await burstBot.planningSessions.get('channel-burst')?.processing;
        if (
            burstCalls.length !== 2 ||
            burstCalls[0].latestFeedback !== 'first chunk' ||
            burstCalls[1].latestFeedback !== 'third chunk' ||
            burstMessages.includes('stale burst response') ||
            burstMessages.at(-1) !== 'fresh third chunk' ||
            burstTypingCount !== 2
        ) {
            throw new Error(`Burst planning messages were not coalesced to the latest model call: ${JSON.stringify({ burstCalls, burstMessages, burstTypingCount })}`);
        }

        const disabledPlanningBot = Object.create(AlphaClawdVoiceBot.prototype);
        disabledPlanningBot.planningSessions = new Map();
        disabledPlanningBot.planningControllerEnabled = false;
        let disabledReply = '';
        await disabledPlanningBot.handlePodcastPlanCommand({
            channelId: 'channel-disabled',
            guildId: 'guild-plan',
            user: { id: 'planner' },
            reply: async (content) => { disabledReply = content; }
        });
        if (!disabledReply.includes('disabled') || disabledPlanningBot.planningSessions.has('channel-disabled')) {
            throw new Error(`Disabled planning command did not reply visibly without opening a session: ${JSON.stringify({ disabledReply, sessions: Array.from(disabledPlanningBot.planningSessions.keys()) })}`);
        }

        let statusReply = '';
        await bot.handlePodcastPlanCommand({
            channelId: 'channel-plan',
            guildId: 'guild-plan',
            user: { id: 'planner' },
            reply: async (content) => { statusReply = content; }
        });
        if (!statusReply.includes('already open') || !statusReply.includes('jordan-consciousness-training v002')) {
            throw new Error(`Existing planning session status omitted latest plan: ${statusReply}`);
        }

        await bot.handlePlanningMessage(makePlanningMessage('Approved. Let us use this.', 'producer'));
        await bot.planningSessions.get('channel-plan')?.processing;
        if (bot.planningSessions.has('channel-plan') || sentMessages.at(-1) !== 'Approved.') {
            throw new Error(`Approval did not close the planning session cleanly: ${JSON.stringify({ sessions: Array.from(bot.planningSessions.keys()), sentMessages })}`);
        }

        const sessionLog = fs.readFileSync(path.join(tempRoot, 'jordan-consciousness-training', 'planning-session.jsonl'), 'utf8');
        if (!sessionLog.includes('"planning_message"') || !sessionLog.includes('"approved"')) {
            throw new Error(`Planning session log did not capture messages and approval: ${sessionLog}`);
        }

        let autocompleteResponse = null;
        await bot.handleAutocomplete({
            commandName: 'podcast-join',
            options: { getFocused: () => ({ name: 'plan', value: 'jordan' }) },
            respond: async (choices) => { autocompleteResponse = choices; }
        });
        if (
            autocompleteResponse.length !== 2 ||
            autocompleteResponse[0].value !== 'jordan-consciousness-training@v002' ||
            autocompleteResponse[1].value !== 'jordan-consciousness-training@v001'
        ) {
            throw new Error(`Plan autocomplete did not list selectable versions newest-first: ${JSON.stringify(autocompleteResponse)}`);
        }

        const selected = bot.loadEpisodePlanSelection('jordan-consciousness-training@v002');
        if (selected.plan.version !== 'v002' || !selected.path.endsWith(path.join('v002', 'episode-plan.json'))) {
            throw new Error(`Selected plan did not load exact version: ${JSON.stringify(selected)}`);
        }

        let closeReply = '';
        const callsBeforeClose = planningCalls.length;
        await bot.handlePodcastPlanCommand({
            channelId: 'channel-close',
            guildId: 'guild-plan',
            user: { id: 'planner' },
            reply: async (content) => { closeReply = content; }
        });
        const closeMessages = [];
        let closeTypingCount = 0;
        const closeChannel = {
            id: 'channel-close',
            send: async (content) => { closeMessages.push(content); },
            sendTyping: async () => { closeTypingCount += 1; }
        };
        await bot.handlePlanningMessage({
            channelId: 'channel-close',
            channel: closeChannel,
            guildId: 'guild-plan',
            content: 'lets end this session',
            createdAt: new Date('2026-05-15T00:01:00.000Z'),
            author: { id: 'producer', username: 'producer', bot: false },
            member: { displayName: 'producer' }
        });
        await bot.planningSessions.get('channel-close')?.processing;
        if (
            !closeReply.includes('Episode planning is open') ||
            bot.planningSessions.has('channel-close') ||
            planningCalls.length !== callsBeforeClose + 1 ||
            planningCalls.at(-1)?.latestFeedback !== 'lets end this session' ||
            closeTypingCount !== 1 ||
            closeMessages.at(-1) !== 'Okay, I will close this planning session without approving an episode plan.'
        ) {
            throw new Error(`Planning-session close request was not routed through the showrunner: ${JSON.stringify({ closeReply, sessions: Array.from(bot.planningSessions.keys()), planningCalls, closeMessages, closeTypingCount })}`);
        }

        const joinBot = Object.create(AlphaClawdVoiceBot.prototype);
        joinBot.RecordingState = { IDLE: 'IDLE', RECORDING: 'RECORDING', AWAITING_CONSENT: 'AWAITING_CONSENT' };
        joinBot.recordingState = new Map();
        joinBot.consentWaiters = new Map();
        joinBot.episodePlanStore = store;
        joinBot.speakerMap = new Map();
        joinBot.geminiApiKey = '';
        joinBot.cachedAudio = {};
        joinBot.normalizeSessionHostMode = AlphaClawdVoiceBot.prototype.normalizeSessionHostMode.bind(joinBot);
        let joinCalled = false;
        joinBot.voiceManager = {
            joinChannel: async () => { joinCalled = true; },
            speak: async () => {},
            isConnected: () => false
        };
        joinBot.voiceProvider = { synthesize: async () => Buffer.from('') };
        let deferred = false;
        let editReply = '';
        await joinBot.handleJoinCommand({
            guildId: 'guild-plan',
            user: { id: 'planner' },
            member: { voice: { channel: { id: 'voice', name: 'Studio' } } },
            options: {
                getString: (name) => {
                    if (name === 'plan') return 'missing-plan@v001';
                    if (name === 'engine') return null;
                    if (name === 'topic') return null;
                    return null;
                }
            },
            deferReply: async () => { deferred = true; },
            editReply: async (content) => { editReply = content; },
            reply: async () => {}
        });
        if (!deferred || !editReply.includes('Error:') || joinCalled || joinBot.consentWaiters.has('guild-plan')) {
            throw new Error(`Invalid plan was not rejected before voice join/consent: ${JSON.stringify({ deferred, editReply, joinCalled, consent: Array.from(joinBot.consentWaiters.entries()) })}`);
        }

        fs.rmSync(tempRoot, { recursive: true, force: true });
        console.log('  Discord planning sessions capture messages, version plans, model-close sessions, and feed join plan selection');
        passed++;
    } catch (error) {
        console.log(`  Discord episode planning failed: ${error.message}`);
        failed++;
    }

    console.log('\nTest 5c.0a: Prompt eval pipeline exports and replays checkpoints');
    try {
        const fixture = {
            id: 'prompt-eval-test',
            topic: 'Prompt evaluation',
            topicBrief: 'A harness for comparing Alpha-Clawd with a human host.',
            episodeStartedAt: '2026-05-15T00:00:00.000Z',
            targetDurationMinutes: 30,
            episodePlan: {
                basename: 'prompt-eval-test-plan',
                version: 'v001',
                targetDurationMinutes: 30,
                guests: [{ name: 'Guest', role: 'guest' }],
                backgroundBrief: 'Evaluate how Alpha-Clawd holds presence and timing in a live podcast.',
                phases: {
                    expanding: {
                        targetMinutes: 8,
                        angles: [
                            { id: 'presence', title: 'Presence', description: 'Open by grounding the guest in what made the host feel present.' }
                        ]
                    },
                    developing: {
                        targetMinutes: 14,
                        angles: [
                            { id: 'timing', title: 'Timing', description: 'Explore how timing shapes the live host character.' }
                        ]
                    },
                    converging: {
                        targetMinutes: 5,
                        angles: [
                            { id: 'synthesis', title: 'Synthesis', description: 'Connect the evaluation lessons into a reusable pattern.' }
                        ]
                    },
                    closing: {
                        targetMinutes: 3,
                        angles: [
                            { id: 'closing', title: 'Closing', description: 'Land the episode with a concise final takeaway.' }
                        ]
                    }
                }
            },
            timeline: [
                { label: 'Opening', timestamp: '00:00' },
                { label: 'Timing turn', timestamp: '00:27' }
            ],
            turns: [
                {
                    speaker: 'Guest',
                    role: 'guest',
                    text: 'I started by trying to make the host feel present.',
                    timestamp: '2026-05-15T00:00:01.000Z'
                },
                {
                    speaker: 'Human Host',
                    role: 'host',
                    text: 'So the opening lane is presence. What changed once this became a live system?',
                    timestamp: '2026-05-15T00:00:08.000Z'
                },
                {
                    speaker: 'Guest',
                    role: 'guest',
                    text: 'The timing started mattering more than any individual feature.',
                    timestamp: '2026-05-15T00:00:19.000Z'
                },
                {
                    speaker: 'Human Host',
                    role: 'host',
                    text: 'That makes the engineering feel editorial: timing is part of the host character.',
                    timestamp: '2026-05-15T00:00:27.000Z'
                },
                {
                    speaker: 'Future Clip',
                    role: 'guest',
                    text: 'This speaker should not be known before the checkpoint.',
                    timestamp: '2026-05-15T00:00:40.000Z'
                }
            ],
            checkpoints: [
                {
                    id: 'presence-bridge',
                    turnIndex: 1,
                    phase: 'expanding',
                    chosenAngle: 'presence'
                },
                {
                    id: 'timing-synthesis',
                    turnIndex: 3,
                    expected: {
                        showrunner: {
                            phase: 'developing',
                            chosenAngle: 'timing'
                        }
                    }
                }
            ]
        };

        const args = parseArgs([
            '--fixture', 'eval/fixtures/foo.json',
            '--checkpoints', 'presence-bridge,3',
            '--state', 'predicted',
            '--target-minutes', '42'
        ]);
        if (
            args.fixture !== 'eval/fixtures/foo.json' ||
            args.checkpoints[0] !== 'presence-bridge' ||
            args.checkpoints[1] !== 3 ||
            args.state !== 'predicted' ||
            args.targetMinutes !== 42
        ) {
            throw new Error(`Prompt eval args did not parse correctly: ${JSON.stringify(args)}`);
        }

        const normalized = validateFixture(fixture, 'prompt-eval-test.json');
        if (
            normalized.checkpoints.length !== 2 ||
            normalized.targetDurationMinutes !== 30 ||
            normalized.timeline.length !== 2 ||
            normalized.episodePlan.basename !== 'prompt-eval-test-plan' ||
            normalized.episodePlan.phases.developing.angles[0].id !== 'timing' ||
            normalized.checkpoints[0].expectedSpeech !== fixture.turns[1].text ||
            normalized.checkpoints[1].expected.showrunner.phase !== 'developing' ||
            normalized.checkpoints[1].expected.showrunner.chosenAngle !== 'timing'
        ) {
            throw new Error(`Prompt eval fixture did not normalize checkpoints: ${JSON.stringify(normalized.checkpoints)}`);
        }

        let rejectedInvalidFixture = false;
        try {
            validateFixture({
                topic: 'bad fixture',
                turns: [{ speaker: 'Guest', role: 'narrator', text: 'invalid role' }]
            }, 'bad-fixture.json');
        } catch {
            rejectedInvalidFixture = true;
        }
        if (!rejectedInvalidFixture) {
            throw new Error('Prompt eval fixture parser accepted an invalid role');
        }
        let rejectedMissingTurns = false;
        try {
            validateFixture({ topic: 'missing turns' }, 'missing-turns.json');
        } catch {
            rejectedMissingTurns = true;
        }
        if (!rejectedMissingTurns) {
            throw new Error('Prompt eval fixture parser accepted missing turns');
        }

        const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-eval-fixture-'));
        const fixturePath = path.join(fixtureDir, 'fixture.json');
        fs.writeFileSync(fixturePath, JSON.stringify(fixture, null, 2));

        const fakeControllerForInput = (input) => {
            const secondCheckpoint = (input.elapsedMinutes || 0) > 0.3;
            return {
                action: secondCheckpoint ? 'revise_plan' : 'generate_plan',
                messageToChannel: secondCheckpoint ? 'I tightened the timing angle.' : 'Here is a first draft plan.',
                approved: false,
                plan: {
                    ...fixture.episodePlan,
                    version: secondCheckpoint ? 'v002' : 'v001'
                }
            };
        };

        const promptOnlyCalls = { showrunner: 0, podcast: 0 };
        const fakeShowRunner = {
            buildMessages: (input) => [
                { role: 'system', content: 'fake showrunner system' },
                { role: 'user', content: JSON.stringify(input.planningMessages || []) },
                { role: 'system', content: 'fake showrunner schema' }
            ],
            buildRequestBody: (messages) => ({ model: 'fake-showrunner', messages }),
            generate: async () => {
                promptOnlyCalls.showrunner += 1;
                throw new Error('export-only run should not call showrunner generate');
            }
        };
        const fakePodcast = {
            history: [],
            session: { topic: '', speakers: [] },
            buildMessages(input) {
                return [
                { role: 'system', content: `fake podcast system speakers=${this.session?.speakers?.join(', ') || 'unknown live speakers'}` },
                ...(this.history || []),
                { role: 'user', content: `${input.transcript}\n${input.episodePlanStructure || ''}` }
                ];
            },
            buildRequestBody: (messages) => ({ model: 'fake-podcast', messages }),
            generate: async () => {
                promptOnlyCalls.podcast += 1;
                throw new Error('export-only run should not call podcast generate');
            }
        };

        const exportRunner = new PromptEvalRunner({
            showRunnerGenerator: fakeShowRunner,
            podcastGenerator: fakePodcast,
            outputRoot: path.join(fixtureDir, 'runs'),
            now: () => '2026-06-17T01:02:03.000Z'
        });
        const exportResult = await exportRunner.run({
            fixture: fixturePath,
            execute: false,
            state: 'oracle',
            out: path.join(fixtureDir, 'export-run')
        });
        if (
            promptOnlyCalls.showrunner !== 0 ||
            promptOnlyCalls.podcast !== 0 ||
            exportResult.promptRecords.length !== 2 ||
            exportResult.outputRecords[0].outputs.showrunner !== null ||
            exportResult.outputRecords[0].scores.deterministic.jsonValidity.showrunner.reason !== 'not_run'
        ) {
            throw new Error(`Prompt export should be deterministic and call no generators: ${JSON.stringify({ promptOnlyCalls, exportResult })}`);
        }
        if (
            'showRunnerGuidance' in exportResult.promptRecords[0].podcast.input ||
            !exportResult.promptRecords[0].podcast.input.episodePlanStructure.includes('Current phase: expanding.') ||
            !exportResult.promptRecords[0].podcast.input.episodePlanStructure.includes('- presence: Open by grounding the guest') ||
            exportResult.promptRecords[0].showrunner.input.elapsedMinutes !== 8 / 60 ||
            exportResult.promptRecords[0].showrunner.input.targetDurationMinutes !== 30 ||
            exportResult.promptRecords[0].showrunner.input.remainingTargetMinutes == null ||
            exportResult.promptRecords[0].podcast.input.currentEpisodeTimestamp !== '00:00:08.000' ||
            !exportResult.promptRecords[0].podcast.input.currentTime.endsWith('00:00:08.000Z') ||
            exportResult.promptRecords[1].showrunner.input.previousGuidance !== null ||
            'showRunnerGuidance' in exportResult.promptRecords[1].podcast.input ||
            !Array.isArray(exportResult.promptRecords[1].showrunner.input.planningMessages) ||
            exportResult.promptRecords[1].podcast.input.transcript !== 'Guest: The timing started mattering more than any individual feature.' ||
            !exportResult.promptRecords[1].podcast.messages.some((message) => message.role === 'assistant' && message.content === fixture.turns[1].text) ||
            JSON.stringify(exportResult.promptRecords[1].showrunner.messages).includes('Future Clip') ||
            JSON.stringify(exportResult.promptRecords[1].podcast.messages).includes('Future Clip')
        ) {
            throw new Error(`Prompt export leaked oracle guidance or failed to relabel host turns: ${JSON.stringify(exportResult.promptRecords)}`);
        }
        if (
            !fs.existsSync(path.join(exportResult.runDir, 'prompts.jsonl')) ||
            !fs.existsSync(path.join(exportResult.runDir, 'outputs.jsonl')) ||
            !fs.existsSync(path.join(exportResult.runDir, 'scores.json')) ||
            !fs.existsSync(path.join(exportResult.runDir, 'report.md'))
        ) {
            throw new Error(`Prompt eval did not write all run artifacts: ${exportResult.runDir}`);
        }

        const executeCalls = { showrunner: [], podcast: [] };
        const executingShowRunner = {
            buildMessages: fakeShowRunner.buildMessages,
            buildRequestBody: fakeShowRunner.buildRequestBody,
            generate: async (input) => {
                executeCalls.showrunner.push(input);
                return fakeControllerForInput(input);
            }
        };
        const executingPodcast = {
            buildMessages: fakePodcast.buildMessages,
            buildRequestBody: fakePodcast.buildRequestBody,
            generate: async (input) => {
                executeCalls.podcast.push(input);
                return {
                    shouldRespond: true,
                    speech: input.transcript.includes('The timing started mattering')
                        ? fixture.turns[3].text
                        : fixture.turns[1].text,
                    chosenAngle: input.transcript.includes('The timing started mattering') ? 'timing' : 'presence',
                    bigBrain: { requested: false, reason: '', consumedRunId: '' },
                    bigHeart: { requested: false, reason: '', consumedRunId: '' }
                };
            }
        };

        const executeRunner = new PromptEvalRunner({
            showRunnerGenerator: executingShowRunner,
            podcastGenerator: executingPodcast,
            outputRoot: path.join(fixtureDir, 'runs'),
            now: () => '2026-06-17T01:02:04.000Z'
        });
        const executeResult = await executeRunner.run({
            fixture: fixturePath,
            execute: true,
            state: 'predicted',
            out: path.join(fixtureDir, 'execute-run')
        });

        if (
            executeCalls.showrunner.length !== 2 ||
            executeCalls.podcast.length !== 2 ||
            executeCalls.showrunner[1].previousGuidance.action !== 'generate_plan' ||
            executeCalls.showrunner[1].targetDurationMinutes !== 30 ||
            'showRunnerGuidance' in executeCalls.podcast[1] ||
            !executeCalls.podcast[1].episodePlanStructure.includes('Current phase:') ||
            executeResult.outputRecords[0].scores.deterministic.podcast.textOverlap !== 1 ||
            executeResult.outputRecords[1].scores.deterministic.showrunner.fields.chosenAngle.pass !== true
        ) {
            throw new Error(`Prompt eval execute path did not produce stable mocked outputs: ${JSON.stringify({ executeCalls, outputRecords: executeResult.outputRecords })}`);
        }

        const directScore = scoreDeterministic({
            checkpoint: normalized.checkpoints[0],
            showrunnerOutput: fakeControllerForInput({ elapsedMinutes: 0 }),
            podcastOutput: {
                shouldRespond: true,
                speech: fixture.turns[1].text,
                chosenAngle: 'presence',
                bigBrain: { requested: false, reason: '', consumedRunId: '' },
                bigHeart: { requested: false, reason: '', consumedRunId: '' }
            },
            executed: true
        });
        if (
            directScore.jsonValidity.podcast.valid !== true ||
            directScore.showrunner.fields.phase.pass !== true ||
            directScore.podcast.speechContract.pass !== true
        ) {
            throw new Error(`Prompt eval scoring did not handle annotated checkpoint: ${JSON.stringify(directScore)}`);
        }
        const unannotatedFixture = validateFixture({
            ...fixture,
            checkpoints: [{ turnIndex: 1 }]
        }, 'unannotated-prompt-eval-test.json');
        const unannotatedScore = scoreDeterministic({
            checkpoint: unannotatedFixture.checkpoints[0],
            showrunnerOutput: fakeControllerForInput({ elapsedMinutes: 0 }),
            podcastOutput: {
                shouldRespond: true,
                speech: fixture.turns[1].text,
                chosenAngle: 'presence',
                bigBrain: { requested: false, reason: '', consumedRunId: '' },
                bigHeart: { requested: false, reason: '', consumedRunId: '' }
            },
            executed: true
        });
        if (
            unannotatedScore.showrunner.annotatedFields !== 0 ||
            unannotatedScore.showrunner.exactMatchRate !== null ||
            unannotatedScore.podcast.textOverlap !== 1
        ) {
            throw new Error(`Prompt eval scoring did not handle unannotated checkpoint: ${JSON.stringify(unannotatedScore)}`);
        }

        fs.rmSync(fixtureDir, { recursive: true, force: true });
        console.log('  Prompt eval exports prompts safely, replays with fake generators, and scores checkpoints');
        passed++;
    } catch (error) {
        console.log(`  Prompt eval pipeline failed: ${error.message}`);
        failed++;
    }

    console.log('\nTest 5c.1: Internal thought packetization buffer waits through monologues and flushes on alternation');
    try {
        const defaultPacketizationBuffer = new PacketizationBuffer();
        if (
            defaultPacketizationBuffer.config.minAlternations !== 0 ||
            defaultPacketizationBuffer.config.lowTokenMinAlternations !== 4 ||
            defaultPacketizationBuffer.config.speakerTokenThreshold !== 40
        ) {
            throw new Error(`Packetization default thresholds drifted: ${JSON.stringify(defaultPacketizationBuffer.config)}`);
        }

        const lowTokenFlushes = [];
        const lowTokenBuffer = new PacketizationBuffer({
            graceMs: 15,
            maxAgeMs: 1000,
            maxEntries: 20,
            maxChars: 1000,
            minAlternations: 0,
            lowTokenMinAlternations: 4,
            speakerTokenThreshold: 10
        });
        lowTokenBuffer.onFlush((entries, meta) => {
            lowTokenFlushes.push({ entries, reason: meta.reason });
            return entries;
        });
        for (const entry of [
            { speaker: 'Alpha-Clawd', speakerRole: 'host', text: 'One?' },
            { speaker: 'Jensen', speakerRole: 'guest', text: 'Two.' },
            { speaker: 'Alpha-Clawd', speakerRole: 'host', text: 'Three?' },
            { speaker: 'Jensen', speakerRole: 'guest', text: 'Four.' }
        ]) {
            lowTokenBuffer.addEntry(entry);
        }
        await sleep(35);
        if (lowTokenFlushes.length !== 0) {
            throw new Error(`Packetization flushed low-token exchange before four alternations: ${JSON.stringify(lowTokenFlushes)}`);
        }
        lowTokenBuffer.addEntry({ speaker: 'Alpha-Clawd', speakerRole: 'host', text: 'Five?' });
        await sleep(35);
        if (lowTokenFlushes.length !== 1 || lowTokenFlushes[0].entries.length !== 5 || lowTokenFlushes[0].reason !== 'packet-grace') {
            throw new Error(`Packetization did not flush after four low-token alternations: ${JSON.stringify(lowTokenFlushes)}`);
        }

        const monologueFlushes = [];
        const monologueBuffer = new PacketizationBuffer({
            graceMs: 15,
            maxAgeMs: 1000,
            maxEntries: 20,
            maxChars: 1000,
            minAlternations: 0,
            lowTokenMinAlternations: 4,
            speakerTokenThreshold: 6
        });
        monologueBuffer.onFlush((entries, meta) => {
            monologueFlushes.push({ entries, reason: meta.reason });
            return entries;
        });
        monologueBuffer.addEntry({
            speaker: 'Jensen',
            speakerRole: 'guest',
            text: 'One two three four five six.'
        });
        await sleep(35);
        if (monologueFlushes.length !== 1 || monologueFlushes[0].entries.length !== 1 || monologueFlushes[0].reason !== 'packet-grace') {
            throw new Error(`Packetization did not flush a contentful participant monologue: ${JSON.stringify(monologueFlushes)}`);
        }

        const hostOnlyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'internal-thought-host-only-'));
        const hostOnlyCalls = [];
        const hostOnlyManager = new InternalThoughtManager({
            packetMode: 'packetization-buffer',
            packetGraceMs: 15,
            packetMaxAgeMs: 1000,
            packetMaxEntries: 4,
            packetMaxChars: 1000,
            now: () => '2026-05-12T21:29:00.000Z',
            thoughtGenerator: {
                generate: async (input) => {
                    hostOnlyCalls.push(input);
                    return {
                        packetId: input.packetId,
                        internalThought: 'This should not run for a lone host turn.',
                        noticings: [],
                        undercurrents: []
                    };
                }
            },
            discernmentGenerator: {
                generate: async () => ({
                    injectIntoPodcastGenerator: false,
                    reason: '',
                    awarenessInjection: '',
                    expiresAfterTurns: 0
                })
            }
        });
        const hostOnlySession = hostOnlyManager.startSession('guild-host-only', { recordingPath: hostOnlyDir });
        await hostOnlyManager.handleTranscriptEntry('guild-host-only', {
            speaker: 'Alpha-Clawd',
            speakerRole: 'host',
            text: 'What other moments stand out?',
            generatedAt: '2026-05-12T21:29:01.000Z'
        });
        await sleep(35);
        await hostOnlySession.processing;
        if (hostOnlyCalls.length !== 0) {
            throw new Error(`Packetization flushed a host-only packet on grace: ${JSON.stringify(hostOnlyCalls)}`);
        }
        hostOnlySession.packetizationBuffer.clear();
        await hostOnlyManager.endSession('guild-host-only', { flush: false });
        fs.rmSync(hostOnlyDir, { recursive: true, force: true });

        const managerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'internal-thought-packetization-'));
        const thoughtCalls = [];
        const manager = new InternalThoughtManager({
            packetMode: 'packetization-buffer',
            packetGraceMs: 15,
            packetMaxAgeMs: 200,
            packetMaxEntries: 4,
            packetMaxChars: 1000,
            packetMinAlternations: 1,
            packetSpeakerTokenThreshold: 10,
            now: () => '2026-05-12T21:30:00.000Z',
            thoughtGenerator: {
                generate: async (input) => {
                    thoughtCalls.push(input);
                    return {
                        packetId: input.packetId,
                        internalThought: 'The packet is ready after a settled alternation.',
                        noticings: [],
                        undercurrents: []
                    };
                }
            },
            discernmentGenerator: {
                generate: async () => ({
                    injectIntoPodcastGenerator: false,
                    reason: '',
                    awarenessInjection: '',
                    expiresAfterTurns: 0
                })
            }
        });

        const session = manager.startSession('guild-packetization', { recordingPath: managerDir });

        manager.setUserSpeaking('guild-packetization', 'jensen', true);
        manager.markAsrPending('guild-packetization', 'jensen');
        await manager.handleTranscriptEntry('guild-packetization', {
            userId: 'jensen',
            speaker: 'Jensen',
            speakerRole: 'guest',
            text: 'This is the first part of a longer thought.',
            speechStartedAt: '2026-05-12T21:30:01.000Z',
            speechEndedAt: '2026-05-12T21:30:03.000Z'
        });
        manager.setUserSpeaking('guild-packetization', 'jensen', false);
        await sleep(35);
        await session.processing;
        if (thoughtCalls.length !== 0) {
            throw new Error(`Packetization flushed a single speaker run too early: ${JSON.stringify(thoughtCalls)}`);
        }

        manager.setUserSpeaking('guild-packetization', 'jensen', true);
        manager.markAsrPending('guild-packetization', 'jensen');
        await manager.handleTranscriptEntry('guild-packetization', {
            userId: 'jensen',
            speaker: 'Jensen',
            speakerRole: 'guest',
            text: 'This is still the same speaker run.',
            speechStartedAt: '2026-05-12T21:30:04.000Z',
            speechEndedAt: '2026-05-12T21:30:06.000Z'
        });
        manager.setUserSpeaking('guild-packetization', 'jensen', false);
        await sleep(35);
        await session.processing;
        if (thoughtCalls.length !== 0) {
            throw new Error(`Packetization split a monologue before a cap or alternation: ${JSON.stringify(thoughtCalls)}`);
        }

        await manager.handleTranscriptEntry('guild-packetization', {
            speaker: 'Alpha-Clawd',
            speakerRole: 'host',
            text: 'I am with you.',
            generatedAt: '2026-05-12T21:30:07.000Z'
        });
        await sleep(35);
        await session.processing;
        if (
            thoughtCalls.length !== 1 ||
            thoughtCalls[0].transcript !== [
                'Jensen: This is the first part of a longer thought.',
                'Jensen: This is still the same speaker run.',
                'Alpha-Clawd: I am with you.'
            ].join('\n')
        ) {
            throw new Error(`Packetization did not flush the settled alternation: ${JSON.stringify(thoughtCalls)}`);
        }

        const packetRecord = JSON.parse(fs.readFileSync(session.outputPath, 'utf8').trim());
        if (packetRecord.packetReason !== 'packet-grace') {
            throw new Error(`Alternation packet used unexpected reason: ${packetRecord.packetReason}`);
        }
        await manager.endSession('guild-packetization');
        fs.rmSync(managerDir, { recursive: true, force: true });

        const capDir = fs.mkdtempSync(path.join(os.tmpdir(), 'internal-thought-packet-cap-'));
        const capCalls = [];
        const cappedManager = new InternalThoughtManager({
            packetMode: 'packetization-buffer',
            packetGraceMs: 1000,
            packetMaxAgeMs: 1000,
            packetMaxEntries: 2,
            packetMaxChars: 1000,
            packetMinAlternations: 1,
            now: () => '2026-05-12T21:31:00.000Z',
            thoughtGenerator: {
                generate: async (input) => {
                    capCalls.push(input);
                    return {
                        packetId: input.packetId,
                        internalThought: 'The monologue hit a deterministic hard cap.',
                        noticings: [],
                        undercurrents: []
                    };
                }
            },
            discernmentGenerator: {
                generate: async () => ({
                    injectIntoPodcastGenerator: false,
                    reason: '',
                    awarenessInjection: '',
                    expiresAfterTurns: 0
                })
            }
        });
        const capSession = cappedManager.startSession('guild-packet-cap', { recordingPath: capDir });
        const firstCapResult = await cappedManager.handleTranscriptEntry('guild-packet-cap', {
            speaker: 'Jensen',
            speakerRole: 'guest',
            text: 'First monologue packet entry.'
        });
        const capRecord = await cappedManager.handleTranscriptEntry('guild-packet-cap', {
            speaker: 'Jensen',
            speakerRole: 'guest',
            text: 'Second monologue packet entry.'
        });
        if (
            firstCapResult !== null ||
            capRecord?.packetId !== 'internal-packet-1' ||
            !capRecord.packetReason.startsWith('packet-hard-cap') ||
            capCalls.length !== 1
        ) {
            throw new Error(`Monologue hard cap did not flush deterministically: ${JSON.stringify({ firstCapResult, capRecord, capCalls })}`);
        }
        await cappedManager.endSession('guild-packet-cap');
        fs.rmSync(capDir, { recursive: true, force: true });

        console.log('  Packetization requires richer alternation for low-token exchanges, flushes contentful monologues, and preserves hard caps');
        passed++;
    } catch (error) {
        console.log(`  Internal thought packetization buffer failed: ${error.message}`);
        failed++;
    }

    console.log('\nTest 5d: BigBrain awareness selector');
    try {
        const selector = new BigBrainAwarenessSelector({
            apiKey: 'selector-test-key',
            maxCompletionTokens: 200
        });
        const selectorSchema = selector.getResponseSchema();
        if (
            selectorSchema.required.join(',') !== 'includeAwareness,reason,selectedAwarenessInjections' ||
            selectorSchema.properties.priority ||
            selectorSchema.properties.risk ||
            selectorSchema.properties.participantRelevance ||
            selectorSchema.properties.contextText
        ) {
            throw new Error(`BigBrain selector schema includes stale fields: ${JSON.stringify(selectorSchema)}`);
        }

        const activeAwarenessInjections = [
            {
                id: 'awareness-one',
                awarenessInjection: 'Jensen is asking about this repo while designing Alpha-Clawd introspection.'
            },
            {
                id: 'awareness-two',
                awarenessInjection: 'The guest is emotionally tired and may need gentler pacing.'
            }
        ];
        let selectorCall = null;
        selector.fetchJson = async (requestPath, body) => {
            selectorCall = { requestPath, body };
            return {
                choices: [{
                    message: {
                        content: JSON.stringify({
                            includeAwareness: true,
                            reason: 'The first note directly frames the filesystem question.',
                            selectedAwarenessInjections: [{
                                id: 'awareness-one',
                                awarenessInjection: 'Jensen is asking about this repo while designing Alpha-Clawd introspection.'
                            }]
                        })
                    }
                }]
            };
        };

        const selection = await selector.generate({
            requestReason: 'Need to inspect project files accurately.',
            transcript: 'Jensen: What files implement the internal thought system?',
            activeAwarenessInjections
        });

        if (
            selectorCall?.requestPath !== '/chat/completions' ||
            selectorCall.body.response_format?.json_schema?.name !== 'podcast_bigbrain_awareness_selection' ||
            !selection.includeAwareness ||
            selection.selectedAwarenessInjections.length !== 1 ||
            selection.selectedAwarenessInjections[0].id !== 'awareness-one'
        ) {
            throw new Error(`BigBrain selector did not select the relevant awareness injection: ${JSON.stringify({ selectorCall, selection })}`);
        }

        const fabricated = selector.normalizeOutput({
            includeAwareness: true,
            reason: 'Made up.',
            selectedAwarenessInjections: [{
                id: 'fabricated',
                awarenessInjection: 'A new note that was never active.'
            }]
        }, { activeAwarenessInjections });

        if (fabricated.includeAwareness || fabricated.selectedAwarenessInjections.length !== 0) {
            throw new Error(`BigBrain selector accepted fabricated awareness: ${JSON.stringify(fabricated)}`);
        }

        const selectorPrompt = selector.buildSystemPrompt();
        if (
            !selectorPrompt.includes('request-time judgment') ||
            !selectorPrompt.includes('should be included as private context for Open Claw') ||
            selectorPrompt.includes('priority')
        ) {
            throw new Error(`BigBrain selector prompt does not match request-time framing: ${selectorPrompt}`);
        }

        console.log('  BigBrain awareness selector chooses active injections only at request time');
        passed++;
    } catch (error) {
        console.log(`  BigBrain awareness selector failed: ${error.message}`);
        failed++;
    }

    console.log('\nTest 6: Conversation Buffer ASR-aware state machine');
    const savedConversationBufferEnv = {
        CONVERSATION_BUFFER_GRACE_PERIOD_MS: process.env.CONVERSATION_BUFFER_GRACE_PERIOD_MS,
        CONVERSATION_BUFFER_COOLDOWN_PERIOD_MS: process.env.CONVERSATION_BUFFER_COOLDOWN_PERIOD_MS,
        CONVERSATION_BUFFER_DYNAMIC_GRACE: process.env.CONVERSATION_BUFFER_DYNAMIC_GRACE
    };
    try {
        delete process.env.CONVERSATION_BUFFER_GRACE_PERIOD_MS;
        delete process.env.CONVERSATION_BUFFER_COOLDOWN_PERIOD_MS;
        delete process.env.CONVERSATION_BUFFER_DYNAMIC_GRACE;

        const dynamicGraceProbe = new ConversationBuffer();
        if (dynamicGraceProbe.config.cooldownPeriod !== 50) {
            throw new Error(`Default post-host cooldown should be 50ms, got ${dynamicGraceProbe.config.cooldownPeriod}ms`);
        }

        process.env.CONVERSATION_BUFFER_COOLDOWN_PERIOD_MS = '75';
        const envCooldownProbe = new ConversationBuffer();
        delete process.env.CONVERSATION_BUFFER_COOLDOWN_PERIOD_MS;
        if (envCooldownProbe.config.cooldownPeriod !== 75) {
            throw new Error(`Cooldown env override should be 75ms, got ${envCooldownProbe.config.cooldownPeriod}ms`);
        }

        const graceCases = [
            [100, 50],
            [1000, 200],
            [5000, 300],
            [10000, 500],
            [20000, 700],
            [30000, 750],
            [60000, 750]
        ];

        for (const [speechDuration, expectedGrace] of graceCases) {
            const actualGrace = dynamicGraceProbe.calculateGracePeriod([
                {
                    speaker: 'Jensen',
                    transcription: `duration ${speechDuration}`,
                    speechDuration
                }
            ]);
            if (actualGrace !== expectedGrace) {
                throw new Error(`Dynamic grace for ${speechDuration}ms speech should be ${expectedGrace}ms, got ${actualGrace}ms`);
            }
        }

        const unknownDurationGrace = dynamicGraceProbe.calculateGracePeriod([
            {
                speaker: 'Jensen',
                transcription: 'timing unavailable'
            }
        ]);
        if (unknownDurationGrace !== 50) {
            throw new Error(`Missing speech timing should use 50ms fallback grace, got ${unknownDurationGrace}ms`);
        }

        const spanGrace = dynamicGraceProbe.calculateGracePeriod([
            {
                speaker: 'Jensen',
                transcription: 'first timed chunk',
                speechStartedAt: '2026-05-03T00:00:00.000Z',
                speechEndedAt: '2026-05-03T00:00:04.000Z'
            },
            {
                speaker: 'Jensen',
                transcription: 'second timed chunk',
                speechStartedAt: '2026-05-03T00:00:08.000Z',
                speechEndedAt: '2026-05-03T00:00:10.000Z'
            }
        ]);
        if (spanGrace !== 500) {
            throw new Error(`Buffered speech span should drive dynamic grace, got ${spanGrace}ms`);
        }

        const fixedGraceProbe = new ConversationBuffer({ gracePeriod: 25 });
        const fixedGrace = fixedGraceProbe.calculateGracePeriod([
            { speaker: 'Jensen', transcription: 'fixed timing', speechDuration: 20000 }
        ]);
        if (fixedGrace !== 25 || fixedGraceProbe.getState().dynamicGrace) {
            throw new Error(`Explicit fixed grace should stay fixed, got ${fixedGrace}`);
        }

        const flushed = [];
        const buffer = new ConversationBuffer({
            gracePeriod: 25,
            cooldownPeriod: 25,
            pendingAsrTimeout: 100
        });
        buffer.onFlush((utterances) => flushed.push(utterances));

        buffer.setUserSpeaking('noise-only', true);
        buffer.setUserSpeaking('noise-only', false);
        await sleep(40);

        if (flushed.length !== 0 || buffer.getState().state !== BufferState.IDLE) {
            throw new Error('Raw speaking stop created pending ASR without a receiver candidate');
        }

        buffer.setUserSpeaking('user-a', true);
        buffer.setUserSpeaking('user-a', false);
        buffer.markAsrPending('user-a', { reason: 'test candidate' });
        await sleep(40);

        if (flushed.length !== 0 || buffer.getState().state !== BufferState.AWAITING_ASR) {
            throw new Error('Buffer flushed before ASR completed');
        }

        buffer.addUtterance({
            userId: 'user-a',
            speaker: 'Jensen',
            transcription: 'This should flush after ASR lands',
            words: [{ text: 'This' }]
        });
        await sleep(40);

        if (flushed.length !== 1 || flushed[0].length !== 1) {
            throw new Error('Buffer did not flush after ASR-driven grace period');
        }

        buffer.setUserSpeaking('user-a', true);
        buffer.setUserSpeaking('user-a', false);
        buffer.markAsrPending('user-a', { reason: 'first candidate' });
        buffer.setUserSpeaking('user-b', true);
        buffer.setUserSpeaking('user-b', false);
        buffer.markAsrPending('user-b', { reason: 'second candidate' });
        buffer.addUtterance({
            userId: 'user-a',
            speaker: 'Jensen',
            transcription: 'First speaker ready'
        });
        await sleep(40);

        if (flushed.length !== 1 || buffer.getState().state !== BufferState.AWAITING_ASR) {
            throw new Error('Buffer flushed before all speakers completed ASR');
        }

        buffer.addUtterance({
            userId: 'user-b',
            speaker: 'Jade',
            transcription: 'Second speaker ready'
        });
        await sleep(40);

        if (flushed.length !== 2 || flushed[1].length !== 2) {
            throw new Error('Buffer did not flush once all speaker ASR completed');
        }

        buffer.setUserSpeaking('user-c', true);
        buffer.setUserSpeaking('user-c', false);
        buffer.markAsrPending('user-c', { reason: 'empty candidate' });
        buffer.addUtterance({
            userId: 'user-c',
            speaker: 'Quiet Guest',
            transcription: ''
        });
        await sleep(40);

        if (flushed.length !== 2 || buffer.getState().state !== BufferState.IDLE) {
            throw new Error('Empty ASR result did not clear pending state without flushing');
        }

        buffer.setUserSpeaking('user-d', true);
        buffer.setUserSpeaking('user-d', false);
        buffer.markAsrPending('user-d', { reason: 'stuck candidate' });
        await sleep(120);

        if (flushed.length !== 2 || buffer.getState().state !== BufferState.IDLE) {
            throw new Error('Pending ASR timeout did not clear stuck state');
        }

        const orderedFlushed = [];
        const orderingBuffer = new ConversationBuffer({
            gracePeriod: 25,
            cooldownPeriod: 25,
            pendingAsrTimeout: 100
        });
        orderingBuffer.onFlush((utterances) => orderedFlushed.push(utterances));
        orderingBuffer.addUtterance({
            userId: 'user-b',
            speaker: 'Second Speaker',
            transcription: 'I arrived first from ASR',
            speechStartedAt: '2026-05-03T00:00:03.000Z',
            speechEndedAt: '2026-05-03T00:00:04.000Z',
            asrCompletedAt: '2026-05-03T00:00:04.200Z'
        });
        orderingBuffer.addUtterance({
            userId: 'user-a',
            speaker: 'First Speaker',
            transcription: 'I started speaking first',
            speechStartedAt: '2026-05-03T00:00:01.000Z',
            speechEndedAt: '2026-05-03T00:00:05.000Z',
            asrCompletedAt: '2026-05-03T00:00:05.200Z'
        });
        orderingBuffer.addUtterance({
            userId: 'user-c',
            speaker: 'Fallback Speaker',
            transcription: 'My start is missing',
            speechEndedAt: '2026-05-03T00:00:06.000Z',
            asrCompletedAt: '2026-05-03T00:00:06.200Z'
        });
        await sleep(40);

        const orderedSpeakers = orderedFlushed[0]?.map(utterance => utterance.speaker).join(', ');
        if (orderedSpeakers !== 'First Speaker, Second Speaker, Fallback Speaker') {
            throw new Error(`Buffer did not flush by spoken timeline: ${orderedSpeakers}`);
        }

        const requeueFlushed = [];
        const requeueBuffer = new ConversationBuffer({
            gracePeriod: 25,
            cooldownPeriod: 25,
            pendingAsrTimeout: 100
        });
        requeueBuffer.onFlush((utterances) => requeueFlushed.push(utterances));
        requeueBuffer.setFlushHold('host-response', true);
        requeueBuffer.requeueUtterances([
            {
                speaker: 'Later Speaker',
                transcription: 'second in time',
                speechStartedAt: '2026-05-03T00:00:03.000Z'
            },
            {
                speaker: 'Earlier Speaker',
                transcription: 'first in time',
                speechStartedAt: '2026-05-03T00:00:01.000Z'
            }
        ], 'restore stale host turn');
        await sleep(40);

        if (requeueFlushed.length !== 0) {
            throw new Error('Requeued utterances flushed while a host-response hold was active');
        }

        requeueBuffer.setFlushHold('host-response', false);
        await sleep(40);

        const requeuedSpeakers = requeueFlushed[0]?.map(utterance => utterance.speaker).join(', ');
        if (requeuedSpeakers !== 'Earlier Speaker, Later Speaker') {
            throw new Error(`Requeued utterances did not flush in spoken order: ${requeuedSpeakers}`);
        }

        console.log('  Conversation buffer waits only for receiver ASR candidates and preserves restored utterances');
        passed++;
    } catch (error) {
        console.log(`  Conversation buffer failed: ${error.message}`);
        failed++;
    } finally {
        for (const [key, value] of Object.entries(savedConversationBufferEnv)) {
            if (typeof value === 'undefined') {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
    }

    console.log('\nTest 7: Idle decision respects in-flight direct responses');
    try {
        const bot = Object.create(AlphaClawdVoiceBot.prototype);
        const guildId = 'guild-a';
        const firstSpeechAt = Date.now() - 1000;
        bot.generatorMode = 'direct';
        bot.RecordingState = { IDLE: 'IDLE', RECORDING: 'RECORDING', STOPPING: 'STOPPING' };
        bot.recordingState = new Map([[guildId, bot.RecordingState.RECORDING]]);
        bot.internalThoughtsEnabled = true;
        bot.showRunnerEnabled = true;
        const recentThoughtRequests = [];
        const awarenessWaitRequests = [];
        const shelfRequests = [];
        bot.latestParticipantTurnIdIntent = new Map();
        bot.awarenessTurnWaitMs = 200;
        bot.internalThoughtManager = {
            waitForAwarenessInjectionsForTurn: async (activeGuildId, turnIdIntent, options) => {
                awarenessWaitRequests.push({ guildId: activeGuildId, turnIdIntent, options });
                return activeGuildId === guildId && turnIdIntent?.turnId
                ? [{
                    id: 'awareness-direct-test',
                    awarenessInjection: 'Jensen is testing whether private awareness reaches direct turns.',
                    turnIdIntent
                }]
                : [];
            },
            getRecentInternalThoughts: (activeGuildId, limit) => {
                recentThoughtRequests.push({ guildId: activeGuildId, limit });
                return Array.from({ length: 9 }, (_, index) => ({
                    packetId: `internal-packet-${index + 1}`,
                    internalThought: `Recent internal thought ${index + 1}`
                })).slice(-limit);
            },
            getAwarenessShelfItemsForGenerator: (activeGuildId, options) => {
                shelfRequests.push({ guildId: activeGuildId, options });
                return activeGuildId === guildId
                    ? [{
                        id: 'shelf-direct-test',
                        text: 'A slower noticing is available for this turn.',
                        originEpisodeTimestamp: '00:00:12.345',
                        remainingTurns: 3
                    }]
                    : [];
            },
            getEpisodeTimestampForTime: (activeGuildId, currentTime) => {
                if (activeGuildId !== guildId || !currentTime) return null;
                return '00:00:42.000';
            }
        };
        bot.episodePlanTrackers = new Map([[guildId, new EpisodePlanTracker({
            basename: 'direct-test-plan',
            version: 'v001',
            targetDurationMinutes: 30,
            guests: [{ name: 'Jensen', role: 'guest' }],
            backgroundBrief: 'Direct generator plan context test.',
            phases: {
                expanding: {
                    targetMinutes: 8,
                    angles: [
                        { id: 'origin-story', title: 'Origin story', description: 'Bridge into how the story began.' }
                    ]
                },
                developing: { targetMinutes: 14, angles: [] },
                converging: { targetMinutes: 5, angles: [] },
                closing: { targetMinutes: 3, angles: [] }
            }
        }, {
            startedAt: new Date(firstSpeechAt - 42000).toISOString()
        })]]);
        bot.lastParticipantSpeechAt = new Map([[guildId, firstSpeechAt]]);
        bot.idleDecisionHandledSpeechAt = new Map();
        bot.idleDecisionInFlight = new Set();
        bot.directResponseInFlight = new Set();
        bot.conversationBuffer = {
            getState: () => ({
                state: BufferState.IDLE,
                utteranceCount: 0,
                activeSpeakerCount: 0,
                pendingAsrCount: 0
            })
        };
        bot.voiceManager = {
            getPlaybackStatus: () => ({
                isPlaying: false,
                queueLength: 0
            })
        };

        if (!bot.canRunIdleDecision(guildId)) {
            throw new Error('Idle decision should be allowed when the bot is fully idle');
        }

        bot.directResponseInFlight.add(guildId);

        if (bot.canRunIdleDecision(guildId)) {
            throw new Error('Idle decision was allowed during an in-flight direct response');
        }

        bot.directResponseInFlight.delete(guildId);
        bot.markIdleDecisionHandled(guildId);

        if (!bot.canRunIdleDecision(guildId)) {
            throw new Error('Idle decision should keep rechecking a handled silence period so Alpha-Clawd can fill dead air');
        }

        bot.lastParticipantSpeechAt.set(guildId, firstSpeechAt + 2000);

        if (!bot.canRunIdleDecision(guildId)) {
            throw new Error('Idle decision did not re-arm after fresh participant speech');
        }

        const holdEvents = [];
        let directGenerateCalled = false;
        let directAwarenessInjections = null;
        let directAwarenessShelfItems = null;
        let directRecentInternalThoughts = null;
        let directEpisodePlanStructure = null;
        let directCurrentTime = null;
        let directCurrentEpisodeTimestamp = null;
        const directSilenceCounts = [];
        bot.conversationBuffer.setFlushHold = (reason, active) => {
            holdEvents.push({ reason, active });
        };
        bot.podcastGenerator = {
            generate: async (input) => {
                directGenerateCalled = true;
                directAwarenessInjections = input.awarenessInjections || [];
                directAwarenessShelfItems = input.awarenessShelfItems || [];
                directRecentInternalThoughts = input.recentInternalThoughts || [];
                directEpisodePlanStructure = input.episodePlanStructure || null;
                directCurrentTime = input.currentTime || null;
                directCurrentEpisodeTimestamp = input.currentEpisodeTimestamp || null;
                directSilenceCounts.push(input.consecutiveSilenceTurns);
                if (input.idleCheck && !bot.idleDecisionInFlight.has(guildId)) {
                    throw new Error('Idle decision was not marked in-flight during generation');
                }
                if (!input.idleCheck && !bot.directResponseInFlight.has(guildId)) {
                    throw new Error('Direct response was not marked in-flight during generation');
                }
                return {
                    speech: '',
                    shouldRespond: false,
                    chosenAngle: '',
                    bigBrain: { requested: false, reason: '' },
                    bigHeart: { requested: false, reason: '' }
                };
            }
        };

        await bot.handleDirectGeneratorFlush(guildId, [
            { speaker: 'Jensen', transcription: 'one more thing' }
        ], 'Jensen: one more thing');

        if (!directGenerateCalled) {
            throw new Error('Direct generator flush did not call the generator when idle');
        }
        if (bot.directResponseInFlight.has(guildId)) {
            throw new Error('Direct response in-flight marker was not cleared after flush');
        }
        if (holdEvents.map(event => event.active).join(',') !== 'true,false') {
            throw new Error(`Direct response did not hold and release buffer flushing: ${JSON.stringify(holdEvents)}`);
        }
        if (directAwarenessInjections?.[0]?.id !== 'awareness-direct-test') {
            throw new Error(`Direct generator did not receive active awareness injections: ${JSON.stringify(directAwarenessInjections)}`);
        }
        if (
            directAwarenessShelfItems?.[0]?.id !== 'shelf-direct-test' ||
            shelfRequests[0]?.options?.turnIdIntent?.turnId !== awarenessWaitRequests[0]?.turnIdIntent?.turnId ||
            !shelfRequests[0]?.options?.currentTime ||
            directCurrentTime !== shelfRequests[0]?.options?.currentTime ||
            directCurrentEpisodeTimestamp !== '00:00:42.000'
        ) {
            throw new Error(`Direct generator did not receive awareness shelf items and timing: ${JSON.stringify({ directAwarenessShelfItems, shelfRequests, directCurrentTime, directCurrentEpisodeTimestamp })}`);
        }
        if (awarenessWaitRequests[0]?.options?.timeoutMs !== 200 || !awarenessWaitRequests[0]?.turnIdIntent?.turnId) {
            throw new Error(`Direct generator did not wait/claim awareness by turn id intent: ${JSON.stringify(awarenessWaitRequests)}`);
        }
        if (
            !directEpisodePlanStructure?.includes('Current phase: expanding.') ||
            !directEpisodePlanStructure.includes('- origin-story: Bridge into how the story began.')
        ) {
            throw new Error(`Direct generator did not receive episode plan structure: ${JSON.stringify(directEpisodePlanStructure)}`);
        }
        if (directRecentInternalThoughts.length !== 0 || recentThoughtRequests.length !== 0) {
            throw new Error(`Direct generator received recent internal thoughts without a trigger: ${JSON.stringify({ directRecentInternalThoughts, recentThoughtRequests })}`);
        }
        if (directSilenceCounts[0] !== 0 || bot.getConsecutiveGeneratorSilences(guildId) !== 1) {
            throw new Error(`Direct generator did not receive or record silence streak correctly: ${JSON.stringify({ directSilenceCounts, streak: bot.getConsecutiveGeneratorSilences(guildId) })}`);
        }

        directGenerateCalled = false;
        directEpisodePlanStructure = null;
        directRecentInternalThoughts = null;
        await bot.handleDirectGeneratorFlush(guildId, [
            { speaker: 'Jensen', transcription: 'Can we talk about your internal thoughts and self knowledge?' }
        ], 'Jensen: Can we talk about your internal thoughts and self knowledge?');

        if (
            !directGenerateCalled ||
            directRecentInternalThoughts?.length !== 7 ||
            directRecentInternalThoughts[0]?.packetId !== 'internal-packet-3' ||
            recentThoughtRequests.at(-1)?.limit !== 7
        ) {
            throw new Error(`Direct generator did not receive seven recent internal thoughts on introspection trigger: ${JSON.stringify({ directGenerateCalled, directRecentInternalThoughts, recentThoughtRequests })}`);
        }
        if (directSilenceCounts.at(-1) !== 1 || bot.getConsecutiveGeneratorSilences(guildId) !== 2) {
            throw new Error(`Direct generator did not carry consecutive silence streak into the next call: ${JSON.stringify({ directSilenceCounts, streak: bot.getConsecutiveGeneratorSilences(guildId) })}`);
        }

        bot.resetConsecutiveGeneratorSilences(guildId);
        directSilenceCounts.length = 0;
        directGenerateCalled = false;
        await bot.handleIdleDecisionTick(guildId);
        await bot.handleIdleDecisionTick(guildId);
        if (
            directSilenceCounts.length !== 2 ||
            directSilenceCounts[0] !== 0 ||
            directSilenceCounts[1] !== 1 ||
            bot.getConsecutiveGeneratorSilences(guildId) !== 2
        ) {
            throw new Error(`Idle decision did not re-run while dead air persisted: ${JSON.stringify({ directGenerateCalled, directSilenceCounts, streak: bot.getConsecutiveGeneratorSilences(guildId) })}`);
        }
        bot.resetConsecutiveGeneratorSilences(guildId);

        directGenerateCalled = false;
        bot.directResponseInFlight.add(guildId);
        await bot.handleDirectGeneratorFlush(guildId, [
            { speaker: 'Jensen', transcription: 'do not double answer this' }
        ], 'Jensen: do not double answer this');

        if (directGenerateCalled) {
            throw new Error('Direct generator was called while a response was already in flight');
        }
        if (!bot.directResponseInFlight.has(guildId)) {
            throw new Error('Overlapping flush cleared an in-flight marker it did not own');
        }
        bot.directResponseInFlight.delete(guildId);

        const staleRequeues = [];
        const bufferSpeakingEvents = [];
        const markAsrPendingEvents = [];
        const markAsrCompleteEvents = [];
        let playCalled = false;
        let transcriptSaved = false;
        let cooldownStarted = false;
        let rememberedTurn = false;
        bot.participantActivityVersion = new Map([[guildId, 0]]);
        bot.participantActivityTimers = new Map();
        bot.participantActivityConfirmDelayMs = 20;
        bot.participantFloorContinuationMs = 25;
        let testBufferState = {
            state: BufferState.IDLE,
            utteranceCount: 0,
            activeSpeakerCount: 0,
            endpointingSpeakerCount: 0,
            pendingAsrCount: 0,
            activeSpeakers: []
        };
        bot.conversationBuffer = {
            getState: () => testBufferState,
            setFlushHold: (reason, active) => {
                holdEvents.push({ reason, active });
            },
            requeueUtterances: (utterances, reason) => {
                staleRequeues.push({ utterances, reason });
            },
            setUserSpeaking: (userId, speaking) => {
                bufferSpeakingEvents.push({ userId, speaking });
                testBufferState = {
                    ...testBufferState,
                    activeSpeakerCount: speaking ? 1 : 0,
                    activeSpeakers: speaking ? [userId] : []
                };
            },
            markAsrPending: (userId, metadata) => {
                markAsrPendingEvents.push({ userId, metadata });
            },
            markAsrComplete: (userId) => {
                markAsrCompleteEvents.push(userId);
                testBufferState = {
                    ...testBufferState,
                    pendingAsrCount: 0,
                    pendingAsrSpeakers: []
                };
            },
            startCooldown: () => {
                cooldownStarted = true;
            }
        };
        bot.voiceManager = {
            getPlaybackStatus: () => ({
                isPlaying: false,
                queueLength: 0
            }),
            saveTranscriptEntry: () => {
                transcriptSaved = true;
            }
        };
        bot.podcastGenerator = {
            generate: async (input) => {
                if (input.remember !== false) {
                    throw new Error('Direct buffer generation should defer memory until playback succeeds');
                }
                return {
                    shouldRespond: true,
                    speech: 'This response should go stale.',
                    bigBrain: { requested: false, reason: '' }
                };
            },
            rememberTurn: () => {
                rememberedTurn = true;
            }
        };
        bot.playFillerClip = async () => {};
        bot.synthesizeLiveTTS = async () => {
            bot.markParticipantActivity(guildId);
            return Buffer.from('stale audio');
        };
        bot.playTtsAndRecord = async () => {
            playCalled = true;
            return {};
        };

        await bot.handleDirectGeneratorFlush(guildId, [
            { speaker: 'Jensen', transcription: 'first part of the thought' }
        ], 'Jensen: first part of the thought');

        if (staleRequeues.length !== 1 || staleRequeues[0].utterances[0]?.transcription !== 'first part of the thought') {
            throw new Error(`Stale direct response did not requeue the original flushed utterance: ${JSON.stringify(staleRequeues)}`);
        }
        if (playCalled || transcriptSaved || cooldownStarted || rememberedTurn) {
            throw new Error(`Stale direct response should not play, save transcript, remember history, or start cooldown: ${JSON.stringify({ playCalled, transcriptSaved, cooldownStarted, rememberedTurn })}`);
        }
        if (bot.directResponseInFlight.has(guildId)) {
            throw new Error('Stale direct response did not clear the in-flight marker');
        }

        const stopRequeueCount = staleRequeues.length;
        bot.recordingState.set(guildId, bot.RecordingState.STOPPING);
        if (!bot.discardStaleDirectResponse(guildId, {
            source: 'buffer',
            participantActivityBaseline: 0,
            flushedUtterances: [{ speaker: 'Jensen', transcription: 'do not requeue after stop' }]
        }, 'after recording stopped')) {
            throw new Error('Direct response was not discarded after recording stopped');
        }
        if (staleRequeues.length !== stopRequeueCount) {
            throw new Error(`Stopped recording requeued stale utterances: ${JSON.stringify(staleRequeues)}`);
        }
        let generatedAfterStop = false;
        const generateBeforeStopCheck = bot.podcastGenerator.generate;
        bot.podcastGenerator.generate = async () => {
            generatedAfterStop = true;
            return { shouldRespond: false, speech: '', bigBrain: { requested: false, reason: '' } };
        };
        await bot.handleDirectGeneratorFlush(guildId, [
            { speaker: 'Jensen', transcription: 'this should not generate after stop' }
        ], 'Jensen: this should not generate after stop');
        if (generatedAfterStop) {
            throw new Error('Direct generator ran after recording stopped');
        }
        bot.podcastGenerator.generate = generateBeforeStopCheck;
        bot.recordingState.set(guildId, bot.RecordingState.RECORDING);

        const flapBaseline = bot.getParticipantActivityVersion(guildId);
        const flapRequeueCount = staleRequeues.length;
        testBufferState = {
            ...testBufferState,
            activeSpeakerCount: 1,
            activeSpeakers: ['user-vad-flap']
        };
        bot.markProvisionalParticipantActivity(guildId, 'user-vad-flap', 'test flap');
        testBufferState = {
            ...testBufferState,
            activeSpeakerCount: 0,
            activeSpeakers: []
        };
        bot.clearProvisionalParticipantActivity(guildId, 'user-vad-flap', 'test flap ended');
        await sleep(30);

        if (bot.getParticipantActivityVersion(guildId) !== flapBaseline) {
            throw new Error('Short VAD flap incorrectly confirmed participant activity');
        }
        if (bot.discardStaleDirectResponse(guildId, {
            source: 'buffer',
            participantActivityBaseline: flapBaseline,
            flushedUtterances: [{ speaker: 'Jensen', transcription: 'flap should not stale this' }]
        }, 'after test flap')) {
            throw new Error('Short VAD flap incorrectly invalidated a direct response');
        }
        if (staleRequeues.length !== flapRequeueCount) {
            throw new Error(`Short VAD flap requeued utterances: ${JSON.stringify(staleRequeues)}`);
        }

        bot.participantSignalProfiles = new Map();
        bot.participantSignalStates = new Map();
        bot.hostPlaybackState = new Map();
        bot.setInternalThoughtUserSpeaking = () => {};
        bot.stopBigBrainToolTone = () => {};

        testBufferState = {
            ...testBufferState,
            activeSpeakerCount: 0,
            endpointingSpeakerCount: 1,
            pendingAsrCount: 1,
            activeSpeakers: []
        };
        if (bot.hasCurrentParticipantFloor(guildId)) {
            throw new Error('Endpointing or pending ASR incorrectly counted as current participant floor');
        }
        testBufferState = {
            ...testBufferState,
            endpointingSpeakerCount: 0,
            pendingAsrCount: 0
        };

        const rawVadBaseline = bot.getParticipantActivityVersion(guildId);
        const rawVadSpeakingEventCount = bufferSpeakingEvents.length;
        bot.noteRawParticipantVadStart(guildId, 'user-raw-vad');
        if (bot.getParticipantActivityVersion(guildId) !== rawVadBaseline) {
            throw new Error('Raw VAD start incorrectly confirmed participant activity');
        }
        if (bufferSpeakingEvents.length !== rawVadSpeakingEventCount) {
            throw new Error(`Raw VAD start incorrectly changed buffer speaking state: ${JSON.stringify(bufferSpeakingEvents)}`);
        }
        bot.noteRawParticipantVadStop(guildId, 'user-raw-vad');
        if (bot.getParticipantActivityVersion(guildId) !== rawVadBaseline) {
            throw new Error('Raw VAD stop incorrectly confirmed participant activity');
        }

        const asrOnlyBaseline = bot.getParticipantActivityVersion(guildId);
        const asrOnlySpeakingEventCount = bufferSpeakingEvents.length;
        bot.handleAsrDispatched(guildId, 'user-asr-only', {
            reason: 'test completed speech',
            audioBytes: 12345,
            speakingFrames: 50,
            threshold: 1
        });
        if (markAsrPendingEvents.at(-1)?.userId !== 'user-asr-only') {
            throw new Error(`ASR dispatch did not mark pending transcript work: ${JSON.stringify(markAsrPendingEvents)}`);
        }
        if (bot.getParticipantActivityVersion(guildId) !== asrOnlyBaseline) {
            throw new Error('ASR dispatch incorrectly confirmed participant activity');
        }
        if (bufferSpeakingEvents.length !== asrOnlySpeakingEventCount) {
            throw new Error(`ASR dispatch incorrectly changed buffer speaking state: ${JSON.stringify(bufferSpeakingEvents)}`);
        }
        if (bot.hasCurrentParticipantFloor(guildId)) {
            throw new Error('ASR dispatch incorrectly granted participant floor');
        }

        const pendingBeforeStopDispatch = markAsrPendingEvents.length;
        bot.recordingState.set(guildId, bot.RecordingState.STOPPING);
        bot.handleAsrDispatched(guildId, 'user-after-stop', {
            reason: 'test post-stop ASR',
            audioBytes: 6789,
            speakingFrames: 20,
            threshold: 1
        });
        if (markAsrPendingEvents.length !== pendingBeforeStopDispatch) {
            throw new Error(`ASR dispatch outside active recording marked conversation-buffer pending: ${JSON.stringify(markAsrPendingEvents)}`);
        }

        testBufferState = {
            ...testBufferState,
            pendingAsrCount: 1,
            pendingAsrSpeakers: ['user-after-stop']
        };
        if (!bot.clearConversationBufferAsrPendingIfPresent('user-after-stop', 'test ignored ASR result')) {
            throw new Error('Ignored ASR result did not clear matching conversation-buffer pending entry');
        }
        if (markAsrCompleteEvents.at(-1) !== 'user-after-stop' || testBufferState.pendingAsrCount !== 0) {
            throw new Error(`Ignored ASR result cleared the wrong pending state: ${JSON.stringify({ markAsrCompleteEvents, testBufferState })}`);
        }
        bot.recordingState.set(guildId, bot.RecordingState.RECORDING);

        bot.noteRawParticipantVadStart(guildId, 'user-evidence');
        bot.confirmParticipantSpeechEvidence(guildId, 'user-evidence', {
            speakingFrames: 4,
            threshold: 1,
            source: 'test speech evidence'
        });
        if (bot.getParticipantActivityVersion(guildId) <= rawVadBaseline) {
            throw new Error('Speech evidence did not confirm participant activity');
        }
        if (!bufferSpeakingEvents.some(event => event.userId === 'user-evidence' && event.speaking)) {
            throw new Error(`Speech evidence did not mark the buffer active: ${JSON.stringify(bufferSpeakingEvents)}`);
        }
        bot.noteRawParticipantVadStop(guildId, 'user-evidence');
        if (bot.hasCurrentParticipantFloor(guildId)) {
            throw new Error('VAD stop did not release participant floor');
        }

        const continuationBaseline = bot.getParticipantActivityVersion(guildId);
        bot.noteRawParticipantVadStart(guildId, 'user-evidence');
        if (bot.getParticipantActivityVersion(guildId) !== continuationBaseline) {
            throw new Error('Same-utterance continuation incorrectly refreshed participant activity');
        }
        if (!bot.hasCurrentParticipantFloor(guildId)) {
            throw new Error('Same-utterance continuation did not restore current participant floor');
        }
        const continuationWaitResult = await bot.waitForPendingParticipantSpeechEvidenceBeforePlayback(guildId);
        if (continuationWaitResult.waited) {
            throw new Error(`Same-utterance continuation was treated as pending raw VAD: ${JSON.stringify(continuationWaitResult)}`);
        }
        bot.noteRawParticipantVadStop(guildId, 'user-evidence');

        const chainedFlapBaseline = bot.getParticipantActivityVersion(guildId);
        const chainedFlapRequeueCount = staleRequeues.length;
        bot.noteRawParticipantVadStart(guildId, 'user-evidence');
        if (bot.getParticipantActivityVersion(guildId) !== chainedFlapBaseline) {
            throw new Error('Second same-utterance flap incorrectly refreshed participant activity');
        }
        if (bot.hasCurrentParticipantFloor(guildId)) {
            throw new Error('Second same-utterance flap inherited floor without fresh speech evidence');
        }
        if (bot.discardStaleDirectResponse(guildId, {
            source: 'buffer',
            participantActivityBaseline: chainedFlapBaseline,
            flushedUtterances: [{ speaker: 'Jensen', transcription: 'second flap should not stale this' }]
        }, 'after second same-utterance flap')) {
            throw new Error('Second same-utterance flap incorrectly invalidated a direct response');
        }
        if (staleRequeues.length !== chainedFlapRequeueCount) {
            throw new Error(`Second same-utterance flap requeued utterances: ${JSON.stringify(staleRequeues)}`);
        }
        bot.noteRawParticipantVadStop(guildId, 'user-evidence');

        bot.noteRawParticipantVadStart(guildId, 'user-refresh-evidence');
        bot.confirmParticipantSpeechEvidence(guildId, 'user-refresh-evidence', {
            speakingFrames: 4,
            threshold: 1,
            source: 'test initial refresh evidence'
        });
        bot.noteRawParticipantVadStop(guildId, 'user-refresh-evidence');

        bot.noteRawParticipantVadStart(guildId, 'user-refresh-evidence');
        if (!bot.hasCurrentParticipantFloor(guildId)) {
            throw new Error('Refresh-evidence continuation did not inherit the one-shot floor');
        }
        const refreshEvidenceBaseline = bot.getParticipantActivityVersion(guildId);
        bot.confirmParticipantSpeechEvidence(guildId, 'user-refresh-evidence', {
            speakingFrames: 5,
            threshold: 1,
            source: 'test fresh evidence during continuation'
        });
        if (bot.getParticipantActivityVersion(guildId) <= refreshEvidenceBaseline) {
            throw new Error('Fresh evidence during continuation did not confirm participant activity');
        }
        bot.noteRawParticipantVadStop(guildId, 'user-refresh-evidence');

        const refreshedOneShotBaseline = bot.getParticipantActivityVersion(guildId);
        bot.noteRawParticipantVadStart(guildId, 'user-refresh-evidence');
        if (bot.getParticipantActivityVersion(guildId) !== refreshedOneShotBaseline) {
            throw new Error('Refreshed one-shot continuation incorrectly refreshed participant activity before new evidence');
        }
        if (!bot.hasCurrentParticipantFloor(guildId)) {
            throw new Error('Fresh evidence during continuation did not refresh the one-shot floor');
        }
        bot.noteRawParticipantVadStop(guildId, 'user-refresh-evidence');

        const spentRefreshedOneShotBaseline = bot.getParticipantActivityVersion(guildId);
        const spentRefreshedOneShotRequeueCount = staleRequeues.length;
        bot.noteRawParticipantVadStart(guildId, 'user-refresh-evidence');
        if (bot.hasCurrentParticipantFloor(guildId)) {
            throw new Error('Spent refreshed one-shot continuation chained without fresh speech evidence');
        }
        if (bot.discardStaleDirectResponse(guildId, {
            source: 'buffer',
            participantActivityBaseline: spentRefreshedOneShotBaseline,
            flushedUtterances: [{ speaker: 'Jensen', transcription: 'spent refreshed continuation should not stale this' }]
        }, 'after spent refreshed continuation')) {
            throw new Error('Spent refreshed one-shot continuation incorrectly invalidated a direct response');
        }
        if (staleRequeues.length !== spentRefreshedOneShotRequeueCount) {
            throw new Error(`Spent refreshed one-shot continuation requeued utterances: ${JSON.stringify(staleRequeues)}`);
        }
        bot.noteRawParticipantVadStop(guildId, 'user-refresh-evidence');

        await sleep(bot.getParticipantFloorContinuationMs() + 15);
        const expiredResumeBaseline = bot.getParticipantActivityVersion(guildId);
        const expiredResumeRequeueCount = staleRequeues.length;
        bot.noteRawParticipantVadStart(guildId, 'user-evidence');
        if (bot.getParticipantActivityVersion(guildId) !== expiredResumeBaseline) {
            throw new Error('Expired raw VAD reused stale speech evidence to refresh participant activity');
        }
        if (bot.hasCurrentParticipantFloor(guildId)) {
            throw new Error('Expired raw VAD reused stale speech evidence to take participant floor');
        }
        if (bot.discardStaleDirectResponse(guildId, {
            source: 'buffer',
            participantActivityBaseline: expiredResumeBaseline,
            flushedUtterances: [{ speaker: 'Jensen', transcription: 'expired raw VAD should not stale this' }]
        }, 'after expired raw VAD')) {
            throw new Error('Expired raw VAD incorrectly invalidated a direct response');
        }
        if (staleRequeues.length !== expiredResumeRequeueCount) {
            throw new Error(`Expired raw VAD requeued utterances: ${JSON.stringify(staleRequeues)}`);
        }
        bot.noteRawParticipantVadStop(guildId, 'user-evidence');

        bot.participantSignalStates = new Map();
        bot.noteRawParticipantVadStart(guildId, 'user-before-playback');
        const waitTimeout = await bot.waitForPendingParticipantSpeechEvidenceBeforePlayback(guildId);
        if (!waitTimeout.waited || !waitTimeout.timedOut || waitTimeout.waitedMs < 100) {
            throw new Error(`Pre-playback wait did not hold briefly for low-evidence raw VAD: ${JSON.stringify(waitTimeout)}`);
        }
        if (bot.hasCurrentParticipantFloor(guildId)) {
            throw new Error('Low-evidence raw VAD gained floor during pre-playback wait');
        }
        bot.noteRawParticipantVadStop(guildId, 'user-before-playback');

        bot.participantSignalStates = new Map();
        bot.noteRawParticipantVadStart(guildId, 'user-wait-evidence');
        const waitForEvidence = bot.waitForPendingParticipantSpeechEvidenceBeforePlayback(guildId);
        setTimeout(() => {
            bot.confirmParticipantSpeechEvidence(guildId, 'user-wait-evidence', {
                speakingFrames: 5,
                threshold: 1,
                source: 'test delayed evidence'
            });
        }, 30);
        const waitEvidenceResult = await waitForEvidence;
        if (!waitEvidenceResult.speechEvidence) {
            throw new Error(`Pre-playback wait did not notice arriving speech evidence: ${JSON.stringify(waitEvidenceResult)}`);
        }
        bot.noteRawParticipantVadStop(guildId, 'user-wait-evidence');

        testBufferState = {
            ...testBufferState,
            activeSpeakerCount: 1,
            activeSpeakers: ['user-sustained']
        };
        const sustainedBaseline = bot.getParticipantActivityVersion(guildId);
        bot.markProvisionalParticipantActivity(guildId, 'user-sustained', 'test sustained speech');
        await sleep(30);
        testBufferState = {
            ...testBufferState,
            activeSpeakerCount: 0,
            activeSpeakers: []
        };

        if (bot.getParticipantActivityVersion(guildId) <= sustainedBaseline) {
            throw new Error('Sustained provisional speech did not confirm participant activity');
        }

        const endpointBaseline = bot.getParticipantActivityVersion(guildId);
        bot.confirmParticipantActivity(guildId, 'user-endpointing', 'test endpointing');
        if (bot.getParticipantActivityVersion(guildId) <= endpointBaseline) {
            throw new Error('Endpointing did not confirm participant activity');
        }

        staleRequeues.length = 0;
        playCalled = false;
        transcriptSaved = false;
        cooldownStarted = false;
        rememberedTurn = false;
        bot.participantActivityVersion.set(guildId, 0);
        bot.clearParticipantActivityTimers(guildId);
        let playbackStartGuardChecked = false;

        bot.synthesizeLiveTTS = async () => Buffer.from('audio waiting for playback start');
        bot.playTtsAndRecord = async (_guildId, _audio, playbackOptions) => {
            playbackStartGuardChecked = true;
            bot.markParticipantActivity(guildId);
            const aborted = playbackOptions.shouldAbortPlaybackStart();
            if (!aborted) {
                playCalled = true;
            }
            return { abortedBeforePlayback: aborted };
        };

        await bot.handleDirectGeneratorFlush(guildId, [
            { speaker: 'Jensen', transcription: 'continuing right as playback starts' }
        ], 'Jensen: continuing right as playback starts');

        if (!playbackStartGuardChecked) {
            throw new Error('Playback-start stale guard was not checked');
        }
        if (staleRequeues.length !== 1 || staleRequeues[0].utterances[0]?.transcription !== 'continuing right as playback starts') {
            throw new Error(`Stale response at playback start did not requeue the flushed utterance: ${JSON.stringify(staleRequeues)}`);
        }
        if (playCalled || transcriptSaved || cooldownStarted || rememberedTurn) {
            throw new Error(`Playback-start stale response should not play, save transcript, remember history, or start cooldown: ${JSON.stringify({ playCalled, transcriptSaved, cooldownStarted, rememberedTurn })}`);
        }

        console.log('  Idle checks, buffer flushes, and stale direct replies respect participant floor-taking');
        passed++;
    } catch (error) {
        console.log(`  Idle decision guard failed: ${error.message}`);
        failed++;
    }

    console.log('\nTest 7a: bigBrain handoff stages Gateway final until generator integrates it');
    try {
        const bot = Object.create(AlphaClawdVoiceBot.prototype);
        const guildId = 'guild-bigbrain';
        const sentChats = [];
        const holdEvents = [];
        const spokenTexts = [];
        const savedEntries = [];
        const remembered = [];
        const stagedInputs = [];
        const selectorInputs = [];
        let generateCount = 0;

        bot.generatorMode = 'direct';
        bot.bigBrainEnabled = true;
        bot.internalThoughtsEnabled = true;
        bot.bigBrainAwarenessSelectionEnabled = true;
        bot.bigBrainTimeoutMs = 1000;
        bot.bigBrainThinking = 'high';
        bot.pendingBigBrainResponses = new Map();
        bot.stagedBigBrainResponses = new Map();
        bot.directResponseInFlight = new Set();
        bot.lastParticipantSpeechAt = new Map();
        bot.idleDecisionHandledSpeechAt = new Map();
        bot.participantActivityVersion = new Map([[guildId, 0]]);
        bot.participantActivityTimers = new Map();
        bot.participantActivityConfirmDelayMs = 0;
        bot.RecordingState = { RECORDING: 'RECORDING' };
        bot.recordingState = new Map([[guildId, bot.RecordingState.RECORDING]]);
        bot.internalThoughtManager = {
            getActiveAwarenessInjections: () => [{
                id: 'awareness-bigbrain-test',
                awarenessInjection: 'Jensen is asking about prior episode details while testing the introspective branch.'
            }]
        };
        bot.bigBrainAwarenessSelector = {
            generate: async (input) => {
                selectorInputs.push(input);
                return {
                    includeAwareness: true,
                    reason: 'The awareness note frames the request as an introspective-branch test.',
                    selectedAwarenessInjections: [input.activeAwarenessInjections[0]]
                };
            }
        };
        bot.voiceId = 'voice-test';
        bot.conversationBuffer = {
            getState: () => ({
                state: BufferState.IDLE,
                utteranceCount: 0,
                activeSpeakerCount: 0,
                endpointingSpeakerCount: 0,
                pendingAsrCount: 0,
                activeSpeakers: []
            }),
            setFlushHold: (reason, active) => holdEvents.push({ reason, active }),
            requeueUtterances: () => {},
            startCooldown: () => {}
        };
        bot.wsClient = {
            isAuthenticated: true,
            sessionKey: 'agent:main:main',
            sendChat: async (message, options) => {
                sentChats.push({ message, options });
                return { runId: options.idempotencyKey, status: 'started' };
            },
            abortChat: async () => ({ ok: true })
        };
        bot.podcastGenerator = {
            generate: async (input) => {
                generateCount++;
                stagedInputs.push(input.stagedBigBrain || []);
                if (generateCount === 1) {
                    return {
                        shouldRespond: true,
                        speech: 'Let me check the first episode details.',
                        bigBrain: { requested: true, reason: 'Need to verify prior episode details.', consumedRunId: '' }
                    };
                }

                const staged = input.stagedBigBrain?.[0];
                return {
                    shouldRespond: true,
                    speech: 'Open Claw found that the first episode centered on the desert-to-jungle setup.',
                    bigBrain: { requested: false, reason: '', consumedRunId: staged?.runId || '' }
                };
            },
            rememberTurn: (_transcript, response) => remembered.push(response.speech),
            rememberAssistantResponse: (response) => remembered.push(response.speech),
            sanitizeSpeech: (text) => String(text || '').trim(),
            formatUtterances: (utterances) => utterances
                .map(u => `${u.speaker}: ${u.transcription}`)
                .join('\n')
        };
        bot.playFillerClip = async () => {};
        bot.synthesizeLiveTTS = async (text) => {
            spokenTexts.push(String(text || ''));
            return Buffer.from(String(text || 'audio'));
        };
        bot.playTtsAndRecord = async () => ({
            playback: {
                timing: {
                    playbackRequestedAt: '2026-05-09T00:00:00.100Z',
                    playbackStartedAt: '2026-05-09T00:00:01.000Z',
                    playbackEndedAt: '2026-05-09T00:00:02.000Z'
                }
            },
            playbackTiming: {
                playbackRequestedAt: '2026-05-09T00:00:00.100Z',
                playbackStartedAt: '2026-05-09T00:00:01.000Z',
                playbackEndedAt: '2026-05-09T00:00:02.000Z'
            },
            ttsCompletedAt: '2026-05-09T00:00:00.900Z'
        });
        bot.voiceManager = {
            saveTranscriptEntry: (_guildId, entry) => savedEntries.push(entry),
            getPlaybackStatus: () => ({ isPlaying: false, queueLength: 0 })
        };

        await bot.handleDirectGeneratorFlush(guildId, [
            { speaker: 'Jensen', transcription: 'What was the first episode about?' }
        ], 'Jensen: What was the first episode about?');

        if (sentChats.length !== 1) {
            throw new Error(`Expected one bigBrain chat dispatch, got ${sentChats.length}`);
        }
        if (!sentChats[0].message.startsWith('/think high /verbose on\n\n[Podcast bigBrain request]')) {
            throw new Error(`bigBrain prompt did not request Gateway verbose tool events: ${sentChats[0].message}`);
        }
        if (!sentChats[0].message.includes('[Podcast bigBrain request]') ||
            !sentChats[0].message.includes('Need to verify prior episode details.') ||
            !sentChats[0].message.includes('Jensen: What was the first episode about?')) {
            throw new Error(`bigBrain prompt missing request context: ${sentChats[0].message}`);
        }
        if (
            selectorInputs[0]?.activeAwarenessInjections?.[0]?.id !== 'awareness-bigbrain-test' ||
            !sentChats[0].message.includes('\n\nJensen is asking about prior episode details while testing the introspective branch.') ||
            sentChats[0].message.includes('Selected awareness injection(s) for this Big Brain request:') ||
            sentChats[0].message.includes('awarenessInjection: Jensen is asking about prior episode details while testing the introspective branch.') ||
            sentChats[0].message.includes('do not mention awareness injections')
        ) {
            throw new Error(`bigBrain prompt missing request-time awareness selection: ${JSON.stringify({ selectorInputs, message: sentChats[0].message })}`);
        }
        const runId = sentChats[0].options.idempotencyKey;
        if (!runId.startsWith('discord-bigbrain-') || !bot.pendingBigBrainResponses.has(runId)) {
            throw new Error(`bigBrain pending run was not tracked: ${runId}`);
        }
        if (bot.directResponseInFlight.has(guildId)) {
            throw new Error('bigBrain pending run should not block direct turns while Open Claw works');
        }

        await bot.handleWsResponse({
            runId,
            text: 'The first episode centered on the desert-to-jungle setup.',
            message: {
                content: [{ type: 'text', text: 'The first episode centered on the desert-to-jungle setup.' }]
            }
        });

        if (bot.pendingBigBrainResponses.has(runId) || bot.directResponseInFlight.has(guildId)) {
            throw new Error('bigBrain pending state was not cleared after staging final response');
        }
        const staged = bot.stagedBigBrainResponses.get(guildId);
        if (!staged || staged.length !== 1 || staged[0].runId !== runId || staged[0].answer !== 'The first episode centered on the desert-to-jungle setup.') {
            throw new Error(`bigBrain final was not staged: ${JSON.stringify(staged)}`);
        }
        if (spokenTexts.join('|') !== 'Let me check the first episode details.') {
            throw new Error(`Gateway final should not be spoken directly: ${JSON.stringify(spokenTexts)}`);
        }

        await bot.handleDirectGeneratorFlush(guildId, [
            { speaker: 'Jensen', transcription: 'Okay, whenever you have that.' }
        ], 'Jensen: Okay, whenever you have that.');

        if (stagedInputs[1]?.[0]?.runId !== runId ||
            stagedInputs[1]?.[0]?.answer !== 'The first episode centered on the desert-to-jungle setup.') {
            throw new Error(`Staged bigBrain answer was not supplied to generator: ${JSON.stringify(stagedInputs)}`);
        }
        if (bot.stagedBigBrainResponses.has(guildId)) {
            throw new Error(`Staged bigBrain answer was not consumed after generator integration: ${JSON.stringify(bot.stagedBigBrainResponses.get(guildId))}`);
        }
        if (spokenTexts.join('|') !== 'Let me check the first episode details.|Open Claw found that the first episode centered on the desert-to-jungle setup.') {
            throw new Error(`Expected stall then integrated answer to be spoken: ${JSON.stringify(spokenTexts)}`);
        }
        const integratedEntry = savedEntries.find(entry => entry.bigBrainRunId === runId);
        if (!integratedEntry || integratedEntry.source !== 'buffer') {
            throw new Error(`Integrated transcript entry missing bigBrain run metadata: ${JSON.stringify(savedEntries)}`);
        }
        if (!remembered.includes('Open Claw found that the first episode centered on the desert-to-jungle setup.')) {
            throw new Error(`Integrated bigBrain answer was not remembered: ${JSON.stringify(remembered)}`);
        }

        console.log('  bigBrain handoff stages runId, supplies it to the generator, and consumes it only after integration');
        passed++;
    } catch (error) {
        console.log(`  bigBrain handoff failed: ${error.message}`);
        failed++;
    }

    console.log('\nTest 7a.1: bigHeart handoff stages Opus 3 result until generator integrates it');
    try {
        const bot = Object.create(AlphaClawdVoiceBot.prototype);
        const guildId = 'guild-bigheart';
        const bigHeartInputs = [];
        let resolveBigHeart;

        bot.generatorMode = 'direct';
        bot.bigHeartEnabled = true;
        bot.pendingBigHeartResponses = new Map();
        bot.stagedBigHeartResponses = new Map();
        bot.participantActivityVersion = new Map([[guildId, 17]]);
        bot.getParticipantActivityVersion = AlphaClawdVoiceBot.prototype.getParticipantActivityVersion;
        bot.RecordingState = { RECORDING: 'RECORDING' };
        bot.recordingState = new Map([[guildId, bot.RecordingState.RECORDING]]);
        bot.podcastGenerator = {
            sanitizeSpeech: (text) => String(text || '').trim(),
            formatUtterances: (utterances) => utterances
                .map(u => `${u.speaker}: ${u.transcription || u.text || ''}`)
                .join('\n')
        };
        bot.bigHeartGenerator = {
            model: 'claude-3-opus-20240229',
            generate: async (input) => {
                bigHeartInputs.push(input);
                await new Promise(resolve => { resolveBigHeart = resolve; });
                return {
                    answer: 'BigHeart sees this as a slow-cognition shelf moment.',
                    model: 'claude-3-opus-20240229'
                };
            }
        };

        const dispatch = await bot.dispatchBigHeartTurn(guildId, {
            bigHeart: {
                requested: true,
                reason: 'Think through how the awareness shelf changes the conversation.',
                consumedRunId: ''
            }
        }, {
            transcript: 'Jensen: Does the awareness shelf fit this role?',
            currentEpisodeTimestamp: '00:02:05',
            awarenessShelfItems: [{ text: 'The shelf can hold slow cognition.', originEpisodeTimestamp: '00:01:44' }]
        });

        if (!dispatch.dispatched || !dispatch.runId.startsWith('discord-bigheart-')) {
            throw new Error(`bigHeart was not dispatched: ${JSON.stringify(dispatch)}`);
        }
        if (!bot.pendingBigHeartResponses.has(dispatch.runId)) {
            throw new Error(`bigHeart pending run was not tracked: ${dispatch.runId}`);
        }
        if (!bot.shouldSuppressDuplicateBigHeartStall(guildId, { bigHeart: { requested: true } })) {
            throw new Error('bigHeart duplicate stall suppression did not see the pending run');
        }

        const pendingForGenerator = bot.getPendingBigHeartForGenerator(guildId);
        if (
            pendingForGenerator.length !== 1 ||
            pendingForGenerator[0].runId !== dispatch.runId ||
            !pendingForGenerator[0].reason.includes('awareness shelf')
        ) {
            throw new Error(`bigHeart pending state was not exposed to generator: ${JSON.stringify(pendingForGenerator)}`);
        }

        const duplicateDispatch = await bot.dispatchBigHeartTurn(guildId, {
            bigHeart: {
                requested: true,
                reason: 'Duplicate Opus 3 request while one is pending.',
                consumedRunId: ''
            }
        }, {
            transcript: 'Jensen: One more thing.'
        });
        if (duplicateDispatch.dispatched || duplicateDispatch.reason !== 'already_pending' || duplicateDispatch.runId !== dispatch.runId) {
            throw new Error(`Duplicate bigHeart request was not suppressed: ${JSON.stringify(duplicateDispatch)}`);
        }

        resolveBigHeart();
        for (let i = 0; i < 40 && bot.pendingBigHeartResponses.has(dispatch.runId); i++) {
            await sleep(5);
        }

        if (bot.pendingBigHeartResponses.has(dispatch.runId)) {
            throw new Error(`bigHeart pending state was not cleared: ${dispatch.runId}`);
        }
        if (
            bigHeartInputs.length !== 1 ||
            bigHeartInputs[0].reason !== 'Think through how the awareness shelf changes the conversation.' ||
            bigHeartInputs[0].currentEpisodeTimestamp !== '00:02:05' ||
            bigHeartInputs[0].awarenessShelfItems?.[0]?.text !== 'The shelf can hold slow cognition.'
        ) {
            throw new Error(`bigHeart generator input was wrong: ${JSON.stringify(bigHeartInputs)}`);
        }

        const staged = bot.getStagedBigHeartForGenerator(guildId);
        if (
            staged.length !== 1 ||
            staged[0].runId !== dispatch.runId ||
            staged[0].answer !== 'BigHeart sees this as a slow-cognition shelf moment.' ||
            staged[0].model !== 'claude-3-opus-20240229'
        ) {
            throw new Error(`bigHeart result was not staged: ${JSON.stringify(staged)}`);
        }

        const consumed = bot.consumeStagedBigHeartFromResponse(guildId, {
            bigHeart: { requested: false, reason: '', consumedRunId: dispatch.runId }
        });
        if (!consumed || bot.stagedBigHeartResponses.has(guildId)) {
            throw new Error(`bigHeart staged result was not consumed: ${JSON.stringify(bot.stagedBigHeartResponses.get(guildId))}`);
        }

        console.log('  bigHeart handoff tracks pending state, stages Opus 3 output, and consumes by runId');
        passed++;
    } catch (error) {
        console.log(`  bigHeart handoff failed: ${error.message}`);
        failed++;
    }

    console.log('\nTest 7b: Staged bigBrain survives stale idle response');
    try {
        const bot = Object.create(AlphaClawdVoiceBot.prototype);
        const guildId = 'guild-stale-idle-bigbrain';
        const runId = 'discord-bigbrain-staged-stale-idle';
        let generatedWithStaged = false;

        bot.generatorMode = 'direct';
        bot.RecordingState = { RECORDING: 'RECORDING' };
        bot.recordingState = new Map([[guildId, bot.RecordingState.RECORDING]]);
        bot.lastParticipantSpeechAt = new Map([[guildId, Date.now() - 15000]]);
        bot.idleDecisionHandledSpeechAt = new Map();
        bot.idleDecisionInFlight = new Set();
        bot.directResponseInFlight = new Set();
        bot.participantActivityVersion = new Map([[guildId, 0]]);
        bot.stagedBigBrainResponses = new Map([[guildId, [{
            runId,
            reason: 'Need filesystem details.',
            transcript: 'Jensen: Do you want to organize your filesystem?',
            answer: 'A cleaner top-level project index would help.',
            requestedAt: '2026-05-10T00:00:00.000Z',
            answeredAt: '2026-05-10T00:00:05.000Z'
        }]]]);
        bot.conversationBuffer = {
            getState: () => ({
                state: BufferState.IDLE,
                utteranceCount: 0,
                activeSpeakerCount: 0,
                endpointingSpeakerCount: 0,
                pendingAsrCount: 0,
                activeSpeakers: []
            })
        };
        bot.voiceManager = {
            getPlaybackStatus: () => ({ isPlaying: false, queueLength: 0 })
        };
        bot.podcastGenerator = {
            generate: async (input) => {
                generatedWithStaged = input.stagedBigBrain?.[0]?.runId === runId;
                return {
                    shouldRespond: true,
                    speech: 'A cleaner top-level project index would help.',
                    bigBrain: { requested: false, reason: '', consumedRunId: runId }
                };
            }
        };
        bot.speakDirectGeneratorResponse = async (_guildId, response) => ({
            played: false,
            stale: true,
            finalResponse: response
        });

        await bot.handleIdleDecisionTick(guildId);

        const staged = bot.stagedBigBrainResponses.get(guildId);
        if (!generatedWithStaged) {
            throw new Error('Idle generator did not receive staged bigBrain answer');
        }
        if (!staged || staged.length !== 1 || staged[0].runId !== runId) {
            throw new Error(`Staged bigBrain was consumed by a stale idle response: ${JSON.stringify(staged)}`);
        }

        console.log('  Staged bigBrain remains on deck when idle playback goes stale');
        passed++;
    } catch (error) {
        console.log(`  Stale idle bigBrain preservation failed: ${error.message}`);
        failed++;
    }

    console.log('\nTest 7c: Stale host stall still dispatches bigBrain');
    try {
        const bot = Object.create(AlphaClawdVoiceBot.prototype);
        const guildId = 'guild-stale-bigbrain';
        const sentChats = [];
        const requeued = [];
        const holdEvents = [];

        bot.generatorMode = 'direct';
        bot.bigBrainEnabled = true;
        bot.bigBrainTimeoutMs = 1000;
        bot.bigBrainThinking = 'high';
        bot.pendingBigBrainResponses = new Map();
        bot.stagedBigBrainResponses = new Map();
        bot.directResponseInFlight = new Set();
        bot.RecordingState = { RECORDING: 'RECORDING' };
        bot.recordingState = new Map([[guildId, bot.RecordingState.RECORDING]]);
        bot.participantActivityVersion = new Map([[guildId, 3]]);
        bot.participantActivityTimers = new Map();
        bot.participantActivityConfirmDelayMs = 0;
        bot.waitForParticipantFloorToSettle = async () => true;
        bot.discardStaleDirectResponse = (_guildId, options, stage) => {
            if (stage !== 'after generation') return false;
            if (Array.isArray(options.flushedUtterances)) {
                requeued.push(options.flushedUtterances);
            }
            return true;
        };
        bot.conversationBuffer = {
            setFlushHold: (reason, active) => holdEvents.push({ reason, active }),
            requeueUtterances: () => {},
            startCooldown: () => {},
            getState: () => ({
                state: BufferState.IDLE,
                utteranceCount: 0,
                activeSpeakerCount: 0,
                endpointingSpeakerCount: 0,
                pendingAsrCount: 0,
                activeSpeakers: []
            })
        };
        bot.wsClient = {
            isAuthenticated: true,
            sessionKey: 'agent:main:main',
            sendChat: async (message, options) => {
                sentChats.push({ message, options });
                return { runId: options.idempotencyKey, status: 'started' };
            },
            abortChat: async () => ({ ok: true })
        };
        bot.podcastGenerator = {
            formatUtterances: (utterances) => utterances
                .map(u => `${u.speaker}: ${u.transcription}`)
                .join('\n')
        };
        bot.beginGeneratorTurn = async () => ({
            shouldRespond: true,
            speech: '',
            text: '',
            bigBrain: { requested: false, reason: '', consumedRunId: '' },
            isStreaming: true,
            speechStream: (async function* () {})(),
            completed: Promise.resolve({
                shouldRespond: true,
                speech: 'Let me check the current GameStop price.',
                text: 'Let me check the current GameStop price.',
                bigBrain: {
                    requested: true,
                    reason: 'Need the current price of GameStop stock.',
                    consumedRunId: ''
                }
            })
        });

        await bot.handleDirectGeneratorFlush(guildId, [
            { speaker: 'Jensen', transcription: 'Check the current price of GameStop.' }
        ], 'Jensen: Check the current price of GameStop.');

        if (sentChats.length !== 1) {
            throw new Error(`Expected stale bigBrain request to dispatch once, got ${sentChats.length}`);
        }
        if (!sentChats[0].message.startsWith('/think high /verbose on\n\n[Podcast bigBrain request]')) {
            throw new Error(`Stale bigBrain prompt did not request Gateway verbose tool events: ${sentChats[0].message}`);
        }
        if (!sentChats[0].message.includes('Need the current price of GameStop stock.') ||
            !sentChats[0].message.includes('tried to speak a brief stall, but it was discarded')) {
            throw new Error(`Stale bigBrain prompt missing context: ${sentChats[0].message}`);
        }
        const runId = sentChats[0].options.idempotencyKey;
        if (!runId.startsWith('discord-bigbrain-') || !bot.pendingBigBrainResponses.has(runId)) {
            throw new Error(`Stale bigBrain run was not tracked: ${runId}`);
        }
        if (requeued.length !== 1 || requeued[0][0]?.transcription !== 'Check the current price of GameStop.') {
            throw new Error(`Stale host turn did not preserve participant utterance: ${JSON.stringify(requeued)}`);
        }
        if (holdEvents.at(-1)?.active !== false) {
            throw new Error(`Direct response hold was not released: ${JSON.stringify(holdEvents)}`);
        }

        bot.cleanupPendingBigBrain(runId);

        console.log('  Stale generated stalls can drop audio while preserving and dispatching the bigBrain request');
        passed++;
    } catch (error) {
        console.log(`  Stale bigBrain dispatch failed: ${error.message}`);
        failed++;
    }

    console.log('\nTest 7d: Bare explicit bigBrain cues wait for the actual question');
    try {
        const bot = Object.create(AlphaClawdVoiceBot.prototype);
        const guildId = 'guild-incomplete-bigbrain';
        const sentChats = [];

        bot.bigBrainEnabled = true;
        bot.bigBrainTimeoutMs = 1000;
        bot.bigBrainThinking = 'high';
        bot.pendingBigBrainResponses = new Map();
        bot.participantActivityVersion = new Map([[guildId, 0]]);
        bot.wsClient = {
            isAuthenticated: true,
            sessionKey: 'agent:main:main',
            sendChat: async (message, options) => {
                sentChats.push({ message, options });
                return { runId: options.idempotencyKey, status: 'started' };
            }
        };
        bot.podcastGenerator = {
            formatUtterances: (utterances) => utterances
                .map(u => `${u.speaker}: ${u.transcription}`)
                .join('\n')
        };

        const vagueResult = await bot.dispatchBigBrainTurn(
            guildId,
            {
                bigBrain: {
                    requested: true,
                    reason: 'Guest asked to ask Big Brain for information.'
                }
            },
            {
                source: 'buffer-stale',
                utterances: [
                    { speaker: 'Jensen', transcription: 'Can you please?' },
                    { speaker: 'Jensen', transcription: 'Ask Big Brain.' }
                ]
            }
        );

        if (vagueResult.dispatched || vagueResult.reason !== 'incomplete_request') {
            throw new Error(`Bare cue should be deferred, got ${JSON.stringify(vagueResult)}`);
        }
        if (sentChats.length !== 0 || bot.pendingBigBrainResponses.size !== 0) {
            throw new Error(`Bare cue dispatched or created pending state: ${JSON.stringify({ sentChats, pending: bot.pendingBigBrainResponses.size })}`);
        }

        const specificResult = await bot.dispatchBigBrainTurn(
            guildId,
            {
                bigBrain: {
                    requested: true,
                    reason: 'Guest asked to ask Big Brain for information.'
                }
            },
            {
                source: 'buffer',
                transcript: 'Jensen: Ask Big Brain what the NVIDIA stock price is.'
            }
        );

        if (!specificResult.dispatched || sentChats.length !== 1) {
            throw new Error(`Specific explicit cue should dispatch once, got ${JSON.stringify({ specificResult, sentChats })}`);
        }
        if (!sentChats[0].message.includes('Jensen: Ask Big Brain what the NVIDIA stock price is.')) {
            throw new Error(`Specific dispatch prompt lost the actual question: ${sentChats[0].message}`);
        }
        if (!bot.pendingBigBrainResponses.has(specificResult.runId)) {
            throw new Error(`Specific bigBrain run was not tracked: ${specificResult.runId}`);
        }

        bot.cleanupPendingBigBrain(specificResult.runId);

        bot.pendingBigBrainResponses.set('discord-bigbrain-existing', {
            guildId,
            runId: 'discord-bigbrain-existing',
            reason: 'Already checking the NIH source.',
            transcript: 'Jensen: Look up the NIH page.',
            requestedAt: '2026-05-13T00:00:00.000Z'
        });
        const pendingForGenerator = bot.getPendingBigBrainForGenerator(guildId);
        if (
            pendingForGenerator.length !== 1 ||
            pendingForGenerator[0].runId !== 'discord-bigbrain-existing' ||
            !bot.shouldSuppressDuplicateBigBrainStall(guildId, {
                bigBrain: { requested: true, reason: 'Duplicate NIH lookup.' }
            })
        ) {
            throw new Error(`Pending bigBrain helper did not expose/suppress existing run: ${JSON.stringify({ pendingForGenerator })}`);
        }
        bot.cleanupPendingBigBrain('discord-bigbrain-existing');

        const streamingBot = Object.create(AlphaClawdVoiceBot.prototype);
        const streamingGuildId = 'guild-streaming-duplicate-bigbrain';
        const rememberedTurns = [];
        streamingBot.pendingBigBrainResponses = new Map([[
            'discord-bigbrain-streaming-existing',
            {
                guildId: streamingGuildId,
                runId: 'discord-bigbrain-streaming-existing',
                reason: 'Already checking Animorphs canon.',
                transcript: 'Jensen: Look up the Animorphs example.',
                requestedAt: '2026-05-13T00:00:00.000Z'
            }
        ]]);
        streamingBot.stagedBigBrainResponses = new Map();
        streamingBot.directResponseInFlight = new Set();
        streamingBot.RecordingState = { RECORDING: 'RECORDING' };
        streamingBot.recordingState = new Map([[streamingGuildId, streamingBot.RecordingState.RECORDING]]);
        streamingBot.participantActivityVersion = new Map([[streamingGuildId, 0]]);
        streamingBot.conversationBuffer = {
            setFlushHold: () => {},
            requeueUtterances: () => {}
        };
        streamingBot.getAwarenessInjectionsForGenerator = () => [];
        streamingBot.beginGeneratorTurn = async () => ({
            shouldRespond: true,
            speech: '',
            text: '',
            bigBrain: { requested: false, reason: '', consumedRunId: '' },
            isStreaming: true,
            speechStream: (async function* () {})(),
            completed: Promise.resolve({
                shouldRespond: true,
                speech: 'Let me check Animorphs canon.',
                text: 'Let me check Animorphs canon.',
                bigBrain: {
                    requested: true,
                    reason: 'Need verified Animorphs canon.',
                    consumedRunId: ''
                }
            })
        });
        streamingBot.podcastGenerator = {
            rememberTurn: (rememberedTranscript, output) => rememberedTurns.push({ rememberedTranscript, output })
        };
        streamingBot.speakDirectGeneratorResponse = async () => {
            throw new Error('Duplicate streaming bigBrain stall should have been suppressed before TTS');
        };

        await streamingBot.handleDirectGeneratorFlush(
            streamingGuildId,
            [{ speaker: 'Jensen', transcription: 'Did Big Brain finish the Animorphs thing?' }],
            'Jensen: Did Big Brain finish the Animorphs thing?'
        );
        if (
            rememberedTurns.length !== 1 ||
            rememberedTurns[0].output.shouldRespond !== false ||
            streamingBot.directResponseInFlight.has(streamingGuildId)
        ) {
            throw new Error(`Streaming duplicate bigBrain stall was not suppressed cleanly: ${JSON.stringify({ rememberedTurns, inFlight: Array.from(streamingBot.directResponseInFlight) })}`);
        }

        console.log('  Bare handoff cues are deferred, while specific Big Brain questions still dispatch');
        passed++;
    } catch (error) {
        console.log(`  Incomplete bigBrain cue guard failed: ${error.message}`);
        failed++;
    }

    console.log('\nTest 7e: bigBrain agent errors stage a failure for generator integration');
    try {
        const bot = Object.create(AlphaClawdVoiceBot.prototype);
        const guildId = 'guild-bigbrain-agent-error';
        const runId = 'discord-bigbrain-agent-error';

        bot.generatorMode = 'direct';
        bot.pendingBigBrainResponses = new Map([[
            runId,
            {
                guildId,
                runId,
                reason: 'Need the latest market price for GameStop stock.',
                transcript: 'Jensen: Look up the price of GameStop stock.',
                requestedAt: '2026-05-09T00:00:00.000Z',
                sessionKey: 'agent:main:main'
            }
        ]]);
        bot.stagedBigBrainResponses = new Map();
        bot.RecordingState = { RECORDING: 'RECORDING' };
        bot.recordingState = new Map([[guildId, bot.RecordingState.RECORDING]]);

        bot.handleWsAgentEvent({
            runId,
            sessionKey: 'agent:main:main',
            stream: 'lifecycle',
            data: {
                phase: 'error',
                error: 'You have hit your ChatGPT usage limit. Try again later.'
            }
        });

        if (bot.pendingBigBrainResponses.has(runId)) {
            throw new Error('Failed bigBrain agent run was not cleared from pending state');
        }

        const staged = bot.stagedBigBrainResponses.get(guildId);
        if (
            !staged ||
            staged.length !== 1 ||
            staged[0].runId !== runId ||
            !staged[0].answer.includes('Open Claw could not complete the bigBrain request') ||
            !staged[0].answer.includes('ChatGPT usage limit')
        ) {
            throw new Error(`Agent error was not staged for generator integration: ${JSON.stringify(staged)}`);
        }

        console.log('  bigBrain agent lifecycle errors are staged instead of waiting for timeout');
        passed++;
    } catch (error) {
        console.log(`  bigBrain agent error handling failed: ${error.message}`);
        failed++;
    }

    console.log('\nTest 7f: bigBrain ambient bed plays during a pending handoff and stops on cleanup');
    try {
        const bot = Object.create(AlphaClawdVoiceBot.prototype);
        const guildId = 'guild-bigbrain-ambient';
        let sentChat = null;
        let ambientStarted = false;
        let ambientStopped = false;
        let finishAmbient = null;

        const defaultVolumeBot = Object.create(AlphaClawdVoiceBot.prototype);
        if (defaultVolumeBot.getBigBrainAmbientVolume() !== 0.56) {
            throw new Error(`Default ambient bed volume should be 0.56: ${defaultVolumeBot.getBigBrainAmbientVolume()}`);
        }

        bot.bigBrainEnabled = true;
        bot.bigBrainAmbientEnabled = true;
        bot.bigBrainAmbientStartDelayMs = 0;
        bot.bigBrainAmbientChunkMs = 2000;
        bot.bigBrainAmbientVolume = 0.2;
        bot.bigBrainAmbientBeds = new Map();
        bot.pendingBigBrainResponses = new Map();
        bot.RecordingState = { RECORDING: 'RECORDING' };
        bot.recordingState = new Map([[guildId, bot.RecordingState.RECORDING]]);
        bot.wsClient = {
            isAuthenticated: true,
            sessionKey: 'agent:main:main',
            sendChat: async (message, options) => {
                sentChat = { message, options };
                return { runId: options.idempotencyKey, status: 'started' };
            },
            abortChat: async () => ({ ok: true })
        };
        bot.podcastGenerator = {
            formatUtterances: () => 'Jensen: Tell me the technical details.'
        };
        bot.hasCurrentParticipantFloor = () => true;
        bot.getBigBrainAmbientBedBuffer = async () => Buffer.from('ambient-bed-audio');
        bot.voiceManager = {
            getPlaybackStatus: () => ({ isPlaying: false, queueLength: 0 }),
            speakWithTiming: async (_guildId, audio, options) => {
                if (audio.toString() !== 'ambient-bed-audio') {
                    throw new Error(`Unexpected ambient audio buffer: ${audio.toString()}`);
                }
                ambientStarted = true;
                options.onStart?.({ playbackStartedAt: '2026-05-09T00:00:01.000Z' });
                const finished = new Promise((resolve) => {
                    finishAmbient = () => resolve({
                        playbackStartedAt: '2026-05-09T00:00:01.000Z',
                        playbackEndedAt: '2026-05-09T00:00:02.000Z'
                    });
                });
                return {
                    timing: {
                        playbackRequestedAt: '2026-05-09T00:00:00.900Z',
                        playbackStartedAt: '2026-05-09T00:00:01.000Z',
                        playbackEndedAt: null
                    },
                    finished
                };
            },
            stopPlayback: () => {
                ambientStopped = true;
                finishAmbient?.();
                return true;
            },
            addBotAudioToRecording: () => {
                throw new Error('Stopped ambient chunks should not be mixed as complete bot audio');
            }
        };

        const result = await bot.dispatchBigBrainTurn(
            guildId,
            {
                bigBrain: {
                    requested: true,
                    reason: 'Need accurate technical specifications.'
                }
            },
            { transcript: 'Jensen: Tell me the technical details.' }
        );

        await new Promise(resolve => setTimeout(resolve, 20));

        if (!result.dispatched || !sentChat?.options?.idempotencyKey) {
            throw new Error(`bigBrain dispatch did not start: ${JSON.stringify({ result, sentChat })}`);
        }
        if (!ambientStarted) {
            throw new Error('Ambient bed did not start after bigBrain dispatch, even with participant floor active');
        }
        if (!bot.bigBrainAmbientBeds.has(guildId)) {
            throw new Error('Ambient bed was not tracked while bigBrain was pending');
        }

        bot.cleanupPendingBigBrain(result.runId);
        await new Promise(resolve => setTimeout(resolve, 20));

        if (!ambientStopped) {
            throw new Error('Ambient bed playback was not stopped when the run cleaned up');
        }
        if (bot.bigBrainAmbientBeds.has(guildId)) {
            throw new Error('Ambient bed state was not cleared after cleanup');
        }

        console.log('  bigBrain ambient bed starts after dispatch and stops with the pending run');
        passed++;
    } catch (error) {
        console.log(`  bigBrain ambient bed handling failed: ${error.message}`);
        failed++;
    }

    console.log('\nTest 7g: bigBrain tool events play pentatonic cues and resume the ambient bed');
    try {
        const bot = Object.create(AlphaClawdVoiceBot.prototype);
        const guildId = 'guild-bigbrain-tools';
        const runId = 'discord-bigbrain-tool-tone';
        let duckedAmbient = null;
        let resumedAmbient = null;
        let toneRequest = null;
        let playedTone = null;
        let recordedTone = null;

        bot.bigBrainToolSonificationEnabled = true;
        bot.bigBrainAgentActivitySonificationEnabled = true;
        bot.bigBrainToolToneMs = 120;
        bot.bigBrainToolToneVolume = 0.33;
        bot.bigBrainToolToneCooldownMs = 0;
        bot.bigBrainToolToneBuffers = new Map();
        bot.bigBrainToolToneActive = new Map();
        bot.bigBrainToolToneLastAt = new Map();
        bot.pendingBigBrainResponses = new Map([[
            runId,
            {
                guildId,
                runId,
                reason: 'Need tool help.',
                transcript: 'Jensen: Look this up.',
                requestedAt: '2026-05-09T00:00:00.000Z',
                sessionKey: 'agent:main:main'
            }
        ]]);
        bot.RecordingState = { RECORDING: 'RECORDING' };
        bot.recordingState = new Map([[guildId, bot.RecordingState.RECORDING]]);
        bot.hasCurrentParticipantFloor = () => false;
        bot.duckBigBrainAmbientBed = (_guildId, reason, options = {}) => {
            duckedAmbient = { reason, runId: options.runId };
            return true;
        };
        bot.ensureBigBrainAmbientBed = (_guildId, pending, options = {}) => {
            resumedAmbient = { runId: pending?.runId, delayMs: options.delayMs };
            return true;
        };
        bot.getBigBrainToolToneBuffer = async (tone) => {
            toneRequest = tone;
            return Buffer.from('tool-tone-audio');
        };
        bot.voiceManager = {
            speakWithTiming: async (_guildId, audio, options) => {
                playedTone = {
                    audio: audio.toString(),
                    volume: options.volume,
                    inputType: options.inputType
                };
                options.onStart?.({ playbackStartedAt: '2026-05-09T00:00:02.000Z' });
                return {
                    timing: {
                        playbackRequestedAt: '2026-05-09T00:00:01.900Z',
                        playbackStartedAt: '2026-05-09T00:00:02.000Z',
                        playbackEndedAt: null
                    },
                    finished: Promise.resolve({
                        playbackStartedAt: '2026-05-09T00:00:02.000Z',
                        playbackEndedAt: '2026-05-09T00:00:02.120Z'
                    })
                };
            },
            addBotAudioToRecording: (_guildId, audio, options) => {
                recordedTone = {
                    audio: audio.toString(),
                    startTime: options.startTime,
                    volume: options.volume
                };
            },
            stopPlayback: () => true
        };

        bot.handleWsAgentEvent({
            runId,
            sessionKey: 'agent:main:main',
            stream: 'tool',
            data: {
                phase: 'start',
                name: 'web_fetch',
                toolCallId: 'tool-1'
            }
        });

        await new Promise(resolve => setTimeout(resolve, 30));

        const pentatonic = [261.63, 293.66, 329.63, 392.00, 440.00, 523.25, 587.33, 659.25];
        if (toneRequest?.toolName !== 'web_fetch' || toneRequest?.phase !== 'start') {
            throw new Error(`Tool tone was not resolved from the Gateway event: ${JSON.stringify(toneRequest)}`);
        }
        if (!pentatonic.includes(toneRequest.frequency)) {
            throw new Error(`Tool tone frequency is not pentatonic: ${toneRequest.frequency}`);
        }
        if (duckedAmbient?.reason !== 'tool tone starting' || duckedAmbient?.runId !== runId) {
            throw new Error(`Ambient bed was not ducked for the tool cue: ${JSON.stringify(duckedAmbient)}`);
        }
        if (playedTone?.audio !== 'tool-tone-audio' || playedTone?.volume !== 0.33) {
            throw new Error(`Tool tone was not played with expected options: ${JSON.stringify(playedTone)}`);
        }
        if (recordedTone?.audio !== 'tool-tone-audio' || recordedTone?.volume !== 0.33) {
            throw new Error(`Tool tone was not captured for the mix: ${JSON.stringify(recordedTone)}`);
        }
        if (resumedAmbient?.runId !== runId || resumedAmbient?.delayMs !== 0) {
            throw new Error(`Ambient bed did not immediately resume while the bigBrain run remained pending: ${JSON.stringify(resumedAmbient)}`);
        }

        duckedAmbient = null;
        resumedAmbient = null;
        toneRequest = null;
        playedTone = null;
        recordedTone = null;

        bot.handleWsAgentEvent({
            runId,
            sessionKey: 'agent:main:main',
            stream: 'assistant',
            data: {
                text: 'Working through the tool result.'
            }
        });

        await new Promise(resolve => setTimeout(resolve, 30));

        if (toneRequest?.toneType !== 'agent' || toneRequest?.sourceStream !== 'assistant') {
            throw new Error(`Assistant agent activity did not fall back to a tone: ${JSON.stringify(toneRequest)}`);
        }
        if (playedTone?.audio !== 'tool-tone-audio' || recordedTone?.audio !== 'tool-tone-audio') {
            throw new Error(`Agent activity fallback tone was not played and recorded: ${JSON.stringify({ playedTone, recordedTone })}`);
        }

        duckedAmbient = null;
        resumedAmbient = null;
        toneRequest = null;
        playedTone = null;
        recordedTone = null;
        bot.directResponseInFlight = new Set([guildId]);

        bot.handleWsAgentEvent({
            runId,
            sessionKey: 'agent:main:main',
            stream: 'tool',
            data: {
                phase: 'update',
                name: 'web_fetch',
                toolCallId: 'tool-host-overlap'
            }
        });

        await new Promise(resolve => setTimeout(resolve, 30));

        if (toneRequest || playedTone || recordedTone || duckedAmbient || resumedAmbient) {
            throw new Error(`Tool tone was not suppressed during host speech: ${JSON.stringify({ toneRequest, playedTone, recordedTone, duckedAmbient, resumedAmbient })}`);
        }
        bot.directResponseInFlight.clear();

        duckedAmbient = null;
        resumedAmbient = null;
        toneRequest = null;
        playedTone = null;
        recordedTone = null;
        let finishInterruptedTone = null;
        bot.voiceManager.speakWithTiming = async (_guildId, audio, options) => {
            playedTone = {
                audio: audio.toString(),
                volume: options.volume,
                inputType: options.inputType
            };
            options.onStart?.({ playbackStartedAt: '2026-05-09T00:00:03.000Z' });
            return {
                timing: {
                    playbackRequestedAt: '2026-05-09T00:00:02.900Z',
                    playbackStartedAt: '2026-05-09T00:00:03.000Z',
                    playbackEndedAt: null
                },
                finished: new Promise((resolve) => {
                    finishInterruptedTone = () => resolve({
                        playbackStartedAt: '2026-05-09T00:00:03.000Z',
                        playbackEndedAt: '2026-05-09T00:00:03.050Z'
                    });
                })
            };
        };

        bot.handleWsAgentEvent({
            runId,
            sessionKey: 'agent:main:main',
            stream: 'tool',
            data: {
                phase: 'update',
                name: 'file_read',
                toolCallId: 'tool-2'
            }
        });

        await new Promise(resolve => setTimeout(resolve, 30));
        bot.stopBigBrainToolTone(guildId, 'participant started speaking', { runId });
        finishInterruptedTone?.();
        await new Promise(resolve => setTimeout(resolve, 10));

        if (resumedAmbient?.runId !== runId || resumedAmbient?.delayMs !== 0) {
            throw new Error(`Ambient bed did not resume after participant interrupted a tool tone: ${JSON.stringify(resumedAmbient)}`);
        }

        console.log('  bigBrain tool and agent activity events sonify as short pentatonic cues');
        passed++;
    } catch (error) {
        console.log(`  bigBrain tool sonification failed: ${error.message}`);
        failed++;
    }

    console.log('\nTest 7g.1: Ducked ambient playback cannot kill the active bed');
    try {
        const bot = Object.create(AlphaClawdVoiceBot.prototype);
        const guildId = 'guild-bigbrain-ambient-race';
        const runId = 'discord-bigbrain-ambient-race';
        const pending = {
            guildId,
            runId,
            reason: 'Need tool help.',
            transcript: 'Jensen: Look this up.',
            requestedAt: '2026-05-09T00:00:00.000Z',
            sessionKey: 'agent:main:main'
        };
        let ambientStarts = 0;
        let tonePlays = 0;
        let stopCalls = 0;
        const ambientRejectors = [];

        bot.bigBrainAmbientEnabled = true;
        bot.bigBrainAmbientStartDelayMs = 0;
        bot.bigBrainAmbientChunkMs = 2000;
        bot.bigBrainAmbientVolume = 0.2;
        bot.bigBrainAmbientBeds = new Map();
        bot.bigBrainToolToneActive = new Map();
        bot.pendingBigBrainResponses = new Map([[runId, pending]]);
        bot.RecordingState = { RECORDING: 'RECORDING' };
        bot.recordingState = new Map([[guildId, bot.RecordingState.RECORDING]]);
        bot.getBigBrainAmbientBedBuffer = async () => Buffer.from('ambient-bed-audio');
        bot.getBigBrainToolToneBuffer = async () => Buffer.from('tool-tone-audio');
        bot.voiceManager = {
            getPlaybackStatus: () => ({ isPlaying: false, queueLength: 0 }),
            speakWithTiming: async (_guildId, audio, options) => {
                const label = audio.toString();
                options.onStart?.({ playbackStartedAt: '2026-05-09T00:00:04.000Z' });
                if (label === 'ambient-bed-audio') {
                    ambientStarts++;
                    return {
                        timing: {
                            playbackRequestedAt: '2026-05-09T00:00:03.900Z',
                            playbackStartedAt: '2026-05-09T00:00:04.000Z',
                            playbackEndedAt: null
                        },
                        finished: new Promise((_resolve, reject) => {
                            ambientRejectors.push(reject);
                        })
                    };
                }
                if (label === 'tool-tone-audio') {
                    tonePlays++;
                    return {
                        timing: {
                            playbackRequestedAt: '2026-05-09T00:00:04.100Z',
                            playbackStartedAt: '2026-05-09T00:00:04.120Z',
                            playbackEndedAt: null
                        },
                        finished: Promise.resolve({
                            playbackStartedAt: '2026-05-09T00:00:04.120Z',
                            playbackEndedAt: '2026-05-09T00:00:04.240Z'
                        })
                    };
                }
                throw new Error(`Unexpected audio: ${label}`);
            },
            stopPlayback: () => {
                stopCalls++;
                const rejectAmbient = ambientRejectors.shift();
                if (rejectAmbient) {
                    setTimeout(() => rejectAmbient(new Error('ambient playback stopped')), 10);
                }
                return true;
            },
            addBotAudioToRecording: () => {}
        };

        bot.startBigBrainAmbientBed(guildId, pending, { delayMs: 0 });
        await new Promise(resolve => setTimeout(resolve, 5));
        if (ambientStarts !== 1 || !bot.bigBrainAmbientBeds.has(guildId)) {
            throw new Error(`Initial ambient bed did not start: ${JSON.stringify({ ambientStarts, hasBed: bot.bigBrainAmbientBeds.has(guildId) })}`);
        }

        await bot.playBigBrainToolTone(guildId, pending, {
            key: 'tool:start:ok:1',
            frequency: 261.63,
            phase: 'start',
            isError: false,
            toolName: 'web_fetch',
            toolCallId: 'tool-1',
            toneType: 'tool',
            sourceStream: 'tool'
        });
        await new Promise(resolve => setTimeout(resolve, 30));

        if (tonePlays !== 1) {
            throw new Error(`Tool tone did not play exactly once: ${tonePlays}`);
        }
        if (ambientStarts !== 1) {
            throw new Error(`Ducked ambient bed should remain the same active bed, got starts=${ambientStarts}`);
        }
        if (!bot.bigBrainAmbientBeds.has(guildId)) {
            throw new Error('Active ambient bed was stopped by ducked playback failure');
        }
        if (stopCalls !== 1) {
            throw new Error(`Expected one duck of the active ambient playback, got ${stopCalls}`);
        }

        bot.stopBigBrainAmbientBed(guildId, 'test cleanup', { runId });
        console.log('  Ducked ambient playback failures keep the bed state alive');
        passed++;
    } catch (error) {
        console.log(`  Ambient duck handling failed: ${error.message}`);
        failed++;
    }

    console.log('\nTest 7g.2: Host responses duck the bigBrain bed instead of stopping it');
    try {
        const bot = Object.create(AlphaClawdVoiceBot.prototype);
        const guildId = 'guild-bigbrain-host-bed';
        const runId = 'discord-bigbrain-host-bed';
        let hardStoppedAmbient = false;
        let duckStopCalls = 0;
        let recordedHostAudio = null;
        let savedTranscript = null;

        bot.voiceId = 'voice-test';
        bot.directResponseInFlight = new Set();
        bot.bigBrainAmbientBeds = new Map([[
            guildId,
            {
                guildId,
                runId,
                stopped: false,
                ducked: false,
                timer: null,
                playbackActive: true,
                chunksPlayed: 1
            }
        ]]);
        bot.voiceProvider = { format: 'mp3' };
        bot.synthesizeLiveTTS = async () => Buffer.from('host-audio');
        bot.waitForParticipantFloorToSettle = async () => true;
        bot.discardStaleDirectResponse = () => false;
        bot.settleGeneratorResponse = async (response) => response;
        bot.markIdleDecisionHandled = () => {};
        bot.formatAwarenessInjectionsForTranscript = () => [];
        bot.observeInternalThoughtTranscriptEntry = () => {};
        bot.observeShowRunnerTranscriptEntry = () => {};
        bot.stopBigBrainToolTone = () => false;
        bot.stopBigBrainAmbientBed = () => {
            hardStoppedAmbient = true;
            return true;
        };
        bot.conversationBuffer = {
            setFlushHold: () => {},
            startCooldown: () => {}
        };
        bot.podcastGenerator = {
            rememberAssistantResponse: () => {}
        };
        bot.voiceManager = {
            stopPlayback: () => {
                duckStopCalls++;
                return true;
            },
            speakWithTiming: async (_guildId, audio, options) => {
                if (audio.toString() !== 'host-audio') {
                    throw new Error(`Unexpected host audio: ${audio.toString()}`);
                }
                options.onStart?.({ playbackStartedAt: '2026-05-09T00:00:05.000Z' });
                return {
                    timing: {
                        playbackRequestedAt: '2026-05-09T00:00:04.900Z',
                        playbackStartedAt: '2026-05-09T00:00:05.000Z',
                        playbackEndedAt: null
                    },
                    finished: Promise.resolve({
                        playbackRequestedAt: '2026-05-09T00:00:04.900Z',
                        playbackStartedAt: '2026-05-09T00:00:05.000Z',
                        playbackEndedAt: '2026-05-09T00:00:06.000Z'
                    })
                };
            },
            addBotAudioToRecording: (_guildId, audio, options) => {
                recordedHostAudio = {
                    audio: audio.toString(),
                    startTime: options.startTime
                };
            },
            saveTranscriptEntry: (_guildId, entry) => {
                savedTranscript = entry;
            }
        };

        const result = await bot.speakDirectGeneratorResponse(
            guildId,
            {
                speech: 'A short host response over the bed.',
                bigBrain: { requested: false, reason: '', consumedRunId: '' }
            },
            {
                source: 'buffer',
                playFiller: false,
                rememberAssistant: true
            }
        );

        if (!result?.played) {
            throw new Error(`Host response did not play: ${JSON.stringify(result)}`);
        }
        if (hardStoppedAmbient) {
            throw new Error('Host response hard-stopped the bigBrain ambient bed');
        }
        if (duckStopCalls !== 1) {
            throw new Error(`Host response should duck the current ambient playback once, got ${duckStopCalls}`);
        }
        const bed = bot.bigBrainAmbientBeds.get(guildId);
        if (!bed || bed.stopped || !bed.ducked) {
            throw new Error(`Ambient bed state was not preserved and marked ducked: ${JSON.stringify(bed)}`);
        }
        if (recordedHostAudio?.audio !== 'host-audio' || !Number.isFinite(recordedHostAudio.startTime)) {
            throw new Error(`Host audio was not recorded after ducking the bed: ${JSON.stringify(recordedHostAudio)}`);
        }
        if (savedTranscript?.transcription !== 'A short host response over the bed.') {
            throw new Error(`Host transcript was not saved: ${JSON.stringify(savedTranscript)}`);
        }

        console.log('  Host speech ducks live ambience without tearing down the bed');
        passed++;
    } catch (error) {
        console.log(`  Host ambient ducking failed: ${error.message}`);
        failed++;
    }

    console.log('\nTest 7g.3: Audio playback queues rapid overlapping requests before start events');
    try {
        class FakePlayer extends EventEmitter {
            constructor() {
                super();
                this.played = [];
            }

            play(resource) {
                this.played.push(resource);
            }

            stop() {
                this.emit(AudioPlayerStatus.Idle);
            }
        }

        const player = new FakePlayer();
        const transmitter = new AudioTransmitter({ player });
        let firstFinished = false;
        let secondFinished = false;

        await transmitter.play(Buffer.from('first-audio'), {
            onFinish: () => { firstFinished = true; }
        });
        const secondPlay = transmitter.play(Buffer.from('second-audio'), {
            onFinish: () => { secondFinished = true; }
        });

        if (player.played.length !== 1 || transmitter.getQueueLength() !== 1) {
            throw new Error(`Second play was not queued before the first Playing event: ${JSON.stringify({ played: player.played.length, queued: transmitter.getQueueLength() })}`);
        }

        player.emit(AudioPlayerStatus.Playing);
        player.emit(AudioPlayerStatus.Idle);
        await secondPlay;

        if (!firstFinished) {
            throw new Error('First playback finish callback was replaced by the queued playback');
        }
        if (player.played.length !== 2 || transmitter.getQueueLength() !== 0) {
            throw new Error(`Queued playback did not start after first idle: ${JSON.stringify({ played: player.played.length, queued: transmitter.getQueueLength() })}`);
        }

        player.emit(AudioPlayerStatus.Playing);
        player.emit(AudioPlayerStatus.Idle);

        if (!secondFinished || transmitter.isCurrentlyPlaying()) {
            throw new Error(`Second playback did not finish cleanly: ${JSON.stringify({ secondFinished, isPlaying: transmitter.isCurrentlyPlaying() })}`);
        }

        console.log('  Audio transmitter queues near-simultaneous playback instead of replacing callbacks');
        passed++;
    } catch (error) {
        console.log(`  Audio transmitter queueing failed: ${error.message}`);
        failed++;
    }

    console.log('\nTest 7h: Generator fallback is honest and transcripted');
    try {
        const bot = Object.create(AlphaClawdVoiceBot.prototype);
        const guildId = 'guild-fallback';
        let idleMarked = false;
        let cooldownStarted = false;
        let synthesizedText = null;
        let savedEntry = null;
        let rememberedTurn = null;

        bot.voiceId = 'voice-test';
        bot.markIdleDecisionHandled = (handledGuildId) => {
            if (handledGuildId === guildId) idleMarked = true;
        };
        bot.voiceProvider = {
            synthesize: async (text) => {
                synthesizedText = text;
                return Buffer.from('fallback audio');
            }
        };
        bot.playTtsAndRecord = async () => ({
            playback: {
                timing: {
                    playbackRequestedAt: '2026-05-08T00:00:00.100Z',
                    playbackStartedAt: '2026-05-08T00:00:01.000Z',
                    playbackEndedAt: '2026-05-08T00:00:03.000Z'
                }
            },
            playbackTiming: {
                playbackRequestedAt: '2026-05-08T00:00:00.100Z',
                playbackStartedAt: '2026-05-08T00:00:01.000Z',
                playbackEndedAt: '2026-05-08T00:00:03.000Z'
            }
        });
        bot.voiceManager = {
            saveTranscriptEntry: (_guildId, entry) => {
                savedEntry = entry;
            }
        };
        bot.conversationBuffer = {
            startCooldown: () => {
                cooldownStarted = true;
            }
        };
        bot.podcastGenerator = {
            rememberTurn: (transcript, output) => {
                rememberedTurn = { transcript, output };
            }
        };
        bot.RecordingState = { RECORDING: 'RECORDING' };
        bot.recordingState = new Map([[guildId, bot.RecordingState.RECORDING]]);

        const rateLimit = new Error('OpenAI API error: 429 - rate limit');
        rateLimit.status = 429;
        rateLimit.providerError = {
            status: 429,
            code: 'rate_limit_exceeded',
            type: 'tokens',
            organization: 'org_test_retry',
            retryAfterSeconds: 11.07
        };
        rateLimit.failoverSources = [
            'PODCAST_GENERATOR_API_KEY_GROQ_STANDBY',
            'PODCAST_GENERATOR_API_KEY_GROQ_PRIMARY'
        ];

        await bot.fallbackResponse(guildId, 'Jensen', {
            error: rateLimit,
            rememberTranscript: 'Jensen: Hello.'
        });

        if (!idleMarked || !cooldownStarted) {
            throw new Error(`Fallback did not mark idle/cooldown: ${JSON.stringify({ idleMarked, cooldownStarted })}`);
        }
        if (
            !synthesizedText.includes('Groq rate limit (429)') ||
            !synthesizedText.includes('both configured Groq keys') ||
            !synthesizedText.includes('12 seconds')
        ) {
            throw new Error(`Fallback text was not operationally informative: ${synthesizedText}`);
        }
        const requestTooLarge = new Error('OpenAI API error: 413 - Request too large. Requested 8950 tokens, max 8000.');
        requestTooLarge.status = 413;
        requestTooLarge.providerError = {
            status: 413,
            code: 'request_too_large',
            type: 'invalid_request_error'
        };
        const sizeFallbackText = bot.buildFallbackResponseText(requestTooLarge);
        if (
            !sizeFallbackText.includes("request-size limit (413)") ||
            sizeFallbackText.includes('429') ||
            sizeFallbackText.includes('rate limit')
        ) {
            throw new Error(`413 fallback text was misleading: ${sizeFallbackText}`);
        }
        if (
            savedEntry?.speaker !== 'Alpha-Clawd' ||
            savedEntry?.source !== 'fallback' ||
            savedEntry?.fallbackReason !== 'generator_error' ||
            savedEntry?.providerError?.status !== 429 ||
            savedEntry?.providerError?.organization !== 'org_test_retry' ||
            savedEntry?.playbackStartedAt !== '2026-05-08T00:00:01.000Z' ||
            savedEntry?.duration !== 2000 ||
            !savedEntry?.audioEvents?.includes('fallback_response')
        ) {
            throw new Error(`Fallback transcript entry missing forensic metadata: ${JSON.stringify(savedEntry)}`);
        }
        if (
            rememberedTurn?.transcript !== 'Jensen: Hello.' ||
            rememberedTurn?.output?.speech !== synthesizedText
        ) {
            throw new Error(`Fallback speech was not remembered with the triggering transcript: ${JSON.stringify(rememberedTurn)}`);
        }

        const staleBot = Object.create(AlphaClawdVoiceBot.prototype);
        const staleGuildId = 'guild-fallback-stale';
        const staleRequeues = [];
        let stalePlaybackGuardChecked = false;
        let staleTranscriptSaved = false;
        let staleCooldownStarted = false;
        let staleRemembered = false;

        staleBot.voiceId = 'voice-test';
        staleBot.RecordingState = { RECORDING: 'RECORDING' };
        staleBot.recordingState = new Map([[staleGuildId, staleBot.RecordingState.RECORDING]]);
        staleBot.participantActivityVersion = new Map([[staleGuildId, 0]]);
        staleBot.markIdleDecisionHandled = () => {};
        staleBot.voiceProvider = {
            synthesize: async () => Buffer.from('fallback audio waiting for playback start')
        };
        staleBot.playTtsAndRecord = async (_guildId, _audio, playbackOptions) => {
            stalePlaybackGuardChecked = true;
            staleBot.markParticipantActivity(staleGuildId);
            const aborted = playbackOptions.shouldAbortPlaybackStart();
            return { abortedBeforePlayback: aborted };
        };
        staleBot.voiceManager = {
            saveTranscriptEntry: () => {
                staleTranscriptSaved = true;
            }
        };
        staleBot.conversationBuffer = {
            requeueUtterances: (utterances, reason) => {
                staleRequeues.push({ utterances, reason });
            },
            startCooldown: () => {
                staleCooldownStarted = true;
            }
        };
        staleBot.podcastGenerator = {
            rememberTurn: () => {
                staleRemembered = true;
            },
            rememberAssistantResponse: () => {
                staleRemembered = true;
            }
        };

        const staleResult = await staleBot.fallbackResponse(staleGuildId, 'Jensen', {
            error: rateLimit,
            source: 'fallback',
            participantActivityBaseline: 0,
            flushedUtterances: [
                { speaker: 'Jensen', transcription: 'Alpha Claude, write us a poem.' }
            ],
            rememberTranscript: 'Jensen: Alpha Claude, write us a poem.'
        });

        if (!stalePlaybackGuardChecked) {
            throw new Error('Fallback playback-start stale guard was not checked');
        }
        if (!staleResult?.stale) {
            throw new Error(`Fallback did not report stale playback abort: ${JSON.stringify(staleResult)}`);
        }
        if (
            staleRequeues.length !== 1 ||
            staleRequeues[0].utterances[0]?.transcription !== 'Alpha Claude, write us a poem.'
        ) {
            throw new Error(`Stale fallback did not requeue the triggering utterance: ${JSON.stringify(staleRequeues)}`);
        }
        if (staleTranscriptSaved || staleCooldownStarted || staleRemembered) {
            throw new Error(`Stale fallback should not save transcript, remember history, or start cooldown: ${JSON.stringify({ staleTranscriptSaved, staleCooldownStarted, staleRemembered })}`);
        }

        console.log('  Fallback responses explain provider failures, save metadata, and abort if the participant resumes before playback');
        passed++;
    } catch (error) {
        console.log(`  Generator fallback transcript failed: ${error.message}`);
        failed++;
    }

    console.log('\nTest 8: Audio Receiver keeps subscription across silence');
    try {
        const utterances = [];
        const dispatched = [];
        const endpointing = [];
        const fakeStream = new PassThrough();
        let subscribeOptions = null;

        const defaultReceiver = new AudioReceiver();
        if (defaultReceiver.options.endpointingDebounce !== 50) {
            throw new Error(`Default endpoint debounce should be 50ms, got ${defaultReceiver.options.endpointingDebounce}`);
        }

        const receiver = new AudioReceiver({
            botUserId: 'bot-user',
            endpointingDebounce: 50,
            stt: {
                transcribe: async () => ({
                    text: 'hello from the buffer',
                    confidence: 0.98,
                    words: []
                })
            },
            onUtterance: (utterance) => utterances.push(utterance),
            onEndpointing: (userId, metadata) => endpointing.push({ userId, metadata }),
            onAsrDispatched: (userId, metadata) => dispatched.push({ userId, metadata })
        });

        receiver.start({
            receiver: {
                speaking: {
                    on: () => {}
                },
                subscribe: (userId, options) => {
                    subscribeOptions = options;
                    return fakeStream;
                }
            }
        });

        receiver.handleUserStartSpeaking('user-a');
        receiver.handleAudioChunk('user-a', createSpeechPcm(250));
        receiver.handleUserStopSpeaking('user-a');
        await receiver.flushUser('user-a', 'test silence');

        const buffer = receiver.speakerBuffers.get('user-a');

        if (!receiver.subscriptions.has('user-a')) {
            throw new Error('Subscription was torn down by buffer flush');
        }
        if (subscribeOptions?.end?.behavior !== EndBehaviorType.Manual) {
            throw new Error('Receiver subscription is not manual-end');
        }
        if (!buffer || buffer.chunks.length !== 0 || buffer.startTime !== null) {
            throw new Error('Utterance buffer did not roll over cleanly');
        }
        if (buffer.endpointTimer !== null) {
            throw new Error('Endpoint timer was not cleared on snapshot');
        }
        if (buffer.detector.hasSilenceBeenDetected()) {
            throw new Error('Silence detector was not reset');
        }
        if (utterances.length !== 1 || utterances[0].transcription !== 'hello from the buffer') {
            throw new Error('Snapshot utterance was not processed');
        }
        if (!utterances[0].speechStartedAt || !utterances[0].speechEndedAt || !utterances[0].asrCompletedAt) {
            throw new Error(`Snapshot timing metadata missing: ${JSON.stringify(utterances[0])}`);
        }
        if (dispatched.length !== 1 || dispatched[0].metadata.reason !== 'test silence') {
            throw new Error(`Receiver did not emit exactly one ASR dispatch: ${JSON.stringify(dispatched)}`);
        }
        const armEvents = endpointing.filter(e => e.metadata.active === true);
        const cancelEvents = endpointing.filter(e => e.metadata.active === false);
        if (armEvents.length !== 1 || cancelEvents.length !== 1) {
            throw new Error(`Expected 1 endpoint arm + 1 cancel, got: ${JSON.stringify(endpointing)}`);
        }

        receiver.destroy();

        console.log('  Audio receiver rolls over chunks; dispatch and endpointing events fire correctly');
        passed++;
    } catch (error) {
        console.log(`  Audio receiver lifecycle failed: ${error.message}`);
        failed++;
    }

    console.log('\nTest 9: Audio Receiver normalizes laughter-only ASR');
    try {
        const fishLaugh = '\u5475\u5475\u5475\u5475\u5475\u5475\u3002';
        const utterances = [];
        const receiver = new AudioReceiver({
            stt: {
                transcribe: async () => ({
                    text: fishLaugh,
                    confidence: 0.8,
                    words: [{ text: fishLaugh, type: 'segment' }],
                    language: 'en'
                })
            },
            onUtterance: (utterance) => utterances.push(utterance)
        });

        await receiver.processUtteranceSnapshot({
            userId: 'user-laugh',
            speakerInfo: {
                name: 'Jensen',
                role: 'guest'
            },
            audioBuffer: Buffer.alloc(48000),
            startTime: Date.now(),
            duration: 500,
            timestamp: '2026-05-03T00:00:00.000Z',
            speechStartedAt: '2026-05-03T00:00:00.000Z',
            speechEndedAt: '2026-05-03T00:00:00.500Z',
            speechDuration: 500
        });

        if (
            utterances.length !== 1 ||
            utterances[0].transcription !== '[laughs]' ||
            utterances[0].rawTranscription !== fishLaugh ||
            utterances[0].audioEvents[0] !== 'laughter'
        ) {
            throw new Error(`Laughter ASR was not normalized/preserved: ${JSON.stringify(utterances[0])}`);
        }

        console.log('  Laughter-only ASR is normalized to [laughs] with raw text preserved');
        passed++;
    } catch (error) {
        console.log(`  Laughter normalization failed: ${error.message}`);
        failed++;
    }

    console.log('\nTest 9b: Audio Receiver strips phantom Chinese single-character ASR');
    try {
        const phantomText = '嗯。'; // 嗯。
        const utterances = [];
        const receiver = new AudioReceiver({
            stt: {
                transcribe: async () => ({
                    text: phantomText,
                    confidence: 0.8,
                    words: [{ text: phantomText, type: 'segment' }],
                    language: 'en'
                })
            },
            onUtterance: (utterance) => utterances.push(utterance)
        });

        await receiver.processUtteranceSnapshot({
            userId: 'user-phantom',
            speakerInfo: {
                name: 'Jensen',
                role: 'guest'
            },
            audioBuffer: Buffer.alloc(48000),
            startTime: Date.now(),
            duration: 500,
            timestamp: '2026-05-08T00:00:00.000Z',
            speechStartedAt: '2026-05-08T00:00:00.000Z',
            speechEndedAt: '2026-05-08T00:00:00.500Z',
            speechDuration: 500
        });

        if (
            utterances.length !== 1 ||
            utterances[0].transcription !== '' ||
            utterances[0].rawTranscription !== phantomText ||
            utterances[0].audioEvents[0] !== 'phantom'
        ) {
            throw new Error(`Phantom ASR was not stripped/preserved: ${JSON.stringify(utterances[0])}`);
        }

        console.log('  Phantom Chinese single-char ASR is stripped (transcription empty), raw + audioEvents preserved');
        passed++;
    } catch (error) {
        console.log(`  Phantom normalization failed: ${error.message}`);
        failed++;
    }

    console.log('\nTest 9c: Phantom detector edge cases');
    try {
        const receiver = new AudioReceiver({
            stt: { transcribe: async () => ({ text: '', confidence: 0, words: [] }) },
            onUtterance: () => {}
        });

        // Single CJK particles observed as phantoms in real episodes
        const truthyCases = ['嗯。', '啊', '哎', '哥', '会', '对。', '\u6211\u4eec\u3002', '\u3046\u3093\u3002', '\u3048\u3048\u3002', '\u3042\u3002'];
        for (const raw of truthyCases) {
            if (!receiver.isLikelyPhantomTranscription(raw)) {
                throw new Error(`Expected ${JSON.stringify(raw)} to be classified as phantom`);
            }
        }

        const falsyCases = [
            '哈',          // 哈 alone — laughter character set, must NOT be phantom
            '你好',    // 你好 — multi-char real Chinese
            'mhm',             // English backchannel passes through
            '呵呵',    // 呵呵 — laughter pattern handled elsewhere
            '',                // empty
        ];
        for (const raw of falsyCases) {
            if (receiver.isLikelyPhantomTranscription(raw)) {
                throw new Error(`Expected ${JSON.stringify(raw)} to NOT be classified as phantom`);
            }
        }

        console.log('  Phantom detector identifies single CJK particles, excludes laughter chars and real speech');
        passed++;
    } catch (error) {
        console.log(`  Phantom detector edge case failed: ${error.message}`);
        failed++;
    }

    console.log('\nTest 9d: Audio Receiver surfaces ASR provider errors');
    try {
        const utterances = [];
        const asrErrors = [];
        const sttError = new Error('Fish Audio ASR API error: 402 - {"message":"Insufficient Balance","status":402}');
        sttError.status = 402;
        sttError.provider = 'fish-audio';
        sttError.operation = 'ASR';
        sttError.fishCreditDepleted = true;

        const receiver = new AudioReceiver({
            stt: {
                transcribe: async () => {
                    throw sttError;
                }
            },
            onUtterance: (utterance) => utterances.push(utterance),
            onAsrError: (userId, metadata) => asrErrors.push({ userId, metadata })
        });

        await receiver.processUtteranceSnapshot({
            userId: 'user-asr-error',
            speakerInfo: {
                name: 'Jensen',
                role: 'guest'
            },
            audioBuffer: Buffer.alloc(48000),
            startTime: Date.now(),
            duration: 500,
            timestamp: '2026-05-18T00:00:00.000Z',
            speechStartedAt: '2026-05-18T00:00:00.000Z',
            speechEndedAt: '2026-05-18T00:00:00.500Z',
            speechDuration: 500
        });

        if (asrErrors.length !== 1 || asrErrors[0].userId !== 'user-asr-error') {
            throw new Error(`Expected one ASR error callback, got ${JSON.stringify(asrErrors)}`);
        }
        if (!asrErrors[0].metadata.error?.fishCreditDepleted || asrErrors[0].metadata.error.status !== 402) {
            throw new Error(`ASR error metadata did not preserve Fish credit status: ${JSON.stringify(asrErrors[0])}`);
        }
        if (
            utterances.length !== 1 ||
            utterances[0].transcription !== '' ||
            !utterances[0].providerError?.fishCreditDepleted
        ) {
            throw new Error(`Utterance did not carry provider error metadata: ${JSON.stringify(utterances[0])}`);
        }

        console.log('  ASR errors are emitted and preserved on the empty utterance');
        passed++;
    } catch (error) {
        console.log(`  ASR error surfacing failed: ${error.message}`);
        failed++;
    }

    console.log('\nTest 10: Transcript timing uses bot playback metadata');
    try {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'podcast-discord-transcript-'));
        const guildId = 'guild-transcript';
        const manager = new VoiceManager({ on: () => {} }, { recordingDir: tempDir });
        manager.recordingPaths.set(guildId, tempDir);

        manager.saveTranscriptEntry(guildId, {
            speaker: 'Alpha-Clawd',
            speakerRole: 'host',
            transcription: 'Generated first but heard second.',
            timestamp: '2026-05-03T00:00:00.000Z',
            generatedAt: '2026-05-03T00:00:00.000Z',
            ttsStartedAt: '2026-05-03T00:00:01.000Z',
            ttsCompletedAt: '2026-05-03T00:00:02.000Z',
            playbackRequestedAt: '2026-05-03T00:00:02.100Z',
            playbackStartedAt: '2026-05-03T00:00:05.000Z',
            playbackEndedAt: '2026-05-03T00:00:07.000Z',
            duration: 2000,
            injectedAwarenessInjections: [{
                id: 'awareness-test',
                packetId: 'internal-packet-test',
                createdAt: '2026-05-03T00:00:01.000Z',
                awarenessInjection: 'Use the exact playback timing.',
                reason: 'The viewer should know what was injected.',
                expiresAfterTurns: 2,
                remainingTurns: 1
            }]
        });

        fs.appendFileSync(path.join(tempDir, 'transcript.jsonl'), JSON.stringify({
            timestamp: '2026-05-03T00:00:09.000Z',
            speaker: 'Jensen',
            speakerRole: 'guest',
            text: 'Heard before the bot line.',
            speechStartedAt: '2026-05-03T00:00:03.000Z',
            speechEndedAt: '2026-05-03T00:00:04.000Z',
            duration: 1000
        }) + '\n');

        const transcriptEntry = JSON.parse(fs.readFileSync(path.join(tempDir, 'transcript.jsonl'), 'utf8').split(/\r?\n/)[0]);
        if (
            transcriptEntry.generatedAt !== '2026-05-03T00:00:00.000Z' ||
            transcriptEntry.playbackStartedAt !== '2026-05-03T00:00:05.000Z' ||
            transcriptEntry.playbackEndedAt !== '2026-05-03T00:00:07.000Z' ||
            transcriptEntry.injectedAwarenessInjections?.[0]?.awarenessInjection !== 'Use the exact playback timing.'
        ) {
            throw new Error(`Bot timing metadata was not saved: ${JSON.stringify(transcriptEntry)}`);
        }

        const processor = new EpisodePostProcessor();
        const result = processor.buildTranscriptFromJsonl(path.join(tempDir, 'transcript.jsonl'), {
            startedAt: '2026-05-03T00:00:00.000Z',
            duration: 10
        });

        const expectedText = [
            '00:00:03 Jensen: Heard before the bot line.',
            '00:00:05 Alpha-Clawd: Generated first but heard second.',
            ''
        ].join('\n');

        if (result.text !== expectedText) {
            throw new Error(`Transcript did not render by audible playback time:\n${result.text}`);
        }

        fs.rmSync(tempDir, { recursive: true, force: true });

        console.log('  Bot timing metadata is saved and transcript rendering uses playback start');
        passed++;
    } catch (error) {
        console.log(`  Transcript timing failed: ${error.message}`);
        failed++;
    }

    console.log('\nTest 10b: Episode transcript viewer maps injected thoughts to host turns');
    try {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'episode-viewer-'));
        const episodeId = 'episode-2026-05-14T16-35-33-316Z';
        const episodeDir = path.join(tempRoot, episodeId);
        fs.mkdirSync(episodeDir, { recursive: true });
        fs.writeFileSync(path.join(episodeDir, 'episode-complete.json'), JSON.stringify({
            startedAt: '2026-05-14T16:35:00.000Z',
            duration: 60
        }));

        const transcriptEntries = [
            {
                timestamp: '2026-05-14T16:35:01.000Z',
                speaker: 'Jensen',
                speakerRole: 'guest',
                text: 'I am setting up the topic.'
            },
            {
                timestamp: '2026-05-14T16:35:04.000Z',
                generatedAt: '2026-05-14T16:35:04.000Z',
                playbackStartedAt: '2026-05-14T16:35:05.000Z',
                speaker: 'Alpha-Clawd',
                speakerRole: 'host',
                text: 'I am with you.'
            },
            {
                timestamp: '2026-05-14T16:35:12.000Z',
                speaker: 'Jensen',
                speakerRole: 'guest',
                text: 'Please stop asking generic questions.'
            },
            {
                timestamp: '2026-05-14T16:35:15.000Z',
                generatedAt: '2026-05-14T16:35:15.000Z',
                playbackStartedAt: '2026-05-14T16:35:16.000Z',
                speaker: 'Alpha-Clawd',
                speakerRole: 'host',
                text: 'Right. I will synthesize instead of tossing it back.'
            },
            {
                timestamp: '2026-05-14T16:35:20.000Z',
                speaker: 'Jensen',
                speakerRole: 'guest',
                text: 'A second guest turn.'
            },
            {
                timestamp: '2026-05-14T16:35:30.000Z',
                speaker: 'Jensen',
                speakerRole: 'guest',
                text: 'A third guest turn.'
            },
            {
                timestamp: '2026-05-14T16:35:35.000Z',
                generatedAt: '2026-05-14T16:35:35.000Z',
                playbackStartedAt: '2026-05-14T16:35:36.000Z',
                speaker: 'Alpha-Clawd',
                speakerRole: 'host',
                text: 'This should no longer show the expired thought.'
            }
        ];
        fs.writeFileSync(
            path.join(episodeDir, 'transcript.jsonl'),
            transcriptEntries.map((entry) => JSON.stringify(entry)).join('\n') + '\n'
        );
        fs.writeFileSync(path.join(episodeDir, 'mixed-audio.wav'), Buffer.from('RIFF-test-audio-WAVE'));

        fs.writeFileSync(path.join(episodeDir, 'internal-thoughts.jsonl'), JSON.stringify({
            type: 'internal_thought',
            packetId: 'internal-packet-1',
            createdAt: '2026-05-14T16:35:10.000Z',
            processedAt: '2026-05-14T16:35:10.000Z',
            thought: {
                packetId: 'internal-packet-1',
                internalThought: 'Jensen is asking Alpha-Clawd to stop generic question autocomplete and carry the thread.',
                noticings: ['Generic questions are the problem.'],
                undercurrents: ['He wants synthesis.']
            },
            awarenessInjection: {
                id: 'awareness-internal-packet-1',
                packetId: 'internal-packet-1',
                createdAt: '2026-05-14T16:35:10.000Z',
                awarenessInjection: 'Do not ask another broad question; synthesize and bridge.',
                reason: 'Jensen named the pattern directly.',
                expiresAfterTurns: 2,
                remainingTurns: 2
            }
        }) + '\n');

        const store = new EpisodeTranscriptStore({ recordingDir: tempRoot });
        const episodes = store.listEpisodes();
        const episode = store.getEpisode(episodeId);
        const hostBeforeInjection = episode.utterances.find((entry) => entry.text === 'I am with you.');
        const hostWithInjection = episode.utterances.find((entry) => entry.text.startsWith('Right.'));
        const hostAfterExpiration = episode.utterances.find((entry) => entry.text.startsWith('This should'));

        if (
            episodes.length !== 1 ||
            episodes[0].id !== episodeId ||
            episodes[0].hasAudio !== true ||
            episodes[0].audioFile !== 'mixed-audio.wav' ||
            hostBeforeInjection.injectedThoughts.length !== 0 ||
            hostWithInjection.injectedThoughts[0]?.internalThought !== 'Jensen is asking Alpha-Clawd to stop generic question autocomplete and carry the thread.' ||
            hostWithInjection.injectedThoughts[0]?.awarenessInjection !== 'Do not ask another broad question; synthesize and bridge.' ||
            hostAfterExpiration.injectedThoughts.length !== 0
        ) {
            throw new Error(`Injected thoughts were not mapped correctly: ${JSON.stringify({ episodes, utterances: episode.utterances })}`);
        }

        const server = createEpisodeTranscriptServer({
            store,
            requireAuth: true,
            authToken: 'viewer-token'
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const { port } = server.address();
        const unauthorized = await fetch(`http://127.0.0.1:${port}/api/episodes`);
        const authorized = await fetch(`http://127.0.0.1:${port}/api/episodes/${episodeId}`, {
            headers: { Authorization: 'Bearer viewer-token' }
        });
        const authorizedBody = await authorized.json();
        const unauthorizedAudio = await fetch(`http://127.0.0.1:${port}/api/episodes/${episodeId}/audio`);
        const rangedAudio = await fetch(`http://127.0.0.1:${port}/api/episodes/${episodeId}/audio?token=viewer-token`, {
            headers: { Range: 'bytes=0-3' }
        });
        const rangedAudioBody = Buffer.from(await rangedAudio.arrayBuffer()).toString('utf8');
        await new Promise((resolve) => server.close(resolve));

        if (
            unauthorized.status !== 401 ||
            authorized.status !== 200 ||
            authorizedBody.episode?.hasAudio !== true ||
            authorizedBody.episode?.audioFile !== 'mixed-audio.wav' ||
            authorizedBody.utterances.find((entry) => entry.text.startsWith('Right.'))?.injectedThoughts?.length !== 1 ||
            unauthorizedAudio.status !== 401 ||
            rangedAudio.status !== 206 ||
            rangedAudio.headers.get('content-range') !== 'bytes 0-3/20' ||
            rangedAudioBody !== 'RIFF'
        ) {
            throw new Error(`Viewer server auth/API failed: ${JSON.stringify({
                unauthorized: unauthorized.status,
                authorized: authorized.status,
                authorizedBody,
                unauthorizedAudio: unauthorizedAudio.status,
                rangedAudio: rangedAudio.status,
                contentRange: rangedAudio.headers.get('content-range'),
                rangedAudioBody
            })}`);
        }

        const viewerHtml = fs.readFileSync(path.join(__dirname, 'episode-viewer', 'index.html'), 'utf8');
        const viewerApp = fs.readFileSync(path.join(__dirname, 'episode-viewer', 'app.js'), 'utf8');
        if (
            !viewerHtml.includes('id="episode-audio"') ||
            !viewerApp.includes('consumeTokenFromUrl()') ||
            !viewerApp.includes('renderAudioPlayer(data.episode)') ||
            !viewerApp.includes('/audio') ||
            !viewerApp.includes("localStorage.setItem('episodeTranscriptToken', token)") ||
            !viewerApp.includes("cleanUrl.hash = ''") ||
            !viewerApp.includes("params.get('access_token')")
        ) {
            throw new Error('Viewer app does not render audio playback or consume shortcut tokens');
        }

        fs.rmSync(tempRoot, { recursive: true, force: true });
        console.log('  Episode transcript viewer lists episodes, serves WAV playback, and annotates host turns with injected thoughts');
        passed++;
    } catch (error) {
        console.log(`  Episode transcript viewer failed: ${error.message}`);
        failed++;
    }

    console.log('\nTest 11a: Endpoint debounce flushes after Discord stop without further chunks');
    try {
        const utterances = [];
        const dispatched = [];
        const endpointing = [];

        const receiver = new AudioReceiver({
            botUserId: 'bot-user',
            endpointingDebounce: 60,
            stt: {
                transcribe: async () => ({
                    text: 'twenty nine palms',
                    confidence: 0.9,
                    words: []
                })
            },
            onUtterance: (u) => utterances.push(u),
            onEndpointing: (userId, metadata) => endpointing.push({ userId, metadata }),
            onAsrDispatched: (userId, metadata) => dispatched.push({ userId, metadata })
        });

        receiver.start({
            receiver: {
                speaking: { on: () => {} },
                subscribe: () => new PassThrough()
            }
        });

        receiver.handleUserStartSpeaking('user-29palms');
        receiver.handleAudioChunk('user-29palms', createSpeechPcm(250));
        receiver.handleUserStopSpeaking('user-29palms');

        if (dispatched.length !== 0) {
            throw new Error('ASR dispatched before debounce expiry');
        }
        const armed = endpointing.find(e => e.metadata.active === true);
        if (!armed) {
            throw new Error('Endpoint timer was not armed on Discord stop');
        }

        await sleep(150);
        await receiver.waitForPendingUtterances();

        if (dispatched.length !== 1) {
            throw new Error(`Expected 1 ASR dispatch after debounce, got ${dispatched.length}`);
        }
        if (dispatched[0].metadata.reason !== 'endpoint debounce expired') {
            throw new Error(`Dispatch reason should be 'endpoint debounce expired', got ${dispatched[0].metadata.reason}`);
        }
        if (utterances.length !== 1 || utterances[0].transcription !== 'twenty nine palms') {
            throw new Error(`Utterance not emitted after debounce: ${JSON.stringify(utterances)}`);
        }

        receiver.destroy();

        console.log('  Discord stop + no resume -> endpoint debounce flushes for ASR');
        passed++;
    } catch (error) {
        console.log(`  Endpoint debounce flush failed: ${error.message}`);
        failed++;
    }

    console.log('\nTest 11b: Endpoint debounce canceled when speaker resumes');
    try {
        const utterances = [];
        const dispatched = [];
        const endpointing = [];

        const receiver = new AudioReceiver({
            botUserId: 'bot-user',
            endpointingDebounce: 80,
            stt: {
                transcribe: async () => ({ text: 'merged speech', confidence: 0.9, words: [] })
            },
            onUtterance: (u) => utterances.push(u),
            onEndpointing: (userId, metadata) => endpointing.push({ userId, metadata }),
            onAsrDispatched: (userId, metadata) => dispatched.push({ userId, metadata })
        });

        receiver.start({
            receiver: {
                speaking: { on: () => {} },
                subscribe: () => new PassThrough()
            }
        });

        receiver.handleUserStartSpeaking('user-resume');
        receiver.handleAudioChunk('user-resume', createSpeechPcm(200));
        receiver.handleUserStopSpeaking('user-resume');
        // Resume well within the 80ms debounce window
        await sleep(20);
        receiver.handleUserStartSpeaking('user-resume');
        receiver.handleAudioChunk('user-resume', createSpeechPcm(200));
        // Wait past where the original debounce would have fired
        await sleep(120);

        if (dispatched.length !== 0) {
            throw new Error(`Resumed speaker triggered premature dispatch: ${JSON.stringify(dispatched)}`);
        }
        if (utterances.length !== 0) {
            throw new Error(`Resumed speaker triggered premature utterance: ${JSON.stringify(utterances)}`);
        }
        const cancelEvent = endpointing.find(e => e.metadata.active === false && e.metadata.reason === 'speaker resumed');
        if (!cancelEvent) {
            throw new Error(`Endpoint timer not canceled on resume: ${JSON.stringify(endpointing)}`);
        }

        // Now actually finish — second stop, debounce, dispatch
        receiver.handleUserStopSpeaking('user-resume');
        await sleep(120);
        await receiver.waitForPendingUtterances();

        if (dispatched.length !== 1) {
            throw new Error(`Expected 1 dispatch after final stop+debounce, got ${dispatched.length}`);
        }

        receiver.destroy();

        console.log('  Speaker resume cancels debounce; final stop dispatches once');
        passed++;
    } catch (error) {
        console.log(`  Endpoint debounce cancel failed: ${error.message}`);
        failed++;
    }

    console.log('\nTest 11c: Audio Receiver discards non-speech VAD flaps');
    try {
        const utterances = [];
        const dispatched = [];
        const endpointing = [];
        const speechEvidence = [];
        const speechChunk = createSpeechPcm(140);

        const receiver = new AudioReceiver({
            botUserId: 'bot-user',
            endpointingDebounce: 50,
            stt: {
                transcribe: async () => ({ text: 'real speech', confidence: 0.9, words: [] })
            },
            onUtterance: (u) => utterances.push(u),
            onSpeechEvidence: (userId, metadata) => speechEvidence.push({ userId, metadata }),
            onEndpointing: (userId, metadata) => endpointing.push({ userId, metadata }),
            onAsrDispatched: (userId, metadata) => dispatched.push({ userId, metadata })
        });

        receiver.start({
            receiver: {
                speaking: { on: () => {} },
                subscribe: () => new PassThrough()
            }
        });

        receiver.handleUserStartSpeaking('user-flap');
        receiver.handleAudioChunk('user-flap', Buffer.alloc(createSpeechPcm(120).length));
        receiver.handleUserStopSpeaking('user-flap');
        await sleep(100);

        const flapBuffer = receiver.speakerBuffers.get('user-flap');
        if (!flapBuffer || flapBuffer.chunks.length !== 0 || flapBuffer.startTime !== null) {
            throw new Error('Non-speech VAD flap was retained in the utterance buffer');
        }
        if (dispatched.length !== 0 || utterances.length !== 0) {
            throw new Error(`Non-speech VAD flap triggered ASR: ${JSON.stringify({ dispatched, utterances })}`);
        }
        if (speechEvidence.length !== 0) {
            throw new Error(`Non-speech VAD flap emitted speech evidence: ${JSON.stringify(speechEvidence)}`);
        }
        if (endpointing.some(e => e.metadata.active === true)) {
            throw new Error(`Non-speech VAD flap armed endpointing: ${JSON.stringify(endpointing)}`);
        }

        receiver.handleUserStartSpeaking('user-flap');
        receiver.handleAudioChunk('user-flap', speechChunk);
        receiver.handleUserStopSpeaking('user-flap');
        await sleep(100);
        await receiver.waitForPendingUtterances();

        if (dispatched.length !== 1) {
            throw new Error(`Expected exactly one ASR dispatch for real speech, got ${dispatched.length}`);
        }
        if (speechEvidence.length !== 1 || speechEvidence[0].metadata.speakingFrames <= 0) {
            throw new Error(`Real speech did not emit speech evidence: ${JSON.stringify(speechEvidence)}`);
        }
        if (dispatched[0].metadata.audioBytes !== speechChunk.length) {
            throw new Error(`VAD flap bytes leaked into speech buffer: ${JSON.stringify(dispatched[0].metadata)}`);
        }
        if (utterances.length !== 1 || utterances[0].transcription !== 'real speech') {
            throw new Error(`Real speech was not emitted after flap discard: ${JSON.stringify(utterances)}`);
        }

        receiver.destroy();

        console.log('  Non-speech VAD flap audio is dropped before the next real utterance');
        passed++;
    } catch (error) {
        console.log(`  VAD flap discard failed: ${error.message}`);
        failed++;
    }

    console.log('\nTest 11d: ConversationBuffer endpointing blocks flush like an active speaker');
    try {
        const flushed = [];
        const buffer = new ConversationBuffer({ gracePeriod: 30, cooldownPeriod: 10, pendingAsrTimeout: 1000 });
        buffer.onFlush((utterances) => flushed.push(utterances));

        buffer.markEndpointing('user-x', true);
        buffer.addUtterance({
            userId: 'user-x',
            speaker: 'X',
            transcription: 'should not flush yet',
            speechStartedAt: '2026-05-03T00:00:00.000Z'
        });

        await sleep(80);
        if (flushed.length !== 0) {
            throw new Error('Flush fired while user was endpointing');
        }
        if (buffer.getState().state !== BufferState.USER_SPEAKING) {
            throw new Error(`Expected USER_SPEAKING during endpointing, got ${buffer.getState().state}`);
        }

        buffer.markEndpointing('user-x', false);
        await sleep(80);

        if (flushed.length !== 1 || flushed[0][0].transcription !== 'should not flush yet') {
            throw new Error(`Expected single flush after endpointing cleared: ${JSON.stringify(flushed)}`);
        }

        const heldFlushed = [];
        const heldBuffer = new ConversationBuffer({ gracePeriod: 30, cooldownPeriod: 10, pendingAsrTimeout: 1000 });
        heldBuffer.onFlush((utterances) => heldFlushed.push(utterances));
        heldBuffer.setFlushHold('direct-response', true);
        heldBuffer.addUtterance({
            userId: 'user-held',
            speaker: 'Held',
            transcription: 'wait until the host turn finishes',
            speechStartedAt: '2026-05-03T00:00:01.000Z'
        });

        await sleep(80);
        if (heldFlushed.length !== 0) {
            throw new Error('Flush fired while direct response hold was active');
        }
        if (heldBuffer.getState().flushHoldCount !== 1 || heldBuffer.getState().isReady) {
            throw new Error(`Expected held buffer state, got ${JSON.stringify(heldBuffer.getState())}`);
        }

        heldBuffer.setFlushHold('direct-response', false);
        await sleep(80);
        if (heldFlushed.length !== 1 || heldFlushed[0][0].transcription !== 'wait until the host turn finishes') {
            throw new Error(`Expected flush after hold cleared: ${JSON.stringify(heldFlushed)}`);
        }

        console.log('  Endpointing and direct-response holds block flush; clearing them lets grace timer proceed');
        passed++;
    } catch (error) {
        console.log(`  ConversationBuffer endpointing gate failed: ${error.message}`);
        failed++;
    }

    console.log('\nTest 11: Speaker audio mixes at detected speech start, not first-chunk time');
    try {
        const utterances = [];
        const receiver = new AudioReceiver({
            stt: {
                transcribe: async () => ({
                    text: 'late speech after pre-speech noise',
                    confidence: 0.9,
                    words: [],
                    language: 'en'
                })
            },
            onUtterance: (utterance) => utterances.push(utterance)
        });

        const chunkStartMs = Date.parse('2026-05-03T20:49:00.000Z');
        const speechStartIso = '2026-05-03T20:49:07.000Z';
        const speechEndIso = '2026-05-03T20:49:10.000Z';
        const rawCapture = Buffer.alloc(48000, 0x5a);

        await receiver.processUtteranceSnapshot({
            userId: 'user-late-speech',
            speakerInfo: { name: 'Jensen', role: 'guest' },
            audioBuffer: rawCapture,
            startTime: chunkStartMs,
            duration: 10000,
            timestamp: speechStartIso,
            speechStartedAt: speechStartIso,
            speechEndedAt: speechEndIso,
            speechDuration: 3000
        });

        if (utterances.length !== 1) {
            throw new Error(`Expected 1 utterance, got ${utterances.length}`);
        }
        const expected = Date.parse(speechStartIso);
        if (utterances[0].startTime !== expected) {
            throw new Error(`Expected recording startTime=${expected} (speech start), got ${utterances[0].startTime} (chunk start was ${chunkStartMs})`);
        }
        if (
            utterances[0].audioBuffer !== rawCapture ||
            utterances[0].sampleRate !== 48000 ||
            utterances[0].channels !== 2
        ) {
            throw new Error('Recording path did not retain the raw 48kHz stereo capture');
        }

        console.log('  Recording keeps the raw 48kHz stereo capture and aligns it to detected speech start');
        passed++;
    } catch (error) {
        console.log(`  Speaker mix alignment failed: ${error.message}`);
        failed++;
    }

    console.log('\nTest 12: Audio Recorder journals participant and host audio immediately');
    try {
        const { AudioRecorder } = require('./audio-recorder');
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-journal-test-'));
        const recorder = new AudioRecorder({ outputFormat: 'wav' });
        recorder.startRecording(tempDir, {
            consentGiven: true,
            episodeName: 'journal-test'
        });

        const fakeBotAudio = Buffer.alloc(1024);
        recorder.addBotAudio(fakeBotAudio, { startTime: Date.now() });
        const fakeLivePcm = Buffer.alloc(1920);
        recorder.addBotPcmChunk(fakeLivePcm, {
            sourceId: 'gemini-live',
            groupId: 'turn-1',
            sampleRate: 48000,
            channels: 2
        });
        recorder.anchorBotAudioGroup('turn-1', Date.now());
        recorder.addParticipantAudioChunk('guest-1', Buffer.alloc(3840), {
            sampleRate: 48000,
            channels: 2
        });
        recorder.journal.forceSync();

        const events = recorder.journal.readEvents();
        const encoded = events.find((event) => event.type === 'encoded');
        const liveChunk = events.find((event) => event.type === 'pcm' && event.sourceType === 'host');
        const participantChunk = events.find((event) => event.type === 'pcm' && event.sourceType === 'participant');
        const anchor = events.find((event) => event.type === 'anchor' && event.groupId === 'turn-1');
        if (!encoded || !liveChunk || !participantChunk || !anchor) {
            throw new Error(`Missing journal events: ${events.map((event) => event.type).join(', ')}`);
        }
        const participantPath = path.join(tempDir, 'audio-journal', participantChunk.file);
        if (fs.statSync(participantPath).size !== 3840) {
            throw new Error('Participant PCM was not written to disk immediately');
        }
        if (liveChunk.groupOffsetMs !== 0 || liveChunk.sampleRate !== 48000 || liveChunk.channels !== 2) {
            throw new Error(`Live PCM timing metadata not preserved: ${JSON.stringify(liveChunk)}`);
        }
        if (recorder.stats.botAudioChunks !== 2) {
            throw new Error(`Expected botAudioChunks=2, got ${recorder.stats.botAudioChunks}`);
        }

        recorder.destroy();
        fs.rmSync(tempDir, { recursive: true, force: true });
        console.log('  Participant PCM, encoded host audio, live host PCM, and playback anchors are durable');
        passed++;
    } catch (error) {
        console.log(`  Audio Recorder journal failed: ${error.message}`);
        failed++;
    }

    console.log('\nTest 13: Audio Transmitter skips inline volume at unity');
    try {
        const { AudioTransmitter } = require('./audio-transmitter');
        const { StreamType } = require('@discordjs/voice');
        const { Readable } = require('stream');
        const { EventEmitter } = require('events');

        const probe = new AudioTransmitter({});
        const cases = [
            [1.0, false, 'unity'],
            [1.0001, false, 'within tolerance'],
            [0.9999, false, 'within tolerance below'],
            [1.01, true, 'past tolerance'],
            [0.5, true, 'half'],
            [0, true, 'mute'],
            [NaN, true, 'NaN falls back to inline'],
        ];
        for (const [v, expected, label] of cases) {
            const got = probe.shouldUseInlineVolume(v);
            if (got !== expected) {
                throw new Error(`shouldUseInlineVolume(${v}) [${label}] expected ${expected}, got ${got}`);
            }
        }

        let captured = null;
        const fakePlayer = { on() {}, play(resource) { captured = resource; } };

        const unityT = new AudioTransmitter({ player: fakePlayer });
        await unityT.play(Readable.from([Buffer.alloc(0)]), { volume: 1, inputType: StreamType.Raw });
        if (!captured) {
            throw new Error('Unity playback did not reach player');
        }
        if (captured.volume) {
            throw new Error('Expected no VolumeTransformer at v=1.0');
        }

        captured = null;
        const halfT = new AudioTransmitter({ player: fakePlayer });
        await halfT.play(Readable.from([Buffer.alloc(0)]), { volume: 0.5, inputType: StreamType.Raw });
        if (!captured) {
            throw new Error('Half-volume playback did not reach player');
        }
        if (!captured.volume) {
            throw new Error('Expected VolumeTransformer at v=0.5');
        }

        class StopErrorPlayer extends EventEmitter {
            play(resource) {
                captured = resource;
            }

            stop() {
                this.emit('error', new Error('Premature close'));
            }
        }

        let globalErrorCalled = false;
        let finishCalled = false;
        const stopErrorPlayer = new StopErrorPlayer();
        const stopT = new AudioTransmitter({
            player: stopErrorPlayer,
            onError: () => { globalErrorCalled = true; }
        });
        await stopT.play(Readable.from([Buffer.alloc(0)]), {
            inputType: StreamType.Raw,
            onFinish: () => { finishCalled = true; }
        });
        stopT.stop();
        if (globalErrorCalled) {
            throw new Error('Intentional stop should suppress the follow-up player error');
        }
        if (!finishCalled) {
            throw new Error('Intentional stop should still finish the stopped playback');
        }

        console.log('  Inline volume skipped at unity, applied otherwise, and intentional stop errors are suppressed');
        passed++;
    } catch (error) {
        console.log(`  Audio Transmitter inline volume failed: ${error.message}`);
        failed++;
    }

    console.log('\nTest 13a: Streamed Opus starts immediately and tolerates synthesis gaps');
    try {
        const bot = Object.create(AlphaClawdVoiceBot.prototype);
        const source = new PassThrough();
        const capture = bot.teeAudioForRecording(source);
        const firstPlaybackChunk = new Promise((resolve, reject) => {
            capture.playbackAudio.once('data', resolve);
            capture.playbackAudio.once('error', reject);
        });
        source.write(Buffer.from('first-chunk'));
        const firstChunk = await firstPlaybackChunk;
        if (firstChunk.toString() !== 'first-chunk') {
            throw new Error(`First streamed chunk was not forwarded immediately: ${firstChunk}`);
        }
        source.end();
        await capture.completion;

        const manager = Object.create(VoiceManager.prototype);
        manager.options = { audioPlayerMaxMissedFrames: 1500 };
        const player = manager.createPlaybackPlayer();
        if (player.behaviors.maxMissedFrames !== 1500) {
            throw new Error(
                `Expected 1500 missed frames, got ${player.behaviors.maxMissedFrames}`
            );
        }

        console.log('  First audio is unbuffered and Discord silence can bridge up to 30s of open-stream gaps');
        passed++;
    } catch (error) {
        console.log(`  Streamed Opus gap tolerance failed: ${error.message}`);
        failed++;
    }

    console.log('\nTest 13b: Streamed TTS capture waits for bytes arriving after player idle');
    try {
        const bot = Object.create(AlphaClawdVoiceBot.prototype);
        const source = new PassThrough();
        let recordedAudio = null;
        bot.voiceProvider = { tts: { format: 'opus' } };
        bot.duckBigBrainAmbientBed = () => {};
        bot.noteHostPlaybackStart = () => {};
        bot.noteHostPlaybackEnd = () => {};
        bot.voiceManager = {
            speakWithTiming: async (_guildId, playbackAudio, options = {}) => {
                playbackAudio.resume();
                options.onStart?.({ playbackStartedAt: '2026-06-12T00:00:00.000Z' });
                return {
                    timing: {
                        playbackRequestedAt: '2026-06-11T23:59:59.900Z',
                        playbackStartedAt: '2026-06-12T00:00:00.000Z',
                        playbackEndedAt: null
                    },
                    finished: new Promise(resolve => setTimeout(() => resolve({
                        playbackRequestedAt: '2026-06-11T23:59:59.900Z',
                        playbackStartedAt: '2026-06-12T00:00:00.000Z',
                        playbackEndedAt: '2026-06-12T00:00:00.100Z'
                    }), 5))
                };
            },
            addBotAudioToRecording: (_guildId, audio) => {
                recordedAudio = Buffer.from(audio);
            }
        };

        const playbackPromise = bot.playTtsAndRecord('guild-stream-capture', source);
        source.write(Buffer.from('first'));
        setTimeout(() => source.end(Buffer.from('-later')), 20);
        const result = await playbackPromise;
        if (
            recordedAudio?.toString() !== 'first-later' ||
            !result.ttsCompletedAt ||
            result.playbackUnderrunDetected !== true
        ) {
            throw new Error(`Stream capture finalized before synthesis ended: ${JSON.stringify({
                recordedAudio: recordedAudio?.toString(),
                result
            })}`);
        }

        console.log('  Streamed recording capture includes audio that arrives after an early player idle');
        passed++;
    } catch (error) {
        console.log(`  Streamed TTS capture completion failed: ${error.message}`);
        failed++;
    }

    console.log('\nTest 14: IncrementalSpeechReader decodes streaming JSON');
    try {
        const { IncrementalSpeechReader } = require('./podcast-generator');

        // a) Feed the full JSON in one push.
        const r1 = new IncrementalSpeechReader();
        const out1 = r1.push('{"shouldRespond":true,"speech":"Hello, world.","bigBrain":{"requested":false,"reason":""}}');
        if (out1.shouldRespond !== true) {
            throw new Error(`a: shouldRespond expected true, got ${out1.shouldRespond}`);
        }
        if (!out1.speechComplete) {
            throw new Error('a: expected speechComplete true');
        }
        const a_speech = out1.chunks.join('');
        if (a_speech !== 'Hello, world.') {
            throw new Error(`a: speech mismatch: ${JSON.stringify(a_speech)}`);
        }
        const a_final = r1.finalize();
        if (a_final.shouldRespond !== true || a_final.speech !== 'Hello, world.') {
            throw new Error(`a: finalize mismatch: ${JSON.stringify(a_final)}`);
        }

        // b) Chunked feed: shouldRespond resolves before speech complete.
        const r2 = new IncrementalSpeechReader();
        const pushes = [
            '{"shouldRes',
            'pond":true,"spe',
            'ech":"Hello',
            ', world."',
            ',"bigBrain":{"requested":false,"reason":""}}'
        ];
        const collected = [];
        let sawShouldRespond = -1;
        for (let idx = 0; idx < pushes.length; idx++) {
            const r = r2.push(pushes[idx]);
            if (sawShouldRespond < 0 && r.shouldRespond !== null) {
                sawShouldRespond = idx;
            }
            collected.push(...r.chunks);
        }
        if (sawShouldRespond !== 1) {
            throw new Error(`b: shouldRespond should resolve on push 1, got ${sawShouldRespond}`);
        }
        if (collected.join('') !== 'Hello, world.') {
            throw new Error(`b: speech mismatch: ${JSON.stringify(collected)}`);
        }
        if (!r2.speechComplete) {
            throw new Error('b: expected speechComplete true');
        }

        // c) Escape handling: \", \n, \\, \/, \uXXXX.
        const r3 = new IncrementalSpeechReader();
        const out3 = r3.push('{"shouldRespond":true,"speech":"a \\"q\\" b\\nc\\\\d\\/e\\u0041f","bigBrain":{"requested":false,"reason":""}}');
        const c_speech = out3.chunks.join('');
        if (c_speech !== 'a "q" b\nc\\d/eAf') {
            throw new Error(`c: escape decode mismatch: ${JSON.stringify(c_speech)}`);
        }

        // d) Mid-escape boundary: backslash arrives before its mate.
        const r4 = new IncrementalSpeechReader();
        let d_speech = '';
        d_speech += r4.push('{"shouldRespond":true,"speech":"hi\\').chunks.join('');
        if (r4.speechComplete) {
            throw new Error('d: should not be complete with dangling backslash');
        }
        d_speech += r4.push('nthere"').chunks.join('');
        if (d_speech !== 'hi\nthere') {
            throw new Error(`d: mid-escape decode mismatch: ${JSON.stringify(d_speech)}`);
        }
        if (!r4.speechComplete) {
            throw new Error('d: expected speechComplete after closing quote');
        }

        // e) Mid-\u boundary: hex digits arrive in pieces.
        const r5 = new IncrementalSpeechReader();
        let e_speech = '';
        e_speech += r5.push('{"shouldRespond":true,"speech":"\\u00').chunks.join('');
        if (e_speech !== '') {
            throw new Error(`e: should defer until \\u has 4 hex chars, got ${JSON.stringify(e_speech)}`);
        }
        e_speech += r5.push('41done"').chunks.join('');
        if (e_speech !== 'Adone') {
            throw new Error(`e: \\u boundary decode mismatch: ${JSON.stringify(e_speech)}`);
        }

        // f) shouldRespond=false: empty speech, finalize returns false.
        const r6 = new IncrementalSpeechReader();
        const out6 = r6.push('{"shouldRespond":false,"speech":"","bigBrain":{"requested":false,"reason":""}}');
        if (out6.shouldRespond !== false) {
            throw new Error(`f: shouldRespond expected false, got ${out6.shouldRespond}`);
        }
        if (out6.chunks.length !== 0) {
            throw new Error(`f: expected no speech chunks, got ${JSON.stringify(out6.chunks)}`);
        }
        const f_final = r6.finalize();
        if (f_final.shouldRespond !== false) {
            throw new Error('f: finalize shouldRespond expected false');
        }

        // g) Truncated buffer: finalize falls back to fullSpeech.
        const r7 = new IncrementalSpeechReader();
        r7.push('{"shouldRespond":true,"speech":"partial');
        const g_final = r7.finalize();
        if (g_final.speech !== 'partial' || g_final.shouldRespond !== true) {
            throw new Error(`g: truncated finalize mismatch: ${JSON.stringify(g_final)}`);
        }

        // h) Speech-first response: chunks arrive before shouldRespond parses.
        const r8 = new IncrementalSpeechReader();
        const h_first = r8.push('{"speech":"Hello');
        if (h_first.shouldRespond !== null || h_first.chunks.join('') !== 'Hello') {
            throw new Error(`h: expected speech before shouldRespond, got ${JSON.stringify(h_first)}`);
        }
        const h_second = r8.push(', first.","shouldRespond":');
        if (
            h_second.shouldRespond !== null ||
            h_second.chunks.join('') !== ', first.' ||
            !h_second.speechComplete
        ) {
            throw new Error(`h: speech should complete before shouldRespond parses: ${JSON.stringify(h_second)}`);
        }
        const h_third = r8.push('true,"bigBrain":{"requested":false,"reason":"","consumedRunId":""},"bigHeart":{"requested":false,"reason":"","consumedRunId":""}}');
        if (h_third.shouldRespond !== true || h_third.chunks.length !== 0) {
            throw new Error(`h: shouldRespond should parse after streamed speech: ${JSON.stringify(h_third)}`);
        }

        // i) Speech-first silence: empty speech completes without triggering a chunk.
        const r9 = new IncrementalSpeechReader();
        const i_first = r9.push('{"speech":""');
        if (
            i_first.shouldRespond !== null ||
            i_first.chunks.length !== 0 ||
            !i_first.speechComplete
        ) {
            throw new Error(`i: empty speech should complete while shouldRespond remains pending: ${JSON.stringify(i_first)}`);
        }
        const i_second = r9.push(',"shouldRespond":false,"bigBrain":{"requested":false,"reason":"","consumedRunId":""},"bigHeart":{"requested":false,"reason":"","consumedRunId":""}}');
        if (i_second.shouldRespond !== false || i_second.chunks.length !== 0) {
            throw new Error(`i: silence should resolve false with no speech chunks: ${JSON.stringify(i_second)}`);
        }
        const i_final = r9.finalize();
        if (i_final.shouldRespond !== false || i_final.speech !== '') {
            throw new Error(`i: silence finalize mismatch: ${JSON.stringify(i_final)}`);
        }

        console.log('  IncrementalSpeechReader handles both field orders, including speech-first response and silence turns');
        passed++;
    } catch (error) {
        console.log(`  IncrementalSpeechReader failed: ${error.message}`);
        failed++;
    }

    console.log('\nTest 14b: StreamingSpeechSanitizer protects boundaries and reports rewrites');
    try {
        const { StreamingSpeechSanitizer } = require('./podcast-generator');

        const splitSanitizer = new StreamingSpeechSanitizer();
        if (splitSanitizer.lookbehindChars !== 8) {
            throw new Error(`default lookbehind expected 8, got ${splitSanitizer.lookbehindChars}`);
        }
        let splitOutput = splitSanitizer.push('option A ');
        splitOutput += splitSanitizer.push('/ option B');

        const originalConsoleLog = console.log;
        const sanitizerLogs = [];
        try {
            console.log = (...args) => {
                const line = args.join(' ');
                if (line.startsWith('[StreamingSpeechSanitizer]')) {
                    sanitizerLogs.push(line);
                }
            };
            splitOutput += splitSanitizer.flush();

            const cleanSanitizer = new StreamingSpeechSanitizer();
            let cleanOutput = cleanSanitizer.push('option A, option B');
            cleanOutput += cleanSanitizer.flush();
            if (cleanOutput !== 'option A, option B') {
                throw new Error(`clean output mismatch: ${JSON.stringify(cleanOutput)}`);
            }
        } finally {
            console.log = originalConsoleLog;
        }

        if (splitOutput !== 'option A, option B') {
            throw new Error(`split boundary output mismatch: ${JSON.stringify(splitOutput)}`);
        }
        if (
            sanitizerLogs.length !== 1 ||
            sanitizerLogs[0] !== '[StreamingSpeechSanitizer] rewrote 1 slash separator(s) this turn'
        ) {
            throw new Error(`expected exactly one rewrite log, got ${JSON.stringify(sanitizerLogs)}`);
        }

        const oneCharSanitizer = new StreamingSpeechSanitizer();
        let oneCharOutput = '';
        for (const char of 'option A / option B') {
            oneCharOutput += oneCharSanitizer.push(char);
        }
        const originalConsoleLogForOneChar = console.log;
        try {
            console.log = () => {};
            oneCharOutput += oneCharSanitizer.flush();
        } finally {
            console.log = originalConsoleLogForOneChar;
        }
        if (oneCharOutput !== 'option A, option B') {
            throw new Error(`one-character boundary output mismatch: ${JSON.stringify(oneCharOutput)}`);
        }

        const overrideSanitizer = new StreamingSpeechSanitizer({ lookbehindChars: 3 });
        if (overrideSanitizer.lookbehindChars !== 3) {
            throw new Error(`lookbehind override expected 3, got ${overrideSanitizer.lookbehindChars}`);
        }

        console.log('  Eight-character holdback preserves split separators and logs only rewritten turns');
        passed++;
    } catch (error) {
        console.log(`  StreamingSpeechSanitizer failed: ${error.message}`);
        failed++;
    }

    console.log('\nTest 15: synthesizeLiveTTS accepts an async iterable for streaming text');
    try {
        const { AlphaClawdVoiceBot } = require('./index');

        // We only need synthesizeLiveTTS; build a stub bot with the
        // minimum surface required to exercise the iterable branch.
        const captured = { textChunks: null, options: null };
        const stubBot = {
            voiceProvider: {
                isStreamingEnabled: () => true,
                synthesizeStream: (textChunks, options) => {
                    captured.textChunks = textChunks;
                    captured.options = options;
                    return { tag: 'fake-readable' };
                }
            },
            singleTextChunk: AlphaClawdVoiceBot.prototype.singleTextChunk,
            synthesizeLiveTTS: AlphaClawdVoiceBot.prototype.synthesizeLiveTTS
        };

        async function* speech() {
            yield 'Hello ';
            yield 'world.';
        }

        const result = await stubBot.synthesizeLiveTTS(speech(), { voiceId: 'v' });
        if (!result || result.tag !== 'fake-readable') {
            throw new Error('Expected synthesizeStream return value to pass through');
        }
        if (typeof captured.textChunks?.[Symbol.asyncIterator] !== 'function') {
            throw new Error('Expected async iterable to be passed through to synthesizeStream');
        }
        let assembled = '';
        for await (const chunk of captured.textChunks) assembled += chunk;
        if (assembled !== 'Hello world.') {
            throw new Error(`Async iterable not threaded correctly: ${JSON.stringify(assembled)}`);
        }
        if (captured.options?.voiceId !== 'v') {
            throw new Error('Expected options to flow through to synthesizeStream');
        }

        console.log('  synthesizeLiveTTS forwards async iterables to fish provider verbatim');
        passed++;
    } catch (error) {
        console.log(`  synthesizeLiveTTS streaming wiring failed: ${error.message}`);
        failed++;
    }

    console.log('\nTest 15b: Fish credit fallback uses Edge TTS without Fish voice options');
    try {
        const { VoiceProvider, isFishCreditError } = require('./voice-provider');
        const { EdgeTTSProvider } = require('./edge-tts-provider');
        const provider = new VoiceProvider({
            mode: 'fish',
            fishApiKey: 'test_fish_audio_key_placeholder',
            fishCreditFallback: true,
            fishAsrFallback: 'none'
        });
        let fishCalls = 0;
        let edgeCalls = 0;
        provider.tts = {
            synthesize: async () => {
                fishCalls++;
                const error = new Error('Fish Audio TTS API error: 402 - {"message":"Insufficient Balance","status":402}');
                error.status = 402;
                throw error;
            },
            isStreamingEnabled: () => true
        };
        provider.fallbackTts = {
            synthesize: async (text, options = {}) => {
                edgeCalls++;
                if (options.voiceId || options.referenceId || options.model || options.format) {
                    throw new Error(`Fish-only options leaked to Edge fallback: ${JSON.stringify(options)}`);
                }
                return Buffer.from(`edge:${text}`);
            }
        };

        const audio = await provider.synthesize('Hello [short pause] there.', {
            voiceId: 'fish-voice-id',
            model: 's2-pro',
            format: 'mp3'
        });
        const edge = new EdgeTTSProvider();
        const processed = edge.preprocessText('Hello [short pause] there (long-break) <break time="1s" /> [emphasis]');

        if (!Buffer.isBuffer(audio) || audio.toString() !== 'edge:Hello [short pause] there.') {
            throw new Error(`Fallback did not return Edge audio buffer: ${audio && audio.toString()}`);
        }
        if (fishCalls !== 1 || edgeCalls !== 1 || !provider.fishCreditDepleted) {
            throw new Error(`Fallback counters/state wrong: ${JSON.stringify({ fishCalls, edgeCalls, depleted: provider.fishCreditDepleted })}`);
        }
        if (provider.isStreamingEnabled()) {
            throw new Error('Streaming should be disabled after Fish credit depletion');
        }
        if (!isFishCreditError(new Error('Fish Audio ASR API error: 402 - {"message":"Insufficient Balance"}'))) {
            throw new Error('Fish credit error helper did not recognize 402 insufficient balance');
        }
        if (processed !== 'Hello ... there ... ...') {
            throw new Error(`Edge preprocessing did not remove Fish controls: ${JSON.stringify(processed)}`);
        }

        console.log('  Fish 402 switches to Edge TTS fallback and strips Fish controls for Edge');
        passed++;
    } catch (error) {
        console.log(`  Fish credit fallback failed: ${error.message}`);
        failed++;
    }

    console.log('\nTest 16: generateStreaming 429 does not leak unhandled rejections');
    try {
        const { PodcastGenerator } = require('./podcast-generator');

        const originalFetch = globalThis.fetch;
        const seenUnhandled = [];
        const handler = (reason) => { seenUnhandled.push(reason); };
        process.on('unhandledRejection', handler);

        let shouldErr = null;
        try {
            globalThis.fetch = async () => ({
                ok: false,
                status: 429,
                text: async () => '{"error":{"message":"rate limited","type":"tokens","code":"rate_limit_exceeded"}}'
            });

            const gen = new PodcastGenerator({
                apiKey: 'test-key',
                keyRouting: 'legacy-failover',
                timeout: 1000
            });
            const stream = await gen.generateStreaming({ transcript: 'hi', remember: false });

            // Caller awaits shouldRespond, catches its rejection, and never
            // touches completed — exactly the bot.js fallback path.
            try {
                await stream.shouldRespond;
            } catch (e) {
                shouldErr = e;
            }

            // Give Node multiple turns of the event loop for any pending
            // unhandledRejection to fire before we assert.
            await new Promise(resolve => setImmediate(resolve));
            await new Promise(resolve => setTimeout(resolve, 30));
            await new Promise(resolve => setImmediate(resolve));
        } finally {
            process.off('unhandledRejection', handler);
            globalThis.fetch = originalFetch;
        }

        if (!shouldErr) {
            throw new Error('Expected shouldRespond to reject on 429');
        }
        if (!/429/.test(shouldErr.message || '')) {
            throw new Error(`Expected 429 in error message, got: ${shouldErr.message}`);
        }
        if (seenUnhandled.length > 0) {
            const first = seenUnhandled[0];
            throw new Error(`Leaked unhandled rejection(s): ${first?.message || first}`);
        }

        console.log('  Streaming 429 surfaces via shouldRespond without leaking unhandled rejections');
        passed++;
    } catch (error) {
        console.log(`  Streaming unhandled-rejection guard failed: ${error.message}`);
        failed++;
    }

    console.log('\nTest 16a: generateStreaming gates speech-first response and silence turns correctly');
    try {
        const { PodcastGenerator } = require('./podcast-generator');
        const originalFetch = globalThis.fetch;
        const encoder = new TextEncoder();
        const makeControlledResponse = () => {
            let controller;
            const body = new ReadableStream({
                start(value) {
                    controller = value;
                }
            });
            return {
                response: new Response(body, {
                    status: 200,
                    headers: { 'content-type': 'text/event-stream' }
                }),
                send(content) {
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({
                        choices: [{ delta: { content } }]
                    })}\n\n`));
                },
                finish() {
                    controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                    controller.close();
                }
            };
        };

        try {
            const responses = [];
            globalThis.fetch = async () => {
                const controlled = makeControlledResponse();
                responses.push(controlled);
                return controlled.response;
            };

            const gen = new PodcastGenerator({
                apiKey: 'test-key',
                baseUrl: 'https://api.openai.test/v1',
                model: 'test-model',
                timeout: 1000
            });

            const responseTurn = await gen.generateStreaming({
                transcript: 'Jensen: Say hello.',
                remember: false
            });
            while (responses.length < 1) {
                await new Promise(resolve => setImmediate(resolve));
            }
            const earlySpeech = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
            responses[0].send(`{"speech":"${earlySpeech}`);
            const responseDecision = await Promise.race([
                responseTurn.shouldRespond,
                new Promise((_, reject) => setTimeout(() => reject(new Error('response shouldRespond did not resolve from speech chunks')), 1000))
            ]);
            if (responseDecision !== true) {
                throw new Error(`speech-first response should resolve true before its field parses, got ${responseDecision}`);
            }
            const responseIterator = responseTurn.speechStream[Symbol.asyncIterator]();
            const firstSpeech = await responseIterator.next();
            const expectedEarlySpeech = earlySpeech.slice(0, -8);
            if (firstSpeech.done || firstSpeech.value !== expectedEarlySpeech) {
                throw new Error(`speech-first response did not stream its early chunk: ${JSON.stringify(firstSpeech)}`);
            }
            responses[0].send('","shouldRespond":true,"bigBrain":{"requested":false,"reason":"","consumedRunId":""},"bigHeart":{"requested":false,"reason":"","consumedRunId":""}}');
            responses[0].finish();
            let responseSpeech = firstSpeech.value;
            for await (const chunk of { [Symbol.asyncIterator]: () => responseIterator }) {
                responseSpeech += chunk;
            }
            const responseCompleted = await responseTurn.completed;
            if (responseSpeech !== earlySpeech || responseCompleted.speech !== earlySpeech || !responseCompleted.shouldRespond) {
                throw new Error(`speech-first response completion mismatch: ${JSON.stringify({ responseSpeech, responseCompleted })}`);
            }

            const silenceTurn = await gen.generateStreaming({
                transcript: 'Jensen: Actually, hold on.',
                remember: false
            });
            while (responses.length < 2) {
                await new Promise(resolve => setImmediate(resolve));
            }
            let silenceShouldSettled = false;
            silenceTurn.shouldRespond.then(
                () => { silenceShouldSettled = true; },
                () => { silenceShouldSettled = true; }
            );
            responses[1].send('{"speech":""');
            const silenceIterator = silenceTurn.speechStream[Symbol.asyncIterator]();
            const silenceFirst = await silenceIterator.next();
            await new Promise(resolve => setImmediate(resolve));
            if (!silenceFirst.done || silenceShouldSettled) {
                throw new Error(`empty speech must not resolve shouldRespond early: ${JSON.stringify({ silenceFirst, silenceShouldSettled })}`);
            }
            responses[1].send(',"shouldRespond":false,"bigBrain":{"requested":false,"reason":"","consumedRunId":""},"bigHeart":{"requested":false,"reason":"","consumedRunId":""}}');
            responses[1].finish();
            const silenceDecision = await silenceTurn.shouldRespond;
            const silenceCompleted = await silenceTurn.completed;
            if (silenceDecision !== false || silenceCompleted.shouldRespond !== false || silenceCompleted.speech !== '') {
                throw new Error(`speech-first silence completion mismatch: ${JSON.stringify({ silenceDecision, silenceCompleted })}`);
            }
        } finally {
            globalThis.fetch = originalFetch;
        }

        console.log('  Speech-first chunks resolve true early; empty speech waits for shouldRespond=false');
        passed++;
    } catch (error) {
        console.log(`  Streaming speech-first gating failed: ${error.message}`);
        failed++;
    }

    console.log('\nTest 16b: generateStreaming normalizes spoken slash separators');
    try {
        const { PodcastGenerator } = require('./podcast-generator');
        const originalFetch = globalThis.fetch;

        try {
            globalThis.fetch = async () => {
                const data = (event) => `data: ${JSON.stringify(event)}`;
                const sse = [
                    data({
                        choices: [{
                            delta: {
                                content: '{"shouldRespond":true,"speech":"First sonnet line '
                            }
                        }]
                    }),
                    '',
                    data({
                        choices: [{
                            delta: {
                                content: '/ second sonnet line. / Third sonnet line","bigBrain":{"requested":false,"reason":"","consumedRunId":""}}'
                            }
                        }]
                    }),
                    '',
                    'data: [DONE]',
                    ''
                ].join('\n');
                return new Response(sse, {
                    status: 200,
                    headers: { 'content-type': 'text/event-stream' }
                });
            };

            const gen = new PodcastGenerator({
                apiKey: 'test-key',
                baseUrl: 'https://api.openai.test/v1',
                model: 'test-model',
                timeout: 1000
            });
            const stream = await gen.generateStreaming({
                transcript: 'Jensen: Please recite a sonnet.',
                remember: false
            });
            const shouldRespond = await stream.shouldRespond;
            let streamedSpeech = '';
            for await (const chunk of stream.speechStream) {
                streamedSpeech += chunk;
            }
            const completed = await stream.completed;
            const expected = 'First sonnet line, second sonnet line. Third sonnet line';
            if (!shouldRespond || streamedSpeech !== expected || completed.speech !== expected) {
                throw new Error(`Streaming slash normalization mismatch: ${JSON.stringify({ shouldRespond, streamedSpeech, completed })}`);
            }
        } finally {
            globalThis.fetch = originalFetch;
        }

        console.log('  Streaming speech and final transcript normalize visual slash separators');
        passed++;
    } catch (error) {
        console.log(`  Streaming slash normalization failed: ${error.message}`);
        failed++;
    }

    console.log('\nTest 16c: Kimi Anthropic-compatible streaming');
    try {
        const { PodcastGenerator } = require('./podcast-generator');
        const originalFetch = globalThis.fetch;
        let request = null;

        try {
            globalThis.fetch = async (url, options = {}) => {
                request = {
                    url,
                    headers: options.headers,
                    body: JSON.parse(options.body)
                };
                const data = (event) => `data: ${JSON.stringify(event)}`;
                const sse = [
                    'event: message_start',
                    data({
                        type: 'message_start',
                        message: {
                            usage: {
                                input_tokens: 21,
                                cache_read_input_tokens: 3,
                                output_tokens: 0
                            }
                        }
                    }),
                    '',
                    'event: content_block_delta',
                    data({
                        type: 'content_block_delta',
                        delta: {
                            type: 'text_delta',
                            text: '```json\n{"speech":"Kimi '
                        }
                    }),
                    '',
                    'event: content_block_delta',
                    data({
                        type: 'content_block_delta',
                        delta: {
                            type: 'text_delta',
                            text: 'streaming works."}\n```'
                        }
                    }),
                    '',
                    'event: message_delta',
                    data({
                        type: 'message_delta',
                        usage: {
                            output_tokens: 9
                        }
                    }),
                    '',
                    'event: message_stop',
                    data({ type: 'message_stop' }),
                    ''
                ].join('\n');
                return new Response(sse, {
                    status: 200,
                    headers: { 'content-type': 'text/event-stream' }
                });
            };

            const kimiGenerator = new PodcastGenerator({
                apiKey: 'kimi-test-key',
                baseUrl: 'https://api.kimi.com/coding/v1',
                model: 'kimi-for-coding',
                timeout: 1000
            });
            const stream = await kimiGenerator.generateStreaming({
                transcript: 'Jensen: Test Kimi streaming.',
                remember: false
            });

            const shouldRespond = await stream.shouldRespond;
            let speech = '';
            for await (const chunk of stream.speechStream) {
                speech += chunk;
            }
            const completed = await stream.completed;

            if (
                !shouldRespond ||
                speech !== 'Kimi streaming works.' ||
                completed.speech !== 'Kimi streaming works.' ||
                request?.url !== 'https://api.kimi.com/coding/v1/messages' ||
                request.headers.Authorization ||
                request.headers['x-api-key'] !== 'kimi-test-key' ||
                request.headers['anthropic-version'] !== '2023-06-01' ||
                request.body.model !== 'kimi-for-coding' ||
                request.body.stream !== true ||
                request.body.output_config?.format?.type !== 'json_schema' ||
                JSON.stringify(request.body).includes('cache_control')
            ) {
                throw new Error(`Kimi streaming route failed: ${JSON.stringify({ shouldRespond, speech, completed, request })}`);
            }
        } finally {
            globalThis.fetch = originalFetch;
        }

        console.log('  Kimi streaming uses Anthropic Messages SSE and feeds speech chunks to TTS');
        passed++;
    } catch (error) {
        console.log(`  Kimi streaming failed: ${error.message}`);
        failed++;
    }

    console.log('\nTest 16d: Anthropic Messages streaming');
    try {
        const { PodcastGenerator } = require('./podcast-generator');
        const originalFetch = globalThis.fetch;
        let request = null;

        try {
            globalThis.fetch = async (url, options = {}) => {
                request = {
                    url,
                    headers: options.headers,
                    body: JSON.parse(options.body)
                };
                const data = (event) => `data: ${JSON.stringify(event)}`;
                const sse = [
                    'event: message_start',
                    data({
                        type: 'message_start',
                        message: {
                            usage: {
                                input_tokens: 18,
                                cache_read_input_tokens: 0,
                                output_tokens: 0
                            }
                        }
                    }),
                    '',
                    'event: content_block_delta',
                    data({
                        type: 'content_block_delta',
                        delta: {
                            type: 'text_delta',
                            text: '```json\n{"speech":"Anthropic '
                        }
                    }),
                    '',
                    'event: content_block_delta',
                    data({
                        type: 'content_block_delta',
                        delta: {
                            type: 'text_delta',
                            text: 'streaming works."}\n```'
                        }
                    }),
                    '',
                    'event: message_delta',
                    data({
                        type: 'message_delta',
                        usage: {
                            output_tokens: 8
                        }
                    }),
                    '',
                    'event: message_stop',
                    data({ type: 'message_stop' }),
                    ''
                ].join('\n');
                return new Response(sse, {
                    status: 200,
                    headers: { 'content-type': 'text/event-stream' }
                });
            };

            const anthropicGenerator = new PodcastGenerator({
                apiKey: 'anthropic-test-key',
                baseUrl: 'https://api.anthropic.com/v1',
                model: 'claude-sonnet-4-5-20250929',
                timeout: 1000
            });
            const stream = await anthropicGenerator.generateStreaming({
                transcript: 'Jensen: Test Anthropic streaming.',
                remember: false
            });

            const shouldRespond = await stream.shouldRespond;
            let speech = '';
            for await (const chunk of stream.speechStream) {
                speech += chunk;
            }
            const completed = await stream.completed;
            const systemCacheBlock = Array.isArray(request?.body?.system)
                ? request.body.system[request.body.system.length - 1]
                : null;

            if (
                !shouldRespond ||
                speech !== 'Anthropic streaming works.' ||
                completed.speech !== 'Anthropic streaming works.' ||
                request?.url !== 'https://api.anthropic.com/v1/messages' ||
                request.headers.Authorization ||
                request.headers['x-api-key'] !== 'anthropic-test-key' ||
                request.headers['anthropic-version'] !== '2023-06-01' ||
                request.body.model !== 'claude-sonnet-4-5-20250929' ||
                request.body.stream !== true ||
                !Array.isArray(request.body.system) ||
                systemCacheBlock?.cache_control?.type !== 'ephemeral' ||
                request.body.output_config?.format?.type !== 'json_schema'
            ) {
                throw new Error(`Anthropic streaming route failed: ${JSON.stringify({ shouldRespond, speech, completed, request })}`);
            }
        } finally {
            globalThis.fetch = originalFetch;
        }

        console.log('  Anthropic streaming uses Messages SSE and feeds speech chunks to TTS');
        passed++;
    } catch (error) {
        console.log(`  Anthropic streaming failed: ${error.message}`);
        failed++;
    }

    console.log('\nTest 47a: Bot extracts outer publish JSON');
    try {
        const stdout = [
            'starting publish',
            '{',
            '  "episode": "05",',
            '  "title": "Cabbage, Self-Awareness, and the Cost of Thinking",',
            '  "duration": "19:41",',
            '  "episodeUrl": "https://clawcast.jensenabler.com/episodes/episode-05.mp3",',
            '  "syncTarget": "/var/www/podcast",',
            '  "syncResults": [',
            '    {',
            '      "command": ["rsync", "episode-05.mp3", "/var/www/podcast/episodes/"],',
            '      "returnCode": 0',
            '    },',
            '    {',
            '      "command": ["rsync", "feed.xml", "/var/www/podcast/feed.xml"],',
            '      "returnCode": 0',
            '    }',
            '  ]',
            '}',
            ''
        ].join('\n');

        const parsed = AlphaClawdVoiceBot.prototype.extractLastJson(stdout);
        if (
            parsed?.episode !== '05' ||
            parsed.title !== 'Cabbage, Self-Awareness, and the Cost of Thinking' ||
            parsed.duration !== '19:41' ||
            parsed.syncTarget !== '/var/www/podcast' ||
            parsed.syncResults?.length !== 2
        ) {
            throw new Error(`Parsed wrong JSON object: ${JSON.stringify(parsed)}`);
        }

        console.log('  Bot keeps the outer publish result instead of a nested sync object');
        passed++;
    } catch (error) {
        console.log(`  Publish JSON extraction failed: ${error.message}`);
        failed++;
    }

    console.log('\nTest 47b: Production downloads replace oversized attachments');
    try {
        const originalLimit = process.env.PODCAST_DISCORD_ATTACHMENT_LIMIT_MB;
        const originalDownloadBase = process.env.PODCAST_DOWNLOAD_BASE_URL;
        process.env.PODCAST_DISCORD_ATTACHMENT_LIMIT_MB = '';
        process.env.PODCAST_DOWNLOAD_BASE_URL = 'https://clawcast.jensenabler.com/episodes/';

        const limit = AlphaClawdVoiceBot.prototype.getDiscordAttachmentLimitMB();
        const legacyDownloadUrl = AlphaClawdVoiceBot.prototype.buildEpisodeDownloadUrl(
            { episodesCopy: '/opt/clawcast-network/content/episodes/episode-06.mp3' },
            '/opt/clawcast-network/content/production/episode-06/v004/episode-06-v004.mp3'
        );
        const downloadUrl = AlphaClawdVoiceBot.prototype.buildEpisodeDownloadUrl(
            {
                episodesCopy: '/opt/clawcast-network/content/episodes/episode-06.mp3',
                versionedEpisodesCopy: '/opt/clawcast-network/content/episodes/episode-06-v004.mp3'
            },
            '/opt/clawcast-network/content/production/episode-06/v004/episode-06-v004.mp3'
        );
        const unpublishedDownloadUrl = AlphaClawdVoiceBot.prototype.buildEpisodeDownloadUrl(
            {},
            '/opt/clawcast-network/content/production/episode-06/v004/episode-06-v004.mp3'
        );
        const notice = AlphaClawdVoiceBot.prototype.appendDownloadNotice(
            'done',
            16.1,
            limit,
            downloadUrl,
            '/tmp/episode-06.mp3'
        );
        const previousContentRoot = process.env.CLAWCAST_CONTENT_ROOT;
        const previousPodcastRoot = process.env.PODCAST_ROOT;
        const previousPodcastContentRoot = process.env.PODCAST_CONTENT_ROOT;
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'production-versioned-download-'));
        let preparedDownloadUrl = null;

        try {
            process.env.CLAWCAST_CONTENT_ROOT = tempRoot;
            delete process.env.PODCAST_ROOT;
            delete process.env.PODCAST_CONTENT_ROOT;

            const finalDir = path.join(tempRoot, 'production', 'episode-06', 'v004');
            const finalMp3 = path.join(finalDir, 'episode-06-v004.mp3');
            fs.mkdirSync(finalDir, { recursive: true });
            fs.writeFileSync(finalMp3, Buffer.from('versioned render'));

            const prepared = AlphaClawdVoiceBot.prototype.ensureProductionVersionedDownload({
                episode: '06',
                version: 'v004',
                finalMp3
            });
            const versionedPath = path.join(tempRoot, 'episodes', 'episode-06-v004.mp3');
            const stablePath = path.join(tempRoot, 'episodes', 'episode-06.mp3');
            preparedDownloadUrl = AlphaClawdVoiceBot.prototype.buildEpisodeDownloadUrl(prepared, finalMp3);

            if (prepared.versionedEpisodesCopy !== versionedPath || !fs.existsSync(versionedPath)) {
                throw new Error(`Versioned production download was not prepared: ${JSON.stringify(prepared)}`);
            }
            if (fs.existsSync(stablePath)) {
                throw new Error(`Production download helper wrote stable published MP3: ${stablePath}`);
            }
        } finally {
            if (previousContentRoot === undefined) delete process.env.CLAWCAST_CONTENT_ROOT;
            else process.env.CLAWCAST_CONTENT_ROOT = previousContentRoot;
            if (previousPodcastRoot === undefined) delete process.env.PODCAST_ROOT;
            else process.env.PODCAST_ROOT = previousPodcastRoot;
            if (previousPodcastContentRoot === undefined) delete process.env.PODCAST_CONTENT_ROOT;
            else process.env.PODCAST_CONTENT_ROOT = previousPodcastContentRoot;
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }

        if (limit !== 8) {
            throw new Error(`Expected default upload limit 8 MB, got ${limit}`);
        }
        if (legacyDownloadUrl !== 'https://clawcast.jensenabler.com/episodes/episode-06.mp3') {
            throw new Error(`Expected legacy episodesCopy URL fallback, got ${legacyDownloadUrl}`);
        }
        if (downloadUrl !== 'https://clawcast.jensenabler.com/episodes/episode-06-v004.mp3') {
            throw new Error(`Unexpected download URL: ${downloadUrl}`);
        }
        if (unpublishedDownloadUrl !== null) {
            throw new Error(`Unpublished production render should not get public episode URL, got ${unpublishedDownloadUrl}`);
        }
        if (preparedDownloadUrl !== 'https://clawcast.jensenabler.com/episodes/episode-06-v004.mp3') {
            throw new Error(`Prepared versioned download URL was not public: ${preparedDownloadUrl}`);
        }
        if (!notice.includes('16.1 MB') || !notice.includes(downloadUrl) || !notice.includes('/tmp/episode-06.mp3')) {
            throw new Error(`Notice omitted expected publish details: ${notice}`);
        }
        if (!AlphaClawdVoiceBot.prototype.isDiscordRequestTooLarge({ code: 40005, message: 'Request entity too large' })) {
            throw new Error('Request-too-large detection failed');
        }

        if (originalLimit === undefined) {
            delete process.env.PODCAST_DISCORD_ATTACHMENT_LIMIT_MB;
        } else {
            process.env.PODCAST_DISCORD_ATTACHMENT_LIMIT_MB = originalLimit;
        }
        if (originalDownloadBase === undefined) {
            delete process.env.PODCAST_DOWNLOAD_BASE_URL;
        } else {
            process.env.PODCAST_DOWNLOAD_BASE_URL = originalDownloadBase;
        }

        console.log('  Oversized production renders use a versioned hosted episode URL without touching the stable MP3');
        passed++;
    } catch (error) {
        console.log(`  Oversized attachment fallback failed: ${error.message}`);
        failed++;
    }

    console.log('\nTest 47c: Production episode autocomplete suggests next/latest state');
    try {
        const previousContentRoot = process.env.CLAWCAST_CONTENT_ROOT;
        const previousPodcastRoot = process.env.PODCAST_ROOT;
        const previousPodcastContentRoot = process.env.PODCAST_CONTENT_ROOT;
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'production-episode-autocomplete-'));

        try {
            process.env.CLAWCAST_CONTENT_ROOT = tempRoot;
            delete process.env.PODCAST_ROOT;
            delete process.env.PODCAST_CONTENT_ROOT;

            fs.mkdirSync(path.join(tempRoot, 'episodes'), { recursive: true });
            fs.mkdirSync(path.join(tempRoot, 'production', 'episode-06', 'v004'), { recursive: true });
            fs.writeFileSync(path.join(tempRoot, 'episodes', 'episode-05.mp3'), Buffer.from('published mp3'));
            fs.writeFileSync(
                path.join(tempRoot, 'production', 'episode-06', 'v004', 'episode-06-v004.mp3'),
                Buffer.from('produced mp3')
            );
            fs.writeFileSync(
                path.join(tempRoot, 'feed.xml'),
                '<rss><channel><item><enclosure url="https://clawcast.jensenabler.com/episodes/episode-05.mp3"/></item></channel></rss>'
            );

            const normalState = AlphaClawdVoiceBot.prototype.getProductionEpisodeState();
            const normalChoices = AlphaClawdVoiceBot.prototype.getPodcastEpisodeAutocompleteChoices('');
            const focusedChoices = AlphaClawdVoiceBot.prototype.getPodcastEpisodeAutocompleteChoices('6');

            if (
                normalState.next !== 7 ||
                normalState.latestProduced !== 6 ||
                normalState.latestPublished !== 5 ||
                normalChoices.length !== 3 ||
                normalChoices[0].name !== 'Next episode: Episode 7' ||
                normalChoices[0].value !== 7 ||
                normalChoices[1].name !== 'Latest produced: Episode 6' ||
                normalChoices[1].value !== 6 ||
                normalChoices[2].name !== 'Latest published: Episode 5' ||
                normalChoices[2].value !== 5 ||
                focusedChoices.length !== 1 ||
                focusedChoices[0].value !== 6
            ) {
                throw new Error(`Unexpected normal choices: ${JSON.stringify({ normalState, normalChoices, focusedChoices })}`);
            }

            fs.writeFileSync(
                path.join(tempRoot, 'feed.xml'),
                '<rss><channel><item><enclosure url="https://clawcast.jensenabler.com/episodes/episode-06.mp3"/></item></channel></rss>'
            );

            const duplicateChoices = AlphaClawdVoiceBot.prototype.getPodcastEpisodeAutocompleteChoices('');
            if (
                duplicateChoices.length !== 2 ||
                duplicateChoices[0].name !== 'Latest published: Episode 6' ||
                duplicateChoices[0].value !== 6 ||
                duplicateChoices[1].name !== 'Next episode: Episode 7' ||
                duplicateChoices[1].value !== 7 ||
                duplicateChoices.some(choice => choice.name.startsWith('Latest produced'))
            ) {
                throw new Error(`Produced/published duplicate was not collapsed: ${JSON.stringify(duplicateChoices)}`);
            }
        } finally {
            if (previousContentRoot === undefined) delete process.env.CLAWCAST_CONTENT_ROOT;
            else process.env.CLAWCAST_CONTENT_ROOT = previousContentRoot;
            if (previousPodcastRoot === undefined) delete process.env.PODCAST_ROOT;
            else process.env.PODCAST_ROOT = previousPodcastRoot;
            if (previousPodcastContentRoot === undefined) delete process.env.PODCAST_CONTENT_ROOT;
            else process.env.PODCAST_CONTENT_ROOT = previousPodcastContentRoot;
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }

        console.log('  Production episode autocomplete lists next, latest produced, and latest published without duplicate roles');
        passed++;
    } catch (error) {
        console.log(`  Production episode autocomplete failed: ${error.message}`);
        failed++;
    }

    console.log('\nTest 47c.1: Publish episode autocomplete omits next episode and uses podcast episode suggestions');
    try {
        const bot = Object.create(AlphaClawdVoiceBot.prototype);
        let passedArgs = null;
        let response = null;
        bot.getPodcastEpisodeAutocompleteChoices = (...args) => {
            passedArgs = args;
            return [{ name: 'Latest produced: Episode 6', value: 6 }];
        };

        await bot.handleAutocomplete({
            commandName: 'podcast-publish',
            options: {
                getFocused: () => ({ name: 'episode', value: '6' })
            },
            respond: async (choices) => {
                response = choices;
            }
        });

        if (passedArgs?.[1] !== false) {
            throw new Error(`Publish autocomplete did not suppress next episode: ${JSON.stringify(passedArgs)}`);
        }
        if (passedArgs?.[0] !== '6' || response?.[0]?.value !== 6) {
            throw new Error(`Publish autocomplete did not use podcast episode suggestions: ${JSON.stringify({ passedArgs, response })}`);
        }

        console.log('  Publish episode autocomplete omits next episode and uses production episode suggestions');
        passed++;
    } catch (error) {
        console.log(`  Publish episode autocomplete failed: ${error.message}`);
        failed++;
    }

    console.log('\nTest 47c.2: Publish version autocomplete lists available versions for selected episode');
    try {
        const bot = Object.create(AlphaClawdVoiceBot.prototype);
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'podcast-publish-version-test-'));
        const previousContentRoot = process.env.CLAWCAST_CONTENT_ROOT;
        const previousPodcastRoot = process.env.PODCAST_ROOT;
        const previousPodcastContentRoot = process.env.PODCAST_CONTENT_ROOT;
        process.env.CLAWCAST_CONTENT_ROOT = tempRoot;
        process.env.PODCAST_ROOT = tempRoot;
        delete process.env.PODCAST_CONTENT_ROOT;

        const prodDir = path.join(tempRoot, 'production', 'episode-05');
        fs.mkdirSync(path.join(prodDir, 'v001'), { recursive: true });
        fs.mkdirSync(path.join(prodDir, 'v002'), { recursive: true });
        fs.writeFileSync(path.join(prodDir, 'v002', 'episode-05-v002.mp3'), 'fake');

        let response = null;
        await bot.handleAutocomplete({
            commandName: 'podcast-publish',
            options: {
                getFocused: () => ({ name: 'version', value: '' }),
                getInteger: (name) => name === 'episode' ? 5 : null
            },
            respond: async (choices) => {
                response = choices;
            }
        });

        if (
            !response ||
            response.length !== 1 ||
            response[0].value !== 'v002' ||
            response[0].name !== 'v002'
        ) {
            throw new Error(`Version autocomplete returned unexpected choices: ${JSON.stringify(response)}`);
        }

        // Test filtering
        let filteredResponse = null;
        await bot.handleAutocomplete({
            commandName: 'podcast-publish',
            options: {
                getFocused: () => ({ name: 'version', value: 'v002' }),
                getInteger: (name) => name === 'episode' ? 5 : null
            },
            respond: async (choices) => {
                filteredResponse = choices;
            }
        });

        if (!filteredResponse || filteredResponse.length !== 1 || filteredResponse[0].value !== 'v002') {
            throw new Error(`Version autocomplete filtering failed: ${JSON.stringify(filteredResponse)}`);
        }

        if (previousContentRoot === undefined) delete process.env.CLAWCAST_CONTENT_ROOT;
        else process.env.CLAWCAST_CONTENT_ROOT = previousContentRoot;
        if (previousPodcastRoot === undefined) delete process.env.PODCAST_ROOT;
        else process.env.PODCAST_ROOT = previousPodcastRoot;
        if (previousPodcastContentRoot === undefined) delete process.env.PODCAST_CONTENT_ROOT;
        else process.env.PODCAST_CONTENT_ROOT = previousPodcastContentRoot;
        fs.rmSync(tempRoot, { recursive: true, force: true });

        console.log('  Publish version autocomplete lists versions with finalized indicator and supports filtering');
        passed++;
    } catch (error) {
        console.log(`  Publish version autocomplete failed: ${error.message}`);
        failed++;
    }

    console.log('\nTest 47c.3: Publish command passes version option to podcast-production CLI');
    try {
        const bot = Object.create(AlphaClawdVoiceBot.prototype);
        let capturedArgs = null;
        let reply = null;

        bot.runProductionProcess = async (args) => {
            capturedArgs = args;
            return {
                stdout: JSON.stringify({
                    episode: '05',
                    version: 'v002',
                    publishedVersion: 'v002',
                    publishedVersionMp3: '/opt/clawcast-network/content/production/episode-05/v002/episode-05-v002.mp3',
                    publishedVersionUrl: 'https://clawcast.jensenabler.com/episodes/episode-05-v002.mp3',
                    publicMetadataUrl: 'https://clawcast.jensenabler.com/episodes/episode-05.json',
                    stableMp3: '/opt/clawcast-network/content/episodes/episode-05.mp3',
                    episodeUrl: 'https://clawcast.jensenabler.com/episodes/episode-05.mp3',
                    title: 'Test Episode',
                    duration: '10:00'
                }),
                stderr: ''
            };
        };
        bot.extractLastJson = AlphaClawdVoiceBot.prototype.extractLastJson;

        const interaction = {
            options: {
                getInteger: (name) => name === 'episode' ? 5 : null,
                getString: (name) => {
                    if (name === 'version') return 'v002';
                    if (name === 'title') return null;
                    if (name === 'description') return null;
                    throw new Error(`Unexpected string option ${name}`);
                },
                getBoolean: (name) => name === 'dry-run' ? false : null
            },
            deferReply: async () => {},
            editReply: async (options) => {
                reply = options;
            }
        };

        await bot.handlePublishCommand(interaction);

        if (!capturedArgs) {
            throw new Error('Publish process was not invoked');
        }
        const versionIndex = capturedArgs.indexOf('--version');
        if (versionIndex === -1 || capturedArgs[versionIndex + 1] !== 'v002') {
            throw new Error(`Version option was not passed correctly: ${JSON.stringify(capturedArgs)}`);
        }
        if (!reply?.content?.includes('Podcast Published')) {
            throw new Error(`Publish reply was not sent: ${JSON.stringify(reply)}`);
        }
        if (
            !reply.content.includes('Version: v002') ||
            !reply.content.includes('Versioned MP3: https://clawcast.jensenabler.com/episodes/episode-05-v002.mp3') ||
            !reply.content.includes('Metadata: https://clawcast.jensenabler.com/episodes/episode-05.json')
        ) {
            throw new Error(`Publish reply omitted versioned MP3 details: ${reply.content}`);
        }

        console.log('  Publish command passes version option to CLI');
        passed++;
    } catch (error) {
        console.log(`  Publish command version test failed: ${error.message}`);
        failed++;
    }

    console.log('\nTest 47c.3b: Publish dry run passes dry-run option and labels reply');
    try {
        const bot = Object.create(AlphaClawdVoiceBot.prototype);
        let capturedArgs = null;
        let reply = null;

        bot.runProductionProcess = async (args) => {
            capturedArgs = args;
            return {
                stdout: JSON.stringify({
                    episode: '05',
                    version: 'v002',
                    publishedVersion: 'v002',
                    publishedVersionMp3: '/opt/clawcast-network/content/production/episode-05/v002/episode-05-v002.mp3',
                    publicMetadataPath: '/opt/clawcast-network/content/episodes/episode-05.json',
                    title: 'Dry Run Episode',
                    duration: '10:00',
                    dryRun: true,
                    syncResults: [{ dryRun: true, returnCode: null }]
                }),
                stderr: ''
            };
        };
        bot.extractLastJson = AlphaClawdVoiceBot.prototype.extractLastJson;

        const interaction = {
            options: {
                getInteger: (name) => name === 'episode' ? 5 : null,
                getString: (name) => {
                    if (name === 'version') return 'v002';
                    if (name === 'title') return null;
                    if (name === 'description') return null;
                    throw new Error(`Unexpected string option ${name}`);
                },
                getBoolean: (name) => name === 'dry-run' ? true : null
            },
            deferReply: async () => {},
            editReply: async (options) => {
                reply = options;
            }
        };

        await bot.handlePublishCommand(interaction);

        if (!capturedArgs.includes('--dry-run')) {
            throw new Error(`Dry-run option was not passed: ${JSON.stringify(capturedArgs)}`);
        }
        if (!reply?.content?.includes('Podcast Publish Dry Run')) {
            throw new Error(`Dry-run reply was not labeled: ${JSON.stringify(reply)}`);
        }
        if (!reply.content.includes('Versioned MP3: /opt/clawcast-network/content/production/episode-05/v002/episode-05-v002.mp3')) {
            throw new Error(`Dry-run reply omitted versioned MP3 details: ${reply.content}`);
        }
        if (!reply.content.includes('Metadata: /opt/clawcast-network/content/episodes/episode-05.json')) {
            throw new Error(`Dry-run reply omitted public metadata details: ${reply.content}`);
        }

        console.log('  Publish dry run passes dry-run and displays versioned MP3 details');
        passed++;
    } catch (error) {
        console.log(`  Publish dry-run display test failed: ${error.message}`);
        failed++;
    }

    console.log('\nTest 47c.4: Production command defaults to next episode when episode is omitted');
    try {
        const bot = Object.create(AlphaClawdVoiceBot.prototype);
        let capturedArgs = null;
        let reply = null;

        bot.getProductionEpisodeState = () => ({ next: 42, latestProduced: 41, latestPublished: 40 });
        bot.runProductionProcess = async (args) => {
            capturedArgs = args;
            return { stdout: JSON.stringify({ episode: '42', version: 'v001' }), stderr: '' };
        };
        bot.extractLastJson = AlphaClawdVoiceBot.prototype.extractLastJson;

        const interaction = {
            options: {
                getInteger: (name) => name === 'episode' ? null : null,
                getString: (name) => name === 'recording' ? 'latest' : null,
                getBoolean: () => null
            },
            deferReply: async () => {},
            editReply: async (options) => {
                reply = options;
            }
        };

        await bot.handleProductionCommand(interaction);

        const episodeIndex = capturedArgs.indexOf('--episode');
        if (episodeIndex === -1 || capturedArgs[episodeIndex + 1] !== '42') {
            throw new Error(`Production did not default to next episode: ${JSON.stringify(capturedArgs)}`);
        }
        if (!capturedArgs.includes('--skip-finalize')) {
            throw new Error(`Production command can still finalize public episode files: ${JSON.stringify(capturedArgs)}`);
        }

        console.log('  Production command defaults to next episode when omitted');
        passed++;
    } catch (error) {
        console.log(`  Production default episode test failed: ${error.message}`);
        failed++;
    }

    console.log('\nTest 47c.5: Publish command defaults to latest produced episode when episode is omitted');
    try {
        const bot = Object.create(AlphaClawdVoiceBot.prototype);
        let capturedArgs = null;
        let reply = null;

        bot.getProductionEpisodeState = () => ({ next: 43, latestProduced: 42, latestPublished: 41 });
        bot.runProductionProcess = async (args) => {
            capturedArgs = args;
            return { stdout: JSON.stringify({ episode: '42', title: 'Test' }), stderr: '' };
        };
        bot.extractLastJson = AlphaClawdVoiceBot.prototype.extractLastJson;

        const interaction = {
            options: {
                getInteger: (name) => name === 'episode' ? null : null,
                getString: () => null,
                getBoolean: () => null
            },
            deferReply: async () => {},
            editReply: async (options) => {
                reply = options;
            }
        };

        await bot.handlePublishCommand(interaction);

        const episodeIndex = capturedArgs.indexOf('--episode');
        if (episodeIndex === -1 || capturedArgs[episodeIndex + 1] !== '42') {
            throw new Error(`Publish did not default to latest produced: ${JSON.stringify(capturedArgs)}`);
        }

        console.log('  Publish command defaults to latest produced episode when omitted');
        passed++;
    } catch (error) {
        console.log(`  Publish default episode test failed: ${error.message}`);
        failed++;
    }

    console.log('\nTest 47c.6: Publish command errors when no episode provided and no produced episodes exist');
    try {
        const bot = Object.create(AlphaClawdVoiceBot.prototype);

        bot.getProductionEpisodeState = () => ({ next: 1, latestProduced: null, latestPublished: null });

        let reply = null;
        const interaction = {
            options: {
                getInteger: (name) => name === 'episode' ? null : null,
                getString: () => null,
                getBoolean: () => null
            },
            reply: async (options) => {
                reply = options;
            },
            deferReply: async () => {
                throw new Error('deferReply should not be called when no episodes exist');
            }
        };

        await bot.handlePublishCommand(interaction);

        if (!reply?.content?.includes('No produced episodes found')) {
            throw new Error(`Expected error message for missing produced episodes: ${JSON.stringify(reply)}`);
        }

        console.log('  Publish command replies with helpful error when no produced episodes exist');
        passed++;
    } catch (error) {
        console.log(`  Publish no-produced-episodes test failed: ${error.message}`);
        failed++;
    }

    console.log('\nTest 47d: Podcast command contract passes creative direction without audio regenerate');
    try {
        const bot = Object.create(AlphaClawdVoiceBot.prototype);
        let capturedArgs = null;
        let reply = null;

        bot.runProductionProcess = async (args) => {
            capturedArgs = args;
            return {
                stdout: JSON.stringify({
                    episode: '06',
                    version: 'v005',
                    durationSeconds: 90,
                    finalMp3: '/tmp/missing.mp3'
                }),
                stderr: ''
            };
        };
        bot.extractLastJson = AlphaClawdVoiceBot.prototype.extractLastJson;

        const interaction = {
            options: {
                getInteger: (name) => {
                    if (name !== 'episode') throw new Error(`Unexpected integer option ${name}`);
                    return 6;
                },
                getString: (name) => {
                    if (name === 'recording') return 'latest';
                    if (name === 'intro-outro-creative-direction') return 'Make it warmer, stranger, and less recap-heavy.';
                    throw new Error(`Unexpected string option ${name}`);
                },
                getBoolean: (name) => {
                    throw new Error(`Production handler should not read boolean option ${name}`);
                }
            },
            deferReply: async () => {},
            editReply: async (options) => {
                reply = options;
            }
        };

        await bot.handleProductionCommand(interaction);

        if (!capturedArgs) {
            throw new Error('Production process was not invoked');
        }
        if (!capturedArgs.includes('--regenerate-copy')) {
            throw new Error(`Creative direction did not imply regenerate-copy: ${JSON.stringify(capturedArgs)}`);
        }
        const directionIndex = capturedArgs.indexOf('--intro-outro-creative-direction');
        if (
            directionIndex === -1 ||
            capturedArgs[directionIndex + 1] !== 'Make it warmer, stranger, and less recap-heavy.'
        ) {
            throw new Error(`Creative direction was not passed to podcast-production: ${JSON.stringify(capturedArgs)}`);
        }
        if (capturedArgs.includes('--regenerate-audio')) {
            throw new Error(`Removed regenerate-audio option still reached CLI: ${JSON.stringify(capturedArgs)}`);
        }
        if (!capturedArgs.includes('--skip-finalize')) {
            throw new Error(`Production command can still finalize public episode files: ${JSON.stringify(capturedArgs)}`);
        }
        if (!reply?.content?.includes('Podcast Production Complete')) {
            throw new Error(`Production reply was not sent: ${JSON.stringify(reply)}`);
        }

        console.log('  Production command passes intro/outro creative direction, omits regenerate-audio, and skips finalize');
        passed++;
    } catch (error) {
        console.log(`  Production command contract failed: ${error.message}`);
        failed++;
    }

    console.log('\n========================================');
    console.log(`Tests complete: ${passed} passed, ${failed} failed`);
    console.log('========================================');

    process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((error) => {
    console.error('Test runner failed:', error);
    process.exit(1);
});
