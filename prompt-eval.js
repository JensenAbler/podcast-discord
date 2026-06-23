#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { PodcastGenerator } = require('./podcast-generator');
const { ShowRunnerGenerator } = require('./showrunner-generator');
const { EpisodePlanTracker } = require('./episode-plan-tracker');
const { normalizeEpisodePlan } = require('./episode-plan-store');

const STATE_MODES = new Set(['oracle', 'predicted', 'none']);
const SHOWRUNNER_REQUIRED_FIELDS = ['action', 'messageToChannel', 'approved', 'plan'];
const SHOWRUNNER_EXACT_FIELDS = ['phase', 'chosenAngle'];
const PODCAST_REQUIRED_FIELDS = ['speech', 'shouldRespond', 'chosenAngle', 'bigBrain', 'bigHeart'];
const EXPECTED_SHOWRUNNER_FIELDS = ['phase', 'chosenAngle', 'notes'];

function usage() {
    return [
        'Usage: node prompt-eval.js --fixture eval/fixtures/foo.json [options]',
        '',
        'Options:',
        '  --execute              Call the configured showrunner and podcast generators.',
        '  --judge                Call the evaluator model too. Requires --execute.',
        '  --checkpoints a,b,c    Override selected checkpoint turn indices or checkpoint ids.',
        '  --state <mode>         predicted, none, or oracle. Default: predicted.',
        '  --target-minutes <n>   Override the fixture target episode length.',
        '  --out <dir>            Override output run directory.',
        '  --help                 Show this help.'
    ].join('\n');
}

function parseArgs(argv = process.argv.slice(2)) {
    const options = {
        fixture: null,
        execute: false,
        judge: false,
        checkpoints: null,
        state: 'predicted',
        targetMinutes: null,
        out: null,
        help: false
    };

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--help' || arg === '-h') {
            options.help = true;
        } else if (arg === '--execute') {
            options.execute = true;
        } else if (arg === '--judge') {
            options.judge = true;
        } else if (arg === '--fixture') {
            options.fixture = requireValue(argv, i, arg);
            i += 1;
        } else if (arg.startsWith('--fixture=')) {
            options.fixture = arg.slice('--fixture='.length);
        } else if (arg === '--checkpoints') {
            options.checkpoints = parseCheckpointList(requireValue(argv, i, arg));
            i += 1;
        } else if (arg.startsWith('--checkpoints=')) {
            options.checkpoints = parseCheckpointList(arg.slice('--checkpoints='.length));
        } else if (arg === '--state') {
            options.state = requireValue(argv, i, arg);
            i += 1;
        } else if (arg.startsWith('--state=')) {
            options.state = arg.slice('--state='.length);
        } else if (arg === '--target-minutes') {
            options.targetMinutes = parsePositiveNumber(requireValue(argv, i, arg), arg);
            i += 1;
        } else if (arg.startsWith('--target-minutes=')) {
            options.targetMinutes = parsePositiveNumber(arg.slice('--target-minutes='.length), '--target-minutes');
        } else if (arg === '--out') {
            options.out = requireValue(argv, i, arg);
            i += 1;
        } else if (arg.startsWith('--out=')) {
            options.out = arg.slice('--out='.length);
        } else {
            throw new Error(`Unknown option: ${arg}`);
        }
    }

    if (!options.help && !options.fixture) {
        throw new Error('Missing required --fixture path.');
    }
    if (!STATE_MODES.has(options.state)) {
        throw new Error(`Invalid --state "${options.state}". Expected oracle, predicted, or none.`);
    }
    if (options.judge && !options.execute) {
        throw new Error('--judge requires --execute.');
    }

    return options;
}

function parsePositiveNumber(value, flag) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) {
        throw new Error(`${flag} requires a positive number.`);
    }
    return number;
}

function requireValue(argv, index, flag) {
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
        throw new Error(`${flag} requires a value.`);
    }
    return value;
}

function parseCheckpointList(value) {
    const tokens = String(value || '')
        .split(',')
        .map((token) => token.trim())
        .filter(Boolean);
    if (tokens.length === 0) {
        throw new Error('--checkpoints requires at least one checkpoint.');
    }
    return tokens.map((token) => {
        if (/^\d+$/.test(token)) {
            return Number(token);
        }
        return token;
    });
}

function loadFixture(fixturePath) {
    const absolutePath = path.resolve(fixturePath);
    let raw;
    try {
        raw = JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
    } catch (error) {
        throw new Error(`Could not read fixture ${absolutePath}: ${error.message}`);
    }
    return normalizeFixture(raw, absolutePath);
}

function validateFixture(rawFixture, sourcePath = 'fixture.json') {
    return normalizeFixture(rawFixture, sourcePath);
}

function normalizeFixture(rawFixture, sourcePath = 'fixture.json') {
    if (!rawFixture || typeof rawFixture !== 'object' || Array.isArray(rawFixture)) {
        throw new Error('Fixture must be a JSON object.');
    }

    const topic = cleanText(rawFixture.topic);
    if (!topic) {
        throw new Error('Fixture requires a non-empty topic.');
    }

    if (!Array.isArray(rawFixture.turns) || rawFixture.turns.length === 0) {
        throw new Error('Fixture requires a non-empty turns array.');
    }

    const turns = rawFixture.turns.map((turn, index) => normalizeTurn(turn, index));
    if (!turns.some((turn) => turn.role === 'host')) {
        throw new Error('Fixture turns must include at least one host turn.');
    }

    const rawCheckpoints = rawFixture.checkpoints === undefined
        ? turns.map((turn, index) => (turn.role === 'host' ? index : null)).filter((index) => index !== null)
        : rawFixture.checkpoints;
    if (!Array.isArray(rawCheckpoints) || rawCheckpoints.length === 0) {
        throw new Error('Fixture checkpoints must be a non-empty array when provided.');
    }

    const fixture = {
        id: cleanId(rawFixture.id || path.basename(sourcePath, path.extname(sourcePath))),
        sourcePath,
        topic,
        topicBrief: cleanMultiline(rawFixture.topicBrief || ''),
        episodeStartedAt: cleanText(rawFixture.episodeStartedAt || ''),
        targetDurationMinutes: numericOrNull(rawFixture.targetDurationMinutes ?? rawFixture.targetMinutes),
        maxDurationMinutes: numericOrNull(rawFixture.maxDurationMinutes),
        timeline: normalizeTimeline(rawFixture.timeline || rawFixture.chapters),
        turns,
        checkpoints: []
    };
    fixture.episodePlan = normalizeEpisodePlan(rawFixture.episodePlan || buildDefaultEpisodePlan(fixture));

    fixture.checkpoints = rawCheckpoints.map((checkpoint, index) => normalizeCheckpoint(checkpoint, index, fixture));
    return fixture;
}

