'use strict';
const fs = require('fs');
const path = require('path');

function participantTag(name) {
    let slug = String(name || '').normalize('NFKC').trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');
    slug = ({ 'alpha-clawd': 'alpha', 'jensen-abler': 'jensen' })[slug] || slug;
    return slug && !['unknown', 'speaker'].includes(slug) ? 'person:' + slug : null;
}
function planTag(plan) {
    const base = typeof plan === 'string' ? plan : plan?.basename;
    return base ? 'plan:' + String(base).trim().replace(/^plan:/, '').split('@')[0] : null;
}
function readJson(dir, name) {
    try { return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { return null; }
}
function recordingTags(dir) {
    const metadata = readJson(dir, 'episode-complete.json') || readJson(dir, 'episode-metadata.json') || {};
    const saved = readJson(dir, 'recording-tags.json');
    if (saved && Array.isArray(saved.tags)) return saved;
    const plan = metadata.episodePlan || readJson(dir, 'episode-plan.json') || readJson(dir, 'resume-background.json');
    const tags = new Set((metadata.tags || []).filter(t => typeof t === 'string'));
    const p = metadata.planTag || planTag(plan);
    if (p) tags.add(p);
    // Only this recording's speech; resume-history is deliberately excluded.
    const json = readJson(dir, 'transcript.json');
    let entries = json?.utterances || [];
    try { entries = [...entries, ...fs.readFileSync(path.join(dir, 'transcript.jsonl'), 'utf8').split('\n').filter(s => s.trim()).map(JSON.parse)]; } catch {}
    for (const entry of entries) {
        if (entry.admission?.status === 'candidate' || ['failed', 'not_started'].includes(entry.playbackStatus)) continue;
        const tag = participantTag(entry.speaker);
        if (tag) tags.add(tag);
    }
    return { schemaVersion: 1, tags: [...tags].sort(), planTag: p };
}
function writeTags(dir, tags, plan) {
    const value = { schemaVersion: 1, tags: [...new Set(tags.filter(Boolean))].sort(), planTag: plan || null };
    const target = path.join(dir, 'recording-tags.json');
    fs.writeFileSync(target + '.tmp', JSON.stringify(value, null, 2) + '\n');
    fs.renameSync(target + '.tmp', target);
    return value;
}
function planChoices(root, query = '', guildId = null) {
    if (!fs.existsSync(root)) return [];
    const counts = new Map();
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith('episode-')) continue;
        const dir = path.join(root, entry.name);
        const metadata = readJson(dir, 'episode-complete.json');
        if (!metadata || (guildId && metadata.guildId !== guildId)) continue;
        const tag = recordingTags(dir).planTag;
        if (tag) counts.set(tag, (counts.get(tag) || 0) + 1);
    }
    return [...counts].sort(([a], [b]) => a.localeCompare(b))
        .filter(([tag]) => tag.toLowerCase().includes(String(query).toLowerCase()))
        .slice(0, 25).map(([tag, count]) => ({ name: (tag.slice(5) + ' · ' + count + ' recordings').slice(0, 100), value: tag.slice(5) }));
}
module.exports = { participantTag, planTag, recordingTags, writeTags, planChoices };
