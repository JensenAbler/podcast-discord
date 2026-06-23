const { PHASES, normalizeEpisodePlan } = require('./episode-plan-store');

class EpisodePlanTracker {
    constructor(plan, options = {}) {
        this.plan = normalizeEpisodePlan(plan || {});
        this.startedAt = options.startedAt || new Date().toISOString();
        this.currentPhaseIndex = Math.max(0, PHASES.indexOf(options.currentPhase || PHASES[0]));
        this.phaseStartedAt = options.phaseStartedAt || this.startedAt;
        this.lastChosenAngle = cleanText(options.lastChosenAngle || '');
        this.currentAngleStartedAt = options.currentAngleStartedAt || null;
        this.currentAngleHostTurns = Math.max(0, Number(options.currentAngleHostTurns || 0));
        this.completedAngles = new Set(Array.isArray(options.completedAngles) ? options.completedAngles : []);
        this.activeAngles = new Set(Array.isArray(options.activeAngles) ? options.activeAngles : []);
        this.recentTurns = Array.isArray(options.recentTurns) ? options.recentTurns.slice(-6) : [];
        this.openingHostSpoken = Boolean(options.openingHostSpoken);
        this.openingGuestSpeakers = new Set(
            Array.isArray(options.openingGuestSpeakers)
                ? options.openingGuestSpeakers.map(normalizeSpeakerName).filter(Boolean)
                : []
        );
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

        if (role === 'host') {
            this.openingHostSpoken = true;
        } else if (this.openingHostSpoken && !this.isOpeningRoundComplete()) {
            const speaker = normalizeSpeakerName(entry.speaker || entry.userId || 'guest');
            if (speaker) {
                this.openingGuestSpeakers.add(speaker);
            }
        }
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
        const now = timing.now || timing.playbackEndedAt || new Date().toISOString();
        if (chosenAngle !== previous) {
            if (previous) {
                this.completedAngles.add(previous);
                this.activeAngles.delete(previous);
            }
            if (plannedIds.has(chosenAngle)) {
                this.activeAngles.add(chosenAngle);
            }
            this.lastChosenAngle = chosenAngle;
            this.currentAngleStartedAt = now;
            this.currentAngleHostTurns = 1;
        } else if (plannedIds.has(chosenAngle)) {
            this.activeAngles.add(chosenAngle);
            this.lastChosenAngle = chosenAngle;
            if (!this.currentAngleStartedAt) {
                this.currentAngleStartedAt = now;
            }
            this.currentAngleHostTurns += 1;
        }

        this.advancePhaseIfNeeded(now);
        return true;
    }