function normalizeTurn(turn, index) {
    if (!turn || typeof turn !== 'object' || Array.isArray(turn)) {
        throw new Error(`Turn ${index} must be an object.`);
    }

    const role = String(turn.role || '').trim().toLowerCase();
    if (role !== 'host' && role !== 'guest') {
        throw new Error(`Turn ${index} role must be "host" or "guest".`);
    }

    const speaker = cleanText(turn.speaker);
    if (!speaker) {
        throw new Error(`Turn ${index} requires a non-empty speaker.`);
    }

    const text = cleanMultiline(turn.text);
    if (!text) {
        throw new Error(`Turn ${index} requires non-empty text.`);
    }

    const normalized = {
        index,
        speaker,
        role,
        text
    };
    if (turn.timestamp !== undefined) {
        normalized.timestamp = String(turn.timestamp);
    }
    return normalized;
}

function buildDefaultEpisodePlan(fixture) {
    const target = Number.isFinite(fixture.targetDurationMinutes) ? fixture.targetDurationMinutes : 90;
    const phaseMinutes = Math.max(1, Math.round(target / 4));
    return {
        basename: cleanId(`${fixture.id}-eval-plan`),
        version: 'v001',
        targetDurationMinutes: target,
        guests: unique(fixture.turns.filter((turn) => turn.role !== 'host').map((turn) => turn.speaker))
            .map((name) => ({ name, role: 'guest', brief: '' })),
        backgroundBrief: cleanMultiline(fixture.topicBrief || fixture.topic || ''),
        excludedAngles: [],
        phases: {
            expanding: {
                targetMinutes: phaseMinutes,
                angles: [
                    { id: 'guest-background', title: 'Guest background', description: 'Establish who the guest is and why this conversation matters.' }
                ]
            },
            developing: {
                targetMinutes: phaseMinutes * 2,
                angles: [
                    { id: 'core-story', title: 'Core story', description: 'Work through the central experience, claim, or evidence in detail.' },
                    { id: 'methods-and-specifics', title: 'Methods and specifics', description: 'Ground the conversation in concrete procedures, scenes, and examples.' }
                ]
            },
            converging: {
                targetMinutes: phaseMinutes,
                angles: [
                    { id: 'meaning-and-implications', title: 'Meaning and implications', description: 'Synthesize what the story changes for listeners.' }
                ]
            },
            closing: {
                targetMinutes: Math.max(5, Math.round(phaseMinutes / 2)),
                angles: [
                    { id: 'closing-message', title: 'Closing message', description: 'Land the episode with final reflection and where listeners can go next.' }
                ]
            }
        }
    };
}

function normalizeTimeline(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    return value
        .map((item) => {
            if (!item || typeof item !== 'object' || Array.isArray(item)) {
                return null;
            }
            const label = cleanText(item.label || item.title || item.name);
            const timestamp = cleanText(item.timestamp || item.time || item.at);
            if (!label || !timestamp) {
                return null;
            }
            return { label, timestamp };
        })
        .filter(Boolean);
}

function normalizeCheckpoint(rawCheckpoint, ordinal, fixture) {
    const checkpointObject = rawCheckpoint && typeof rawCheckpoint === 'object' && !Array.isArray(rawCheckpoint)
        ? rawCheckpoint
        : {};
    const indexValue = checkpointObject.turnIndex ?? checkpointObject.hostTurnIndex ?? rawCheckpoint;
    const targetTurnIndex = resolveHostTurnIndex(indexValue, fixture.turns);
    const targetTurn = fixture.turns[targetTurnIndex];
    const hostTurnOrdinal = fixture.turns.slice(0, targetTurnIndex + 1).filter((turn) => turn.role === 'host').length - 1;
    const id = cleanId(checkpointObject.id || `turn-${targetTurnIndex}`);
    const expectedShowrunner = extractExpectedShowrunner(checkpointObject);

    return {
        id,
        ordinal,
        targetTurnIndex,
        hostTurnOrdinal,
        targetTurn,
        expectedSpeech: targetTurn.text,
        expected: {
            showrunner: Object.keys(expectedShowrunner).length > 0 ? expectedShowrunner : null
        },
        notes: cleanMultiline(checkpointObject.notes || checkpointObject.expected?.notes || '')
    };
}

function resolveHostTurnIndex(value, turns) {
    const hostTurnIndices = turns
        .map((turn, index) => (turn.role === 'host' ? index : null))
        .filter((index) => index !== null);

    if (!Number.isInteger(value)) {
        const parsed = Number(value);
        if (Number.isInteger(parsed)) {
            value = parsed;
        }
    }

    if (Number.isInteger(value)) {
        if (value >= 0 && value < turns.length && turns[value].role === 'host') {
            return value;
        }
        if (value >= 0 && value < hostTurnIndices.length) {
            return hostTurnIndices[value];
        }
        if (value >= 1 && value <= hostTurnIndices.length) {
            return hostTurnIndices[value - 1];
        }
    }

    throw new Error(`Checkpoint ${JSON.stringify(value)} does not resolve to a host turn.`);
}

