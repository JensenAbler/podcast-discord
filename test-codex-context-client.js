'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createCodexClient, childEnvironment, makeExecArgs } = require('./codex-context-client');

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-context-test-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const jobDir = path.join(root, 'job'), authHome = path.join(root, 'auth');
    await fs.mkdir(jobDir); await fs.mkdir(authHome);
    const targetPath = path.join(jobDir, 'target.png'), schemaPath = path.join(jobDir, 'schema.json');
    await fs.writeFile(targetPath, 'fixture'); await fs.writeFile(schemaPath, '{}');
    return { jobDir, authHome, targetPaths: [targetPath], referencePaths: [], schemaPath, prompt: 'Decode.' };
}

function fakeClient({ auth = 'Logged in using ChatGPT', servers = [], exec, version = 'codex-cli 0.154.0', hangStage } = {}) {
    const calls = [], signals = [];
    const client = createCodexClient({
        resolveCli: () => '/fixture/codex.js', killGraceMs: 5,
        killGroup: (child, signal) => {
            signals.push(signal);
            if (signal === 'SIGKILL') setImmediate(() => child.emit('close', null, signal));
        },
        spawnImpl: (command, args, options) => {
            const child = new EventEmitter();
            child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
            child.pid = 12345;
            calls.push({ command, args, options });
            setImmediate(async () => {
                const stage = args.includes('--version') ? 'version' : args.includes('mcp') ? 'mcp' : args.includes('login') ? 'auth' : 'exec';
                if (hangStage === stage) return;
                try {
                    if (stage === 'version') child.stdout.write(version + '\n');
                    else if (stage === 'mcp') child.stdout.write(JSON.stringify(servers));
                    else if (stage === 'auth') child.stderr.write(auth + '\n');
                    else if (exec) { await exec(child, args, options); return; }
                    else {
                        await fs.writeFile(args[args.indexOf('--output-last-message') + 1], JSON.stringify({ awarenessText: 'Decoded.' }));
                        child.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Done.' } }) + '\n');
                        child.stdout.write(JSON.stringify({ type: 'turn.completed', usage: {} }) + '\n');
                    }
                    child.emit('close', 0, null);
                } catch { child.emit('error', new Error('fixture error')); }
            });
            return child;
        }
    });
    return { ...client, calls, signals };
}

test('ChatGPT-only preflight, controlled argv/environment, and structured final result', async t => {
    const options = await fixture(t);
    const client = fakeClient();
    assert.deepEqual(await client.runCodex(options), { awarenessText: 'Decoded.' });
    assert.equal(client.calls.length, 4);
    assert.equal(client.calls[1].args.includes('--strict-config'), false);
    const call = client.calls[3];
    assert.ok(call.args.includes('--strict-config'));
    assert.equal(call.options.shell, false);
    assert.ok(call.args.includes('gpt-6-astra'));
    assert.ok(call.args.includes('forced_login_method="chatgpt"'));
    assert.ok(call.args.includes('features.shell_tool=false'));
    assert.ok(call.args.includes('features.apps=false'));
    assert.ok(call.args.includes('features.view_image=false'));
    assert.ok(call.args.includes('features.skill_search=false'));
    assert.ok(call.args.includes('features.tool_suggest=false'));
    for (const feature of ['plugins', 'image_generation', 'in_app_browser', 'in_app_chat', 'in_app_local_automation', 'sleep_tool']) {
        assert.ok(call.args.includes(`features.${feature}=false`));
    }
    assert.ok(call.args.includes('permissions.podcast-image-context.network.enabled=false'));
    const permissions = call.args.find(arg => arg.startsWith('permissions.podcast-image-context.filesystem='));
    assert.ok(permissions.includes(`${JSON.stringify(options.authHome)}="deny"`));
    assert.ok(!call.args.includes('--dangerously-bypass-approvals-and-sandbox'));
    assert.deepEqual(Object.keys(call.options.env).sort(), ['CODEX_HOME', 'HOME', 'LANG', 'NO_COLOR', 'PATH', 'TERM', 'TZ']);
    assert.equal(call.options.env.CODEX_HOME, options.authHome);
});

test('an API-key login or ambiguous auth output cannot reach the model', async t => {
    for (const auth of ['Logged in using an API key', 'Logged in using ChatGPT\nextra private data']) {
        const options = await fixture(t), client = fakeClient({ auth });
        await assert.rejects(client.runCodex(options), { code: 'XENOLEX_AUTH_REQUIRED' });
        assert.equal(client.calls.length, 3);
    }
});

test('enabled managed MCP and a wrong pinned version fail before auth/model', async t => {
    const options = await fixture(t);
    const mcp = fakeClient({ servers: [{ name: 'external', enabled: true }] });
    await assert.rejects(mcp.runCodex(options), { code: 'XENOLEX_NOT_CONFIGURED' });
    assert.equal(mcp.calls.length, 2);
    const wrong = fakeClient({ version: 'codex-cli 0.153.0' });
    await assert.rejects(wrong.runCodex(options), { code: 'XENOLEX_NOT_CONFIGURED' });
    assert.equal(wrong.calls.length, 1);
});

