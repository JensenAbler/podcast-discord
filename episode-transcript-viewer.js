const fs = require('fs');
const http = require('http');
const path = require('path');
const { URL } = require('url');
const { EpisodePostProcessor } = require('./post-processor');
const { getRecordingDir } = require('./paths');

const DEFAULT_VIEWER_DIR = path.join(__dirname, 'episode-viewer');

class EpisodeTranscriptStore {
    constructor(options = {}) {
        this.recordingDir = path.resolve(options.recordingDir || getRecordingDir());
        this.processor = options.processor || new EpisodePostProcessor({
            recordingDir: this.recordingDir
        });
    }

    listEpisodes() {
        if (!fs.existsSync(this.recordingDir)) {
            return [];
        }

        return fs.readdirSync(this.recordingDir, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && this.isSafeEpisodeId(entry.name))
            .map((entry) => this.getEpisodeSummary(entry.name))
            .filter(Boolean)
            .sort((a, b) => b.sortTime - a.sortTime)
            .map(({ sortTime, ...episode }) => episode);
    }

    getEpisodeSummary(id) {
        const episodePath = this.getEpisodePath(id);
        if (!episodePath) return null;

        const metadata = this.readEpisodeMetadata(episodePath);
        const transcriptPath = path.join(episodePath, 'transcript.jsonl');
        const thoughtsPath = path.join(episodePath, 'internal-thoughts.jsonl');
        const audio = this.findEpisodeAudio(episodePath);
        const stat = fs.statSync(episodePath);
        const startedAt = metadata.startedAt ||
            metadata.startTime ||
            metadata.episode?.recordedAt ||
            this.parseEpisodeStartFromId(id) ||
            stat.mtime.toISOString();

        return {
            id,
            path: episodePath,
            startedAt,
            stoppedAt: metadata.stoppedAt || metadata.stopTime || null,
            duration: metadata.duration || metadata.episode?.duration || 0,
            hasTranscript: fs.existsSync(transcriptPath),
            hasInternalThoughts: fs.existsSync(thoughtsPath),
            hasAudio: Boolean(audio),
            audioFile: audio?.filename || null,
            audioBytes: audio?.bytes || 0,
            transcriptCount: this.countJsonlLines(transcriptPath),
            internalThoughtCount: this.countJsonlLines(thoughtsPath),
            sortTime: this.toMs(startedAt) || stat.mtimeMs
        };
    }

    getEpisode(id) {
        const episodePath = this.getEpisodePath(id);
        if (!episodePath) {
            return null;
        }

        const summary = this.getEpisodeSummary(id);
        const metadata = this.readEpisodeMetadata(episodePath);
        const transcriptPath = path.join(episodePath, 'transcript.jsonl');
        const thoughtsPath = path.join(episodePath, 'internal-thoughts.jsonl');
        const transcript = this.readTranscript(transcriptPath, metadata);
        const thoughts = this.readInternalThoughts(thoughtsPath);
        const utterances = this.attachInjectedThoughts(transcript.utterances, thoughts.injectedThoughts);

        return {
            episode: {
                ...summary,
                files: this.listEpisodeFiles(episodePath),
                metadata
            },
            utterances,
            thoughts: thoughts.records,
            parseErrors: [
                ...transcript.parseErrors,
                ...thoughts.parseErrors
            ]
        };
    }

    getEpisodeAudio(id) {
        const episodePath = this.getEpisodePath(id);
        return episodePath ? this.findEpisodeAudio(episodePath) : null;
    }

    readTranscript(transcriptPath, metadata = {}) {
        if (!fs.existsSync(transcriptPath)) {
            return { utterances: [], parseErrors: [] };
        }

        try {
            const result = this.processor.buildTranscriptFromJsonl(transcriptPath, metadata);
            const baseTime = this.processor.getRecordingStartMs(metadata);
            return {
                utterances: result.utterances.map((entry, index) => this.normalizeUtterance(entry, index, baseTime)),
                parseErrors: []
            };
        } catch (error) {
            return {
                utterances: [],
                parseErrors: [`transcript.jsonl: ${error.message}`]
            };
        }
    }

