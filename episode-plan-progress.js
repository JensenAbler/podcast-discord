'use strict';
const fs = require('fs');
const path = require('path');
const { PHASES } = require('./episode-plan-store');

function savePlanProgress(tracker, directory, now = new Date().toISOString()) {
    if (!tracker || !directory) return;
    const file = path.join(directory, 'episode-plan-state.json');
    const checkpoint = { schemaVersion: 1, savedAt: now, state: tracker.snapshot() };
    fs.writeFileSync(file + '.tmp', JSON.stringify(checkpoint, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(file + '.tmp', file);
    return checkpoint;
}

function validatePlanProgress(checkpoint, plan) {
    const s = checkpoint?.state;
    if (checkpoint?.schemaVersion !== 1 || !Number.isFinite(Date.parse(checkpoint.savedAt)) ||
        !s || !plan || s.basename !== plan.basename || s.version !== plan.version ||
        !PHASES.includes(s.currentPhase) ||
        !Number.isFinite(Date.parse(s.phaseStartedAt)) ||
        !Number.isFinite(s.currentAngleHostTurns) || s.currentAngleHostTurns < 0 ||
        typeof s.lastChosenAngle !== 'string' ||
        ['completedAngles', 'activeAngles', 'openingGuestSpeakers', 'closingThoughtSpeakers'].some(
            key => !Array.isArray(s[key]) || s[key].some(value => typeof value !== 'string')) ||
        !Array.isArray(s.recentTurns) ||
        ['openingHostSpoken', 'closingThoughtsQueued', 'closingThoughtsRequested'].some(
            key => typeof s[key] !== 'boolean') ||
        ['startedAt', 'currentAngleStartedAt', 'closingThoughtsQueuedAt', 'closingThoughtsRequestedAt'].some(
            key => s[key] != null && !Number.isFinite(Date.parse(s[key])))) {
        throw new Error('Invalid saved episode plan progress or mismatched plan version');
    }
    return checkpoint;
}

function resumePlanOptions(checkpoint, plan, now = new Date().toISOString()) {
    validatePlanProgress(checkpoint, plan);
    const state = structuredClone(checkpoint.state);
    const pause = Math.max(0, Date.parse(now) - Date.parse(checkpoint.savedAt));
    for (const key of ['startedAt', 'phaseStartedAt', 'currentAngleStartedAt',
        'closingThoughtsQueuedAt', 'closingThoughtsRequestedAt']) {
        if (state[key]) state[key] = new Date(Date.parse(state[key]) + pause).toISOString();
    }
    return state;
}
module.exports = { savePlanProgress, validatePlanProgress, resumePlanOptions };
