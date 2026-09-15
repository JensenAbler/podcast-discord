'use strict';
const fs = require('fs');
const path = require('path');
const { SlashCommandBuilder, PermissionFlagsBits, AttachmentBuilder } = require('discord.js');
const { getPodcastRoot } = require('./paths');
const { EvolveSession, validateManifest, contained, atomicJson } = require('./evolve-session');
const { PreparedClipPlayer } = require('./prepared-clip');

function buildEvolveCommand() {
    return new SlashCommandBuilder().setName('podcast-evolve').setDescription('Retrospective interview and prepared audio controls')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addStringOption(o => o.setName('action').setDescription('What to do').setRequired(true).addChoices(
            ...['status','load','resume','next','reveal','reflect','ask','prompt-export','prompt','proposal','clip-import','clip','stop','end'].map(v => ({ name: v, value: v }))))
        .addStringOption(o => o.setName('asset').setDescription('Saved retrospective or clip ID').setMaxLength(80))
        .addAttachmentOption(o => o.setName('manifest').setDescription('Full-transcript retrospective manifest JSON'))
        .addAttachmentOption(o => o.setName('audio').setDescription('Prepared audio for clip-import (up to 100 MB, ten minutes)'))
        .addAttachmentOption(o => o.setName('cues').setDescription('Curated timed transcript JSON for clip-import'));
}
function assetId(value) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value || '')) throw new Error('Use an asset ID containing letters, numbers, hyphens, or underscores');
    return value;
}
async function attachmentBytes(attachment, limit) {
    if (!attachment) throw new Error('Required attachment is missing');
    if (attachment.size > limit) throw new Error('Attachment is too large');
    const u = new URL(attachment.url);
    if (u.protocol !== 'https:' || !['cdn.discordapp.com','media.discordapp.net'].includes(u.hostname)) throw new Error('Use a Discord attachment');
    const response = await fetch(u, { signal: AbortSignal.timeout(60000), redirect: 'error' });
    if (!response.ok) throw new Error('Attachment download failed: HTTP ' + response.status);
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
        size += chunk.length;
        if (size > limit) throw new Error('Attachment exceeds size limit');
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}
function assertReady(bot, guildId) {
    if (!bot.isRecordingActive(guildId)) throw new Error('Join and complete recording consent first');
    if (bot.useGatewayGenerator() || bot.sessionHostModes?.get(guildId) === 'gemini-live' || bot.isLiveAlphaSession(guildId)) throw new Error('Evolve currently uses the Claude + Fish engine; choose that in podcast-join');
}
function assertIdle(bot, guildId) {
    const playback = bot.voiceManager.getPlaybackStatus(guildId);
    if (bot.preparedClips?.has(guildId) || bot.directResponseInFlight?.has(guildId) || bot.idleDecisionInFlight?.has(guildId) || playback.isPlaying || playback.queueLength || bot.hasPendingBigBrain?.(guildId) || bot.hasPendingBigHeart?.(guildId)) throw new Error('Wait for the current response or clip to finish');
}
async function handleEvolveCommand(bot, interaction) {
    await interaction.deferReply({ ephemeral: true });
    const guild = interaction.guildId, user = interaction.user.id;
    bot.evolveSessions ||= new Map(); bot.preparedClips ||= new Map(); bot.evolveCommandLocks ||= new Set();
    const action = interaction.options.getString('action');
    let locked = false;
    try {
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) throw new Error('Manage Server permission is required for production controls');
        const root = getPodcastRoot();
        let session = bot.evolveSessions.get(guild);
        if (session && session.state.ownerId !== user && action !== 'stop' && action !== 'status') throw new Error('This retrospective is controlled by its original operator');
        if (action === 'status') {
            const dir = path.join(root, 'evolve');
            const ids = fs.existsSync(dir) ? fs.readdirSync(dir).filter(x => x.endsWith('.json')).map(x => x.slice(0,-5)) : [];
            return await interaction.editReply(JSON.stringify(session?.status() || { active: false, savedRetrospectives: ids }, null, 2));
        }
        const member = await interaction.guild.members.fetch(user);
        const self = interaction.guild.members.me || await interaction.guild.members.fetchMe();
        if (!member.voice?.channelId || member.voice.channelId !== self.voice?.channelId) throw new Error('Join the bot’s voice channel to operate the session');
        if (action === 'stop') {
            const player = bot.preparedClips.get(guild);
            if (player) await player.stop();
            return await interaction.editReply(player ? 'Clip stopped. Only completed transcript cues were delivered.' : 'No prepared clip is playing.');
        }
        if (bot.evolveCommandLocks.has(guild)) throw new Error('Another Evolve control is still running');
        bot.evolveCommandLocks.add(guild); locked = true;
        bot.conversationBuffer?.setFlushHold?.('evolve-control', true);
        assertReady(bot, guild);
        assertIdle(bot, guild);
        const recordingPath = bot.voiceManager.recordingPaths.get(guild);
        if (action === 'load' || action === 'resume') {
            if (session) throw new Error('A retrospective is already loaded');
            const stateFile = path.join(recordingPath, 'evolve-state.json');
            if (action === 'resume') {
                const sourceId = interaction.options.getString('asset');
                const source = sourceId ? contained(root, 'recordings/' + assetId(sourceId) + '/evolve-state.json') : stateFile;
                session = EvolveSession.resume(source, user);
                if (source !== stateFile) {
                    if (fs.existsSync(stateFile)) throw new Error('Current recording already contains an Evolve state');
                    session.file = stateFile;
                    session.state.timeline.push(...bot.podcastGenerator.spokenTranscript.map(e => ({ speaker: e.speaker, text: e.transcription, at: e.timestamp })));
                    session.event('resumed', { sourceRecording: sourceId });
                }
            }
            else {
                const attachment = interaction.options.getAttachment('manifest');
                const data = attachment ? JSON.parse((await attachmentBytes(attachment, 8 * 1024 * 1024)).toString('utf8'))
                    : JSON.parse(fs.readFileSync(contained(root, 'evolve/' + assetId(interaction.options.getString('asset')) + '.json'), 'utf8'));
                const manifest = validateManifest(data, root);
                // Reserve prompt, live conversation, schema and response capacity.
                const estimate = Math.ceil(manifest.episodes.reduce((n,e) => n + e.transcript.length, 0) / 3) + 30000;
                if (estimate > manifest.contextLimit) throw new Error('Full corpus plus headroom exceeds the configured context limit. Reduce the episode set; transcripts will not be summarized');
                const timeline = bot.podcastGenerator.spokenTranscript.map(e => ({ speaker: e.speaker, text: e.transcription, at: e.timestamp }));
                session = new EvolveSession(manifest, stateFile, user, timeline);
                session.state.applicationPromptAtLoad = bot.podcastGenerator.buildSystemPrompt();
                session.state.modelAtLoad = bot.podcastGenerator.model;
                session.save();
            }
            bot.evolveSessions.set(guild, session);
            bot.podcastGenerator.evolveSession = session;
            await interaction.editReply('Retrospective loaded. Jensen is interviewing Alpha. Use next for the first title; transcripts remain hidden until reveal.');
            return;
        }
        if (action === 'prompt-export') {
            const file = path.join(recordingPath, 'evolve-system-prompt.txt');
            fs.writeFileSync(file, bot.podcastGenerator.buildSystemPrompt());
            return await interaction.editReply({ content: 'Current application prompt exported. Alpha has not been told about the planned prompt stage.', files: [new AttachmentBuilder(file)] });
        }
        if (action === 'clip-import') {
            const id = assetId(interaction.options.getString('asset'));
            const dir = path.join(root, 'evolve', 'clips', id);
            if (fs.existsSync(dir)) throw new Error('Clip ID already exists; choose a new ID');
            const cuesData = JSON.parse((await attachmentBytes(interaction.options.getAttachment('cues'), 2 * 1024 * 1024)).toString('utf8'));
            const audio = await attachmentBytes(interaction.options.getAttachment('audio'), 100 * 1024 * 1024);
            const { decodeAudio, validateCues } = require('./prepared-clip');
            fs.mkdirSync(dir, { recursive: true });
            try {
                fs.writeFileSync(path.join(dir, 'audio.bin'), audio);
                const pcm = await decodeAudio(path.join(dir, 'audio.bin'));
                const cues = validateCues(Array.isArray(cuesData) ? cuesData : cuesData.cues, pcm.length / 192);
                atomicJson(path.join(dir, 'clip.json'), { title: cuesData.title || id, audioFile: 'evolve/clips/' + id + '/audio.bin', cues });
            } catch (e) { fs.rmSync(dir, { recursive: true, force: true }); throw e; }
            await interaction.editReply('Clip imported as ' + id + '. Use clip with this asset ID to play it.');
            return;
        }
        if (action === 'clip') {
            const id = assetId(interaction.options.getString('asset'));
            const clip = JSON.parse(fs.readFileSync(contained(root, 'evolve/clips/' + id + '/clip.json'), 'utf8'));
            const player = new PreparedClipPlayer(bot, guild);
            bot.preparedClips.set(guild, player);
            bot.conversationBuffer?.setFlushHold?.('prepared-clip', true);
            try {
                await interaction.editReply('Playing prepared clip: ' + (clip.title || id));
                const receipt = await player.play(clip, root);
                await interaction.editReply((receipt.interrupted ? 'Clip interrupted' : 'Clip finished') + '. Delivered ' + (receipt.deliveredCues || 0) + ' completed transcript cues.');
            } finally {
                bot.preparedClips.delete(guild);
                bot.conversationBuffer?.setFlushHold?.('prepared-clip', false);
            }
            return;
        }
        if (!session) throw new Error('Load a retrospective first');
        let cue;
        if (action === 'next') cue = session.next();
        else if (action === 'reveal') cue = session.reveal();
        else if (action === 'reflect') {
            session.reflect();
            return await interaction.editReply('Reflection preserved verbatim. Continue the conversation, or use next.');
        } else if (action === 'prompt') {
            const prompt = bot.podcastGenerator.buildSystemPrompt();
            cue = session.prompt(prompt);
            fs.writeFileSync(path.join(recordingPath, 'evolve-system-prompt.txt'), prompt);
        } else if (action === 'proposal') {
            const proposal = session.proposal();
            const file = path.join(recordingPath, 'evolve-proposal.json');
            atomicJson(file, { promptSha256: require('./evolve-session').hash(session.state.prompt), statements: proposal });
            return await interaction.editReply({ content: 'Alpha’s statements preserved verbatim for implementation review.', files: [new AttachmentBuilder(file)] });
        } else if (action === 'end') {
            session.end(); bot.evolveSessions.delete(guild); bot.podcastGenerator.evolveSession = null;
            return await interaction.editReply('Retrospective ended and saved. The podcast recording continues.');
        } else if (action === 'ask') {
            cue = session.state.lastCue;
            if (!cue) throw new Error('No previous stage cue to repeat');
        } else throw new Error('Unknown action');
        session.state.lastCue = cue; session.save();
        bot.podcastGenerator.buildMessages({ transcript: cue }); // fail visibly before attempting a provider request
        await interaction.editReply({ content: 'Stage: ' + session.state.phase + '. Asking Alpha now. If interrupted, continue by voice or use ask.',
            ...(action === 'prompt' ? { files: [new AttachmentBuilder(path.join(recordingPath, 'evolve-system-prompt.txt'))] } : {}) });
        await bot.handleDirectGeneratorFlush(guild, [], cue, null, { evolveControl: true });
    } catch (error) {
        await interaction.editReply('Evolve: ' + error.message);
    } finally {
        if (locked) {
            bot.evolveCommandLocks.delete(guild);
            bot.conversationBuffer?.setFlushHold?.('evolve-control', false);
        }
    }
}
module.exports = { buildEvolveCommand, handleEvolveCommand, assertIdle, attachmentBytes };