    readInternalThoughts(thoughtsPath) {
        const parsed = this.parseJsonlFile(thoughtsPath);
        const records = parsed.records
            .map((record, index) => this.normalizeThoughtRecord(record, index))
            .filter(Boolean);

        return {
            records,
            injectedThoughts: records.filter((record) => record.awarenessInjection),
            parseErrors: parsed.errors
        };
    }

    attachInjectedThoughts(utterances = [], injectedThoughts = []) {
        const pending = injectedThoughts
            .map((thought) => ({
                ...thought,
                remainingTurns: Math.max(1, Number(thought.expiresAfterTurns || thought.remainingTurns || 1))
            }))
            .filter((thought) => Number.isFinite(thought.createdAtMs))
            .sort((a, b) => a.createdAtMs - b.createdAtMs);

        const byId = new Map(pending.map((thought) => [thought.id, thought]).filter(([id]) => id));
        const byPacket = new Map(pending.map((thought) => [thought.packetId, thought]).filter(([packetId]) => packetId));
        const byAwareness = new Map(pending.map((thought) => [thought.awarenessInjection, thought]).filter(([text]) => text));

        const active = [];
        let nextThoughtIndex = 0;

        return utterances.map((utterance) => {
            const entryTimeMs = Number.isFinite(utterance.sortTimeMs)
                ? utterance.sortTimeMs
                : this.toMs(utterance.timestamp);

            while (
                nextThoughtIndex < pending.length &&
                Number.isFinite(entryTimeMs) &&
                pending[nextThoughtIndex].createdAtMs <= entryTimeMs
            ) {
                active.push({ ...pending[nextThoughtIndex] });
                nextThoughtIndex += 1;
            }

            const exact = this.normalizeExactInjectedThoughts(utterance, { byId, byPacket, byAwareness });
            const injected = this.isHostUtterance(utterance)
                ? (exact.length > 0 ? exact : active.map((thought) => this.toInjectedThoughtView(thought)))
                : [];

            if (!this.isHostUtterance(utterance)) {
                for (const thought of active) {
                    thought.remainingTurns -= 1;
                }
                for (let index = active.length - 1; index >= 0; index -= 1) {
                    if (active[index].remainingTurns <= 0) {
                        active.splice(index, 1);
                    }
                }
            }

            return {
                ...utterance,
                injectedThoughts: injected
            };
        });
    }

    normalizeExactInjectedThoughts(utterance, indexes) {
        const raw = utterance.injectedAwarenessInjections ||
            utterance.awarenessInjections ||
            utterance.activeAwarenessInjections ||
            [];

        return (Array.isArray(raw) ? raw : [])
            .map((item) => {
                const id = this.cleanText(item?.id || '');
                const packetId = this.cleanText(item?.packetId || '');
                const awarenessInjection = this.cleanText(typeof item === 'string'
                    ? item
                    : item?.awarenessInjection || item?.text || '');
                const match = indexes.byId.get(id) ||
                    indexes.byPacket.get(packetId) ||
                    indexes.byAwareness.get(awarenessInjection);

                return this.toInjectedThoughtView({
                    ...(match || {}),
                    id: id || match?.id || '',
                    packetId: packetId || match?.packetId || '',
                    awarenessInjection: awarenessInjection || match?.awarenessInjection || '',
                    reason: this.cleanText(item?.reason || match?.reason || ''),
                    internalThought: this.cleanText(item?.internalThought || item?.thought || match?.internalThought || '')
                });
            })
            .filter((item) => item.internalThought || item.awarenessInjection);
    }

    toInjectedThoughtView(thought = {}) {
        return {
            id: thought.id || '',
            packetId: thought.packetId || '',
            createdAt: thought.createdAt || null,
            internalThought: thought.internalThought || '',
            awarenessInjection: thought.awarenessInjection || '',
            reason: thought.reason || ''
        };
    }

    normalizeUtterance(entry, index, baseTime) {
        const timestamp = this.processor.getTranscriptTimestampValue(entry);
        const sortTime = this.processor.getSortTimestamp(entry);
        return {
            id: `utterance-${index + 1}`,
            index,
            speaker: entry.speaker || 'Unknown',
            speakerRole: entry.speakerRole || 'guest',
            text: entry.text || '',
            timestamp,
            displayTime: this.processor.formatTranscriptTimestamp(entry, baseTime),
            sortTimeMs: typeof sortTime === 'number' ? sortTime : this.toMs(sortTime),
            source: entry.source || null,
            fallbackReason: entry.fallbackReason || null,
            providerError: entry.providerError || null,
            bigBrainRunId: entry.bigBrainRunId || null,
            injectedAwarenessInjections: entry.injectedAwarenessInjections || entry.awarenessInjections || null
        };
    }

