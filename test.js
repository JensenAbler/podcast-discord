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
            systemPrompt.includes('Permission framing is for sensitive, personal, or easy-to-decline invitations') &&
            systemPrompt.includes('Do not ask a question every turn') &&
            systemPrompt.includes('Minimal backchannel is allowed but should be rare') &&
            systemPrompt.includes('meta-comment naming a missed signal') &&
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

        const savedEnv = {
            PODCAST_GENERATOR_API_KEY_ACTIVE: process.env.PODCAST_GENERATOR_API_KEY_ACTIVE,
            PODCAST_GENERATOR_KEY_ROUTING: process.env.PODCAST_GENERATOR_KEY_ROUTING,
            PODCAST_GENERATOR_API_KEY_GROQ_FREE: process.env.PODCAST_GENERATOR_API_KEY_GROQ_FREE,
            PODCAST_GENERATOR_API_KEY_GROQ_PAID: process.env.PODCAST_GENERATOR_API_KEY_GROQ_PAID,
            PODCAST_GENERATOR_API_KEY_GROQ_PRIMARY: process.env.PODCAST_GENERATOR_API_KEY_GROQ_PRIMARY,
            PODCAST_GENERATOR_API_KEY_GROQ_STANDBY: process.env.PODCAST_GENERATOR_API_KEY_GROQ_STANDBY,
            OPENAI_API_KEY: process.env.OPENAI_API_KEY
        };

        try {
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
            bigBrainSchema.properties.bigBrain.required.join(',') !== 'requested,reason'
        ) {
            throw new Error(`bigBrain schema is missing or malformed: ${JSON.stringify(bigBrainSchema.properties.bigBrain)}`);
        }

        const defaultOut = bigBrainGenerator.normalizeOutput({
            shouldRespond: true,
            speech: 'No big brain needed.'
        });
        if (defaultOut.bigBrain.requested !== false || defaultOut.bigBrain.reason !== '') {
            throw new Error(`Missing bigBrain should default to {requested:false, reason:""}: ${JSON.stringify(defaultOut.bigBrain)}`);
        }

        const requestedOut = bigBrainGenerator.normalizeOutput({
            shouldRespond: true,
            speech: 'Let me think about this for a moment.',
            bigBrain: { requested: true, reason: 'Need to verify a date I am unsure about.' }
        });
        if (
            requestedOut.bigBrain.requested !== true ||
            requestedOut.bigBrain.reason !== 'Need to verify a date I am unsure about.'
        ) {
            throw new Error(`bigBrain pass-through failed: ${JSON.stringify(requestedOut.bigBrain)}`);
        }

        const garbageOut = bigBrainGenerator.normalizeOutput({
            shouldRespond: false,
            speech: '',
            bigBrain: { requested: 'yes please', reason: 42 }
        });
        if (garbageOut.bigBrain.requested !== false || garbageOut.bigBrain.reason !== '') {
            throw new Error(`Malformed bigBrain payload was not normalized: ${JSON.stringify(garbageOut.bigBrain)}`);
        }

        console.log('  bigBrain field defaults safely and passes valid payloads through');
    } catch (error) {
        console.log(`  Podcast generator failed: ${error.message}`);
        failed++;
    }

    console.log('\nTest 6: Conversation Buffer ASR-aware state machine');
    try {
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
        if (unknownDurationGrace !== 200) {
            throw new Error(`Missing speech timing should use 200ms fallback grace, got ${unknownDurationGrace}ms`);
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
    }

    console.log('\nTest 7: Idle decision respects in-flight direct responses');
    try {
        const bot = Object.create(AlphaClawdVoiceBot.prototype);
        const guildId = 'guild-a';
        const firstSpeechAt = Date.now() - 1000;
        bot.generatorMode = 'direct';
        bot.RecordingState = { RECORDING: 'RECORDING' };
        bot.recordingState = new Map([[guildId, bot.RecordingState.RECORDING]]);
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
        bot.conversationBuffer.setFlushHold = (reason, active) => {
            holdEvents.push({ reason, active });
        };
        bot.podcastGenerator = {
            generate: async () => {
                directGenerateCalled = true;
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
        bot.conversationBuffer = {
            getState: () => ({
                state: BufferState.IDLE,
                utteranceCount: 0,
                activeSpeakerCount: 0,
                pendingAsrCount: 0
            }),
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

        staleRequeues.length = 0;
        playCalled = false;
        transcriptSaved = false;
        cooldownStarted = false;
        rememberedTurn = false;
        bot.participantActivityVersion.set(guildId, 0);
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

    console.log('\nTest 7b: Generator fallback is honest and transcripted');
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
            !synthesizedText.includes('Groq 429 rate limit') ||
            !synthesizedText.includes('both configured Groq keys') ||
            !synthesizedText.includes('12 seconds')
        ) {
            throw new Error(`Fallback text was not operationally informative: ${synthesizedText}`);
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
        const truthyCases = ['嗯。', '啊', '哎', '哥', '会', '对。'];
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

    console.log('\nTest 11c: ConversationBuffer endpointing blocks flush like an active speaker');
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

    console.log('\n========================================');
    console.log(`Tests complete: ${passed} passed, ${failed} failed`);
    console.log('========================================');

    process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((error) => {
    console.error('Test runner failed:', error);
    process.exit(1);
});
