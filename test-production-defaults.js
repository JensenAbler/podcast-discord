const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AlphaClawdVoiceBot } = require('./bot');

test('default workflow follows published sequence and latest recording, ignoring draft numbers and directory mtimes', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-defaults-'));
    const keys = ['CLAWCAST_CONTENT_ROOT', 'PODCAST_ROOT', 'PODCAST_CONTENT_ROOT', 'RECORDING_DIR'];
    const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
    const write = (name, value) => {
        const file = path.join(root, name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
    };
    try {
        keys.forEach(k => delete process.env[k]);
        process.env.CLAWCAST_CONTENT_ROOT = root;
        const old = path.join(root, 'recordings/episode-2026-09-12');
        const latest = path.join(root, 'recordings/episode-2026-09-14');
        write('recordings/episode-2026-09-12/episode-metadata.json', { startedAt: '2026-09-12T10:00:00Z' });
        write('recordings/episode-2026-09-14/episode-metadata.json', { startedAt: '2026-09-14T10:00:00Z' });
        fs.utimesSync(old, new Date(), new Date());
        fs.utimesSync(latest, new Date(0), new Date(0));
        write('feed.xml', '<rss><channel><item><enclosure url="https://example.com/episode-10.mp3"/></item></channel></rss>');
        const version = (episode, v, recording, complete = true, filename = 'manifest.json') => {
            const dir = `production/episode-${episode}/${v}`;
            write(`${dir}/${filename}`, { sourceRecording: recording });
            if (complete) write(`${dir}/episode-${episode}-${v}.mp3`, 'fixture');
        };
        version(18, 'v001', old);
        version(11, 'v001', old);
        version(11, 'v002', latest, true, 'source/recording-import.json');
        version(11, 'v003', latest);
        version(11, 'v004', old);
        version(11, 'v005', latest, false);
        const bot = Object.create(AlphaClawdVoiceBot.prototype);
        let calls = [], reply;
        bot.runProductionProcess = async args => { calls.push(args); return { stdout: '', stderr: '' }; };
        const interaction = (options = {}) => ({
            options: { getInteger: k => options[k] ?? null, getString: k => options[k] ?? null, getBoolean: k => options[k] ?? null },
            deferReply: async () => {}, editReply: async r => { reply = r; }, reply: async r => { reply = r; }
        });
        assert.deepEqual(bot.getProductionEpisodeState(), { latestProduced: 18, latestPublished: 10, next: 11 });
        assert.equal(bot.getLatestRecording(), latest);
        await bot.handleProductionCommand(interaction());
        assert.equal(calls[0][calls[0].indexOf('--episode') + 1], '11');
        assert.equal(calls[0][calls[0].indexOf('--recording') + 1], latest);
        assert.ok(calls[0].includes('--skip-finalize'));
        await bot.handlePublishCommand(interaction());
        assert.equal(calls[1][calls[1].indexOf('--episode') + 1], '11');
        assert.equal(calls[1][calls[1].indexOf('--version') + 1], 'v003');
        fs.rmSync(path.join(root, 'production/episode-11/v003'), { recursive: true });
        assert.equal(bot.getDefaultPublishVersion(11), 'v002');
        fs.rmSync(path.join(root, 'production/episode-11/v002'), { recursive: true });
        await bot.handlePublishCommand(interaction());
        assert.equal(calls.length, 2);
        assert.match(reply.content, /latest recording has not been produced as Episode 11/);
        await bot.handlePublishCommand(interaction({ episode: 18, version: 'v001' }));
        assert.equal(calls[2][calls[2].indexOf('--episode') + 1], '18');
        assert.equal(calls[2][calls[2].indexOf('--version') + 1], 'v001');
        await bot.handleProductionCommand(interaction({ episode: 20, recording: old }));
        assert.equal(calls[3][calls[3].indexOf('--episode') + 1], '20');
        assert.equal(calls[3][calls[3].indexOf('--recording') + 1], old);
        await bot.handleProductionCommand(interaction({ append: true, recording: latest }));
        assert.equal(calls.length, 4);
        assert.match(reply.content, /Choose the episode to append/);
        await bot.handleProductionCommand(interaction({ episode: 11, append: true, recording: latest }));
        assert.equal(calls.length, 5);
        assert.ok(calls[4].includes('--append'));
        assert.equal(calls[4][calls[4].indexOf('--recording') + 1], latest);
        write('production/episode-11/v006/manifest.json', { sourceRecording: old, sourceRecordings: [old, latest] });
        write('production/episode-11/v006/episode-11-v006.mp3', 'combined');
        assert.equal(bot.getDefaultPublishVersion(11), 'v006');
        write('feed.xml', '<rss><channel></channel></rss>');
        assert.equal(bot.getProductionEpisodeState().next, 1);
        fs.rmSync(path.join(root, 'recordings'), { recursive: true });
        await bot.handleProductionCommand(interaction());
        assert.equal(calls.length, 5);
        assert.match(reply.content, /No recordings found/);
    } finally {
        for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
        fs.rmSync(root, { recursive: true, force: true });
    }
});