    normalizeThoughtRecord(record, index) {
        if (!record || record.type === 'internal_thought_error') {
            return null;
        }

        const thought = record.thought || {};
        const awarenessInjection = record.awarenessInjection || null;
        const createdAt = awarenessInjection?.createdAt || record.processedAt || record.createdAt || null;

        return {
            id: awarenessInjection?.id || '',
            index,
            packetId: record.packetId || thought.packetId || awarenessInjection?.packetId || '',
            packetReason: record.packetReason || '',
            createdAt,
            createdAtMs: this.toMs(createdAt),
            internalThought: this.cleanText(thought.internalThought || ''),
            noticings: this.normalizeStringArray(thought.noticings),
            undercurrents: this.normalizeStringArray(thought.undercurrents),
            awarenessCandidate: this.cleanText(record.awarenessCandidate?.candidateAwarenessNote || ''),
            awarenessInjection: this.cleanText(awarenessInjection?.awarenessInjection || ''),
            reason: this.cleanText(awarenessInjection?.reason || record.discernment?.reason || ''),
            expiresAfterTurns: Number(awarenessInjection?.expiresAfterTurns || record.discernment?.expiresAfterTurns || 0),
            remainingTurns: Number(awarenessInjection?.remainingTurns || 0)
        };
    }

    getEpisodePath(id) {
        if (!this.isSafeEpisodeId(id)) {
            return null;
        }

        const episodePath = path.join(this.recordingDir, id);
        const resolved = path.resolve(episodePath);
        const root = `${this.recordingDir}${path.sep}`;
        if (!resolved.startsWith(root) || !fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
            return null;
        }

        return resolved;
    }

    isSafeEpisodeId(id) {
        return /^episode-[A-Za-z0-9._-]+$/.test(String(id || ''));
    }

    readEpisodeMetadata(episodePath) {
        return this.readJsonFile(path.join(episodePath, 'episode-complete.json')) ||
            this.readJsonFile(path.join(episodePath, 'episode-metadata.json')) ||
            {};
    }

    readJsonFile(filePath) {
        try {
            if (!fs.existsSync(filePath)) return null;
            return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        } catch {
            return null;
        }
    }

    parseJsonlFile(filePath) {
        if (!fs.existsSync(filePath)) {
            return { records: [], errors: [] };
        }

        const records = [];
        const errors = [];
        const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
        lines.forEach((line, index) => {
            const trimmed = line.trim();
            if (!trimmed) return;
            try {
                records.push(JSON.parse(trimmed));
            } catch (error) {
                errors.push(`${path.basename(filePath)} line ${index + 1}: ${error.message}`);
            }
        });
        return { records, errors };
    }

    countJsonlLines(filePath) {
        if (!fs.existsSync(filePath)) return 0;
        return fs.readFileSync(filePath, 'utf8')
            .split(/\r?\n/)
            .filter((line) => line.trim().length > 0)
            .length;
    }

    listEpisodeFiles(episodePath) {
        return fs.existsSync(episodePath)
            ? fs.readdirSync(episodePath).sort()
            : [];
    }

    findEpisodeAudio(episodePath) {
        if (!fs.existsSync(episodePath)) return null;

        const files = fs.readdirSync(episodePath);
        const preferred = ['mixed-audio.wav', 'recording.wav', 'episode.wav'];
        const filename = preferred.find((name) => files.includes(name)) ||
            files.find((name) => /\.wav$/i.test(name));

        if (!filename) return null;

        const filePath = path.resolve(episodePath, filename);
        const root = `${path.resolve(episodePath)}${path.sep}`;
        if (!filePath.startsWith(root) || !fs.statSync(filePath).isFile()) {
            return null;
        }

        const stat = fs.statSync(filePath);
        return {
            filename,
            filePath,
            bytes: stat.size
        };
    }

