'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

// Search the existing OpenClaw index, with no generation or summarization call.
function searchOpenClaw(query, options = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(options.command || '/usr/local/bin/openclaw',
            ['memory', 'search', '--query', query, '--max-results', '12', '--json'], {
                cwd: options.workspace || '/root/clawd',
                env: { ...process.env, HOME: options.home || '/root' },
                stdio: ['ignore', 'pipe', 'pipe']
            });
        const stdout = [];
        const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
        child.stdout.on('data', chunk => stdout.push(chunk));
        child.stderr.resume();
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('close', (code, signal) => {
            clearTimeout(timer);
            if (code !== 0) return reject(new Error('OpenClaw memory search failed (' + (signal || code) + ')'));
            try {
                const output = JSON.parse(Buffer.concat(stdout).toString('utf8'));
                if (!Array.isArray(output.results)) throw new Error('Missing results array');
                resolve(output.results);
            } catch (error) {
                reject(new Error('Invalid OpenClaw memory search response: ' + error.message));
            }
        });
    });
}

// Entity queries complement thematic queries; all plan angles are searched.
// No payload-size budget or total result truncation is applied.
function buildQueries(plan) {
    const queries = [];
    const add = value => {
        if (typeof value !== 'string' || !value.trim()) return;
        const query = value.trim().replace(/\s+/g, ' ');
        if (!queries.some(q => q.toLowerCase() === query.toLowerCase())) queries.push(query);
    };
    for (const guest of plan.guests || []) {
        add(guest.name);
        add(guest.role);
    }
    add(plan.title);
    add(plan.backgroundBrief);
    for (const phase of Object.values(plan.phases || {})) {
        for (const angle of phase.angles || []) {
            add(angle.title);
            add(angle.description);
        }
    }
    return queries;
}

function collectPassages(hits, { root, workspace, contextLines = 12 }) {
    const canonicalRoot = fs.realpathSync(root);
    const grouped = new Map();
    for (const hit of hits) {
        if (typeof hit.path !== 'string') throw new Error('Invalid OpenClaw source path');
        const filename = path.resolve(workspace, hit.path);
        // OpenClaw also indexes personal memory. Only published podcast sources belong here.
        if (path.dirname(filename) !== canonicalRoot || !/^episode-[a-zA-Z0-9-]+\.md$/.test(path.basename(filename))) continue;
        if (path.dirname(fs.realpathSync(filename)) !== canonicalRoot) continue;
        if (!Number.isInteger(hit.startLine) || !Number.isInteger(hit.endLine) ||
            hit.startLine < 1 || hit.endLine < hit.startLine) throw new Error('Invalid OpenClaw source range');
        let file = grouped.get(filename);
        if (!file) {
            const text = fs.readFileSync(filename, 'utf8');
            file = { lines: text.split('\n'), sha256: crypto.createHash('sha256').update(text).digest('hex'), ranges: [] };
            grouped.set(filename, file);
        }
        if (hit.endLine > file.lines.length) throw new Error('OpenClaw index source range is stale: ' + path.basename(filename));
        file.ranges.push({
            startLine: Math.max(1, hit.startLine - contextLines),
            endLine: Math.min(file.lines.length, hit.endLine + contextLines)
        });
    }
    const memories = [], sources = [];
    for (const [filename, file] of grouped) {
        const merged = [];
        for (const range of file.ranges.sort((a, b) => a.startLine - b.startLine)) {
            const previous = merged.at(-1);
            if (previous && range.startLine <= previous.endLine + 1) previous.endLine = Math.max(previous.endLine, range.endLine);
            else merged.push({ ...range });
        }
        const title = file.lines.find(line => /^# /.test(line))?.slice(2) || path.basename(filename);
        for (const range of merged) {
            const id = path.basename(filename) + ':L' + range.startLine + '-' + range.endLine;
            memories.push({ text: file.lines.slice(range.startLine - 1, range.endLine).join('\n'), sourceIds: [id] });
            sources.push({ id, title, path: filename, ...range, sha256: file.sha256 });
        }
    }
    return { memories, sources };
}

class EpisodeMemoryBuilder {
    constructor(options = {}) {
        this.root = options.root || '/var/lib/openclaw-podcast-memory';
        this.workspace = options.workspace || '/root/clawd';
        this.search = options.search || (query => searchOpenClaw(query, { ...options, workspace: this.workspace }));
    }
    async build(plan) {
        const queries = buildQueries(plan);
        const hits = [];
        // Sequential searches avoid competing local embedding workers.
        for (const query of queries) hits.push(...await this.search(query));
        const { memories, sources } = collectPassages(hits, this);
        return {
            schemaVersion: 2, status: 'ready', createdAt: new Date().toISOString(),
            planRef: plan.basename + '@' + plan.version,
            retrieval: 'openclaw-local', corpus: 'published-podcast', queries,
            hitsRetrieved: hits.length, recordingsConsidered: new Set(sources.map(s => s.path)).size,
            chunksConsidered: hits.length, skipped: [], memories, sources
        };
    }
}

function seedEpisodeMemory(manager, guildId, plan) {
    const memory = plan?.backgroundMemory;
    if (memory?.status !== 'ready' || !memory.memories?.length) return null;
    const sources = new Map((memory.sources || []).map(source => [source.id, source]));
    return manager?.addAwarenessShelfItem?.(guildId, {
        id: 'episode-background-memory', scope: 'episode',
        text: memory.memories.map(item => {
            const titles = [...new Set(item.sourceIds.map(id => sources.get(id)?.title).filter(Boolean))];
            return (titles.length ? titles.join(' / ') + '\n' : '') + item.text +
                '\nSources: ' + item.sourceIds.join(', ');
        }).join('\n\n'),
        reason: 'Background from past podcast conversations',
        topicAnchors: []
    }) || null;
}

module.exports = { EpisodeMemoryBuilder, buildQueries, collectPassages, searchOpenClaw, seedEpisodeMemory };
