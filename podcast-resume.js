'use strict';
const fs = require('fs');
const path = require('path');
const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { contained, hash } = require('./content-assets');
const { EpisodePlanTracker } = require('./episode-plan-tracker');
const { validatePlanProgress, resumePlanOptions } = require('./episode-plan-progress');
const { recordingTags } = require('./recording-tags');

function buildResumeCommand() {
    return new SlashCommandBuilder().setName('podcast-resume')
        .setDescription('Resume the conversation and saved showrunner progress')
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
function loadResumeSource(root, recording, ownerId, guildId) {
    if (recording && (!/^episode-[A-Za-z0-9-]+$/.test(recording))) {
        throw new Error('Use an episode recording folder name, not a path');
    }
    const names = recording ? [recording] : fs.readdirSync(root, { withFileTypes: true })
        .filter(e => e.isDirectory() && /^episode-[A-Za-z0-9-]+$/.test(e.name))
        .map(e => e.name).sort().reverse();
    for (const name of names) {
        const dir = path.join(root, name);
        if (!fs.existsSync(path.join(dir, 'episode-complete.json'))) {
            const identityFile = path.join(dir, 'resume-identity.json');
            const identity = fs.existsSync(identityFile) ? JSON.parse(read(root, name + '/resume-identity.json')) : null;
            if (recording || (identity?.ownerId === ownerId && identity?.guildId === guildId)) {
                throw new Error('Latest recording ' + name + ' is not completed yet. Finish or recover it before resuming; an older episode was not selected.');
            }
            continue;
        }
        const metadata = JSON.parse(read(root, name + '/episode-complete.json'));
        const identity = fs.existsSync(path.join(dir, 'resume-identity.json'))
            ? JSON.parse(read(root, name + '/resume-identity.json')) : null;
        if (metadata.guildId !== guildId || identity?.guildId !== guildId || identity?.ownerId !== ownerId) {
            if (recording) throw new Error('Source must belong to this server and its original operator');
            continue;
        }
        if (!metadata.stoppedAt) throw new Error('Source must be completed');
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
        return { recording: name, sourcePath: fs.realpathSync(dir), entries, plan, planProgress, ownerId, guildId,
            planTag: recordingTags(dir).planTag,
            topic: plan?.basename || 'general discussion',
            transcriptSha256: hash(transcriptBytes) };
    }
    throw new Error('No completed resumable recording owned by you was found in this server');
}
function restoreGenerator(generator, source) {
    generator.spokenTranscript = [];
    for (const entry of source.entries) generator.observeSpokenTranscript(entry);
    generator.hasBackchannels = true; // Use the same audible timeline as an uninterrupted session.
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
    // Exclusive writes protect both the published source and any existing target state.
    fs.writeFileSync(path.join(target, 'resume-history.json'), JSON.stringify(source.entries),
        { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(path.join(target, 'resume-source.json'), JSON.stringify({
        version: 1, sourceRecording: source.recording, resumedAt: new Date().toISOString(),
        sourceTranscriptSha256: source.transcriptSha256, inheritedEntries: source.entries.length,
        planProgressRestored: Boolean(source.planProgress)
    }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(path.join(target, 'resume-background.json'), JSON.stringify(source.plan),
        { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(path.join(target, 'resume-identity.json'), JSON.stringify({
        ownerId: source.ownerId, guildId: source.guildId
    }), { flag: 'wx', mode: 0o600 });
    restoreGenerator(generator, source);
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
        // Recovery can exceed Discord's initial interaction deadline.
        if (!interaction.deferred && !interaction.replied) await interaction.deferReply?.();
        await bot.voiceManager.recoveryPromise;
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
    preflightResume, installResume, restoreGenerator };