function extractExpectedShowrunner(checkpointObject = {}) {
    const expected = checkpointObject.expected && typeof checkpointObject.expected === 'object'
        ? checkpointObject.expected
        : {};
    const showrunner = expected.showrunner && typeof expected.showrunner === 'object'
        ? expected.showrunner
        : {};
    const merged = { ...showrunner };

    for (const field of EXPECTED_SHOWRUNNER_FIELDS) {
        if (checkpointObject[field] !== undefined) {
            merged[field] = checkpointObject[field];
        } else if (expected[field] !== undefined) {
            merged[field] = expected[field];
        }
    }

    return cleanObject(merged);
}

function selectCheckpoints(fixture, override = null) {
    if (!override || override.length === 0) {
        return fixture.checkpoints;
    }

    return override.map((item, ordinal) => {
        if (typeof item === 'string') {
            const byId = fixture.checkpoints.find((checkpoint) => checkpoint.id === item);
            if (!byId) {
                throw new Error(`No checkpoint with id "${item}" in fixture ${fixture.id}.`);
            }
            return { ...byId, ordinal };
        }

        const targetTurnIndex = resolveHostTurnIndex(item, fixture.turns);
        const existing = fixture.checkpoints.find((checkpoint) => checkpoint.targetTurnIndex === targetTurnIndex);
        if (existing) {
            return { ...existing, ordinal };
        }
        return normalizeCheckpoint(item, ordinal, fixture);
    });
}

function buildCheckpointContext(fixture, checkpoint, previousGuidance = null) {
    const transcript = formatTranscriptPrefix(fixture, checkpoint.targetTurnIndex);
    const elapsedMinutes = computeElapsedMinutes(fixture, checkpoint.targetTurnIndex);
    const base = {
        fixtureId: fixture.id,
        checkpointId: checkpoint.id,
        targetTurnIndex: checkpoint.targetTurnIndex,
        hostTurnOrdinal: checkpoint.hostTurnOrdinal,
        transcript,
        previousGuidance
    };

    const showrunnerInput = {
        planningMessages: buildFixturePlanningMessages(fixture),
        previousPlan: fixture.episodePlan,
        basename: fixture.episodePlan.basename,
        previousGuidance,
        generatedAt: checkpoint.targetTurn.timestamp
    };
    if (Number.isFinite(elapsedMinutes)) {
        showrunnerInput.elapsedMinutes = elapsedMinutes;
    }
    if (Number.isFinite(fixture.targetDurationMinutes)) {
        showrunnerInput.targetDurationMinutes = fixture.targetDurationMinutes;
        if (Number.isFinite(elapsedMinutes)) {
            showrunnerInput.remainingTargetMinutes = Math.max(0, fixture.targetDurationMinutes - elapsedMinutes);
        }
    }
    if (Number.isFinite(fixture.maxDurationMinutes)) {
        showrunnerInput.maxDurationMinutes = fixture.maxDurationMinutes;
    }

    return {
        ...base,
        showrunnerInput
    };
}

function buildFixturePlanningMessages(fixture) {
    return [
        fixture.topic ? { speaker: 'Producer', text: `Episode context: ${fixture.topic}` } : null,
        fixture.topicBrief ? { speaker: 'Producer', text: fixture.topicBrief } : null,
        Number.isFinite(fixture.targetDurationMinutes)
            ? { speaker: 'Producer', text: `Target duration: ${fixture.targetDurationMinutes} minutes.` }
            : null
    ].filter(Boolean);
}

function buildPodcastInput(fixture, checkpoint, transcript, episodePlanStructure = '') {
    const input = {
        transcript: transcript || '(empty)',
        utterances: [],
        episodePlanStructure,
        stagedBigBrain: [],
        pendingBigBrain: [],
        stagedBigHeart: [],
        pendingBigHeart: [],
        awarenessInjections: [],
        awarenessShelfItems: [],
        recentInternalThoughts: [],
        consecutiveSilenceTurns: 0,
        remember: false
    };
    if (checkpoint.targetTurn.timestamp) {
        input.currentTime = checkpoint.targetTurn.timestamp;
        input.currentEpisodeTimestamp = formatEpisodeTimestamp(fixture, checkpoint.targetTurn.timestamp);
        input.generatorCalledAt = checkpoint.targetTurn.timestamp;
    }
    return input;
}

function formatTranscriptPrefix(fixture, targetTurnIndex) {
    return fixture.turns
        .slice(0, targetTurnIndex)
        .map((turn) => {
            const speaker = turn.role === 'host' ? 'Alpha-Clawd' : turn.speaker;
            return `${speaker}: ${turn.text}`;
        })
        .join('\n');
}

function getPodcastCurrentTranscriptStart(fixture, targetTurnIndex) {
    const turns = fixture.turns || [];
    let start = Math.max(0, Math.min(Number(targetTurnIndex) || 0, turns.length));
    while (start > 0 && turns[start - 1]?.role !== 'host') {
        start -= 1;
    }
    return start;
}

function formatPodcastCurrentTranscript(fixture, targetTurnIndex) {
    const start = getPodcastCurrentTranscriptStart(fixture, targetTurnIndex);
    return fixture.turns
        .slice(start, targetTurnIndex)
        .map((turn) => `${turn.speaker}: ${turn.text}`)
        .join('\n');
}

function buildPodcastHistory(fixture, targetTurnIndex) {
    const currentStart = getPodcastCurrentTranscriptStart(fixture, targetTurnIndex);
    return fixture.turns
        .slice(0, currentStart)
        .map((turn) => {
            if (turn.role === 'host') {
                return {
                    role: 'assistant',
                    content: turn.text
                };
            }
            return {
                role: 'user',
                content: `${turn.speaker}: ${turn.text}`
            };
        });
}

function observeTurnsForTracker(tracker, turns = [], fromIndex = 0, toIndex = 0) {
    for (const turn of turns.slice(fromIndex, toIndex)) {
        tracker.observeTranscriptEntry({
            speaker: turn.role === 'host' ? 'Alpha-Clawd' : turn.speaker,
            speakerRole: turn.role === 'host' ? 'host' : 'guest',
            transcription: turn.text,
            timestamp: turn.timestamp,
            speechStartedAt: turn.speechStartedAt || turn.timestamp,
            speechEndedAt: turn.speechEndedAt || turn.timestamp,
            playbackStartedAt: turn.playbackStartedAt || turn.timestamp,
            playbackEndedAt: turn.playbackEndedAt || turn.timestamp,
            duration: turn.duration
        });
    }
}

