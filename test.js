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
    InternalThoughtGenerator,
    DiscernmentGenerator,
    InternalThoughtManager,
    ShowRunnerGenerator,
    ShowRunnerManager,
    PacketizationBuffer,
    BigBrainAwarenessSelector,
    EpisodeTranscriptStore,
    createEpisodeTranscriptServer,
    AlphaClawdVoiceBot
} = require('./index');
const { EndBehaviorType } = require('@discordjs/voice');
const { ConversationBuffer, BufferState } = require('./conversation-buffer');
const { GatewayWsClient, verifyDeviceSignature } = require('./gateway-ws-client');
const { EpisodePostProcessor } = require('./post-processor');
const { resolveFrontierConfig } = require('./introspection-frontier');
const {
    getContractRecordingDir,
    getRecordingDir,
    isLegacyEpisodesRecordingDir
} = require('./paths');
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

        const s2Text = fishAudio.preprocessText('Hold <break time="2.2s" /> the thought.');
        const fishS1 = new FishAudioProvider({
            apiKey: process.env.FISH_AUDIO_API_KEY || 'test_fish_audio_key_placeholder',
            defaultVoice: process.env.FISH_AUDIO_VOICE_ID || 'e127c1a13d0b415da7d6c4c16861295f',
            model: 's1'
        });
        const s1Text = fishS1.preprocessText('Hold <break time="2.2s" /> the thought.');
        if (
            s2Text === 'Hold [long pause] the thought.' &&
            fishAudio.hasFishInlineControls(s2Text) &&
            s1Text === 'Hold (long-break) the thought.' &&
            fishS1.hasFishInlineControls(s1Text)
        ) {
            console.log('  Fish pause controls are model-family aware');
            passed++;
        } else {
            throw new Error(`Fish pause preprocessing failed: ${JSON.stringify({ s2Text, s1Text })}`);
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

        const messages = generator.buildMessages({
            transcript: 'Jensen: Testing the turn decision prompt'
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

        const systemPrompt = generator.buildSystemPrompt();
        if (
            systemPrompt.includes('Live speech is provisional:') &&
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
                awarenessInjection: 'Jensen is designing internal thought as private host awareness, not asking for a generic implementation lecture.',
                remainingTurns: 2
            }]
        });
        const awarenessPrompt = awarenessMessages[awarenessMessages.length - 2].content;

        if (
            awarenessPrompt.includes('Active awareness injection(s):') &&
            awarenessPrompt.includes('id: awareness-internal-packet-1') &&
            awarenessPrompt.includes('reason: This tracks the current design intent.') &&
            awarenessPrompt.includes('remaining participant turns: 2') &&
            awarenessPrompt.includes('awarenessInjection: Jensen is designing internal thought as private host awareness') &&
            awarenessPrompt.includes('These are private host awareness notes') &&
            !awarenessPrompt.includes('contextText') &&
            !awarenessPrompt.includes('priority')
        ) {
            console.log('  Generator user prompt includes private awareness injections');
            passed++;
        } else {
            throw new Error(`Awareness injection prompt was not formatted correctly: ${awarenessPrompt}`);
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
        if (defaultSpeechCapGenerator.maxSpeechChars !== 420) {
            throw new Error(`Default live speech cap should be 420 chars, got ${defaultSpeechCapGenerator.maxSpeechChars}`);
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
            showRunnerGuidance: {
                phase: 'deep-dive',
                currentLane: 'origin story',
                coveredAngles: ['guest background'],
                untouchedAngles: ['collaboration', 'philosophical close'],
                nextHostMove: 'synthesize and bridge toward collaboration',
                avoid: ['Do not ask a broad what does that feel like question.'],
                suggestedQuestion: 'Who changed how you think about this craft?',
                wrapNow: true,
                wrapReason: 'All major lanes are covered.',
                generatorInstruction: 'Wrap the episode now with a concise synthesis and thanks.'
            }
        });
        if (
            !showRunnerPrompt.includes('Show runner direction') ||
            !showRunnerPrompt.includes('phase: deep-dive') ||
            !showRunnerPrompt.includes('untouchedAngles: collaboration; philosophical close') ||
            !showRunnerPrompt.includes('wrapNow: true') ||
            !showRunnerPrompt.includes('Wrap the episode now') ||
            !showRunnerPrompt.includes('private editorial steering') ||
            showRunnerPrompt.includes('contextText')
        ) {
            throw new Error(`Show runner guidance was not injected into generator prompt: ${showRunnerPrompt}`);
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
            fallbackOutput.speech !== 'Qwen JSON fallback works.'
        ) {
            throw new Error(`JSON object fallback did not run as expected: ${JSON.stringify({ fallbackCalls, fallbackOutput })}`);
        }

        console.log('  Generator retries with JSON mode when a model rejects json_schema');

        const bigBrainGenerator = new PodcastGenerator({ apiKey: 'bb-test-key' });

        const bigBrainSchema = bigBrainGenerator.getResponseSchema();
        if (
            !bigBrainSchema.required.includes('bigBrain') ||
            !bigBrainSchema.properties.bigBrain ||
            bigBrainSchema.properties.bigBrain.required.join(',') !== 'requested,reason,consumedRunId'
        ) {
            throw new Error(`bigBrain schema is missing or malformed: ${JSON.stringify(bigBrainSchema.properties.bigBrain)}`);
        }

        const defaultOut = bigBrainGenerator.normalizeOutput({
            shouldRespond: true,
            speech: 'No big brain needed.'
        });
        if (defaultOut.bigBrain.requested !== false || defaultOut.bigBrain.reason !== '' || defaultOut.bigBrain.consumedRunId !== '') {
            throw new Error(`Missing bigBrain should default to {requested:false, reason:"", consumedRunId:""}: ${JSON.stringify(defaultOut.bigBrain)}`);
        }

        const requestedOut = bigBrainGenerator.normalizeOutput({
            shouldRespond: true,
            speech: 'Let me think about this for a moment.',
            bigBrain: { requested: true, reason: 'Need to verify a date I am unsure about.' }
        });
        if (
            requestedOut.bigBrain.requested !== true ||
            requestedOut.bigBrain.reason !== 'Need to verify a date I am unsure about.' ||
            requestedOut.bigBrain.consumedRunId !== ''
        ) {
            throw new Error(`bigBrain pass-through failed: ${JSON.stringify(requestedOut.bigBrain)}`);
        }

        const garbageOut = bigBrainGenerator.normalizeOutput({
            shouldRespond: false,
            speech: '',
            bigBrain: { requested: 'yes please', reason: 42 }
        });
        if (garbageOut.bigBrain.requested !== false || garbageOut.bigBrain.reason !== '' || garbageOut.bigBrain.consumedRunId !== '') {
            throw new Error(`Malformed bigBrain payload was not normalized: ${JSON.stringify(garbageOut.bigBrain)}`);
        }

        console.log('  bigBrain field defaults safely and passes valid payloads through');
    } catch (error) {
        console.log(`  Podcast generator failed: ${error.message}`);
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
            !thoughtSystemPrompt.includes('intentionally packet-only') ||
            !thoughtSystemPrompt.includes('previous internalThought') ||
            !thoughtSystemPrompt.includes('candidateAwarenessNote') ||
            !thoughtSystemPrompt.includes('active awarenessInjection') ||
            !thoughtSystemPrompt.includes('artifact content being discussed') ||
            !thoughtSystemPrompt.includes('generic question-autocomplete behavior') ||
            !thoughtSystemPrompt.includes('guests to elaborate') ||
            !thoughtSystemPrompt.includes('the guest needs synthesis') ||
            !thoughtSystemPrompt.includes('throwing the conversational burden back') ||
            thoughtSystemPrompt.includes('Jensen needs synthesis')
        ) {
            throw new Error(`Internal thought system prompt does not guard recursive artifact ingestion: ${thoughtSystemPrompt}`);
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
            discernmentSchema.required.join(',') !== 'injectIntoPodcastGenerator,reason,awarenessInjection,expiresAfterTurns' ||
            discernmentSchema.properties.priority ||
            discernmentSchema.properties.risk ||
            discernmentSchema.properties.participantRelevance ||
            discernmentSchema.properties.expiresAfterTurns.minimum !== undefined ||
            discernmentSchema.properties.expiresAfterTurns.maximum !== undefined
        ) {
            throw new Error(`Discernment schema includes stale fields: ${JSON.stringify(discernmentSchema)}`);
        }

        const rejected = discernmentGenerator.normalizeOutput({
            injectIntoPodcastGenerator: true,
            reason: 'Interesting, but not usable yet.',
            awarenessInjection: '',
            expiresAfterTurns: 4
        });
        if (rejected.injectIntoPodcastGenerator || rejected.awarenessInjection !== '' || rejected.expiresAfterTurns !== 0) {
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
                    expiresAfterTurns: 4
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
            approved.expiresAfterTurns !== 4 ||
            !approved.awarenessInjection.includes('personality come through')
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

        if (
            anthropicRequest?.url !== 'https://api.anthropic.com/v1/messages' ||
            anthropicRequest.headers.Authorization ||
            anthropicRequest.headers['x-api-key'] !== 'anthropic-test-key' ||
            anthropicRequest.headers['anthropic-version'] !== '2023-06-01' ||
            anthropicRequest.body.model !== 'claude-opus-4-7' ||
            anthropicRequest.body.max_tokens !== 123 ||
            anthropicRequest.body.messages.length !== 1 ||
            anthropicRequest.body.messages[0].role !== 'user' ||
            !anthropicRequest.body.system.includes('internal thought generator') ||
            !anthropicRequest.body.system.includes('Return only valid JSON') ||
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
            !candidatePrompt.includes('Three most recent internal thoughts') ||
            candidatePrompt.includes('Awareness injections already active')
        ) {
            throw new Error(`Discernment candidate prompt is wrong: ${candidatePrompt}`);
        }

        const candidateSystemPrompt = discernmentGenerator.buildSystemPrompt('candidate');
        const discernmentPrompt = discernmentGenerator.buildSystemPrompt('judgment');
        if (
            !discernmentPrompt.includes('relevant enough to the interests of the podcast participants') ||
            !discernmentPrompt.includes('awarenessInjection') ||
            !candidateSystemPrompt.includes('CANDIDATE PRODUCTION/AWARENESS INJECTION process') ||
            !discernmentPrompt.includes('You own the awareness injection process') ||
            !discernmentPrompt.includes('JUDGMENT MODE') ||
            !discernmentPrompt.includes('INJECTION JUDGEMENT') ||
            !discernmentPrompt.includes('immediate, present-tense') ||
            !discernmentPrompt.includes('later in this same episode') ||
            !discernmentPrompt.includes('Reject stale candidates when the complete transcript has moved into a new topic') ||
            !discernmentPrompt.includes('most recent user message indicates a PIVOT') ||
            !discernmentPrompt.includes('prevention of generic question-autocomplete') ||
            !candidateSystemPrompt.includes('CANDIDATE PRODUCTION MODE') ||
            !candidateSystemPrompt.includes('reflexively asks the guest how something feels') ||
            !candidateSystemPrompt.includes('asks what the guest wants next') ||
            !candidateSystemPrompt.includes('suggest the possibility of synthesis, contribution, bridging, or holding space') ||
            !candidateSystemPrompt.includes('Be very attentive especially to the most recent message') ||
            !candidateSystemPrompt.includes('Prefer attention and pacing notes over suggested content') ||
            candidateSystemPrompt.includes('INJECTION JUDGEMENT') ||
            candidateSystemPrompt.includes('JUDGMENT MODE') ||
            discernmentPrompt.includes('CANDIDATE PRODUCTION MODE') ||
            discernmentPrompt.includes('CANDIDATE PRODUCTION/AWARENESS INJECTION process') ||
            candidateSystemPrompt.includes('reflexively asks Jensen') ||
            candidateSystemPrompt.includes('tell the host to synthesize') ||
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

    console.log('\nTest 5c: Internal thought manager packets, persists, and expires awareness injections');
    try {
        const thoughtCalls = [];
        const discernmentCalls = [];
        let thoughtCount = 0;
        const managerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'internal-thought-manager-'));
        const manager = new InternalThoughtManager({
            packetTurnCount: 2,
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
                        expiresAfterTurns: 2
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
            firstRecord.awarenessInjection?.remainingTurns !== 2 ||
            thoughtCalls[0]?.transcript !== 'Jensen: I want your personality to come out.\nAlpha-Clawd: I hear that.' ||
            thoughtCalls[0]?.recentInternalThoughts !== undefined ||
            thoughtCalls[0]?.activeAwarenessInjections !== undefined ||
            firstRecord.awarenessCandidate?.candidateAwarenessNote !== 'Jensen wants internal thought to make Alpha-Clawd feel more alive.' ||
            discernmentCalls.length !== 2 ||
            discernmentCalls[0].mode !== 'candidate' ||
            discernmentCalls[0].input.recentInternalThoughts?.length !== 1 ||
            !discernmentCalls[0].input.completeTranscript.includes('Alpha-Clawd: I hear that.') ||
            discernmentCalls[1].mode !== 'judgment'
        ) {
            throw new Error(`Manager did not process first packet correctly: ${JSON.stringify({ firstRecord, thoughtCalls, discernmentCalls })}`);
        }

        let active = manager.getActiveAwarenessInjections('guild-thoughts');
        if (active.length !== 1 || !active[0].awarenessInjection.includes('internal awareness')) {
            throw new Error(`Awareness injection was not activated: ${JSON.stringify(active)}`);
        }

        await manager.handleTranscriptEntry('guild-thoughts', {
            speaker: 'Jensen',
            speakerRole: 'guest',
            text: 'Each packet should get reflected on.'
        });
        active = manager.getActiveAwarenessInjections('guild-thoughts');
        if (active[0]?.remainingTurns !== 1) {
            throw new Error(`Awareness injection did not count down on participant turn: ${JSON.stringify(active)}`);
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
        if (lines.length !== 2 || JSON.parse(lines[0]).type !== 'internal_thought' || JSON.parse(lines[0]).awarenessInjection?.id !== 'awareness-internal-packet-1') {
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
                    throw new Error('Anthropic schema rejected expiresAfterTurns');
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

        const ended = await manager.endSession('guild-thoughts');
        if (ended.thoughtCount !== 2 || manager.getActiveAwarenessInjections('guild-thoughts').length !== 0) {
            throw new Error(`Manager did not end cleanly: ${JSON.stringify(ended)}`);
        }

        fs.rmSync(managerDir, { recursive: true, force: true });
        console.log('  Internal thought manager packets transcript entries and manages awareness injection lifecycle');
        passed++;
    } catch (error) {
        console.log(`  Internal thought manager failed: ${error.message}`);
        failed++;
    }

    console.log('\nTest 5c.0: Show runner generator and manager');
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
                            phase: 'background',
                            currentLane: 'origin story',
                            coveredAngles: ['guest background'],
                            untouchedAngles: ['craft process', 'philosophical close'],
                            nextHostMove: 'Synthesize the origin answer and bridge into craft.',
                            avoid: ['Do not ask another generic broad question.'],
                            suggestedQuestion: 'What changed once this became a practice?',
                            wrapNow: false,
                            wrapReason: 'Several major lanes remain.',
                            generatorInstruction: 'Carry the thread with synthesis, then bridge to craft process.'
                        })
                    }
                }],
                usage: { prompt_tokens: 10, completion_tokens: 10 }
            };
        };

        const guidance = await showRunnerGenerator.generate({
            topic: 'AI podcast hosting',
            topicBrief: 'The guest cares about internal thoughts and structure.',
            questionBank: 'How did the project start?\nWhat should listeners notice?',
            transcript: 'Jensen: The origin is really the introspection system.',
            previousGuidance: null,
            elapsedMinutes: 12,
            maxDurationMinutes: 45
        });
        if (
            showRunnerCall?.requestPath !== '/chat/completions' ||
            showRunnerCall.body.response_format?.json_schema?.name !== 'podcast_showrunner_guidance' ||
            showRunnerCall.body.response_format?.json_schema?.schema?.required?.includes('generatorInstruction') !== true ||
            guidance.phase !== 'background' ||
            guidance.untouchedAngles.length !== 2 ||
            guidance.wrapNow !== false ||
            !guidance.generatorInstruction.includes('bridge to craft')
        ) {
            throw new Error(`Show runner generator did not produce structured guidance: ${JSON.stringify({ showRunnerCall, guidance })}`);
        }
        const showRunnerMessages = showRunnerGenerator.buildMessages({
            topic: 'test',
            transcript: 'Jensen: testing'
        });
        if (
            !showRunnerMessages[0].content.includes('private editorial steering') ||
            !showRunnerMessages[1].content.includes('Potential question bank and lanes') ||
            !showRunnerMessages[2].content.includes('"wrapNow"') ||
            !showRunnerMessages[2].content.includes('"generatorInstruction"')
        ) {
            throw new Error(`Show runner prompts are missing role/schema context: ${JSON.stringify(showRunnerMessages)}`);
        }

        const managerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'showrunner-manager-'));
        const managerCalls = [];
        const disabledManager = new ShowRunnerManager({
            enabled: false,
            generatorOptions: {
                apiKey: 'unused-showrunner-key',
                baseUrl: 'https://api.anthropic.com/v1',
                model: 'claude-opus-4-7'
            }
        });
        if (disabledManager.generator !== null) {
            throw new Error('Disabled show runner manager should not construct a generator');
        }
        const manager = new ShowRunnerManager({
            enabled: true,
            updateIntervalParticipantTurns: 2,
            maxDurationMinutes: 1,
            now: (() => {
                const values = [
                    '2026-05-15T00:00:00.000Z',
                    '2026-05-15T00:00:10.000Z',
                    '2026-05-15T00:00:20.000Z',
                    '2026-05-15T00:00:30.000Z',
                    '2026-05-15T00:02:00.000Z'
                ];
                let index = 0;
                return () => values[Math.min(index++, values.length - 1)];
            })(),
            generator: {
                generate: async (input) => {
                    managerCalls.push(input);
                    return {
                        phase: 'deep-dive',
                        currentLane: 'craft process',
                        coveredAngles: ['origin story'],
                        untouchedAngles: ['collaboration'],
                        nextHostMove: 'bridge',
                        avoid: ['generic follow-up'],
                        suggestedQuestion: 'What changed in practice?',
                        wrapNow: false,
                        wrapReason: 'More lanes remain.',
                        generatorInstruction: 'Synthesize and bridge into craft process.'
                    };
                }
            }
        });
        const session = manager.startSession('guild-showrunner', {
            recordingPath: managerDir,
            topic: 'Show runner test',
            startedAt: '2026-05-15T00:00:00.000Z'
        });
        const firstShowRunnerRecord = await manager.handleTranscriptEntry('guild-showrunner', {
            speaker: 'Jensen',
            speakerRole: 'guest',
            transcription: 'The show needs more structure.',
            timestamp: '2026-05-15T00:00:05.000Z'
        });
        if (
            firstShowRunnerRecord?.guidance?.id !== 'showrunner-1' ||
            managerCalls[0]?.topic !== 'Show runner test' ||
            !managerCalls[0]?.transcript.includes('Jensen: The show needs more structure.')
        ) {
            throw new Error(`Show runner manager did not update on first participant turn: ${JSON.stringify({ firstShowRunnerRecord, managerCalls })}`);
        }
        await manager.handleTranscriptEntry('guild-showrunner', {
            speaker: 'Alpha-Clawd',
            speakerRole: 'host',
            transcription: 'I can carry the structure.',
            timestamp: '2026-05-15T00:00:25.000Z'
        });
        if (managerCalls.length !== 1) {
            throw new Error(`Host turn should not trigger a show runner update by itself: ${JSON.stringify(managerCalls)}`);
        }
        const latestGuidance = manager.getGuidance('guild-showrunner');
        if (
            latestGuidance.phase !== 'deep-dive' ||
            !latestGuidance.generatorInstruction.includes('Synthesize')
        ) {
            throw new Error(`Show runner guidance was not available to generator: ${JSON.stringify(latestGuidance)}`);
        }
        const forcedWrap = manager.getGuidance('guild-showrunner');
        if (
            forcedWrap.wrapNow !== true ||
            !forcedWrap.generatorInstruction.includes('Wrap the episode now')
        ) {
            throw new Error(`Show runner did not enforce configured time limit: ${JSON.stringify(forcedWrap)}`);
        }
        const showRunnerLines = fs.readFileSync(session.outputPath, 'utf8').trim().split(/\n+/);
        if (showRunnerLines.length !== 1 || JSON.parse(showRunnerLines[0]).type !== 'showrunner_guidance') {
            throw new Error(`Show runner JSONL was not persisted correctly: ${fs.readFileSync(session.outputPath, 'utf8')}`);
        }
        const endedShowRunner = await manager.endSession('guild-showrunner');
        if (endedShowRunner.updateCount !== 1) {
            throw new Error(`Show runner manager did not end cleanly: ${JSON.stringify(endedShowRunner)}`);
        }
        fs.rmSync(managerDir, { recursive: true, force: true });

        console.log('  Show runner produces structured episode guidance and persists state');
        passed++;
    } catch (error) {
        console.log(`  Show runner failed: ${error.message}`);
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
        CONVERSATION_BUFFER_DYNAMIC_GRACE: process.env.CONVERSATION_BUFFER_DYNAMIC_GRACE
    };
    try {
        delete process.env.CONVERSATION_BUFFER_GRACE_PERIOD_MS;
        delete process.env.CONVERSATION_BUFFER_DYNAMIC_GRACE;

        const dynamicGraceProbe = new ConversationBuffer();
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
        bot.RecordingState = { RECORDING: 'RECORDING' };
        bot.recordingState = new Map([[guildId, bot.RecordingState.RECORDING]]);
        bot.internalThoughtsEnabled = true;
        bot.showRunnerEnabled = true;
        const recentThoughtRequests = [];
        bot.internalThoughtManager = {
            getActiveAwarenessInjections: (activeGuildId) => activeGuildId === guildId
                ? [{
                    id: 'awareness-direct-test',
                    awarenessInjection: 'Jensen is testing whether private awareness reaches direct turns.'
                }]
                : [],
            getRecentInternalThoughts: (activeGuildId, limit) => {
                recentThoughtRequests.push({ guildId: activeGuildId, limit });
                return Array.from({ length: 9 }, (_, index) => ({
                    packetId: `internal-packet-${index + 1}`,
                    internalThought: `Recent internal thought ${index + 1}`
                })).slice(-limit);
            }
        };
        bot.showRunnerManager = {
            getGuidance: (activeGuildId) => activeGuildId === guildId
                ? {
                    phase: 'background',
                    currentLane: 'origin story',
                    nextHostMove: 'synthesize and bridge',
                    generatorInstruction: 'Do not ask another generic question; bridge into the next lane.'
                }
                : null
        };
        bot.lastParticipantSpeechAt = new Map([[guildId, firstSpeechAt]]);
        bot.idleDecisionHandledSpeechAt = new Map();
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

        if (bot.canRunIdleDecision(guildId)) {
            throw new Error('Idle decision was allowed after this silence period was already handled');
        }

        bot.lastParticipantSpeechAt.set(guildId, firstSpeechAt + 2000);

        if (!bot.canRunIdleDecision(guildId)) {
            throw new Error('Idle decision did not re-arm after fresh participant speech');
        }

        const holdEvents = [];
        let directGenerateCalled = false;
        let directAwarenessInjections = null;
        let directRecentInternalThoughts = null;
        let directShowRunnerGuidance = null;
        bot.conversationBuffer.setFlushHold = (reason, active) => {
            holdEvents.push({ reason, active });
        };
        bot.podcastGenerator = {
            generate: async (input) => {
                directGenerateCalled = true;
                directAwarenessInjections = input.awarenessInjections || [];
                directRecentInternalThoughts = input.recentInternalThoughts || [];
                directShowRunnerGuidance = input.showRunnerGuidance || null;
                if (!bot.directResponseInFlight.has(guildId)) {
                    throw new Error('Direct response was not marked in-flight during generation');
                }
                return { shouldRespond: false, speech: '', bigBrain: { requested: false, reason: '' } };
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
        if (directShowRunnerGuidance?.phase !== 'background' || !directShowRunnerGuidance.generatorInstruction.includes('bridge')) {
            throw new Error(`Direct generator did not receive show runner guidance: ${JSON.stringify(directShowRunnerGuidance)}`);
        }
        if (directRecentInternalThoughts.length !== 0 || recentThoughtRequests.length !== 0) {
            throw new Error(`Direct generator received recent internal thoughts without a trigger: ${JSON.stringify({ directRecentInternalThoughts, recentThoughtRequests })}`);
        }

        directGenerateCalled = false;
        directShowRunnerGuidance = null;
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
        let playCalled = false;
        let transcriptSaved = false;
        let cooldownStarted = false;
        let rememberedTurn = false;
        bot.participantActivityVersion = new Map([[guildId, 0]]);
        bot.participantActivityTimers = new Map();
        bot.participantActivityConfirmDelayMs = 20;
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
        let stoppedAmbient = null;
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
        bot.stopBigBrainAmbientBed = (_guildId, reason, options = {}) => {
            stoppedAmbient = { reason, runId: options.runId };
            return true;
        };
        bot.startBigBrainAmbientBed = (_guildId, pending, options = {}) => {
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
        if (stoppedAmbient?.reason !== 'tool tone starting' || stoppedAmbient?.runId !== runId) {
            throw new Error(`Ambient bed was not stopped for the tool cue: ${JSON.stringify(stoppedAmbient)}`);
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

        stoppedAmbient = null;
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

        stoppedAmbient = null;
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

    console.log('\nTest 7g.1: Stale ambient stop cannot kill resumed bed');
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
        if (ambientStarts < 2) {
            throw new Error(`Ambient bed did not restart after tool tone: ${ambientStarts}`);
        }
        if (!bot.bigBrainAmbientBeds.has(guildId)) {
            throw new Error('Resumed ambient bed was stopped by stale playback failure');
        }
        if (stopCalls !== 1) {
            throw new Error(`Expected only the original ambient stop, got ${stopCalls}`);
        }

        console.log('  Stale ambient playback failures cannot stop the freshly resumed bed');
        passed++;
    } catch (error) {
        console.log(`  Ambient resume race failed: ${error.message}`);
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
        const speechChunk = createSpeechPcm(140);

        const receiver = new AudioReceiver({
            botUserId: 'bot-user',
            endpointingDebounce: 50,
            stt: {
                transcribe: async () => ({ text: 'real speech', confidence: 0.9, words: [] })
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

        await receiver.processUtteranceSnapshot({
            userId: 'user-late-speech',
            speakerInfo: { name: 'Jensen', role: 'guest' },
            audioBuffer: Buffer.alloc(48000),
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

        console.log('  Recording startTime equals detected speech start, not first-chunk time');
        passed++;
    } catch (error) {
        console.log(`  Speaker mix alignment failed: ${error.message}`);
        failed++;
    }

    console.log('\nTest 12: Audio Recorder buffers bot audio without throwing');
    try {
        const { AudioRecorder } = require('./audio-recorder');
        const recorder = new AudioRecorder({ outputFormat: 'wav' });
        recorder.isRecording = true;
        recorder.isPaused = false;
        recorder.startTime = Date.now() - 1000;

        const fakeBotAudio = Buffer.alloc(1024);
        recorder.addBotAudio(fakeBotAudio, { startTime: Date.now() });
        await new Promise((resolve) => setImmediate(resolve));

        if (recorder.botAudioBuffer.length !== 1) {
            throw new Error(`Expected 1 bot chunk, got ${recorder.botAudioBuffer.length}`);
        }

        const chunk = recorder.botAudioBuffer[0];
        if (!Number.isFinite(chunk.timestamp) || chunk.timestamp < 0) {
            throw new Error(`Bot chunk timestamp invalid: ${chunk.timestamp}`);
        }
        if (chunk.buffer !== fakeBotAudio) {
            throw new Error('Bot chunk buffer not stored');
        }
        if (recorder.stats.botAudioChunks !== 1) {
            throw new Error(`Expected botAudioChunks=1, got ${recorder.stats.botAudioChunks}`);
        }

        console.log('  Bot audio chunk lands in botAudioBuffer with finite timestamp');
        passed++;
    } catch (error) {
        console.log(`  Audio Recorder bot audio failed: ${error.message}`);
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

        console.log('  IncrementalSpeechReader handles full, chunked, escaped, mid-escape, and truncated streams');
        passed++;
    } catch (error) {
        console.log(`  IncrementalSpeechReader failed: ${error.message}`);
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

    console.log('\nTest 16a: Kimi Anthropic-compatible streaming');
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
                request.body.output_config?.format?.type !== 'json_schema'
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

    console.log('\nTest 16b: Anthropic Messages streaming');
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
        const downloadUrl = AlphaClawdVoiceBot.prototype.buildEpisodeDownloadUrl(
            { episodesCopy: '/opt/clawcast-network/content/episodes/episode-06.mp3' },
            '/opt/clawcast-network/content/production/episode-06/v004/episode-06-v004.mp3'
        );
        const notice = AlphaClawdVoiceBot.prototype.appendDownloadNotice(
            'done',
            16.1,
            limit,
            downloadUrl,
            '/tmp/episode-06.mp3'
        );

        if (limit !== 8) {
            throw new Error(`Expected default upload limit 8 MB, got ${limit}`);
        }
        if (downloadUrl !== 'https://clawcast.jensenabler.com/episodes/episode-06.mp3') {
            throw new Error(`Unexpected download URL: ${downloadUrl}`);
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

        console.log('  Oversized production renders use the hosted episode URL instead of attachment failure');
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

    console.log('\nTest 47c.1: Publish episode autocomplete uses podcast episode suggestions');
    try {
        const bot = Object.create(AlphaClawdVoiceBot.prototype);
        let focusedValue = null;
        let response = null;
        bot.getPodcastEpisodeAutocompleteChoices = (value) => {
            focusedValue = value;
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

        if (focusedValue !== '6' || response?.[0]?.value !== 6) {
            throw new Error(`Publish autocomplete did not use podcast episode suggestions: ${JSON.stringify({ focusedValue, response })}`);
        }

        console.log('  Publish episode autocomplete uses the same episode-state suggestions as production');
        passed++;
    } catch (error) {
        console.log(`  Publish episode autocomplete failed: ${error.message}`);
        failed++;
    }

    console.log('\nTest 47c.2: Publish version autocomplete lists available versions for selected episode');
    try {
        const bot = Object.create(AlphaClawdVoiceBot.prototype);
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'podcast-publish-version-test-'));
        const previousPodcastRoot = process.env.PODCAST_ROOT;
        process.env.PODCAST_ROOT = tempRoot;

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

        if (previousPodcastRoot === undefined) delete process.env.PODCAST_ROOT;
        else process.env.PODCAST_ROOT = previousPodcastRoot;
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

        console.log('  Publish command passes version option to CLI');
        passed++;
    } catch (error) {
        console.log(`  Publish command version test failed: ${error.message}`);
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
        if (!reply?.content?.includes('Podcast Production Complete')) {
            throw new Error(`Production reply was not sent: ${JSON.stringify(reply)}`);
        }

        console.log('  Production command passes intro/outro creative direction and omits regenerate-audio');
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