    advancePhaseIfNeeded(now = new Date().toISOString()) {
        while (this.currentPhaseIndex < PHASES.length - 1 && this.getAvailableAngles().length === 0) {
            this.currentPhaseIndex += 1;
            this.phaseStartedAt = now;
            this.currentAngleStartedAt = null;
            this.currentAngleHostTurns = 0;
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
        const availableAngles = this.getAvailableAngles();
        const openingRoundComplete = this.isOpeningRoundComplete();
        const currentAngleElapsed = this.lastChosenAngle && this.currentAngleStartedAt
            ? elapsedMinutes(this.currentAngleStartedAt, now)
            : 0;
        const visibleAngles = openingRoundComplete ? availableAngles : [];
        const timePerRemainingAngle = visibleAngles.length > 0
            ? remaining / visibleAngles.length
            : remaining;
        const lines = [];
        const guestLines = this.formatGuestBriefs();
        if (guestLines) {
            lines.push('Guest background:', guestLines, '');
        }
        if (this.plan.backgroundBrief) {
            lines.push('Episode background:', this.plan.backgroundBrief, '');
        }
        lines.push(
            `Current phase: ${this.currentPhase}.`,
            `Phase target length: ${formatMinutes(target)}.`,
            `Phase elapsed: ${formatMinutes(phaseElapsed)}.`,
            `Phase time remaining: ${formatMinutes(remaining)}.`,
            '',
            `Last turn chosenAngle: ${this.lastChosenAngle || '(none)'}.`,
            `Current angle elapsed: ${this.lastChosenAngle ? formatMinutes(currentAngleElapsed) : '(none)'}.`,
            `Host turns spent on current angle: ${this.lastChosenAngle ? this.currentAngleHostTurns : 0}.`,
            `Phase time remaining per remaining angle: ${visibleAngles.length > 0 ? formatMinutes(timePerRemainingAngle) : '(none)'}.`,
            'The planned angles below are preproduction background knowledge, not things the guest already said in this live conversation.',
            'When using planned background, frame it as background or the episode plan. Only say the guest "mentioned" or "said earlier" when that fact appears in the live transcript.',
            'Available planned angles in this phase:'
        );

        if (!openingRoundComplete) {
            lines.push('- (waiting for each planned guest to respond to the opening)');
        } else if (visibleAngles.length === 0) {
            lines.push('- (none)');
        } else {
            for (const angle of visibleAngles) {
                lines.push(`- ${angle.id}: ${angle.description || angle.title}`);
            }
        }

        if (!openingRoundComplete) {
            lines.push(
                '',
                'Opening round:',
                'Alpha-Clawd has introduced the episode. Let each planned guest respond once before asking the first planned-angle question.',
                `Guests heard in opening round: ${this.formatOpeningGuestSpeakers() || '(none yet)'}.`
            );
        }

        const timing = this.formatRecentTurnTiming();
        if (timing) {
            lines.push('', 'Recent turn timing:', timing);
        }

        lines.push(
            '',
            "Use the phase time remaining as a pressure signal, not a hard timer. A substantive answer does not necessarily complete an angle. When the phase is ahead of schedule, prefer deepening the current angle, asking for examples, tension, stakes, consequences, lived texture, and generally playing with what's alive and curious before moving on.",
            '',
            'When your response is working one of these planned angles, set chosenAngle to that angle id.',
            'Keep the same chosenAngle while staying with it.',
            'When you deliberately move to a new planned angle, set chosenAngle to the new id; that marks the previous planned angle complete.'
        );

        return lines.join('\n');
    }

    formatGuestBriefs() {
        const lines = (Array.isArray(this.plan.guests) ? this.plan.guests : [])
            .map((guest) => {
                const name = cleanText(guest.name);
                if (!name) return '';
                const role = cleanText(guest.role);
                const brief = cleanText(guest.brief);
                const label = role ? `${name} (${role})` : name;
                return brief ? `- ${label}: ${brief}` : `- ${label}`;
            })
            .filter(Boolean);
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
            currentAngleStartedAt: this.currentAngleStartedAt,
            currentAngleHostTurns: this.currentAngleHostTurns,
            completedAngles: Array.from(this.completedAngles),
            activeAngles: Array.from(this.activeAngles),
            recentTurns: this.recentTurns.slice(),
            openingHostSpoken: this.openingHostSpoken,
            openingGuestSpeakers: Array.from(this.openingGuestSpeakers)
        };
    }

    isOpeningRoundComplete() {
        if (!this.openingHostSpoken) {
            return false;
        }

        const expected = this.getExpectedGuestNames();
        if (expected.length === 0) {
            return this.openingGuestSpeakers.size > 0;
        }

        for (const name of expected) {
            if (this.openingGuestSpeakers.has(name)) {
                continue;
            }
            const matched = Array.from(this.openingGuestSpeakers)
                .some((speaker) => speaker.includes(name) || name.includes(speaker));
            if (!matched) {
                return this.openingGuestSpeakers.size >= expected.length;
            }
        }
        return true;
    }

    getExpectedGuestNames() {
        return (Array.isArray(this.plan.guests) ? this.plan.guests : [])
            .map((guest) => normalizeSpeakerName(guest.name))
            .filter(Boolean);
    }

    formatOpeningGuestSpeakers() {
        return Array.from(this.openingGuestSpeakers).join(', ');
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

function normalizeSpeakerName(value) {
    return cleanText(value).toLowerCase();
}

module.exports = {
    EpisodePlanTracker,
    elapsedMinutes,
    formatMinutes
};