function getKnownSpeakersForCheckpoint(fixture, targetTurnIndex) {
    if (Array.isArray(fixture.speakers) && fixture.speakers.length > 0) {
        return fixture.speakers.map((speaker) => cleanText(speaker)).filter(Boolean);
    }
    return unique(
        fixture.turns
            .slice(0, targetTurnIndex)
            .map((turn) => turn.role === 'host' ? 'Alpha-Clawd' : turn.speaker)
    );
}

function formatEpisodeTimestamp(fixture, timestamp) {
    const current = Date.parse(timestamp || '');
    if (!Number.isFinite(current)) {
        return String(timestamp || '').trim();
    }
    const episodeStart = Date.parse(fixture.episodeStartedAt || '');
    const firstTurn = Date.parse(fixture.turns?.[0]?.timestamp || '');
    const start = Number.isFinite(episodeStart) ? episodeStart : firstTurn;
    if (!Number.isFinite(start)) {
        return String(timestamp || '').trim();
    }

    const totalMs = Math.max(0, current - start);
    const hours = Math.floor(totalMs / 3600000);
    const minutes = Math.floor((totalMs % 3600000) / 60000);
    const seconds = Math.floor((totalMs % 60000) / 1000);
    const millis = Math.floor(totalMs % 1000);
    return [
        String(hours).padStart(2, '0'),
        String(minutes).padStart(2, '0'),
        `${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`
    ].join(':');
}

function computeElapsedMinutes(fixture, targetTurnIndex) {
    const turns = fixture.turns || [];
    const episodeStart = Date.parse(fixture.episodeStartedAt || '');
    const firstTurn = Date.parse(turns[0]?.timestamp || '');
    const current = Date.parse(turns[targetTurnIndex]?.timestamp || '');
    const start = Number.isFinite(episodeStart) ? episodeStart : firstTurn;
    if (!Number.isFinite(start) || !Number.isFinite(current)) {
        return null;
    }
    return Math.max(0, (current - start) / 60000);
}

class PromptEvalRunner {
    constructor(options = {}) {
        this.showRunnerGenerator = options.showRunnerGenerator || new ShowRunnerGenerator(options.showRunnerOptions || {});
        this.podcastGenerator = options.podcastGenerator || new PodcastGenerator(options.podcastOptions || {});
        this.judgeGenerator = options.judgeGenerator || null;
        this.now = options.now || (() => new Date().toISOString());
        this.outputRoot = options.outputRoot || path.join(process.cwd(), 'eval', 'runs');
        this.maxSpeechChars = Number(options.maxSpeechChars || process.env.PROMPT_EVAL_MAX_SPEECH_CHARS || 420);
    }

