'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');

const CODEX_VERSION = '0.154.0';
const MODEL = 'gpt-6-astra';
const OUTPUT_LIMIT = 1024 * 1024;
const RESULT_LIMIT = 128 * 1024;
const MESSAGES = Object.freeze({
    XENOLEX_NOT_CONFIGURED: 'Astra image interpretation needs its local Codex setup.',
    XENOLEX_AUTH_REQUIRED: 'Astra image interpretation needs a ChatGPT account sign-in.',
    XENOLEX_TIMEOUT: 'Astra image interpretation timed out.',
    XENOLEX_FAILED: 'Astra image interpretation failed.',
    XENOLEX_CANCELLED: 'Astra image interpretation was cancelled.'
});

function failure(code) {
    const error = new Error(MESSAGES[code] || MESSAGES.XENOLEX_FAILED);
    error.code = Object.hasOwn(MESSAGES, code) ? code : 'XENOLEX_FAILED';
    return error;
}

function cancelled(signal) {
    return failure(signal?.reason?.code === 'XENOLEX_TIMEOUT' ? 'XENOLEX_TIMEOUT' : 'XENOLEX_CANCELLED');
}

function childEnvironment(authHome) {
    // Never inherit API keys, the Discord token, NODE_OPTIONS, provider URLs, or proxies.
    return {
        PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
        LANG: 'C.UTF-8', TZ: 'UTC', TERM: 'dumb', NO_COLOR: '1',
        HOME: authHome, CODEX_HOME: authHome
    };
}

function resolveCodex() {
    try {
        const packagePath = require.resolve('@openai/codex/package.json');
        const metadata = require(packagePath);
        if (metadata.version !== CODEX_VERSION || metadata.bin?.codex !== 'bin/codex.js') throw new Error();
        return path.join(path.dirname(packagePath), 'bin/codex.js');
    } catch {
        throw failure('XENOLEX_NOT_CONFIGURED');
    }
}

function configArgs(jobDir, authHome) {
    // Source: learn.chatgpt.com/docs/config-file/config-reference and /docs/permissions.
    // A custom profile is essential: ordinary read-only mode permits host-wide reads.
    const controls = [
        'forced_login_method="chatgpt"', 'model_provider="openai"', 'approval_policy="never"',
        'default_permissions="podcast-image-context"',
        `permissions.podcast-image-context.filesystem={":root"="deny", ":minimal"="read", ${JSON.stringify(jobDir)}="read", ${JSON.stringify(authHome)}="deny", "/proc"="deny"}`,
        'permissions.podcast-image-context.network.enabled=false',
        'features.shell_tool=false', 'features.unified_exec=false', 'features.shell_snapshot=false',
        'features.apps=false', 'features.multi_agent=false', 'features.hooks=false',
        'features.memories=false', 'features.remote_plugin=false', 'features.goals=false',
        'features.plugins=false', 'features.image_generation=false', 'features.in_app_browser=false',
        'features.in_app_chat=false', 'features.in_app_local_automation=false', 'features.sleep_tool=false',
        'features.skill_mcp_dependency_install=false', 'features.view_image=false',
        'features.skill_search=false', 'features.tool_suggest=false', 'web_search="disabled"',
        'history.persistence="none"', 'project_doc_max_bytes=0'
    ];
    return controls.flatMap(value => ['-c', value]);
}

function makeExecArgs({ jobDir, authHome, referencePaths, targetPaths, schemaPath, resultPath }) {
    return ['exec', '--strict-config', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check',
        '--cd', jobDir, '--model', MODEL, '--color', 'never', '--json',
        '--output-schema', schemaPath, '--output-last-message', resultPath,
        ...configArgs(jobDir, authHome),
        ...referencePaths.flatMap(file => ['--image', file]),
        ...targetPaths.flatMap(file => ['--image', file]), '-'];
}

