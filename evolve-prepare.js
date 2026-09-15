'use strict';
// Read-only corpus inventory; writes only new operator bundles, never publishes.
const fs = require('fs');
const path = require('path');
const { atomicJson, contained } = require('./evolve-session');
const { getPodcastRoot } = require('./paths');
function xmlText(s) {
    return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'");
}
function inventory(root) {
    const feed = fs.readFileSync(path.join(root, 'feed.xml'), 'utf8');
    const episodes = [], missing = [];
    for (const match of feed.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/g)) {
        const body = match[1];
        const id = body.match(/<itunes:episode>(\d+)<\/itunes:episode>/)?.[1];
        const title = xmlText(body.match(/<title>([\s\S]*?)<\/title>/)?.[1] || '');
        const link = body.match(/https?:\/\/[^\s<]+_transcript\.txt/)?.[0];
        if (!id || !title || !link) { missing.push({ id, title, reason: 'No full transcript linked from feed; scripts are not substituted' }); continue; }
        const relative = decodeURIComponent(new URL(xmlText(link)).pathname).replace(/^\/+/, '');
        try {
            const file = contained(root, relative);
            if (!fs.readFileSync(file, 'utf8').trim()) throw new Error('Empty transcript');
            episodes.push({ id, title, transcriptFile: relative, complete: true, provenance: 'Full published live-STT transcript linked by feed; accuracy and nonverbal coverage require human audit' });
        } catch (e) { missing.push({ id, title, reason: e.message }); }
    }
    episodes.sort((a,b) => Number(a.id) - Number(b.id));
    return { episodes, missing };
}
function prepare(root, id = 'published-evolve') {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id)) throw new Error('Invalid bundle ID');
    const result = inventory(root);
    if (!result.episodes.length) throw new Error('No full published transcripts found');
    const dir = path.join(root, 'evolve');
    const targets = [path.join(dir,id + '.json'),path.join(dir,id + '-rehearsal.json'),path.join(dir,id + '-inventory.json')];
    if (targets.some(p => fs.existsSync(p))) throw new Error('Bundle already exists; choose a new ID');
    const common = { version: 1, contextLimit: 200000, title: 'Alpha-Clawd Evolve' };
    atomicJson(targets[0], { ...common, episodes: result.episodes });
    atomicJson(targets[1], { ...common, title: 'Evolve two-episode rehearsal', episodes: result.episodes.slice(0,2) });
    atomicJson(targets[2], result);
    return { bundles: targets, completeEpisodeIds: result.episodes.map(e => e.id), missing: result.missing };
}
if (require.main === module) {
    try { console.log(JSON.stringify(prepare(process.argv[2] || getPodcastRoot(), process.argv[3]), null, 2)); }
    catch (e) { console.error(e.message); process.exitCode = 1; }
}
module.exports = { inventory, prepare };