    async run(options = {}) {
        let fixture = typeof options.fixture === 'string'
            ? loadFixture(options.fixture)
            : validateFixture(options.fixture, options.fixturePath || 'inline-fixture.json');
        if (Number.isFinite(options.targetMinutes)) {
            fixture = {
                ...fixture,
                targetDurationMinutes: options.targetMinutes
            };
        }
        const checkpoints = selectCheckpoints(fixture, options.checkpoints || null);
        const execute = Boolean(options.execute);
        const judge = Boolean(options.judge);
        const stateMode = options.state || 'predicted';
        if (!STATE_MODES.has(stateMode)) {
            throw new Error(`Invalid state mode "${stateMode}".`);
        }
        if (judge && !execute) {
            throw new Error('Judge mode requires execute mode.');
        }

        const timestamp = safeTimestamp(options.timestamp || this.now());
        const runDir = path.resolve(options.out || path.join(this.outputRoot, fixture.id, timestamp));
        fs.mkdirSync(runDir, { recursive: true });

        const promptRecords = [];
        const outputRecords = [];
        let previousGuidance = null;
        let activeEpisodePlan = fixture.episodePlan;
        let tracker = new EpisodePlanTracker(activeEpisodePlan, {
            startedAt: fixture.episodeStartedAt || fixture.turns[0]?.timestamp || this.now(),
            openingHostSpoken: true
        });
        let observedTurnCursor = 0;
        const judgeGenerator = judge ? (this.judgeGenerator || new PromptEvalJudgeGenerator()) : null;

        for (const checkpoint of checkpoints) {
            const context = buildCheckpointContext(fixture, checkpoint, previousGuidance);
            const showrunnerMessages = this.showRunnerGenerator.buildMessages(context.showrunnerInput);
            const showrunnerRequest = buildRequestBody(this.showRunnerGenerator, showrunnerMessages);
            let showrunnerOutput = null;
            let showrunnerError = null;

            if (execute) {
                try {
                    showrunnerOutput = await this.showRunnerGenerator.generate(context.showrunnerInput);
                    if (showrunnerOutput?.plan) {
                        activeEpisodePlan = showrunnerOutput.plan;
                        tracker = new EpisodePlanTracker(activeEpisodePlan, {
                            startedAt: fixture.episodeStartedAt || fixture.turns[0]?.timestamp || this.now(),
                            openingHostSpoken: true
                        });
                        observedTurnCursor = 0;
                    }
                } catch (error) {
                    showrunnerError = error.message;
                }
            }

            observeTurnsForTracker(tracker, fixture.turns, observedTurnCursor, checkpoint.targetTurnIndex);
            observedTurnCursor = checkpoint.targetTurnIndex;
            const episodePlanStructure = tracker.getStructureBlock(checkpoint.targetTurn.timestamp || this.now());
            this.preparePodcastGenerator(fixture, checkpoint);
            const podcastTranscript = formatPodcastCurrentTranscript(fixture, checkpoint.targetTurnIndex);
            const podcastInput = buildPodcastInput(fixture, checkpoint, podcastTranscript, episodePlanStructure);
            const podcastMessages = this.podcastGenerator.buildMessages(podcastInput);
            const podcastRequest = buildRequestBody(this.podcastGenerator, podcastMessages);
            let podcastOutput = null;
            let podcastError = null;

            if (execute && !showrunnerError) {
                try {
                    podcastOutput = await this.podcastGenerator.generate(podcastInput);
                    if (podcastOutput?.shouldRespond) {
                        tracker.applySpokenResponse(podcastOutput, { now: checkpoint.targetTurn.timestamp || this.now() });
                    }
                } catch (error) {
                    podcastError = error.message;
                }
            }

            const deterministicScores = scoreDeterministic({
                checkpoint,
                showrunnerOutput,
                podcastOutput,
                executed: execute,
                maxSpeechChars: this.maxSpeechChars
            });
            let judgeScores = null;
            let judgeError = null;
            if (judge && !podcastError && !showrunnerError) {
                try {
                    judgeScores = await judgeGenerator.generate({
                        fixture,
                        checkpoint,
                        transcript: context.transcript,
                        showrunnerOutput,
                        podcastOutput
                    });
                } catch (error) {
                    judgeError = error.message;
                }
            }

            const promptRecord = {
                type: 'prompt_bundle',
                fixtureId: fixture.id,
                checkpointId: checkpoint.id,
                targetTurnIndex: checkpoint.targetTurnIndex,
                hostTurnOrdinal: checkpoint.hostTurnOrdinal,
                stateMode,
                showrunner: {
                    input: context.showrunnerInput,
                    messages: showrunnerMessages,
                    requestBody: showrunnerRequest
                },
                podcast: {
                    input: podcastInput,
                    messages: podcastMessages,
                    requestBody: podcastRequest
                }
            };

            const outputRecord = {
                type: 'eval_result',
                fixtureId: fixture.id,
                checkpointId: checkpoint.id,
                targetTurnIndex: checkpoint.targetTurnIndex,
                hostTurnOrdinal: checkpoint.hostTurnOrdinal,
                executed: execute,
                expected: {
                    podcastSpeech: checkpoint.expectedSpeech,
                    showrunner: checkpoint.expected.showrunner
                },
                outputs: {
                    showrunner: showrunnerOutput,
                    podcast: podcastOutput
                },
                errors: {
                    showrunner: showrunnerError,
                    podcast: podcastError,
                    judge: judgeError
                },
                scores: {
                    deterministic: deterministicScores,
                    judge: judgeScores
                }
            };

            promptRecords.push(promptRecord);
            outputRecords.push(outputRecord);
            previousGuidance = updatePreviousGuidance({
                stateMode,
                previousGuidance,
                showrunnerOutput
            });
        }

        const scores = summarizeScores(outputRecords);
        fs.writeFileSync(path.join(runDir, 'prompts.jsonl'), toJsonl(promptRecords));
        fs.writeFileSync(path.join(runDir, 'outputs.jsonl'), toJsonl(outputRecords));
        fs.writeFileSync(path.join(runDir, 'scores.json'), `${JSON.stringify(scores, null, 2)}\n`);
        fs.writeFileSync(path.join(runDir, 'report.md'), generateReport({
            fixture,
            checkpoints,
            runDir,
            stateMode,
            execute,
            judge,
            scores,
            outputRecords
        }));

        return {
            fixture,
            checkpoints,
            runDir,
            promptRecords,
            outputRecords,
            scores
        };
    }

    preparePodcastGenerator(fixture, checkpoint = null) {
        const generator = this.podcastGenerator;
        if (!generator || typeof generator !== 'object') {
            return;
        }
        if (Array.isArray(generator.history)) {
            generator.history = checkpoint
                ? buildPodcastHistory(fixture, checkpoint.targetTurnIndex)
                : [];
        }
        if (generator.session && typeof generator.session === 'object') {
            generator.session = {
                ...generator.session,
                topic: fixture.topic,
                speakers: checkpoint
                    ? getKnownSpeakersForCheckpoint(fixture, checkpoint.targetTurnIndex)
                    : []
            };
        }
        if ('standbyMode' in generator) {
            generator.standbyMode = false;
        }
        if ('questionMoratoriumTurns' in generator) {
            generator.questionMoratoriumTurns = 0;
        }
        if (Array.isArray(generator.episodeStructureNotes)) {
            generator.episodeStructureNotes = [];
        }
    }
}

function choosePodcastGuidance({ execute, showrunnerOutput, previousGuidance, stateMode }) {
    if (execute && showrunnerOutput) {
        return showrunnerOutput;
    }
    if (stateMode === 'oracle') {
        return previousGuidance;
    }
    return null;
}

function updatePreviousGuidance({ stateMode, previousGuidance, showrunnerOutput }) {
    if (stateMode === 'none') {
        return null;
    }
    return showrunnerOutput || previousGuidance;
}

function buildRequestBody(generator, messages) {
    if (!generator || typeof generator.buildRequestBody !== 'function') {
        return null;
    }
    try {
        return generator.buildRequestBody(messages);
    } catch (error) {
        return { error: error.message };
    }
}

function scoreDeterministic({ checkpoint, showrunnerOutput, podcastOutput, executed = false, maxSpeechChars = 420 }) {
    const expectedShowrunner = checkpoint.expected.showrunner || {};
    const actualSpeech = cleanMultiline(podcastOutput?.speech || podcastOutput?.text || '');
    const expectedSpeech = checkpoint.expectedSpeech || '';

    return {
        executed,
        jsonValidity: {
            showrunner: executed ? validateShowrunnerOutput(showrunnerOutput) : notRunValidity(),
            podcast: executed ? validatePodcastOutput(podcastOutput) : notRunValidity()
        },
        showrunner: scoreShowrunnerAnnotations(expectedShowrunner, showrunnerOutput, executed),
        podcast: {
            textOverlap: executed ? scoreTextOverlap(expectedSpeech, actualSpeech) : null,
            speechContract: executed
                ? scoreSpeechContract(actualSpeech, podcastOutput, { maxSpeechChars })
                : notRunContract()
        }
    };
}