    parseEpisodeStartFromId(id) {
        const match = String(id || '').match(/^episode-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)$/);
        if (!match) return null;
        return match[1].replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, 'T$1:$2:$3.$4Z');
    }

    isHostUtterance(utterance = {}) {
        return utterance.speakerRole === 'host' || /^alpha-clawd$/i.test(String(utterance.speaker || ''));
    }

    normalizeStringArray(value) {
        return (Array.isArray(value) ? value : [])
            .map((item) => this.cleanText(item))
            .filter(Boolean);
    }

    cleanText(value) {
        return String(value || '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    toMs(value) {
        if (typeof value === 'number') {
            return value > 1000 ? value : value * 1000;
        }
        const parsed = Date.parse(value);
        return Number.isNaN(parsed) ? null : parsed;
    }
}

function createEpisodeTranscriptRequestHandler(options = {}) {
    const store = options.store || new EpisodeTranscriptStore(options);
    const viewerDir = path.resolve(options.viewerDir || DEFAULT_VIEWER_DIR);
    const basePath = normalizeMountPath(options.basePath || '');
    const requireAuth = Boolean(options.requireAuth);
    const authToken = options.authToken || '';

    return async function handleEpisodeTranscriptRequest(req, res) {
        const requestUrl = new URL(req.url, 'http://localhost');
        const pathname = decodeURIComponent(requestUrl.pathname);
        const relativePath = getRelativePath(pathname, basePath);
        if (relativePath === null) {
            return false;
        }

        setCommonHeaders(res);

        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return true;
        }

        if (req.method !== 'GET') {
            sendJson(res, 405, { error: 'Method not allowed' });
            return true;
        }

        if (relativePath === '/api/episodes' || relativePath === '/api/episodes/') {
            if (!isAuthorized(req, requestUrl, requireAuth, authToken)) {
                sendJson(res, 401, { error: 'Unauthorized' });
                return true;
            }
            sendJson(res, 200, {
                recordingDir: store.recordingDir,
                episodes: store.listEpisodes()
            });
            return true;
        }

        const audioMatch = relativePath.match(/^\/api\/episodes\/([^/]+)\/audio$/);
        if (audioMatch) {
            if (!isAuthorized(req, requestUrl, requireAuth, authToken)) {
                sendJson(res, 401, { error: 'Unauthorized' });
                return true;
            }
            const audio = store.getEpisodeAudio(audioMatch[1]);
            if (!audio) {
                sendJson(res, 404, { error: 'Episode audio not found' });
                return true;
            }
            sendAudioFile(req, res, audio);
            return true;
        }

        const episodeMatch = relativePath.match(/^\/api\/episodes\/([^/]+)$/);
        if (episodeMatch) {
            if (!isAuthorized(req, requestUrl, requireAuth, authToken)) {
                sendJson(res, 401, { error: 'Unauthorized' });
                return true;
            }
            const episode = store.getEpisode(episodeMatch[1]);
            if (!episode) {
                sendJson(res, 404, { error: 'Episode not found' });
                return true;
            }
            sendJson(res, 200, episode);
            return true;
        }

        if (relativePath === '/' || relativePath === '') {
            serveStaticFile(res, viewerDir, 'index.html');
            return true;
        }

        serveStaticFile(res, viewerDir, relativePath.replace(/^\/+/, ''));
        return true;
    };
}

function createEpisodeTranscriptServer(options = {}) {
    const handler = createEpisodeTranscriptRequestHandler(options);
    return http.createServer((req, res) => {
        Promise.resolve(handler(req, res)).then((handled) => {
            if (!handled && !res.headersSent) {
                sendJson(res, 404, { error: 'Not found' });
            }
        }).catch((error) => {
            console.error('[EpisodeTranscriptViewer] Request failed:', error);
            if (!res.headersSent) {
                sendJson(res, 500, { error: 'Internal server error' });
            } else {
                res.end();
            }
        });
    });
}

function startEpisodeTranscriptServer(options = {}) {
    const port = Number(options.port || process.env.TRANSCRIPT_VIEWER_PORT || 4578);
    const host = options.host || process.env.TRANSCRIPT_VIEWER_HOST || '127.0.0.1';
    const server = createEpisodeTranscriptServer(options);
    server.listen(port, host, () => {
        console.log(`[EpisodeTranscriptViewer] Serving ${options.recordingDir || getRecordingDir()} at http://${host}:${port}/`);
    });
    return server;
}

