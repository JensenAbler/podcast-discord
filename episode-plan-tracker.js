const { PHASES, normalizeEpisodePlan } = require('./episode-plan-store');

class EpisodePlanTracker {
    constructor(plan, options = {}) {
        this.plan = normalizeEpisodePlan(plan || {});
        this.startedAt = options.startedAt || new Date().toISOString();
        this.currentPhaseIndex = Math.max(0, PHASES.indexOf(options.currentPhase || PHASES[0]));
        this.phaseStartedAt = options.phaseStartedAt || this.startedAt;
        this.lastChosenAngle = cleanText(options.lastChosenAngle || '');
        this.completedAngles = new Set(Array.isArray(options.completedAngles) ? options.completedAngles : []);
        this.activeAngles = new Set(Array.isArray(options.activeAngles) ? options.activeAngles : []);
        this.recentTurns = Array.isArray(options.recentTurns) ? options.recentTurns.slice(-6) : [];
    }

    get currentPhase() {
        return PHASES[this.currentPhaseIndex] || PHASES[PHASES.length - 1];
    }

    get currentPhasePlan() {
        return this.plan.phases[this.currentPhase] || { targetMinutes: 1, angles: [] };
    }

    observeTranscriptEntry(entry = {}) {
        const role = String(entry.speakerRole || entry.role || '').toLowerCase() === 'host'
            ? 'host'
            : 'guest';
        const startedAt = entry.speechStartedAt || entry.playbackStartedAt || entry.timestamp || entry.generatedAt || null;
        const endedAt = entry.speechEndedAt || entry.playbackEndedAt || entry.asrCompletedAt || entry.timestamp || entry.generatedAt || null;
        const durationMs = durationFromEntry(entry, startedAt, endedAt);
        this.recentTurns.push({
            role,
            speaker: cleanText(entry.speaker || (role === 'host' ? 'Alpha-Clawd' : 'Guest')),
            durationMs
        });
        this.recentTurns = this.recentTurns.slice(-6);
    }

    applySpokenResponse(response = {}, timing = {}) {
        if (!response || response.shouldRespond !== true || !cleanText(response.speech)) {
            return false;
        }
        const chosenAngle = cleanText(response.chosenAngle || '');
        if (!chosenAngle) {
            return false;
        }

        const plannedIds = new Set(this.currentPhasePlan.angles.map((angle) => angle.id));
        const previous = this.lastChosenAngle;
        if (chosenAngle !== previous) {
            if (previous) {
                this.completedAngles.add(previous);
                this.activeAngles.delete(previous);
            }
            if (plannedIds.has(chosenAngle)) {
                this.activeAngles.add(chosenAngle);
            }
            this.lastChosenAngle = chosenAngle;
        } else if (plannedIds.has(chosenAngle)) {
            this.activeAngles.add(chosenAngle);
            this.lastChosenAngle = chosenAngle;
        }

        this.advancePhaseIfNeeded(timing.now || timing.playbackEndedAt || new Date().toISOString());
        return true;
    }

    advancePhaseIfNeeded(now = new Date().toISOString()) {
        while (this.currentPhaseIndex < PHASES.length - 1 && this.getAvailableAngles().length === 0) {
            this.currentPhaseIndex += 1;
            this.phaseStartedAt = now;
        }
    }

    getAvailableAngles() {
        return this.currentPhasePlan.angles.filter((angle) => {
            if (this.completedAngles.has(angle.id)) return false;
            if (this.activeAngles.has(angle.id)) return false;
            if (angle.id === this.lastChosenAngle) return false;
            return true;
        });
    }

    getStructureBlock(now = new Date().toISOString()) {
        const phaseElapsed = elapsedMinutes(this.phaseStartedAt, now);
        const target = Number(this.currentPhasePlan.targetMinutes) || 1;
        const remaining = Math.max(0, target - phaseElapsed);
        const lines = [
            `Current phase: ${this.currentPhase}.`,
            `Phase target length: ${formatMinutes(target)}.`,
            `Phase elapsed: ${formatMinutes(phaseElapsed)}.`,
            `Phase time remaining: ${formatMinutes(remaining)}.`,
            '',
            `Last turn chosenAngle: ${this.lastChosenAngle || '(none)'}.`,
            'The planned angles below are preproduction background knowledge, not things the guest already said in this live conversation.',
            'When using planned background, frame it as background or the episode plan. Only say the guest "mentioned" or "said earlier" when that fact appears in the live transcript.',
            'Available planned angles in this phase:'
        ];

        const angles = this.getAvailableAngles();
        if (angles.length === 0) {
            lines.push('- (none)');
        } else {
            for (const angle of angles) {
                lines.push(`- ${angle.id}: ${angle.description || angle.title}`);
            }
        }

        const timing = this.formatRecentTurnTiming();
        if (timing) {
            lines.push('', 'Recent turn timing:', timing);
        }

        lines.push(
            '',
            'Use the phase time remaining as a pressure signal, not a hard timer. Stay with an angle while curiosity and listener value justify it. Move on when the angle has landed enough for the episode structure, especially if remaining phase time is shrinking.',
            '',
            'When your response is working one of these planned angles, set chosenAngle to that angle id.',
            'Keep the same chosenAngle while staying with it.',
            'When you deliberately move to a new planned angle, set chosenAngle to the new id; that marks the previous planned angle complete.'
        );

        return lines.join('\n');
    }

    formatRecentTurnTiming() {
        const lines = this.recentTurns
            .filter((turn) => Number.isFinite(turn.durationMs) && turn.durationMs > 0)
            .slice(-4)
            .map((turn) => `- ${turn.role === 'host' ? 'Alpha-Clawd' : turn.speaker || 'Guest'}: ${formatDuration(turn.durationMs)}`);
        return lines.join('\n');
    }

    snapshot() {
        return {
            basename: this.plan.basename,
            version: this.plan.version,
            currentPhase: this.currentPhase,
            phaseStartedAt: this.phaseStartedAt,
            lastChosenAngle: this.lastChosenAngle,
            completedAngles: Array.from(this.completedAngles),
            activeAngles: Array.from(this.activeAngles),
            recentTurns: this.recentTurns.slice()
        };
    }
}

function durationFromEntry(entry = {}, startedAt, endedAt) {
    const explicitDuration = Number(entry.duration ?? entry.speechDuration);
    if (Number.isFinite(explicitDuration) && explicitDuration > 0) {
        return explicitDuration > 1000 ? explicitDuration : explicitDuration * 1000;
    }
    const start = Date.parse(startedAt || '');
    const end = Date.parse(endedAt || '');
    if (!Number.isNaN(start) && !Number.isNaN(end) && end >= start) {
        return end - start;
    }
    return null;
}

function elapsedMinutes(startedAt, now) {
    const start = Date.parse(startedAt || '');
    const end = Date.parse(now || '');
    if (Number.isNaN(start) || Number.isNaN(end) || end < start) {
        return 0;
    }
    return (end - start) / 60000;
}

function formatMinutes(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
        return '0 minutes';
    }
    const rounded = Math.max(0, Math.round(number));
    return `${rounded} minute${rounded === 1 ? '' : 's'}`;
}

function formatDuration(ms) {
    const seconds = Math.max(0, Math.round(Number(ms || 0) / 1000));
    if (seconds < 60) {
        return `${seconds}s`;
    }
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    return remainder ? `${minutes}m${String(remainder).padStart(2, '0')}s` : `${minutes}m`;
}

function cleanText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

module.exports = {
    EpisodePlanTracker,
    elapsedMinutes,
    formatMinutes
};
