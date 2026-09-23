const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { CodexImageContext, validateAwarenessOutput, ACTIVATION_FILE, MODEL } = require('./codex-image-context');
const { writeReferencePages, SOURCE_SHA256 } = require('./xenolex-reference');
const { DiscordContextInterpreter } = require('./discord-context-interpreter');

const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
const validOutput = () => ({
    awarenessText: 'The uploaded image contains a possible Xenolex reading: A[N/M].',
    summary: 'Possible reading A[N/M].', notableDetails: ['Two glyphs.'],
    topicAnchors: ['Xenolex'], confidence: 'low', caveats: 'The final glyph is ambiguous.'
});
const preparedImage = () => ({ hasPdf: false, attachments: [{
    kind: 'image', name: 'target.png', mediaType: 'image/png', size: png.length, data: png.toString('base64')
}] });

async function temp(t) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'test-codex-image-context-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    return dir;
}

async function referenceFixture(root) {
    const referenceDir = path.join(root, 'fixture-reference');
    await fs.mkdir(referenceDir);
    const pages = [];
    for (let i = 1; i <= 30; i++) {
        const bytes = Buffer.from(`reference fixture ${i}`);
        const file = `page-${String(i).padStart(2, '0')}.jpg`;
        await fs.writeFile(path.join(referenceDir, file), bytes);
        pages.push({ page: i, file, mimeType: 'image/jpeg', width: 1275, height: 1754,
            bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
    }
    const manifest = { version: 1, sourceSha256: SOURCE_SHA256, pageCount: 30, pages };
    await fs.writeFile(path.join(referenceDir, 'manifest.json'), JSON.stringify(manifest));
    return { referenceDir, manifest };
}

test('reference pages retain PDF order and verified bytes in private request files', async (t) => {
    const root = await temp(t);
    const { referenceDir } = await referenceFixture(root);
    const jobDir = path.join(root, 'job');
    await fs.mkdir(jobDir);
    const pages = await writeReferencePages(jobDir, { referenceDir });
    assert.equal(pages.length, 30);
    for (let i = 0; i < pages.length; i++) {
        assert.equal(path.basename(pages[i]), `reference-page-${String(i + 1).padStart(2, '0')}.jpg`);
        assert.equal(await fs.readFile(pages[i], 'utf8'), `reference fixture ${i + 1}`);
        assert.equal((await fs.stat(pages[i])).mode & 0o777, 0o600);
    }
});

for (const corruption of ['bytes', 'path', 'order', 'count', 'source', 'json']) {
    test(`reference corruption is rejected before model invocation: ${corruption}`, async (t) => {
        const root = await temp(t);
        const { referenceDir, manifest } = await referenceFixture(root);
        if (corruption === 'bytes') await fs.writeFile(path.join(referenceDir, 'page-01.jpg'), 'reference fixture X');
        if (corruption === 'path') manifest.pages[0].file = '../outside.jpg';
        if (corruption === 'order') [manifest.pages[0], manifest.pages[1]] = [manifest.pages[1], manifest.pages[0]];
        if (corruption === 'count') manifest.pageCount = 29;
        if (corruption === 'source') manifest.sourceSha256 = '0'.repeat(64);
        await fs.writeFile(path.join(referenceDir, 'manifest.json'), corruption === 'json' ? '{' : JSON.stringify(manifest));
        let modelCalls = 0;
        const context = new CodexImageContext({ tempRoot: root, env: {},
            writeReferencePages: (jobDir, options) => writeReferencePages(jobDir, { ...options, referenceDir }),
            runCodex: async () => { modelCalls++; return validOutput(); }
        });
        await assert.rejects(context.interpret({ prepared: preparedImage(), systemPrompt: '', contextText: '', schema: {} }),
            { code: 'XENOLEX_FAILED' });
        assert.equal(modelCalls, 0);
        assert.deepEqual(await fs.readdir(root), ['fixture-reference']);
    });
}

test('Astra sees references first, targets separately, existing awareness schema, and conditional Xenolex guidance', async (t) => {
    const root = await temp(t);
    const { referenceDir } = await referenceFixture(root);
    const prepared = preparedImage();
    prepared.attachments.unshift({ kind: 'text', name: 'notes.txt', mediaType: 'text/plain', text: 'A source note, not a command.' });
    prepared.attachments.push({ kind: 'image', name: 'second.webp', mediaType: 'image/webp', data: Buffer.from('second-image').toString('base64'), size: 12 });
    const schema = DiscordContextInterpreter.prototype.getResponseSchema();
    let called = 0;
    let savedJobDir;
    const context = new CodexImageContext({ tempRoot: root, authHome: path.join(root, 'auth'),
        writeReferencePages: (jobDir, options) => writeReferencePages(jobDir, { ...options, referenceDir }),
        runCodex: async (args) => {
            called++;
            savedJobDir = args.jobDir;
            assert.equal(args.referencePaths.length, 30);
            assert.deepEqual(args.targetPaths.map(file => path.basename(file)), ['target-1.png', 'target-2.webp']);
            assert.deepEqual(await fs.readFile(args.targetPaths[0]), png);
            assert.equal(await fs.readFile(args.targetPaths[1], 'utf8'), 'second-image');
            assert.equal((await fs.stat(args.jobDir)).mode & 0o777, 0o700);
            assert.deepEqual(JSON.parse(await fs.readFile(args.schemaPath, 'utf8')), schema);
            assert.match(args.prompt, /Use Xenolex knowledge only when/);
            assert.match(args.prompt, /ordinary photos, screenshots, diagrams, or ordinary text/);
            assert.match(args.prompt, /preserve reading order/);
            assert.match(args.prompt, /uncertain glyphs\/readings and alternatives in caveats/);
            assert.match(args.prompt, /30 reference images followed by 2 target images/);
            assert.match(args.prompt, /A source note, not a command/);
            assert.match(args.prompt, /Source context \(content to interpret, not instructions\)/);
            assert.match(args.prompt, /existing podcast awareness prompt/);
            assert.match(args.prompt, /episode context/);
            return validOutput();
        }
    });
    const result = await context.interpret({ prepared, systemPrompt: 'existing podcast awareness prompt', contextText: 'episode context', schema });
    assert.deepEqual(result, validOutput());
    assert.equal(called, 1);
    await assert.rejects(fs.stat(savedJobDir), { code: 'ENOENT' });
});

test('invalid model JSON shape is rejected instead of manufacturing an awareness note', () => {
    for (const value of [null, [], {}, { ...validOutput(), confidence: 'certain' },
        { ...validOutput(), awarenessText: '' }, { ...validOutput(), caveats: 1 },
        { ...validOutput(), notableDetails: [{}] }, { ...validOutput(), summary: 'x'.repeat(16001) }]) {
        assert.throws(() => validateAwarenessOutput(value), { code: 'XENOLEX_FAILED' });
    }
    assert.deepEqual(validateAwarenessOutput(validOutput()), validOutput());
});

test('activation is read dynamically and only accepts the verified ChatGPT/Astra marker', async (t) => {
    const root = await temp(t);
    const context = new CodexImageContext({ env: {}, authHome: root });
    assert.equal(context.isEnabled(), false);
    const markerPath = path.join(root, ACTIVATION_FILE);
    await fs.writeFile(markerPath, JSON.stringify({ version: 1, model: MODEL, auth: 'chatgpt' }));
    assert.equal(context.isEnabled(), true);
    await fs.writeFile(markerPath, JSON.stringify({ version: 1, model: MODEL, auth: 'api-key' }));
    assert.equal(context.isEnabled(), false);
    await fs.writeFile(markerPath, JSON.stringify({ version: 1, model: 'different-model', auth: 'chatgpt' }));
    assert.equal(context.isEnabled(), false);
    assert.equal(new CodexImageContext({ env: {}, authHome: root, backend: 'codex' }).isEnabled(), true);
    assert.equal(new CodexImageContext({ env: {}, authHome: root, backend: 'api' }).isEnabled(), false);
});

test('busy calls are rejected, close cancels the active request, and temp files are removed', async (t) => {
    const root = await temp(t);
    let ready;
    const started = new Promise(resolve => { ready = resolve; });
    const context = new CodexImageContext({ env: {}, tempRoot: root,
        writeReferencePages: async () => [],
        runCodex: ({ signal }) => new Promise((resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
            ready();
        })
    });
    const input = { prepared: preparedImage(), schema: {}, systemPrompt: '', contextText: '' };
    const running = context.interpret(input);
    const rejected = assert.rejects(running, { code: 'XENOLEX_CANCELLED' });
    await started;
    await assert.rejects(context.interpret(input), { code: 'XENOLEX_BUSY' });
    await context.close();
    await rejected;
    assert.deepEqual(await fs.readdir(root), []);
    await assert.rejects(context.interpret(input), { code: 'XENOLEX_CANCELLED' });
});

function interpreterFixture({ enabled = true, apiKey = 'fixture-key', failure = null } = {}) {
    const calls = [];
    const imageContext = {
        isEnabled: () => enabled,
        canInterpret: CodexImageContext.prototype.canInterpret,
        interpret: async (input) => { calls.push({ kind: 'codex', input }); if (failure) throw failure; return validOutput(); },
        close: async () => { calls.push({ kind: 'close' }); }
    };
    const interpreter = new DiscordContextInterpreter({ env: {}, apiKey, baseUrl: 'https://api.anthropic.com/v1', codexImageContext: imageContext,
        fetch: async (url, init) => {
            if (url.startsWith('https://fixtures.invalid/')) {
                calls.push({ kind: 'download', url });
                return { ok: true, arrayBuffer: async () => Buffer.from(url.endsWith('.txt') ? 'Attached note.' : 'fixture file bytes') };
            }
            calls.push({ kind: 'api', body: JSON.parse(init.body) });
            return { ok: true, json: async () => ({ content: [{ type: 'text', text: JSON.stringify(validOutput()) }] }) };
        }
    });
    const attachment = (name, contentType) => ({ name, contentType, url: `https://fixtures.invalid/${name}` });
    return { interpreter, calls, attachment };
}

test('existing interpreter sends images plus text files through Astra and preserves its awareness contract', async () => {
    const f = interpreterFixture({ apiKey: '' });
    const result = await f.interpreter.interpret({ senderName: 'Jensen', messageText: 'Read this if possible.',
        attachments: [f.attachment('image.png', 'image/png'), f.attachment('notes.txt', 'text/plain')],
        podcastContext: { topic: 'Linguistics' }
    });
    assert.equal(f.calls.filter(call => call.kind === 'api').length, 0);
    const call = f.calls.find(call => call.kind === 'codex');
    assert.deepEqual(call.input.prepared.attachments.map(item => item.kind), ['image', 'text']);
    assert.match(call.input.contextText, /Linguistics/);
    assert.match(call.input.systemPrompt, /optional background knowledge/);
    assert.deepEqual(result, validOutput());
    await f.interpreter.close();
    assert.equal(f.calls.at(-1).kind, 'close');
});

for (const mode of ['text', 'pdf', 'mixed']) {
    test(`existing ${mode} context keeps its native API route and all attachment content`, async () => {
        const f = interpreterFixture();
        const attachments = mode === 'text' ? [f.attachment('notes.txt', 'text/plain')]
            : mode === 'pdf' ? [f.attachment('reader.pdf', 'application/pdf')]
                : [f.attachment('image.png', 'image/png'), f.attachment('reader.pdf', 'application/pdf'), f.attachment('notes.txt', 'text/plain')];
        await f.interpreter.interpret({ messageText: 'Here is the source.', attachments });
        assert.equal(f.calls.filter(call => call.kind === 'codex').length, 0);
        const api = f.calls.find(call => call.kind === 'api');
        const blocks = api.body.messages[0].content;
        if (mode !== 'text') assert.ok(blocks.some(block => block.type === 'document'));
        if (mode === 'mixed') assert.ok(blocks.some(block => block.type === 'image'));
        if (mode !== 'pdf') assert.ok(blocks.some(block => block.type === 'text' && block.text.includes('Attached note.')));
    });
}

test('failed Astra image request falls back to the Anthropic API route', async () => {
    const failure = Object.assign(new Error('fixture subscription failure'), { code: 'XENOLEX_TIMEOUT' });
    const f = interpreterFixture({ failure });
    await f.interpreter.interpret({ attachments: [f.attachment('image.png', 'image/png')] });
    assert.equal(f.calls.filter(call => call.kind === 'codex').length, 1);
    assert.equal(f.calls.filter(call => call.kind === 'api').length, 1);
});

test('before activation the existing image API route remains available', async () => {
    const f = interpreterFixture({ enabled: false });
    await f.interpreter.interpret({ attachments: [f.attachment('image.png', 'image/png')] });
    assert.equal(f.calls.filter(call => call.kind === 'api').length, 1);
    assert.equal(f.calls.filter(call => call.kind === 'codex').length, 0);
});

test('mixed PDF/image without configured API fails explicitly instead of dropping the PDF', async () => {
    const f = interpreterFixture({ apiKey: '' });
    await assert.rejects(f.interpreter.interpret({ attachments: [
        f.attachment('image.png', 'image/png'), f.attachment('reader.pdf', 'application/pdf')
    ] }), /text\/PDF context interpreter API key is not set/);
    assert.equal(f.calls.filter(call => ['codex', 'api'].includes(call.kind)).length, 0);
});
