const fs = require('fs');
const path = require('path');
const { getEpisodePlanDir } = require('./paths');

const PHASES = ['expanding', 'developing', 'converging', 'closing'];

class EpisodePlanStore {
    constructor(options = {}) {
        this.rootDir = options.rootDir || getEpisodePlanDir();
        this.now = options.now || (() => new Date().toISOString());
    }

    getPlanRoot(basename) {
        return path.join(this.rootDir, sanitizeBasename(basename));
    }

    getVersionDir(basename, version) {
        return path.join(this.getPlanRoot(basename), normalizeVersion(version));
    }

    getPlanPath(basename, version) {
        return path.join(this.getVersionDir(basename, version), 'episode-plan.json');
    }

    savePlan(plan, options = {}) {
        const normalized = normalizeEpisodePlan(plan, {
            basename: options.basename,
            version: options.version
        });
        const versionDir = this.getVersionDir(normalized.basename, normalized.version);
        fs.mkdirSync(versionDir, { recursive: true });
        const planPath = path.join(versionDir, 'episode-plan.json');
        fs.writeFileSync(planPath, `${JSON.stringify(normalized, null, 2)}\n`);
        return {
            plan: normalized,
            path: planPath,
            versionDir
        };
    }

    saveNextVersion(plan, options = {}) {
        const basename = sanitizeBasename(options.basename || plan.basename || deriveBasenameFromPlan(plan));
        const version = options.version || this.nextVersion(basename);
        return this.savePlan({ ...plan, basename, version }, { basename, version });
    }

    appendSessionRecord(basename, record = {}) {
        const cleanBase = sanitizeBasename(basename);
        const planRoot = this.getPlanRoot(cleanBase);
        fs.mkdirSync(planRoot, { recursive: true });
        const logPath = path.join(planRoot, 'planning-session.jsonl');
        fs.appendFileSync(logPath, `${JSON.stringify({
            createdAt: this.now(),
            ...record
        })}\n`);
        return logPath;
    }

    nextVersion(basename) {
        const versions = this.listVersionsForBasename(basename)
            .map((item) => parseVersionNumber(item.version))
            .filter((value) => Number.isInteger(value) && value > 0);
        const next = versions.length ? Math.max(...versions) + 1 : 1;
        return formatVersion(next);
    }

    loadPlan(ref) {
        const parsed = parsePlanRef(ref);
        if (!parsed) {
            throw new Error(`Invalid episode plan reference: ${ref}`);
        }
        const planPath = parsed.path || this.getPlanPath(parsed.basename, parsed.version);
        if (!fs.existsSync(planPath)) {
            throw new Error(`Episode plan not found: ${planPath}`);
        }
        const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
        return {
            plan: normalizeEpisodePlan(plan),
            path: planPath
        };
    }

    listPlanVersions(query = '') {
        const root = this.rootDir;
        if (!fs.existsSync(root)) {
            return [];
        }
        const needle = String(query || '').trim().toLowerCase();
        const items = [];
        for (const baseEntry of fs.readdirSync(root, { withFileTypes: true })) {
            if (!baseEntry.isDirectory()) continue;
            const basename = sanitizeBasename(baseEntry.name);
            for (const version of this.listVersionsForBasename(basename)) {
                const label = `${basename} · ${version.version}`;
                if (
                    needle &&
                    !basename.toLowerCase().includes(needle) &&
                    !version.version.toLowerCase().includes(needle) &&
                    !label.toLowerCase().includes(needle)
                ) {
                    continue;
                }
                items.push({
                    basename,
                    version: version.version,
                    label,
                    value: `${basename}@${version.version}`,
                    path: version.path,
                    updatedAt: version.updatedAt
                });
            }
        }
        return items.sort((a, b) => {
            const time = String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
            if (time !== 0) return time;
            if (a.basename === b.basename) {
                return parseVersionNumber(b.version) - parseVersionNumber(a.version);
            }
            return `${a.basename}@${a.version}`.localeCompare(`${b.basename}@${b.version}`);
        });
    }

    listVersionsForBasename(basename) {
        const planRoot = this.getPlanRoot(basename);
        if (!fs.existsSync(planRoot)) {
            return [];
        }
        return fs.readdirSync(planRoot, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && /^v\d{3,}$/i.test(entry.name))
            .map((entry) => {
                const planPath = path.join(planRoot, entry.name, 'episode-plan.json');
                if (!fs.existsSync(planPath)) return null;
                let updatedAt = null;
                try {
                    updatedAt = fs.statSync(planPath).mtime.toISOString();
                } catch {}
                return {
                    version: normalizeVersion(entry.name),
                    path: planPath,
                    updatedAt
                };
            })
            .filter(Boolean)
            .sort((a, b) => parseVersionNumber(b.version) - parseVersionNumber(a.version));
    }
}

