'use strict';
const fs = require('fs');
const path = require('path');
const { SlashCommandBuilder, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { getPodcastRoot } = require('./paths');
const { EvolveSession, validateManifest, hash } = require('./evolve-session');
const { inventory } = require('./evolve-prepare');

function buildEvolveCommand() {
    return new SlashCommandBuilder().setName('reveal').setDescription('Reveal the next full episode transcript to Alpha')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);
}
function assertIdle(bot, guildId) {
    const playback = bot.voiceManager.getPlaybackStatus(guildId);
    if (bot.preparedClips?.has(guildId) || bot.directResponseInFlight?.has(guildId) || bot.idleDecisionInFlight?.has(guildId) || playback.isPlaying || playback.queueLength || bot.hasPendingBigBrain?.(guildId) || bot.hasPendingBigHeart?.(guildId)) throw new Error('Wait for the current response to finish, then use /reveal again. No transcript was advanced.');
}
async function handleEvolveCommand(bot, interaction) {
    const confirming = interaction.isButton?.() === true;
    if (confirming) await interaction.deferUpdate();
    else await interaction.deferReply({ ephemeral: true });
    const guild = interaction.guildId, user = interaction.user.id;
    bot.evolveSessions ||= new Map(); bot.evolveCommandLocks ||= new Set();
    let locked = false;
    try {
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) throw new Error('Manage Server permission is required');
        const member = await interaction.guild.members.fetch(user);
        const self = interaction.guild.members.me || await interaction.guild.members.fetchMe();
        if (!member.voice?.channelId || member.voice.channelId !== self.voice?.channelId) throw new Error('Join the bot’s voice channel first');
        if (bot.evolveCommandLocks.has(guild)) throw new Error('A reveal is already running. No additional transcript was advanced.');
        bot.evolveCommandLocks.add(guild); locked = true;
        bot.conversationBuffer?.setFlushHold?.('evolve-control', true);
        if (!bot.isRecordingActive(guild)) throw new Error('Start the podcast and complete recording consent first');
        if (bot.useGatewayGenerator() || bot.sessionHostModes?.get(guild) === 'gemini-live' || bot.isLiveAlphaSession(guild)) throw new Error('Reveal currently requires the Claude + Fish engine in podcast-join');
        assertIdle(bot, guild);
        let session = bot.evolveSessions.get(guild);
        if (!session) {
            const file = path.join(bot.voiceManager.recordingPaths.get(guild), 'evolve-state.json');
            if (fs.existsSync(file)) session = EvolveSession.resume(file, user);
            else {
                const root = getPodcastRoot();
                const corpus = inventory(root);
                const manifest = validateManifest({ version: 1, title: 'Alpha-Clawd retrospective', episodes: corpus.episodes }, root);
                const timeline = (bot.podcastGenerator.spokenTranscript || []).map(e => ({ speaker: e.speaker, text: e.transcription, at: e.timestamp }));
                session = new EvolveSession(manifest, file, user, timeline);
                session.state.missing = corpus.missing;
                session.save();
            }
            bot.evolveSessions.set(guild, session);
            bot.podcastGenerator.evolveSession = session;
        }
        if (session.state.ownerId !== user) throw new Error('This retrospective is controlled by its original operator');
        const index = session.state.phase === 'predicting' ? session.state.index : session.state.index + 1;
        const episode = session.state.manifest.episodes[index];
        if (!episode) throw new Error('All available transcripts have already been revealed. You can keep talking.');
        const buttonId = 'evolve-reveal:' + hash(session.file).slice(0,16) + ':' + index;
        if (!confirming) {
            return await interaction.editReply({
                content: 'About to reveal **Episode ' + episode.id + ': ' + episode.title + '**.\nAlpha has not received this transcript yet.',
                allowedMentions: { parse: [] },
                components: [new ActionRowBuilder().addComponents(new ButtonBuilder()
                    .setCustomId(buttonId).setLabel('Reveal this episode').setStyle(ButtonStyle.Primary))]
            });
        }
        if (interaction.customId !== buttonId) throw new Error('This preview is out of date. Use /reveal to preview the next episode.');
        const before = JSON.parse(JSON.stringify(session.state));
        let cue;
        try {
            cue = session.revealNext();
            bot.podcastGenerator.buildMessages({ transcript: cue });
            session.save();
        } catch (error) {
            session.state = before;
            throw error;
        }
        const next = session.state.manifest.episodes[session.state.index + 1];
        const missing = session.state.index === 0 && session.state.missing?.length
            ? '\nEpisodes without published transcripts were skipped: ' + session.state.missing.map(e => e.id ?? e.title).join(', ') + '.' : '';
        await interaction.editReply({ components: [], allowedMentions: { parse: [] }, content: 'Revealed: ' + session.current().title + '.'
            + (next ? '\nNext /reveal: ' + next.title + '.' : '\nThat was the last available transcript. You can keep talking.')
            + missing });
        await bot.handleDirectGeneratorFlush(guild, [], cue, null, { evolveControl: true });
    } catch (error) {
        await interaction.editReply({ content: 'Reveal: ' + error.message, components: [], allowedMentions: { parse: [] } });
    } finally {
        if (locked) {
            bot.evolveCommandLocks.delete(guild);
            bot.conversationBuffer?.setFlushHold?.('evolve-control', false);
        }
    }
}
module.exports = { buildEvolveCommand, handleEvolveCommand, assertIdle };
