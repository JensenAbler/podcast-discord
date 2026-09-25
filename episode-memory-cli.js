#!/usr/bin/env node
'use strict';
// Bridge for podcast-production: recall past-episode memories for a finished recording
// using the same OpenClaw retrieval and curation loop as episode planning.
// Reads one JSON brief on stdin; writes one JSON result on stdout. Logs go to stderr.
const fs = require('fs');
const path = require('path');

function loadEnv(file) {
    if (!fs.existsSync(file)) return;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        const match = line.match(/^([^=]+)=(.*)$/);
        if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
    }
}

function parseBrief(text) {
    const input = JSON.parse(text);
    if (!input || typeof input.transcript !== 'string' || !input.transcript.trim()) {
        throw new Error('Brief requires a non-empty transcript');
    }
    const brief = {};
    for (const key of ['title', 'episode', 'host', 'guest']) {
        if (input[key] !== undefined && input[key] !== null && input[key] !== '') brief[key] = input[key];
    }
    brief.transcript = input.transcript;
    const excludeEpisodes = [...new Set((input.excludeEpisodes || []).map(Number).filter(Number.isInteger))];
    return { brief, excludeEpisodes, ref: typeof input.ref === 'string' ? input.ref : null };
}

async function recall(brief, options = {}, builder) {
    const { EpisodeMemoryBuilder, formatSourceCitation } = require('./episode-background-memory');
    const result = await (builder || new EpisodeMemoryBuilder({})).build(brief, {
        kind: 'recording', excludeEpisodes: options.excludeEpisodes || [], ref: options.ref || null
    });
    const sources = new Map(result.sources.map(source => [source.id, source]));
    result.memories = result.memories.map(memory => ({
        ...memory,
        citations: [...new Set(memory.sourceIds.map(id => formatSourceCitation(sources.get(id))))]
    }));
    return result;
}

async function main() {
    // Generators log progress with console.log; keep stdout reserved for the JSON result.
    console.log = (...args) => console.error(...args);
    loadEnv(path.join(__dirname, '.env'));
    const { brief, excludeEpisodes, ref } = parseBrief(fs.readFileSync(0, 'utf8'));
    const result = await recall(brief, { excludeEpisodes, ref });
    process.stdout.write(JSON.stringify(result) + '\n');
}

if (require.main === module) {
    main().catch(error => {
        process.stderr.write('[episode-memory-cli] ' + (error && error.message ? error.message : String(error)) + '\n');
        process.exit(1);
    });
}

module.exports = { parseBrief, recall };
