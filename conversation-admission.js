'use strict';

// Admission is evidence-based, not recognizer confidence or a language blacklist.
// Raw candidates remain in the episode journal but cannot drive a new turn.
const normalize = text => String(text || '').normalize('NFKC').toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
// Matching units are words, or individual characters for unspaced scripts.
const tokens = text => normalize(String(text || '').replace(/[’']/g, ''))
    .replace(/([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])/gu, ' $1 ')
    .split(' ').filter(Boolean);
function matchingTokens(text) {
    return tokens(text).filter(t => !/^(uh|um|erm|er|hmm|mhm|mm)$/.test(t))
        .filter((t, i, all) => i === 0 || t !== all[i - 1]);
}
function compareRecognition(a, b) {
    const aa = matchingTokens(a), bb = matchingTokens(b).slice(0, 1200);
    // Never validate a long unmatched tail by comparing only its prefix.
    if (aa.length > 500) return { matched: false, score: 0, units: aa.length };
    if (!aa.length || !bb.length) return { matched: false, score: 0, units: aa.length };
    // Semi-global edit distance: ignore neighboring Live words outside the
    // matching span, but charge for missing, substituted, or reordered words.
    let previous = new Array(bb.length + 1).fill(0);
    for (let i = 1; i <= aa.length; i++) {
        const row = [i];
        for (let j = 1; j <= bb.length; j++) {
            row[j] = Math.min(previous[j] + 1, row[j - 1] + 1,
                previous[j - 1] + (aa[i - 1] === bb[j - 1] ? 0 : 1));
        }
        previous = row;
    }
    const edits = Math.min(...previous);
    const score = 1 - edits / aa.length;
    // A short phrase needs exact lexical agreement after filler normalization.
    return { matched: aa.length < 5 ? edits === 0 : score >= 0.78,
        score, units: aa.length, edits };
}
function agreement(a, b) { return compareRecognition(a, b).matched; }
function script(text) {
    const scripts = ['Latin', 'Han', 'Hiragana', 'Katakana', 'Cyrillic',
        'Arabic', 'Hebrew', 'Devanagari', 'Hangul', 'Greek', 'Thai'];
    let best = 'other', count = 0;
    for (const name of scripts) {
        const n = (String(text).match(new RegExp('\\p{Script=' + name + '}', 'gu')) || []).length;
        if (n > count) { best = name; count = n; }
    }
    return best;
}
function responseEffect(text, pendingTexts = []) {
    const t = normalize(text);
    // Never treat a correction as an acknowledgment merely because it starts "yes".
    if (/\b(no|not|actually|instead|stop|wait|wrong|but|except|cancel)\b/.test(t)) return 'supersede';
    if (/^(yes|yeah|yep|yup|right|okay|ok|mhm|mm|uh huh|thanks|thank you|got it|exactly|sure|go on|please continue|and that s it|that s all|and thats it|thats all|you know)$/.test(t)) return 'preserve';
    if (pendingTexts.some(previous => normalize(previous) === t)) return 'preserve';
    return 'supersede';
}
function assess(utterance, context = {}) {
    const text = utterance.transcription || utterance.text || '';
    const e = utterance.acousticEvidence;
    const liveMatch = context.liveMatch === true;
    const referenceText = context.previousText || context.liveText;
    const shifted = !!referenceText && script(text) !== script(referenceText);
    const units = matchingTokens(text).length;
    const scriptOutlier = shifted && units >= 4;
    // A recognizer emitting a sentence from a very short acoustic event also
    // needs lexical support. This tests transcription plausibility, not intent.
    const spanMs = Math.max(e?.speechSpanMs || 0, e?.voicedMs || 0);
    const densityOutlier = units >= 6 && spanMs > 0 && units / (spanMs / 1000) > 18;
    const corroborationRequired = scriptOutlier || densityOutlier;
    const corroborated = liveMatch && (!corroborationRequired ||
        (context.liveMatchScore ?? 1) >= 0.9);
    const echo = context.duringHostPlayback && agreement(text, context.hostText);
    // Endpoint silence is transport/segmentation latency, not evidence against
    // a short legitimate acknowledgment. Measure density inside the speech span.
    const windowMs = e?.speechSpanMs > 0 ? Math.max(e.voicedMs, e.speechSpanMs) : e?.audioDurationMs;
    const density = windowMs > 0 ? e.voicedMs / windowMs : 0;
    const sustained = !!e && e.maxRunMs >= 100 && e.voicedMs >= 240 && density >= 0.15;
    const brief = !!e && e.voicedMs >= 60 && e.maxRunMs >= 40 && density >= 0.08;
    const continuation = context.previousText && context.gapMs >= 0 && context.gapMs <= 1200 && !shifted;
    const short = tokens(text).length <= 3;
    const reasons = [];
    if (liveMatch) reasons.push('live-agreement');
    if (sustained) reasons.push('sustained-audio');
    if (brief && short && !shifted) reasons.push('supported-short-speech');
    if (continuation && brief) reasons.push('supported-continuation');
    if (shifted) reasons.push('script-change');
    if (echo) reasons.push('possible-host-echo');
    if (scriptOutlier) reasons.push('substantial-script-change');
    if (densityOutlier) reasons.push('text-audio-density-outlier');
    if (corroborationRequired && !corroborated) reasons.push('awaiting-live-corroboration');
    // Corroborated audible words are valid regardless of source or relevance.
    const accepted = !utterance.providerError && !!normalize(text) &&
        (!corroborationRequired || corroborated) &&
        (liveMatch || sustained || (brief && !shifted && (short || continuation)));
    return {
        status: accepted ? 'accepted' : 'candidate',
        effect: accepted ? responseEffect(text, context.pendingTexts) : 'none',
        reasons: reasons.length ? reasons : ['insufficient-evidence'],
        evidence: { liveMatch, liveMatchScore: context.liveMatchScore ?? null,
            liveMatchUnits: context.liveMatchUnits ?? null,
            liveWindow: context.liveWindow || null, corroborationRequired,
            sustained, brief, density, shifted: !!shifted, echo: !!echo,
            acousticAvailable: !!e }
    };
}
class ConversationAdmission {
    constructor() {
        this.live = [];
        this.recent = new Map();
        this.candidates = new Map();
        this.pendingTexts = [];
        this.supplements = [];
        this.closed = false;
    }
    observeLive(event) {
        if (this.closed || !Number.isFinite(event.audioStartedAt) || !Number.isFinite(event.audioEndedAt)) return;
        this.live.push(event);
        const cutoff = event.audioEndedAt - 90000;
        this.live = this.live.filter(e => e.audioEndedAt >= cutoff).slice(-1500);
    }
    context(utterance, host = {}) {
        const start = Date.parse(utterance.speechStartedAt), end = Date.parse(utterance.speechEndedAt);
        // Live's acoustic offsets and Fish's endpoint boundaries differ. Include
        // a bounded margin; this widens evidence retrieval, never playback waits.
        const windowStart = start - 500, windowEnd = end + 1500;
        const matches = this.live.filter(e => e.audioEndedAt >= windowStart && e.audioStartedAt <= windowEnd);
        const liveText = matches.map(e => e.text).join('');
        const comparison = compareRecognition(utterance.transcription, liveText);
        const previous = this.recent.get(utterance.userId);
        return { ...host, liveText, liveMatch: comparison.matched,
            liveMatchScore: comparison.score, liveMatchUnits: comparison.units,
            liveWindow: { start: windowStart, end: windowEnd, fragments: matches.length },
            previousText: previous?.transcription, gapMs: start - Date.parse(previous?.speechEndedAt),
            pendingTexts: this.pendingTexts };
    }
    evaluate(utterance, host) {
        const { audioBuffer, ...observation } = utterance;
        const result = assess(utterance, this.context(utterance, host));
        const id = JSON.stringify([utterance.userId, utterance.speechStartedAt, utterance.asrStartedAt]);
        result.id = id;
        if (result.status === 'accepted') {
            this.candidates.delete(id);
            const old = this.recent.get(utterance.userId);
            if (!old || Date.parse(utterance.speechStartedAt) >= Date.parse(old.speechStartedAt)) this.recent.set(utterance.userId, observation);
        } else {
            this.candidates.set(id, observation);
            for (const [key, value] of this.candidates) {
                if (Date.parse(utterance.speechStartedAt) - Date.parse(value.speechStartedAt) > 10000 || this.candidates.size > 20) this.candidates.delete(key);
            }
        }
        return result;
    }
    close() { this.closed = true; this.live = []; this.candidates.clear(); this.recent.clear(); }
}
module.exports = { ConversationAdmission, assess, agreement, responseEffect, compareRecognition };
