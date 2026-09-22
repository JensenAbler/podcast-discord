'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Readable } = require('stream');
const { StreamType } = require('@discordjs/voice');
const { contained, hash } = require('./content-assets');
const BYTES_PER_MS = 192; // 48 kHz, stereo, signed 16 bit
const MAX_DURATION_MS = 600000;
function validateCues(cues, durationMs) {
    if (!Array.isArray(cues) || !cues.length) throw new Error('Clip needs curated timed cues');
    let end = 0;
    return cues.map(c => {
        if (!Number.isFinite(c.startMs) || !Number.isFinite(c.endMs) || c.startMs < end || c.endMs <= c.startMs || c.endMs > durationMs + 40 || !String(c.text || '').trim()) throw new Error('Invalid or overlapping clip cue');
        end = c.endMs;
        return { startMs: c.startMs, endMs: c.endMs, text: c.text, speaker: String(c.speaker || 'Prepared audio') };
    });
}
async function decodeAudio(file, signal) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prepared-clip-'));
    const output = path.join(dir, 'audio.pcm');
    try {
        await new Promise((resolve, reject) => {
            if (signal?.aborted) { reject(new Error('Clip cancelled')); return; }
            const ff = spawn('ffmpeg', ['-nostdin','-v','error','-i',file,'-t',String(MAX_DURATION_MS / 1000 + 1),'-f','s16le','-ar','48000','-ac','2',output], { stdio: ['ignore','ignore','pipe'] });
            const abort = () => { ff.kill('SIGKILL'); };
            signal?.addEventListener('abort', abort, { once: true });
            let errors = '';
            ff.stderr.on('data', b => { errors = (errors + b.toString()).slice(-2000); });
            const timer = setTimeout(() => { ff.kill('SIGKILL'); reject(new Error('Clip decoding timed out')); }, 60000);
            ff.once('error', e => { clearTimeout(timer); reject(e); });
            ff.once('close', code => { signal?.removeEventListener('abort', abort); clearTimeout(timer); code === 0 ? resolve() : reject(new Error('Clip decoding failed: ' + errors)); });
        });
        const size = fs.statSync(output).size;
        if (!size || size > MAX_DURATION_MS * BYTES_PER_MS) throw new Error('Clip must be nonempty and at most ten minutes');
        return fs.readFileSync(output);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
class PreparedClipPlayer {
    constructor(bot, guildId, options = {}) {
        this.bot = bot; this.guildId = guildId; this.decode = options.decode || decodeAudio;
        this.cancelled = false; this.done = null; this.started = false; this.abort = new AbortController();
    }
    async play(asset, root) {
        if (this.done) throw new Error('Clip player can only be used once');
        this.done = this.run(asset, root);
        return this.done;
    }
    async run(asset, root) {
        const bot = this.bot, guild = this.guildId, vm = bot.voiceManager;
        const file = contained(root, asset.audioFile);
        let pcm;
        try { pcm = await this.decode(file, this.abort.signal); }
        catch (error) { if (this.cancelled) return { interrupted: true, playedMs: 0 }; throw error; }
        const durationMs = pcm.length / BYTES_PER_MS;
        const cues = validateCues(asset.cues, durationMs);
        if (this.cancelled) return { interrupted: true, playedMs: 0 };
        let resource, startedAt, committedMs = 0, cueIndex = 0, timer, watchdog, started = false, flushError;
        const id = crypto.randomUUID();
        const flush = () => {
            if (!started || !resource) return;
            const playedMs = Math.max(committedMs, Math.min(durationMs, Number(resource.playbackDuration) || 0));
            const from = Math.floor(committedMs * BYTES_PER_MS / 4) * 4;
            const to = Math.floor(playedMs * BYTES_PER_MS / 4) * 4;
            if (to > from) {
                vm.addBotAudioToRecording(guild, pcm.subarray(from, to), {
                    format: 'pcm_s16le', sampleRate: 48000, channels: 2, volume: 1,
                    sourceId: 'clip-' + id, startTime: startedAt + from / BYTES_PER_MS
                });
                committedMs = to / BYTES_PER_MS;
            }
            while (cueIndex < cues.length && cues[cueIndex].endMs <= committedMs) {
                const cue = cues[cueIndex++];
                vm.saveTranscriptEntry(guild, {
                    speaker: cue.speaker, speakerRole: 'clip', transcription: cue.text,
                    source: 'prepared-clip', playbackStatus: 'completed',
                    timestamp: new Date(startedAt + cue.startMs).toISOString(),
                    playbackStartedAt: new Date(startedAt + cue.startMs).toISOString(),
                    playbackEndedAt: new Date(startedAt + cue.endMs).toISOString(),
                    duration: cue.endMs - cue.startMs
                });
                // Ordinary sessions use the same explicit transcript, without STT.
                bot.podcastGenerator.history.push({ role: 'user', content: '[Prepared clip: ' + cue.speaker + '] ' + cue.text });
            }
        };
        const finish = () => {
            clearInterval(timer); clearTimeout(watchdog);
            try { flush(); } catch (error) { flushError ||= error; }
        };
        try {
            const playback = await vm.speakWithTiming(guild, Readable.from([pcm]), {
                inputType: StreamType.Raw, alphaPreview: '', volume: 1,
                beforePlayback: () => !this.cancelled && bot.isRecordingActive(guild),
                onStart: timing => {
                    if (started) return;
                    started = this.started = true;
                    startedAt = Date.parse(timing.playbackStartedAt);
                    resource = vm.transmitters.get(guild).currentResource;
                    bot.noteHostPlaybackStart(guild, timing);
                    timer = setInterval(() => {
                        try { flush(); } catch (error) { flushError ||= error; vm.stopPlayback(guild); }
                    }, 50);
                },
                onFinish: finish,
                onError: finish
            });
            watchdog = setTimeout(() => { this.cancelled = true; vm.stopPlayback(guild); }, durationMs + 30000);
            if (this.cancelled) vm.stopPlayback(guild);
            const timing = await playback.finished;
            finish();
            if (flushError) throw flushError;
            bot.noteHostPlaybackEnd(guild, timing);
            const receipt = { id, title: asset.title || path.basename(file), audioSha256: hash(fs.readFileSync(file)), playedMs: committedMs, durationMs, deliveredCues: cueIndex, totalCues: cues.length, interrupted: this.cancelled || timing.playbackInterrupted || committedMs + 40 < durationMs };
            const dest = vm.recordingPaths.get(guild);
            if (dest) fs.appendFileSync(path.join(dest, 'prepared-clips.jsonl'), JSON.stringify(receipt) + '\n');
            return receipt;
        } catch (error) {
            finish();
            bot.noteHostPlaybackEnd(guild, { playbackEndedAt: new Date().toISOString() });
            const dest = vm.recordingPaths.get(guild);
            if (dest) fs.appendFileSync(path.join(dest, 'prepared-clips.jsonl'), JSON.stringify({ id, title: asset.title || path.basename(file), playedMs: committedMs, durationMs, deliveredCues: cueIndex, totalCues: cues.length, interrupted: true, error: error.message }) + '\n');
            throw error;
        } finally { finish(); }
    }
    stop() { this.cancelled = true; this.abort.abort(); this.bot.voiceManager.stopPlayback(this.guildId); return this.done; }
}
module.exports = { PreparedClipPlayer, validateCues, decodeAudio, BYTES_PER_MS };