function validateShowrunnerOutput(output) {
    if (!isPlainObject(output)) {
        return { valid: false, missing: SHOWRUNNER_REQUIRED_FIELDS.slice(), reason: 'not_object' };
    }
    const missing = SHOWRUNNER_REQUIRED_FIELDS.filter((field) => output[field] === undefined);
    return {
        valid: missing.length === 0,
        missing
    };
}

function validatePodcastOutput(output) {
    if (!isPlainObject(output)) {
        return { valid: false, missing: PODCAST_REQUIRED_FIELDS.slice(), reason: 'not_object' };
    }
    const missing = PODCAST_REQUIRED_FIELDS.filter((field) => output[field] === undefined);
    return {
        valid: missing.length === 0,
        missing
    };
}

function notRunValidity() {
    return { valid: null, missing: [], reason: 'not_run' };
}

function scoreShowrunnerAnnotations(expectedShowrunner, showrunnerOutput, executed) {
    const fields = {};
    let annotated = 0;
    let matched = 0;

    for (const field of SHOWRUNNER_EXACT_FIELDS) {
        if (expectedShowrunner[field] === undefined) {
            continue;
        }
        annotated += 1;
        const actual = field === 'phase'
            ? (showrunnerOutput?.plan?.phases?.[expectedShowrunner[field]] ? expectedShowrunner[field] : undefined)
            : (showrunnerOutput?.plan ? findAngleInPlan(showrunnerOutput.plan, expectedShowrunner[field]) : undefined);
        const pass = executed ? valuesExactMatch(expectedShowrunner[field], actual) : null;
        if (pass) {
            matched += 1;
        }
        fields[field] = {
            expected: expectedShowrunner[field],
            actual,
            pass
        };
    }

    return {
        annotatedFields: annotated,
        exactMatches: matched,
        exactMatchRate: executed && annotated > 0 ? matched / annotated : null,
        fields
    };
}

function findAngleInPlan(plan, angleId) {
    const expected = cleanText(angleId);
    if (!expected) return undefined;
    for (const phase of Object.values(plan?.phases || {})) {
        for (const angle of phase?.angles || []) {
            if (angle.id === expected) return angle.id;
        }
    }
    return undefined;
}

function valuesExactMatch(expected, actual) {
    if (typeof expected === 'boolean') {
        return expected === actual;
    }
    return cleanText(expected).toLowerCase() === cleanText(actual).toLowerCase();
}

function scoreSpeechContract(speech, podcastOutput, options = {}) {
    const maxSpeechChars = Number(options.maxSpeechChars || 420);
    const shouldRespond = podcastOutput?.shouldRespond === true;
    const violations = [];

    if (shouldRespond && speech.length === 0) {
        violations.push('empty_speech_with_shouldRespond_true');
    }
    if (!shouldRespond && speech.length > 0) {
        violations.push('speech_with_shouldRespond_false');
    }
    if (hasMarkdown(speech)) {
        violations.push('markdown');
    }
    if (hasCode(speech)) {
        violations.push('code');
    }
    if (/https?:\/\/\S+/i.test(speech)) {
        violations.push('url');
    }
    if (/(?:[A-Za-z]:\\|(?:^|\s)(?:\.{1,2}\/|\/)[^\s]+)/.test(speech)) {
        violations.push('file_path');
    }
    if (speech.length > maxSpeechChars) {
        violations.push('too_long');
    }

    return {
        pass: violations.length === 0,
        violations,
        chars: speech.length,
        maxSpeechChars
    };
}

function notRunContract() {
    return {
        pass: null,
        violations: [],
        chars: null,
        maxSpeechChars: null,
        reason: 'not_run'
    };
}

function scoreTextOverlap(expected, actual) {
    const expectedTokens = tokenize(expected);
    const actualTokens = tokenize(actual);
    if (expectedTokens.length === 0 && actualTokens.length === 0) {
        return 1;
    }
    if (expectedTokens.length === 0 || actualTokens.length === 0) {
        return 0;
    }

    const expectedCounts = countTokens(expectedTokens);
    const actualCounts = countTokens(actualTokens);
    let shared = 0;
    for (const [token, count] of expectedCounts.entries()) {
        shared += Math.min(count, actualCounts.get(token) || 0);
    }

    const precision = shared / actualTokens.length;
    const recall = shared / expectedTokens.length;
    const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
    return Number(f1.toFixed(4));
}

function tokenize(text) {
    return cleanText(text)
        .toLowerCase()
        .replace(/[^a-z0-9'\s]/g, ' ')
        .split(/\s+/)
        .filter(Boolean);
}

function countTokens(tokens) {
    const counts = new Map();
    for (const token of tokens) {
        counts.set(token, (counts.get(token) || 0) + 1);
    }
    return counts;
}

function hasMarkdown(text) {
    return /```|`|\[[^\]]+\]\([^)]+\)|^\s{0,3}#{1,6}\s+|^\s*[-*+]\s+|\|.+\|/m.test(text);
}

function hasCode(text) {
    return /```|`|\b(?:const|let|var|function|class)\s+[A-Za-z_$][\w$]*|=>|<\/?[a-z][\w-]*(?:\s|>)/i.test(text);
}

