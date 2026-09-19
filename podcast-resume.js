'use strict';
const fs = require('fs');
const path = require('path');
const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { EvolveSession, contained, hash } = require('./evolve-session');
const { EpisodePlanTracker } = require('./episode-plan-tracker');
const { validatePlanProgress, resumePlanOptions } = require('./episode-plan-progress');
const { recordingTags } = require('./recording-tags');

function buildResumeCommand() {
    return new SlashCommandBuilder().setName('podcast-resume')
        .setDescription('Start a new episode with a previous episode’s conversation and saved plan progress')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addStringOption(option => option.setName('recording')
            .setDescription('Source recording folder; defaults to your latest completed resumable episode'));
}
function read(root, name) { return fs.readFileSync(contained(root, name), 'utf8'); }
function audible(entry) {
    return entry.admission?.status !== 'candidate' &&
        !['failed', 'not_started'].includes(entry.playbackStatus) &&
        Boolean(String(entry.transcription || entry.text || '').trim());
}
function sessionFrom(state, file = null) {
    return Object.assign(Object.create(EvolveSession.prototype), {
        state: structuredClone(state), file
    });
}
function loadResumeSource(root, recording, ownerId, guildId) {
    if (recording && (!/^episode-[A-Za-z0-9-]+$/.test(recording))) {
        throw new Error('Use an episode recording folder name, not a path');
    }
    const names = recording ? [recording] : fs.readdirSync(root, { withFileTypes: true })
        .filter(e => e.isDirectory() && /^episode-[A-Za-z0-9-]+$/.test(e.name))
        .map(e => e.name).sort().reverse();
    for (const name of names) {
        const dir = path.join(root, name);
        if (!fs.existsSync(path.join(dir, 'episode-complete.json')) ||
            (!fs.existsSync(path.join(dir, 'evolve-state.json')) &&
             !fs.existsSync(path.join(dir, 'episode-plan-state.json')))) {
            if (recording) throw new Error('Source must be a completed resumable recording');
            continue;
        }
        const metadata = JSON.parse(read(root, name + '/episode-complete.json'));
        const stateBytes = fs.existsSync(path.join(dir, 'evolve-state.json'))
            ? read(root, name + '/evolve-state.json') : null;
        const state = stateBytes ? JSON.parse(stateBytes) : null;
        const identity = fs.existsSync(path.join(dir, 'resume-identity.json'))
            ? JSON.parse(read(root, name + '/resume-identity.json')) : null;
        if (metadata.guildId !== guildId || (state?.ownerId || identity?.ownerId) !== ownerId) {
            if (recording) throw new Error('Source must belong to this server and its original operator');
            continue;
        }
        if (!metadata.stoppedAt) throw new Error('Source must be completed');
        if (state && (state.version !== 1 || !state.manifest?.episodes?.length ||
            !Array.isArray(state.timeline) || !Array.isArray(state.events) ||
            !Number.isInteger(state.index) || state.index < -1 || state.index >= state.manifest.episodes.length ||
            !['ready', 'predicting', 'reflecting', 'reflected', 'prompt'].includes(state.phase) ||
            !Number.isFinite(state.manifest.contextLimit))) {
            throw new Error('Invalid saved retrospective state in ' + name);
        }
        for (const episode of state?.manifest.episodes || []) {
            if (typeof episode.transcript !== 'string' || hash(episode.transcript) !== episode.sha256) {
                throw new Error('Saved transcript integrity check failed in ' + name);
            }
        }
        const transcriptBytes = read(root, name + '/transcript.jsonl');
        const previous = fs.existsSync(path.join(dir, 'resume-history.json'))
            ? JSON.parse(read(root, name + '/resume-history.json')) : [];
        if (!Array.isArray(previous)) throw new Error('Invalid inherited conversation history');
        const entries = [...previous, ...transcriptBytes.split('\n').filter(s => s.trim()).map(s => JSON.parse(s))]
            .filter(audible);
        const plan = fs.existsSync(path.join(dir, 'episode-plan.json'))
            ? JSON.parse(read(root, name + '/episode-plan.json'))
            : fs.existsSync(path.join(dir, 'resume-background.json'))
                ? JSON.parse(read(root, name + '/resume-background.json')) : null;
        const planProgress = fs.existsSync(path.join(dir, 'episode-plan-state.json'))
            ? validatePlanProgress(JSON.parse(read(root, name + '/episode-plan-state.json')), plan) : null;
        // Snapshot is pinned during consent. No source files are ever opened for writing.
        return { recording: name, sourcePath: fs.realpathSync(dir), state, entries, plan, planProgress, ownerId, guildId,
            planTag: recordingTags(dir).planTag,
            topic: state?.manifest.title || plan?.basename || 'continued conversation',
            stateSha256: stateBytes ? hash(stateBytes) : null, transcriptSha256: hash(transcriptBytes),
            contextSha256: state ? hash(sessionFrom(state).context()) : null };
    }
    throw new Error('No completed resumable recording owned by you was found in this server');
}
function continuationContext(source) {
    return 'This is a new recorded episode continuing our prior conversation. The inherited conversation is prior experience, not speech recorded in this episode. ' +
        'Continue from where the conversation ended; do not replay the opening or repeat completed activities. ' +
        'Jensen will guide the continuation.' +
        (source.planProgress
            ? '\nThe active episode plan and saved progress are restored in the current episode structure. Continue from that state.'
            : source.plan ? '\nPrior episode plan, retained as historical background (this older recording has no saved tracker progress):\n' + JSON.stringify(source.plan) : '');
}
function restoreGenerator(generator, source, file = null) {
    // Attach the copied retrospective only AFTER seeding speech: observe would otherwise duplicate its timeline.
    generator.evolveSession = null;
    generator.spokenTranscript = [];
    for (const entry of source.entries) generator.observeSpokenTranscript(entry);
    generator.hasBackchannels = true; // Always include the inherited audible conversation.
    generator.evolveSession = source.state ? sessionFrom(source.state, file) : null;
    generator.continuationContext = continuationContext(source);
}
function preflightResume(generator, source, speakers = []) {
    const probe = Object.assign(Object.create(Object.getPrototypeOf(generator)), generator);
    probe.startSession({ topic: source.topic, recording: true, speakers });
    restoreGenerator(probe, source);
    const tracker = source.planProgress ? new EpisodePlanTracker(source.plan,
        resumePlanOptions(source.planProgress, source.plan)) : null;
    probe.buildMessages({ episodePlanStructure: tracker?.getStructureBlock() || '' });
}
function installResume(generator, source, destination) {
    const target = fs.realpathSync(destination);
    if (target === source.sourcePath) throw new Error('Resume requires a new recording directory');
    const file = path.join(target, 'evolve-state.json');
    // Exclusive writes protect both the published source and any existing target state.
    if (source.state) fs.writeFileSync(file, JSON.stringify(source.state, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(path.join(target, 'resume-history.json'), JSON.stringify(source.entries),
        { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(path.join(target, 'resume-source.json'), JSON.stringify({
        version: 1, sourceRecording: source.recording, resumedAt: new Date().toISOString(),
        sourceStateSha256: source.stateSha256, sourceTranscriptSha256: source.transcriptSha256,
        restoredContextSha256: source.contextSha256, inheritedEntries: source.entries.length,
        planProgressRestored: Boolean(source.planProgress)
    }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(path.join(target, 'resume-background.json'), JSON.stringify(source.plan),
        { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(path.join(target, 'resume-identity.json'), JSON.stringify({
        ownerId: source.ownerId, guildId: source.guildId
    }), { flag: 'wx', mode: 0o600 });
    restoreGenerator(generator, source, file);
    return generator.evolveSession;
}
async function handleResumeCommand(bot, interaction) {
    try {
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
            throw new Error('Manage Server permission is required');
        }
        if (!interaction.member?.voice?.channel) throw new Error('Join a voice channel first');
        if (bot.useGatewayGenerator()) throw new Error('Resume requires the direct Claude + Fish generator');
        if (bot.podcastJoinPending || [...bot.recordingState.values()].some(s =>
            s && s !== bot.RecordingState.IDLE) || bot.voiceManager.isConnected(interaction.guildId)) {
            throw new Error('Finish the current session with /podcast-leave before starting a new episode');
        }
        const source = loadResumeSource(bot.voiceManager.options.recordingDir,
            interaction.options.getString('recording'), interaction.user.id, interaction.guildId);
        preflightResume(bot.podcastGenerator, source,
            Object.values(bot.speakerMap).map(s => s.name + ' (' + (s.role || 'speaker') + ')'));
        return await bot.handleJoinCommand(interaction, source);
    } catch (error) {
        const payload = { content: 'Cannot resume: ' + error.message, allowedMentions: { parse: [] } };
        if (interaction.deferred || interaction.replied) return interaction.editReply(payload);
        return interaction.reply({ ...payload, ephemeral: true });
    }
}
module.exports = { buildResumeCommand, handleResumeCommand, loadResumeSource,
    preflightResume, installResume, restoreGenerator, continuationContext };