function normalizeMountPath(value) {
    const normalized = String(value || '').trim().replace(/\/+$/, '');
    if (!normalized || normalized === '/') return '';
    return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

function getRelativePath(pathname, basePath) {
    if (!basePath) {
        return pathname || '/';
    }
    if (pathname === basePath) {
        return '/';
    }
    if (pathname.startsWith(`${basePath}/`)) {
        return pathname.slice(basePath.length) || '/';
    }
    return null;
}

function isAuthorized(req, requestUrl, requireAuth, authToken) {
    if (!requireAuth) return true;
    const header = req.headers.authorization || '';
    const queryToken = requestUrl?.searchParams?.get('token') || requestUrl?.searchParams?.get('access_token') || '';
    return Boolean(authToken) && (
        header === `Bearer ${authToken}` ||
        queryToken === authToken
    );
}

function setCommonHeaders(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function sendJson(res, statusCode, payload) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload));
}

function sendAudioFile(req, res, audio) {
    const totalBytes = audio.bytes;
    const range = req.headers.range || '';
    const commonHeaders = {
        'Accept-Ranges': 'bytes',
        'Content-Type': 'audio/wav',
        'Content-Disposition': `inline; filename="${audio.filename.replace(/"/g, '')}"`
    };

    if (range) {
        const parsed = parseRangeHeader(range, totalBytes);
        if (!parsed) {
            res.writeHead(416, {
                ...commonHeaders,
                'Content-Range': `bytes */${totalBytes}`
            });
            res.end();
            return;
        }

        res.writeHead(206, {
            ...commonHeaders,
            'Content-Length': parsed.end - parsed.start + 1,
            'Content-Range': `bytes ${parsed.start}-${parsed.end}/${totalBytes}`
        });
        fs.createReadStream(audio.filePath, { start: parsed.start, end: parsed.end }).pipe(res);
        return;
    }

    res.writeHead(200, {
        ...commonHeaders,
        'Content-Length': totalBytes
    });
    fs.createReadStream(audio.filePath).pipe(res);
}

function parseRangeHeader(range, totalBytes) {
    const match = String(range || '').match(/^bytes=(\d*)-(\d*)$/);
    if (!match || totalBytes <= 0) return null;

    let start;
    let end;

    if (match[1] === '' && match[2] !== '') {
        const suffixLength = Number(match[2]);
        if (!Number.isInteger(suffixLength) || suffixLength <= 0) return null;
        start = Math.max(totalBytes - suffixLength, 0);
        end = totalBytes - 1;
    } else {
        start = Number(match[1]);
        end = match[2] === '' ? totalBytes - 1 : Number(match[2]);
    }

    if (
        !Number.isInteger(start) ||
        !Number.isInteger(end) ||
        start < 0 ||
        end < start ||
        start >= totalBytes
    ) {
        return null;
    }

    return {
        start,
        end: Math.min(end, totalBytes - 1)
    };
}

function serveStaticFile(res, rootDir, requestPath) {
    const safePath = path.normalize(requestPath).replace(/^(\.\.[/\\])+/, '');
    const filePath = path.resolve(rootDir, safePath);
    const root = `${rootDir}${path.sep}`;
    if (!filePath.startsWith(root) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        sendJson(res, 404, { error: 'Not found' });
        return;
    }

    res.writeHead(200, { 'Content-Type': getMimeType(filePath) });
    fs.createReadStream(filePath).pipe(res);
}

function getMimeType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return {
        '.html': 'text/html; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.svg': 'image/svg+xml',
        '.wav': 'audio/wav'
    }[ext] || 'application/octet-stream';
}

function parseArgs(argv = process.argv.slice(2)) {
    const options = {};
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--port') options.port = argv[++index];
        else if (arg === '--host') options.host = argv[++index];
        else if (arg === '--recording-dir') options.recordingDir = argv[++index];
        else if (arg === '--auth-token') {
            options.authToken = argv[++index];
            options.requireAuth = true;
        }
    }
    return options;
}

if (require.main === module) {
    startEpisodeTranscriptServer(parseArgs());
}

module.exports = {
    EpisodeTranscriptStore,
    createEpisodeTranscriptRequestHandler,
    createEpisodeTranscriptServer,
    startEpisodeTranscriptServer
};