function normalizeEpisodePlan(plan = {}, options = {}) {
    const basename = sanitizeBasename(options.basename || plan.basename || deriveBasenameFromPlan(plan));
    const version = normalizeVersion(options.version || plan.version || 'v001');
    const targetDurationMinutes = parsePositiveNumber(plan.targetDurationMinutes, 90);
    const guests = normalizeGuests(plan.guests);
    const backgroundBrief = cleanMultiline(plan.backgroundBrief || '');
    const phases = normalizePhases(plan.phases, targetDurationMinutes);
    const floatingAngles = normalizeAngles(plan.floatingAngles || plan.unscheduledAngles || plan.reserveAngles);

    return {
        basename,
        version,
        targetDurationMinutes,
        guests,
        backgroundBrief,
        floatingAngles,
        phases
    };
}

function normalizePhases(rawPhases, targetDurationMinutes = 90) {
    const source = rawPhases && typeof rawPhases === 'object' && !Array.isArray(rawPhases)
        ? rawPhases
        : {};
    const defaultMinutes = Math.max(1, Math.round(targetDurationMinutes / PHASES.length));
    const phases = {};
    for (const phase of PHASES) {
        const value = source[phase] && typeof source[phase] === 'object'
            ? source[phase]
            : {};
        phases[phase] = {
            targetMinutes: parsePositiveNumber(value.targetMinutes, defaultMinutes),
            angles: normalizeAngles(value.angles || value.plannedAngles)
        };
    }
    return phases;
}

function normalizeAngles(value) {
    const angles = Array.isArray(value) ? value : [];
    const seen = new Set();
    return angles
        .map((angle, index) => {
            if (typeof angle === 'string') {
                const title = cleanText(angle);
                if (!title) return null;
                const id = uniqueId(slugify(title) || `angle-${index + 1}`, seen);
                return { id, title, description: title };
            }
            if (!angle || typeof angle !== 'object') return null;
            const title = cleanText(angle.title || angle.name || angle.id || `Angle ${index + 1}`);
            const description = cleanText(angle.description || angle.summary || title);
            const id = uniqueId(slugify(angle.id || title) || `angle-${index + 1}`, seen);
            return { id, title, description };
        })
        .filter(Boolean);
}

function normalizeGuests(value) {
    const guests = Array.isArray(value) ? value : [];
    const seen = new Set();
    return guests
        .map((guest) => {
            if (typeof guest === 'string') {
                const name = cleanText(guest);
                return name ? { name, role: '' } : null;
            }
            if (!guest || typeof guest !== 'object') return null;
            const name = cleanText(guest.name || guest.speaker || guest.displayName);
            if (!name || seen.has(name.toLowerCase())) return null;
            seen.add(name.toLowerCase());
            return {
                name,
                role: cleanText(guest.role || '')
            };
        })
        .filter(Boolean);
}

function parsePlanRef(value) {
    const text = String(value || '').trim();
    if (!text) return null;
    if (text.endsWith('episode-plan.json') || path.isAbsolute(text)) {
        return { path: text };
    }
    const match = text.match(/^([a-z0-9][a-z0-9-]*)@?(v\d{3,})$/i)
        || text.match(/^([a-z0-9][a-z0-9-]*)[/:](v\d{3,})$/i);
    if (!match) return null;
    return {
        basename: sanitizeBasename(match[1]),
        version: normalizeVersion(match[2])
    };
}

function deriveBasenameFromPlan(plan = {}) {
    const guests = normalizeGuests(plan.guests)
        .map((guest) => guest.name)
        .join(' ');
    const brief = cleanText(plan.backgroundBrief || '');
    const firstAngle = PHASES
        .flatMap((phase) => normalizeAngles(plan.phases?.[phase]?.angles || []))
        .concat(normalizeAngles(plan.floatingAngles || plan.unscheduledAngles || plan.reserveAngles))
        .map((angle) => angle.title)
        .find(Boolean);
    return slugify([guests, firstAngle, brief].filter(Boolean).join(' ').slice(0, 80)) || 'episode-plan';
}

function sanitizeBasename(value) {
    return slugify(value) || 'episode-plan';
}

function slugify(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/['"]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80);
}

function uniqueId(base, seen) {
    let candidate = base;
    let suffix = 2;
    while (seen.has(candidate)) {
        candidate = `${base}-${suffix}`;
        suffix += 1;
    }
    seen.add(candidate);
    return candidate;
}

function normalizeVersion(value) {
    const text = String(value || '').trim().toLowerCase();
    const match = text.match(/v?(\d+)/);
    if (!match) return 'v001';
    return formatVersion(Number.parseInt(match[1], 10));
}

function formatVersion(number) {
    return `v${String(Math.max(1, Number(number) || 1)).padStart(3, '0')}`;
}

function parseVersionNumber(version) {
    const match = String(version || '').match(/v?(\d+)/i);
    return match ? Number.parseInt(match[1], 10) : null;
}

function parsePositiveNumber(value, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) {
        return fallback;
    }
    return Math.round(number);
}

function cleanText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function cleanMultiline(value) {
    return String(value || '')
        .replace(/\r\n/g, '\n')
        .replace(/[ \t]+\n/g, '\n')
        .trim();
}

module.exports = {
    EpisodePlanStore,
    PHASES,
    normalizeEpisodePlan,
    normalizePhases,
    normalizeAngles,
    parsePlanRef,
    sanitizeBasename,
    normalizeVersion
};