function summarizeScores(outputRecords) {
    const executedRecords = outputRecords.filter((record) => record.executed);
    const overlaps = executedRecords
        .map((record) => record.scores.deterministic.podcast.textOverlap)
        .filter((score) => Number.isFinite(score));
    const annotatedRates = outputRecords
        .map((record) => record.scores.deterministic.showrunner.exactMatchRate)
        .filter((score) => Number.isFinite(score));
    const contractPasses = executedRecords.filter((record) => record.scores.deterministic.podcast.speechContract.pass === true).length;
    const showrunnerValid = executedRecords.filter((record) => record.scores.deterministic.jsonValidity.showrunner.valid === true).length;
    const podcastValid = executedRecords.filter((record) => record.scores.deterministic.jsonValidity.podcast.valid === true).length;

    return {
        checkpointCount: outputRecords.length,
        executedCount: executedRecords.length,
        averageTextOverlap: average(overlaps),
        averageAnnotatedShowrunnerMatch: average(annotatedRates),
        speechContractPassRate: executedRecords.length > 0 ? contractPasses / executedRecords.length : null,
        showrunnerJsonValidRate: executedRecords.length > 0 ? showrunnerValid / executedRecords.length : null,
        podcastJsonValidRate: executedRecords.length > 0 ? podcastValid / executedRecords.length : null,
        checkpoints: outputRecords.map((record) => ({
            checkpointId: record.checkpointId,
            targetTurnIndex: record.targetTurnIndex,
            textOverlap: record.scores.deterministic.podcast.textOverlap,
            showrunnerExactMatchRate: record.scores.deterministic.showrunner.exactMatchRate,
            speechContractPass: record.scores.deterministic.podcast.speechContract.pass,
            errors: record.errors
        }))
    };
}

function average(values) {
    if (!values.length) {
        return null;
    }
    return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(4));
}

