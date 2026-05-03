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
    GatewayBridge,
    PodcastGenerator,
    AlphaClawdVoiceBot
} = require('./index');
const { EndBehaviorType } = require('@discordjs/voice');
const { ConversationBuffer, BufferState } = require('./conversation-buffer');
const { EpisodePostProcessor } = require('./post-processor');
const { PassThrough } = require('stream');
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
    } catch (error) {
        console.log(`  Fish Audio provider failed: ${error.message}`);
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

    console.log('\nTest 5: Podcast Generator');
    try {
        const generator = new PodcastGenerator({
            apiKey: 'sk-test-placeholder',
            maxSpeechChars: 80
        });

        const output = generator.normalizeOutput({
            shouldRespond: true,
            speech: '**Absolutely.** [ACTION:mode:chatty] I am with you on that.',
            mode: 'chatty',
            confidence: 0.8
        });

        if (
            output.shouldRespond === true &&
            output.mode === 'chatty' &&
            output.speech === 'Absolutely. I am with you on that.'
        ) {
            console.log('  Structured output normalization works');
            passed++;
        } else {
            throw new Error(`Unexpected normalized output: ${JSON.stringify(output)}`);
        }

        const messages = generator.buildMessages({
            transcript: 'Jensen: Testing the turn decision prompt',
            currentMode: 'chatty'
        });
        const userMessage = messages[messages.length - 2];
        const decisionMessage = messages[messages.length - 1];

        if (
            userMessage.role === 'user' &&
            !userMessage.content.includes('Decide whether Alpha-Clawd should speak now') &&
            decisionMessage.role === 'system' &&
            decisionMessage.content === 'Decide whether Alpha-Clawd should speak now.'
        ) {
            console.log('  Turn decision prompt is sent as a trailing system message');
            passed++;
        } else {
            throw new Error(`Unexpected message layout: ${JSON.stringify(messages)}`);
        }
    } catch (error) {
        console.log(`  Podcast generator failed: ${error.message}`);
        failed++;
    }

    console.log('\nTest 6: Conversation Buffer ASR-aware state machine');
    try {
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

        console.log('  Conversation buffer waits only for receiver ASR candidates and clears completion/timeout paths');
        passed++;
    } catch (error) {
        console.log(`  Conversation buffer failed: ${error.message}`);
        failed++;
    }

    console.log('\nTest 7: Idle decision respects in-flight direct responses');
    try {
        const bot = Object.create(AlphaClawdVoiceBot.prototype);
        const guildId = 'guild-a';
        bot.generatorMode = 'direct';
        bot.RecordingState = { RECORDING: 'RECORDING' };
        bot.recordingState = new Map([[guildId, bot.RecordingState.RECORDING]]);
        bot.lastParticipantSpeechAt = new Map([[guildId, Date.now()]]);
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

        console.log('  Idle checks wait while direct response generation/synthesis is in progress');
        passed++;
    } catch (error) {
        console.log(`  Idle decision guard failed: ${error.message}`);
        failed++;
    }

    console.log('\nTest 8: Audio Receiver keeps subscription across silence');
    try {
        const utterances = [];
        const pendingAsr = [];
        const fakeStream = new PassThrough();
        let subscribeOptions = null;

        const receiver = new AudioReceiver({
            botUserId: 'bot-user',
            stt: {
                transcribe: async () => ({
                    text: 'hello from the buffer',
                    confidence: 0.98,
                    words: []
                })
            },
            onUtterance: (utterance) => utterances.push(utterance),
            onAsrPending: (userId, metadata) => pendingAsr.push({ userId, metadata })
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
        if (buffer.detector.hasSilenceBeenDetected()) {
            throw new Error('Silence detector was not reset');
        }
        if (utterances.length !== 1 || utterances[0].transcription !== 'hello from the buffer') {
            throw new Error('Snapshot utterance was not processed');
        }
        if (!utterances[0].speechStartedAt || !utterances[0].speechEndedAt || !utterances[0].asrCompletedAt) {
            throw new Error(`Snapshot timing metadata missing: ${JSON.stringify(utterances[0])}`);
        }
        if (pendingAsr.length !== 1 || pendingAsr[0].metadata.reason !== 'speaking stop with buffered audio') {
            throw new Error(`Receiver did not emit exactly one ASR pending candidate: ${JSON.stringify(pendingAsr)}`);
        }

        receiver.destroy();

        console.log('  Audio receiver rolls over chunks without closing the subscription');
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
            duration: 2000
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
            transcriptEntry.playbackEndedAt !== '2026-05-03T00:00:07.000Z'
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

    console.log('\n========================================');
    console.log(`Tests complete: ${passed} passed, ${failed} failed`);
    console.log('========================================');

    process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((error) => {
    console.error('Test runner failed:', error);
    process.exit(1);
});