function createCodexClient({ spawnImpl = spawn, resolveCli = resolveCodex, killGroup, killGraceMs = 1000 } = {}) {
    const signalChild = (child, signal) => {
        try {
            if (killGroup) killGroup(child, signal);
            else if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
            else child.kill(signal);
        } catch (error) {
            if (error.code !== 'ESRCH') { try { child.kill(signal); } catch {} }
        }
    };

    // The subprocess and its descendants must be terminal before callers remove job files.
    function runProcess(cliPath, args, { authHome, jobDir, signal, deadline, input, onEvent, outputLimit = OUTPUT_LIMIT }) {
        return new Promise((resolve, reject) => {
            if (signal?.aborted) { reject(cancelled(signal)); return; }
            const remaining = deadline - Date.now();
            if (remaining <= 0) { reject(failure('XENOLEX_TIMEOUT')); return; }
            let child;
            try {
                child = spawnImpl(process.execPath, [cliPath, ...args], {
                    cwd: jobDir, env: childEnvironment(authHome), shell: false,
                    detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe']
                });
            } catch { reject(failure('XENOLEX_NOT_CONFIGURED')); return; }
            let stdout = '', stderr = '', lineBuffer = '', totalBytes = 0;
            let pendingError = null, finished = false, killTimer, hardTimer;
            const decoder = new StringDecoder('utf8');
            const cleanup = () => {
                clearTimeout(timer); clearTimeout(killTimer); clearTimeout(hardTimer);
                signal?.removeEventListener('abort', abort);
            };
            const finish = (error, value) => {
                if (finished) return;
                finished = true;
                cleanup();
                if (error) reject(error); else resolve(value);
            };
            const stop = error => {
                if (finished || pendingError) return;
                pendingError = error;
                signalChild(child, 'SIGTERM');
                killTimer = setTimeout(() => {
                    signalChild(child, 'SIGKILL');
                    // Protect shutdown against a broken child implementation / inherited open pipe.
                    hardTimer = setTimeout(() => {
                        child.stdout?.destroy(); child.stderr?.destroy(); child.stdin?.destroy();
                        finish(pendingError);
                    }, killGraceMs);
                }, killGraceMs);
            };
            const abort = () => stop(cancelled(signal));
            const timer = setTimeout(() => stop(failure('XENOLEX_TIMEOUT')), remaining);
            signal?.addEventListener('abort', abort, { once: true });
            if (signal?.aborted) abort();
            const parseLine = line => {
                if (!line.trim() || pendingError) return;
                try { onEvent(JSON.parse(line)); } catch { stop(failure('XENOLEX_FAILED')); }
            };
            child.stdout.on('data', chunk => {
                totalBytes += chunk.length;
                if (totalBytes > outputLimit) { stop(failure('XENOLEX_FAILED')); return; }
                if (pendingError) return;
                const text = decoder.write(chunk);
                stdout += text;
                if (onEvent) {
                    lineBuffer += text;
                    let end;
                    while ((end = lineBuffer.indexOf('\n')) !== -1) {
                        parseLine(lineBuffer.slice(0, end));
                        lineBuffer = lineBuffer.slice(end + 1);
                    }
                }
            });
            child.stderr.on('data', chunk => {
                totalBytes += chunk.length;
                if (totalBytes > outputLimit) stop(failure('XENOLEX_FAILED'));
                else if (!pendingError) stderr += chunk.toString('utf8');
            });
            child.stdin.on('error', () => stop(failure('XENOLEX_FAILED')));
            child.on('error', () => finish(pendingError || failure('XENOLEX_NOT_CONFIGURED')));
            child.on('close', (code, terminationSignal) => {
                const tail = decoder.end();
                stdout += tail;
                if (onEvent && !pendingError) parseLine(lineBuffer + tail);
                if (pendingError) finish(pendingError);
                else finish(null, { code, signal: terminationSignal, stdout, stderr });
            });
            child.stdin.end(input || '');
        });
    }

    async function preflight({ authHome, jobDir, signal, deadline, cliPath }) {
        // A dedicated auth directory has no user MCP, plugins, hooks, or instructions.
        // Managed settings are retained and an enabled MCP server fails closed below.
        for (const entry of ['config.toml', 'AGENTS.md', 'AGENTS.override.md', 'plugins', 'hooks.json']) {
            try { await fs.lstat(path.join(authHome, entry)); throw failure('XENOLEX_NOT_CONFIGURED'); }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        // Codex installs its bundled skills into skills/.system itself. Allow that
        // managed subtree, but never custom sibling skills, links, or special files.
        const skillsDir = path.join(authHome, 'skills');
        try {
            const info = await fs.lstat(skillsDir);
            if (!info.isDirectory() || info.isSymbolicLink()) throw failure('XENOLEX_NOT_CONFIGURED');
            const entries = await fs.readdir(skillsDir);
            if (entries.some(entry => entry !== '.system')) throw failure('XENOLEX_NOT_CONFIGURED');
            const pending = entries.map(entry => ({ file: path.join(skillsDir, entry), depth: 0 }));
            let visited = 0;
            while (pending.length) {
                if (signal?.aborted) throw cancelled(signal);
                if (Date.now() >= deadline) throw failure('XENOLEX_TIMEOUT');
                const { file, depth } = pending.pop();
                if (++visited > 1024 || depth > 12) throw failure('XENOLEX_NOT_CONFIGURED');
                const entry = await fs.lstat(file);
                if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory()) ||
                    (depth === 0 && !entry.isDirectory())) throw failure('XENOLEX_NOT_CONFIGURED');
                if (entry.isDirectory()) {
                    for (const child of await fs.readdir(file)) pending.push({ file: path.join(file, child), depth: depth + 1 });
                }
            }
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
        const options = { authHome, jobDir, signal, deadline, outputLimit: 64 * 1024 };
        const version = await runProcess(cliPath, ['--version'], options);
        if (version.code !== 0 || version.stdout.trim() !== `codex-cli ${CODEX_VERSION}`) throw failure('XENOLEX_NOT_CONFIGURED');
        // Codex 0.154.0 supports strict-config for exec, but rejects it for mcp.
        const mcp = await runProcess(cliPath, ['-c', 'forced_login_method="chatgpt"',
            'mcp', 'list', '--json'], options);
        let servers;
        try { servers = JSON.parse(mcp.stdout); } catch { throw failure('XENOLEX_NOT_CONFIGURED'); }
        if (mcp.code !== 0 || !Array.isArray(servers) || servers.some(server => server.enabled !== false)) {
            throw failure('XENOLEX_NOT_CONFIGURED');
        }
        const auth = await runProcess(cliPath, ['-c', 'forced_login_method="chatgpt"', 'login', 'status'], options);
        if (auth.code !== 0 || [auth.stdout.trim(), auth.stderr.trim()].filter(Boolean).join('\n') !== 'Logged in using ChatGPT') {
            throw failure('XENOLEX_AUTH_REQUIRED');
        }
    }

    async function runCodex({ jobDir, referencePaths = [], targetPaths, targetPath, prompt, schemaPath,
        authHome, signal, timeoutMs = 180000 } = {}) {
        const deadline = Date.now() + Math.min(240000, Math.max(1, Number(timeoutMs) || 180000));
        if (signal?.aborted) throw cancelled(signal);
        try {
            if (!jobDir || !authHome || !schemaPath || typeof prompt !== 'string' || !prompt || prompt.length > 120000) {
                throw failure('XENOLEX_NOT_CONFIGURED');
            }
            jobDir = await fs.realpath(jobDir);
            authHome = await fs.realpath(authHome);
            if (jobDir === authHome || authHome.startsWith(jobDir + path.sep) || jobDir.startsWith(authHome + path.sep)) {
                throw failure('XENOLEX_NOT_CONFIGURED');
            }
            targetPaths = targetPaths || (targetPath ? [targetPath] : []);
            if (!Array.isArray(referencePaths) || !Array.isArray(targetPaths) || !targetPaths.length ||
                referencePaths.length > 40 || targetPaths.length > 10) throw failure('XENOLEX_FAILED');
            for (const file of [...referencePaths, ...targetPaths, schemaPath]) {
                if (typeof file !== 'string' || /[\x00-\x1f,]/.test(file) || !path.isAbsolute(file)) throw failure('XENOLEX_FAILED');
                const real = await fs.realpath(file);
                const info = await fs.lstat(file);
                if (!real.startsWith(jobDir + path.sep) || info.isSymbolicLink() || !info.isFile()) throw failure('XENOLEX_FAILED');
            }
            const cliPath = resolveCli();
            await preflight({ cliPath, authHome, jobDir, signal, deadline });
            const resultPath = path.join(jobDir, 'codex-final.json');
            try { await fs.lstat(resultPath); throw failure('XENOLEX_FAILED'); }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
            let completed = false;
            const onEvent = event => {
                if (!event || typeof event.type !== 'string') throw new Error();
                if (['thread.started', 'turn.started'].includes(event.type)) return;
                if (event.type === 'turn.completed') { completed = true; return; }
                if (['item.started', 'item.updated', 'item.completed'].includes(event.type) &&
                    ['agent_message', 'reasoning', 'todo_list'].includes(event.item?.type)) return;
                // Command, filesystem, web, MCP, unknown future tool events, and failed turns are rejected.
                throw new Error();
            };
            const result = await runProcess(cliPath, makeExecArgs({ jobDir, authHome, referencePaths,
                targetPaths, schemaPath, resultPath }), { authHome, jobDir, signal, deadline, input: prompt, onEvent });
            if (result.code !== 0 || result.signal || !completed) throw failure('XENOLEX_FAILED');
            if (signal?.aborted) throw cancelled(signal);
            const handle = await fs.open(resultPath, require('node:fs').constants.O_RDONLY | require('node:fs').constants.O_NOFOLLOW);
            try {
                const info = await handle.stat();
                if (!info.isFile() || !info.size || info.size > RESULT_LIMIT) throw failure('XENOLEX_FAILED');
                const bytes = Buffer.alloc(RESULT_LIMIT + 1);
                const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
                if (bytesRead > RESULT_LIMIT) throw failure('XENOLEX_FAILED');
                const parsed = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw failure('XENOLEX_FAILED');
                return parsed;
            } finally { await handle.close(); }
        } catch (error) {
            if (signal?.aborted) throw cancelled(signal);
            if (Object.hasOwn(MESSAGES, error?.code)) throw error;
            throw failure('XENOLEX_FAILED');
        }
    }

    async function checkSetup({ authHome, jobDir, signal, timeoutMs = 15000 }) {
        try {
            await preflight({ authHome, jobDir, signal, deadline: Date.now() + timeoutMs, cliPath: resolveCli() });
            return true;
        } catch (error) {
            if (Object.hasOwn(MESSAGES, error?.code)) throw error;
            throw failure('XENOLEX_NOT_CONFIGURED');
        }
    }

    return { runCodex, checkSetup };
}

const client = createCodexClient();
module.exports = { ...client, createCodexClient, resolveCodex, childEnvironment, makeExecArgs,
    configArgs, failure, CODEX_VERSION, MODEL };