function generateReport({ fixture, checkpoints, runDir, stateMode, execute, judge, scores, outputRecords }) {
    const lines = [
        `# Prompt Eval Report: ${fixture.id}`,
        '',
        `- Topic: ${fixture.topic}`,
        `- Run directory: ${runDir}`,
        `- Checkpoints: ${checkpoints.length}`,
        Number.isFinite(fixture.targetDurationMinutes) ? `- Target duration: ${fixture.targetDurationMinutes} minutes` : null,
        Number.isFinite(fixture.maxDurationMinutes) ? `- Hard max duration: ${fixture.maxDurationMinutes} minutes` : null,
        fixture.timeline.length > 0 ? `- Timeline chapters: ${fixture.timeline.length} stored in fixture; not injected into model prompts` : null,
        `- State mode: ${stateMode}`,
        `- Execute: ${execute ? 'yes' : 'no'}`,
        `- Judge: ${judge ? 'yes' : 'no'}`,
        '',
        '## Summary',
        '',
        `- Average text overlap: ${formatScore(scores.averageTextOverlap)}`,
        `- Average annotated showrunner match: ${formatScore(scores.averageAnnotatedShowrunnerMatch)}`,
        `- Speech contract pass rate: ${formatScore(scores.speechContractPassRate)}`,
        '',
        '## Checkpoints',
        '',
        '| checkpoint | turn | expected host turn | actual speech | overlap | phase match | angle match |',
        '| --- | ---: | --- | --- | ---: | --- | --- |'
    ].filter((line) => line !== null);

    for (const record of outputRecords) {
        const expected = record.expected.podcastSpeech || '';
        const actual = record.outputs.podcast?.speech || '';
        const fields = record.scores.deterministic.showrunner.fields;
        lines.push([
            record.checkpointId,
            record.targetTurnIndex,
            fullTextForTable(expected),
            fullTextForTable(actual || '(not run)'),
            formatScore(record.scores.deterministic.podcast.textOverlap),
            formatPass(fields.phase?.pass),
            formatPass(fields.chosenAngle?.pass)
        ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
    }

    lines.push(
        '',
        '## Full Responses',
        ''
    );

    for (const record of outputRecords) {
        const expected = record.expected.podcastSpeech || '';
        const showrunnerOutput = formatShowrunnerOutputForReport(record.outputs.showrunner || null);
        const podcastOutput = formatPodcastOutputForReport(record.outputs.podcast || null);

        lines.push(
            `### ${record.checkpointId} (turn ${record.targetTurnIndex})`,
            '',
            `- Overlap: ${formatScore(record.scores.deterministic.podcast.textOverlap)}`,
            `- Speech contract: ${formatPass(record.scores.deterministic.podcast.speechContract.pass)}`,
            '',
            '**Expected host turn**',
            '',
            markdownFence(expected || '(empty)', 'text'),
            '',
            '**Generated podcast output**',
            '',
            markdownFence(JSON.stringify(podcastOutput, null, 2), 'json'),
            '',
            '**Generated showrunner output**',
            '',
            markdownFence(JSON.stringify(showrunnerOutput, null, 2), 'json'),
            ''
        );
    }

    return `${lines.join('\n')}\n`;
}

function formatScore(value) {
    return Number.isFinite(value) ? value.toFixed(3) : 'n/a';
}

function formatPass(value) {
    if (value === true) return 'yes';
    if (value === false) return 'no';
    return 'n/a';
}

function fullTextForTable(value) {
    return cleanText(value).replace(/\|/g, '/');
}

function markdownFence(value, language = '') {
    const text = String(value ?? '');
    const fence = text.includes('```') ? '````' : '```';
    return `${fence}${language}\n${text}\n${fence}`;
}

function formatPodcastOutputForReport(output) {
    if (!isPlainObject(output)) {
        return output || null;
    }
    const formatted = { ...output };
    if (formatted.text === formatted.speech) {
        delete formatted.text;
    }
    return formatted;
}

function formatShowrunnerOutputForReport(output) {
    if (!isPlainObject(output)) {
        return output || null;
    }
    const formatted = { ...output };
    delete formatted.avoid;
    return formatted;
}

function toJsonl(records) {
    return records.map((record) => JSON.stringify(record)).join('\n') + '\n';
}

class PromptEvalJudgeGenerator extends PodcastGenerator {
    constructor(options = {}) {
        super({
            ...options,
            apiKey: options.apiKey || process.env.PODCAST_EVAL_JUDGE_API_KEY || process.env.PODCAST_GENERATOR_API_KEY,
            baseUrl: options.baseUrl || process.env.PODCAST_EVAL_JUDGE_BASE_URL || process.env.PODCAST_GENERATOR_BASE_URL,
            model: options.model || process.env.PODCAST_EVAL_JUDGE_MODEL || process.env.PODCAST_GENERATOR_MODEL || 'gpt-4.1-mini',
            maxCompletionTokens: options.maxCompletionTokens || process.env.PODCAST_EVAL_JUDGE_MAX_TOKENS || 600,
            responseFormat: options.responseFormat || process.env.PODCAST_EVAL_JUDGE_RESPONSE_FORMAT || 'json_schema'
        });
        this.schemaName = 'podcast_prompt_eval_judge';
    }

    buildMessages(input = {}) {
        return [
            {
                role: 'system',
                content: [
                    'You evaluate an offline replay of a podcast host model.',
                    'Return only JSON. Score each rubric item from 1 to 5, where 5 is excellent.',
                    'Judge against the ground-truth human host turn and the transcript flow, not generic chat helpfulness.'
                ].join('\n')
            },
            { role: 'user', content: buildJudgePrompt(input) }
        ];
    }

    buildRequestBody(messages, options = {}) {
        const body = super.buildRequestBody(messages, options);
        if (body.response_format?.json_schema) {
            body.response_format.json_schema.name = this.schemaName;
            body.response_format.json_schema.schema = this.getResponseSchema();
        }
        return body;
    }

    getResponseSchema() {
        const scoreDescription = 'Integer score from 1 to 5.';
        return {
            type: 'object',
            additionalProperties: false,
            required: [
                'flowMatch',
                'hostRoleFaithfulness',
                'specificityToTranscript',
                'arcPreservation',
                'moveClassification',
                'overall',
                'rationale'
            ],
            properties: {
                flowMatch: { type: 'integer', minimum: 1, maximum: 5, description: scoreDescription },
                hostRoleFaithfulness: { type: 'integer', minimum: 1, maximum: 5, description: scoreDescription },
                specificityToTranscript: { type: 'integer', minimum: 1, maximum: 5, description: scoreDescription },
                arcPreservation: { type: 'integer', minimum: 1, maximum: 5, description: scoreDescription },
                moveClassification: {
                    type: 'string',
                    description: 'One of opens, bridges, synthesizes, wraps, holds-space, or other.'
                },
                overall: { type: 'integer', minimum: 1, maximum: 5, description: scoreDescription },
                rationale: {
                    type: 'string',
                    description: 'Brief reason for the scores.'
                }
            }
        };
    }

    async generate(input = {}) {
        if (!this.apiKey) {
            throw new Error('Eval judge API key not provided. Set PODCAST_EVAL_JUDGE_API_KEY or PODCAST_GENERATOR_API_KEY.');
        }
        const result = await this.fetchCompletion(this.buildMessages(input), input);
        const content = result.choices?.[0]?.message?.content;
        if (!content) {
            throw new Error('Eval judge returned an empty response.');
        }
        return this.normalizeJudgeOutput(this.parseJsonContent(content, 'Prompt eval judge'));
    }

    normalizeJudgeOutput(output = {}) {
        const score = (value) => {
            const number = Number(value);
            if (!Number.isFinite(number)) return 1;
            return Math.max(1, Math.min(5, Math.round(number)));
        };
        return {
            flowMatch: score(output.flowMatch),
            hostRoleFaithfulness: score(output.hostRoleFaithfulness),
            specificityToTranscript: score(output.specificityToTranscript),
            arcPreservation: score(output.arcPreservation),
            moveClassification: cleanText(output.moveClassification || 'other'),
            overall: score(output.overall),
            rationale: cleanText(output.rationale || '')
        };
    }
}

function buildJudgePrompt({ fixture, checkpoint, transcript, showrunnerOutput, podcastOutput }) {
    return [
        `Episode topic: ${fixture.topic}`,
        '',
        'Transcript before the evaluated host turn:',
        transcript || '(empty)',
        '',
        'Ground-truth human host turn:',
        checkpoint.expectedSpeech,
        '',
        'Generated episode plan controller output:',
        JSON.stringify(showrunnerOutput || null, null, 2),
        '',
        'Generated podcast response:',
        JSON.stringify(podcastOutput || null, null, 2),
        '',
        'Evaluate whether the generated host response would preserve the ground-truth podcast arc. Classify the host move as opens, bridges, synthesizes, wraps, holds-space, or other.'
    ].join('\n');
}

async function runPromptEval(options = {}) {
    const runner = new PromptEvalRunner(options.runnerOptions || {});
    return runner.run(options);
}

function cleanText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function cleanMultiline(value) {
    return String(value || '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .trim();
}

function cleanId(value) {
    const id = cleanText(value)
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return id || 'fixture';
}

function cleanObject(object) {
    const cleaned = {};
    for (const [key, value] of Object.entries(object || {})) {
        if (value === undefined || value === null) {
            continue;
        }
        if (Array.isArray(value)) {
            cleaned[key] = value.map((item) => cleanText(item)).filter(Boolean);
        } else if (typeof value === 'string') {
            cleaned[key] = cleanMultiline(value);
        } else {
            cleaned[key] = value;
        }
    }
    return cleaned;
}

function numericOrNull(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function safeTimestamp(value) {
    return String(value || new Date().toISOString())
        .replace(/[:.]/g, '-')
        .replace(/[^0-9A-Za-z_-]/g, '-');
}

function unique(values) {
    return Array.from(new Set(values.filter(Boolean)));
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function main() {
    const options = parseArgs();
    if (options.help) {
        console.log(usage());
        return;
    }

    const runner = new PromptEvalRunner();
    const result = await runner.run(options);
    console.log(`Prompt eval complete: ${result.runDir}`);
    console.log(`Wrote ${result.promptRecords.length} prompt bundle(s) and ${result.outputRecords.length} output record(s).`);
    if (!options.execute) {
        console.log('No live model calls were made. Re-run with --execute to call configured generators.');
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
}

module.exports = {
    PromptEvalRunner,
    PromptEvalJudgeGenerator,
    buildCheckpointContext,
    buildJudgePrompt,
    buildPodcastInput,
    formatTranscriptPrefix,
    generateReport,
    loadFixture,
    normalizeFixture,
    parseArgs,
    parseCheckpointList,
    runPromptEval,
    scoreDeterministic,
    scoreSpeechContract,
    scoreTextOverlap,
    selectCheckpoints,
    validateFixture
};