test('dedicated-home user config and symlink inputs fail closed', async t => {
    const options = await fixture(t), client = fakeClient();
    await fs.writeFile(path.join(options.authHome, 'config.toml'), '[mcp_servers.secret]');
    await assert.rejects(client.runCodex(options), { code: 'XENOLEX_NOT_CONFIGURED' });
    assert.equal(client.calls.length, 0);
    await fs.rm(path.join(options.authHome, 'config.toml'));
    await fs.symlink(options.schemaPath, path.join(options.jobDir, 'link.png'));
    await assert.rejects(client.runCodex({ ...options, targetPaths: [path.join(options.jobDir, 'link.png')] }), { code: 'XENOLEX_FAILED' });
    assert.equal(client.calls.length, 0);
});

test('Codex bundled system skills survive repeated runs; custom skills and links are rejected', async t => {
    const options = await fixture(t);
    const systemDir = path.join(options.authHome, 'skills', '.system', 'bundled-skill');
    await fs.mkdir(systemDir, { recursive: true });
    await fs.writeFile(path.join(systemDir, 'SKILL.md'), 'Bundled skill fixture');
    const client = fakeClient();
    assert.deepEqual(await client.runCodex(options), { awarenessText: 'Decoded.' });
    await fs.rm(path.join(options.jobDir, 'codex-final.json'));
    assert.deepEqual(await client.runCodex(options), { awarenessText: 'Decoded.' });
    await fs.mkdir(path.join(options.authHome, 'skills', 'custom'));
    const custom = fakeClient();
    await assert.rejects(custom.runCodex(options), { code: 'XENOLEX_NOT_CONFIGURED' });
    assert.equal(custom.calls.length, 0);
    await fs.rm(path.join(options.authHome, 'skills', 'custom'), { recursive: true });
    await fs.symlink(options.schemaPath, path.join(systemDir, 'linked-file'));
    const linked = fakeClient();
    await assert.rejects(linked.runCodex(options), { code: 'XENOLEX_NOT_CONFIGURED' });
    assert.equal(linked.calls.length, 0);
});

test('a hanging auth preflight shares the deadline and is killed as a process group', async t => {
    const options = await fixture(t), client = fakeClient({ hangStage: 'auth' });
    await assert.rejects(client.runCodex({ ...options, timeoutMs: 30 }), { code: 'XENOLEX_TIMEOUT' });
    assert.deepEqual(client.signals, ['SIGTERM', 'SIGKILL']);
    assert.equal(client.calls.length, 3);
});

test('cancellation kills the active model process and redacts the abort reason', async t => {
    const options = await fixture(t), client = fakeClient({ hangStage: 'exec' });
    const controller = new AbortController();
    const promise = client.runCodex({ ...options, signal: controller.signal });
    const timer = setTimeout(() => controller.abort(new Error('PRIVATE_TOKEN')), 30);
    t.after(() => clearTimeout(timer));
    await assert.rejects(promise, error => error.code === 'XENOLEX_CANCELLED' && !error.message.includes('PRIVATE_TOKEN'));
    assert.deepEqual(client.signals, ['SIGTERM', 'SIGKILL']);
});

test('unexpected tool execution and excessive output are rejected and terminated', async t => {
    for (const output of [JSON.stringify({ type: 'item.started', item: { type: 'mcp_tool_call', arguments: 'SECRET' } }) + '\n', 'SECRET'.repeat(200000)]) {
        const options = await fixture(t);
        const client = fakeClient({ exec: async child => { child.stdout.write(output); } });
        await assert.rejects(client.runCodex(options), error => error.code === 'XENOLEX_FAILED' && !error.message.includes('SECRET'));
        assert.deepEqual(client.signals, ['SIGTERM', 'SIGKILL']);
    }
});

test('nonzero exit, missing completion, invalid JSON, and oversized final output cannot succeed', async t => {
    for (const scenario of ['exit', 'missing', 'json', 'large']) {
        const options = await fixture(t);
        const client = fakeClient({ exec: async (child, args) => {
            const resultPath = args[args.indexOf('--output-last-message') + 1];
            await fs.writeFile(resultPath, scenario === 'json' ? 'secret invalid JSON' : scenario === 'large' ? 'x'.repeat(1300000) : '{}');
            if (scenario !== 'missing') child.stdout.write('{"type":"turn.completed"}\n');
            child.emit('close', scenario === 'exit' ? 1 : 0, null);
        } });
        await assert.rejects(client.runCodex(options), { code: 'XENOLEX_FAILED' });
    }
});

test('argument construction keeps file names and prompt out of a shell', () => {
    const options = { jobDir: '/tmp/job $(bad)', authHome: '/srv/auth', schemaPath: '/tmp/job $(bad)/schema.json',
        resultPath: '/tmp/job $(bad)/result.json', referencePaths: ['/tmp/job $(bad)/ref.png'], targetPaths: ['/tmp/job $(bad)/target.png'] };
    const args = makeExecArgs(options);
    assert.equal(args.at(-1), '-');
    assert.ok(args.includes(options.targetPaths[0]));
    assert.equal(args.filter(item => item === '--image').length, 2);
    assert.equal(childEnvironment('/srv/auth').HOME, '/srv/auth');
});
