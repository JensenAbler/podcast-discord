'use strict';

// Admission is evidence-based, not recognizer confidence or a language blacklist.
// Raw candidates remain in the episode journal but cannot drive a new turn.
const normalize = text => String(text || '').normalize('NFKC').toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
const tokens = text => normalize(text).split(' ').filter(Boolean);
function agreement(a, b) {
    const x = normalize(a), y = normalize(b);
    if (!x || !y) return false;
    if (x === y) return true;
    const aa = tokens(x), bb = tokens(y);
    if (aa.length < 3) return false;
    return bb.some((_, i) => aa.every((word, j) => word === bb[i + j]));
}
function script(text) {
    if (/[\u3400-\u9fff]/u.test(text)) return 'cjk';
    if (/[\u3040-\u30ff]/u.test(text)) return 'kana';
    if (/[\u0400-\u04ff]/u.test(text)) return 'cyrillic';
    return /[a-z]/i.test(text) ? 'latin' : 'other';
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
    const shifted = context.previousText && script(text) !== script(context.previousText);
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
    // A true language switch is admitted with substantial audio. Weak foreign
    // fragments are uncertain, not categorically rejected.
    const accepted = !utterance.providerError && !!normalize(text) &&
        (!echo || sustained) &&
        (liveMatch || sustained || (brief && !shifted && (short || continuation)));
    return {
        status: accepted ? 'accepted' : 'candidate',
        effect: accepted ? responseEffect(text, context.pendingTexts) : 'none',
        reasons: reasons.length ? reasons : ['insufficient-evidence'],
        evidence: { liveMatch, sustained, brief, density, shifted: !!shifted, echo: !!echo,
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
        const cutoff = event.audioEndedAt - 30000;
        this.live = this.live.filter(e => e.audioEndedAt >= cutoff).slice(-500);
    }
    context(utterance, host = {}) {
        const start = Date.parse(utterance.speechStartedAt), end = Date.parse(utterance.speechEndedAt);
        const matches = this.live.filter(e => e.audioEndedAt >= start - 200 && e.audioStartedAt <= end + 300);
        const previous = this.recent.get(utterance.userId);
        return { ...host, liveMatch: host.singleSpeaker === true && agreement(utterance.transcription, matches.map(e => e.text).join('')),
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
module.exports = { ConversationAdmission, assess, agreement, responseEffect };
