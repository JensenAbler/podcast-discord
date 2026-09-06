const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AudioJournal } = require('./audio-journal');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-recovery-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const journal = new AudioJournal(path.join(root, 'episode-test'), { outputFormat: 'wav' });
    journal.start({ startedAt: 1000 });
    const pcm = Buffer.alloc(48000 * 4);
    for (let i = 0; i < 48000; i++) {
        const sample = Math.round(Math.sin(i * 440 * 2 * Math.PI / 48000) * 8000);
        pcm.writeInt16LE(sample, i * 4);
        pcm.writeInt16LE(sample, i * 4 + 2);
    }
    journal.appendPcm('participant', 'guest', pcm, { capturedAt: 1000, timelineOffsetMs: 0 });
    return { root, journal };
}

test('completion is durable before cleanup, and cleanup failure cannot undo it', async t => {
    const { root, journal } = fixture(t);
    journal.removeDirectoryContents = () => {
        assert.equal(JSON.parse(fs.readFileSync(journal.manifestPath)).status, 'complete');
        throw new Error('simulated cleanup failure');
    };
    const result = await journal.finalize({ stoppedAt: 2000 });
    const before = fs.readFileSync(result.outputPath);
    await AudioJournal.load(journal.outputPath).finalize({ stoppedAt: 3000 });
    assert.deepEqual(await AudioJournal.recoverIncompleteRecordings(root), []);
    assert.deepEqual(fs.readFileSync(result.outputPath), before);
});

test('crash before completion commit retains inputs and can be recovered', async t => {
    const { root, journal } = fixture(t);
    const rename = fs.renameSync;
    fs.renameSync = (source, destination) => {
        if (destination === journal.manifestPath && JSON.parse(fs.readFileSync(source)).status === 'complete') {
            throw new Error('simulated crash before manifest commit');
        }
        return rename(source, destination);
    };
    try {
        await assert.rejects(journal.finalize({ stoppedAt: 2000 }), /simulated crash/);
    } finally {
        fs.renameSync = rename;
    }
    assert.equal(JSON.parse(fs.readFileSync(journal.manifestPath)).status, 'finalizing');
    assert.ok(fs.readdirSync(journal.sourceDir).length);
    const recovered = await AudioJournal.recoverIncompleteRecordings(root);
    assert.equal(recovered.length, 1);
    assert.equal(JSON.parse(fs.readFileSync(journal.manifestPath)).status, 'recovered');
    assert.ok(fs.statSync(recovered[0].outputPath).size > 1000);
});

test('failed render validation leaves previous final audio and journal intact', async t => {
    const { journal } = fixture(t);
    const output = path.join(journal.outputPath, 'mixed-audio.wav');
    fs.writeFileSync(output, 'previous final audio');
    journal.mix = async (_stems, _events, pending) => fs.writeFileSync(pending, 'invalid audio');
    await assert.rejects(journal.finalize({ stoppedAt: 2000 }), /FFmpeg exited/);
    assert.equal(fs.readFileSync(output, 'utf8'), 'previous final audio');
    assert.ok(fs.readdirSync(journal.sourceDir).length);
});
