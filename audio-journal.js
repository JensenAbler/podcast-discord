const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const JOURNAL_VERSION = 1;
const DEFAULT_SYNC_INTERVAL_MS = 750;
const DEFAULT_GAP_TOLERANCE_MS = 80;

function safeName(value) {
    return String(value || 'unknown')
        .replace(/[^a-zA-Z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'unknown';
}

function writeJsonAtomic(filePath, value) {
    const tempPath = `${filePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(value, null, 2));
    try {
        fs.renameSync(tempPath, filePath);
    } catch (error) {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            fs.renameSync(tempPath, filePath);
            return;
        }
        throw error;
    }
}

function runFfmpeg(args) {
    return new Promise((resolve, reject) => {
        const process = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        process.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
        });
        process.on('error', reject);
        process.on('exit', (code) => {
            if (code === 0) {
                resolve();
                return;
            }
            reject(new Error(`FFmpeg exited with code ${code}: ${stderr.slice(-2000)}`));
        });
    });
}

class AudioJournal {
    constructor(outputPath, options = {}) {
        this.outputPath = outputPath;
        this.journalDir = path.join(outputPath, 'audio-journal');
        this.sourceDir = path.join(this.journalDir, 'sources');
        this.encodedDir = path.join(this.journalDir, 'encoded');
        this.stemDir = path.join(outputPath, 'stems');
        this.manifestPath = path.join(this.journalDir, 'manifest.json');
        this.eventsPath = path.join(this.journalDir, 'chunks.jsonl');
        this.options = {
            sampleRate: Number(options.sampleRate || 48000),
            channels: Number(options.channels || 2),
            bitDepth: Number(options.bitDepth || 16),
            syncIntervalMs: Number(options.syncIntervalMs || DEFAULT_SYNC_INTERVAL_MS),
            gapToleranceMs: Number(options.gapToleranceMs || DEFAULT_GAP_TOLERANCE_MS)
        };
        this.manifest = null;
        this.eventFd = null;
        this.sourceStates = new Map();
        this.groupCursors = new Map();
        this.sequence = 0;
        this.lastSyncAt = 0;
        this.closed = true;
    }

    start(metadata = {}) {
        fs.mkdirSync(this.sourceDir, { recursive: true });
        fs.mkdirSync(this.encodedDir, { recursive: true });
        fs.mkdirSync(this.stemDir, { recursive: true });

        const startedAt = Number(metadata.startedAt || Date.now());
        this.manifest = {
            version: JOURNAL_VERSION,
            status: 'recording',
            startedAt: new Date(startedAt).toISOString(),
            startedAtMs: startedAt,
            updatedAt: new Date().toISOString(),
            sampleRate: this.options.sampleRate,
            channels: this.options.channels,
            bitDepth: this.options.bitDepth,
            episodeName: metadata.episodeName || 'episode',
            consentGiven: Boolean(metadata.consentGiven),
            consentTimestamp: metadata.consentTimestamp || new Date(startedAt).toISOString()
        };
        writeJsonAtomic(this.manifestPath, this.manifest);
        this.eventFd = fs.openSync(this.eventsPath, 'a');
        this.closed = false;
        this.forceSync();
        return this.manifest;
    }

    bytesPerFrame(sampleRate = this.options.sampleRate, channels = this.options.channels) {
        void sampleRate;
        return channels * (this.options.bitDepth / 8);
    }

    bufferDurationMs(buffer, sampleRate, channels) {
        const frameSize = this.bytesPerFrame(sampleRate, channels);
        return (buffer.length / frameSize / sampleRate) * 1000;
    }

    getSourceState(sourceType, sourceId, sampleRate, channels) {
        const key = `${sourceType}:${sourceId}`;
        let state = this.sourceStates.get(key);
        if (state) return state;

        const fileName = `${safeName(sourceType)}-${safeName(sourceId)}.pcm.part`;
        const filePath = path.join(this.sourceDir, fileName);
        state = {
            key,
            sourceType,
            sourceId,
            fileName,
            filePath,
            fd: fs.openSync(filePath, 'a+'),
            byteOffset: fs.existsSync(filePath) ? fs.statSync(filePath).size : 0,
            nextTimelineOffsetMs: null,
            sampleRate,
            channels
        };
        this.sourceStates.set(key, state);
        return state;
    }

    appendPcm(sourceType, sourceId, buffer, options = {}) {
        if (this.closed || !Buffer.isBuffer(buffer) || buffer.length === 0) return null;

        const sampleRate = Number(options.sampleRate || this.options.sampleRate);
        const channels = Number(options.channels || this.options.channels);
        const capturedAt = Number(options.capturedAt || Date.now());
        const durationMs = this.bufferDurationMs(buffer, sampleRate, channels);
        const state = this.getSourceState(sourceType, sourceId, sampleRate, channels);
        const capturedOffsetMs = Math.max(0, capturedAt - this.manifest.startedAtMs);
        const observedStartMs = Math.max(0, capturedOffsetMs - durationMs);

        let timelineOffsetMs = Number.isFinite(Number(options.timelineOffsetMs))
            ? Math.max(0, Number(options.timelineOffsetMs))
            : observedStartMs;
        if (!Number.isFinite(Number(options.timelineOffsetMs)) && state.nextTimelineOffsetMs !== null) {
            const hasRealGap = observedStartMs > state.nextTimelineOffsetMs + this.options.gapToleranceMs;
            timelineOffsetMs = hasRealGap ? observedStartMs : state.nextTimelineOffsetMs;
        }

        const groupId = options.groupId ? String(options.groupId) : null;
        const groupOffsetMs = Number.isFinite(Number(options.groupOffsetMs))
            ? Number(options.groupOffsetMs)
            : (groupId ? Number(this.groupCursors.get(groupId) || 0) : null);
        const event = {
            type: 'pcm',
            seq: ++this.sequence,
            sourceType,
            sourceId: String(sourceId),
            file: path.relative(this.journalDir, state.filePath).replace(/\\/g, '/'),
            byteOffset: state.byteOffset,
            byteLength: buffer.length,
            capturedAt: new Date(capturedAt).toISOString(),
            capturedAtMs: capturedAt,
            timelineOffsetMs,
            durationMs,
            sampleRate,
            channels,
            volume: Number(options.volume ?? 1),
            groupId,
            groupOffsetMs
        };

        fs.writeSync(state.fd, buffer, 0, buffer.length, state.byteOffset);
        state.byteOffset += buffer.length;
        state.nextTimelineOffsetMs = timelineOffsetMs + durationMs;
        if (groupId) this.groupCursors.set(groupId, groupOffsetMs + durationMs);
        this.appendEvent(event);
        return event;
    }

    appendEncoded(sourceType, sourceId, buffer, options = {}) {
        if (this.closed || !Buffer.isBuffer(buffer) || buffer.length === 0) return null;

        const format = safeName(options.format || 'encoded');
        const fileName = `${String(++this.sequence).padStart(8, '0')}-${safeName(sourceType)}-${safeName(sourceId)}.${format}.part`;
        const filePath = path.join(this.encodedDir, fileName);
        const capturedAt = Number(options.capturedAt || Date.now());
        const startTime = Number(options.startTime);
        const timelineOffsetMs = Number.isFinite(startTime)
            ? Math.max(0, startTime - this.manifest.startedAtMs)
            : Math.max(0, capturedAt - this.manifest.startedAtMs);

        fs.writeFileSync(filePath, buffer);
        const fd = fs.openSync(filePath, 'r+');
        fs.fdatasyncSync(fd);
        fs.closeSync(fd);

        const event = {
            type: 'encoded',
            seq: this.sequence,
            sourceType,
            sourceId: String(sourceId),
            file: path.relative(this.journalDir, filePath).replace(/\\/g, '/'),
            byteLength: buffer.length,
            capturedAt: new Date(capturedAt).toISOString(),
            capturedAtMs: capturedAt,
            timelineOffsetMs,
            volume: Number(options.volume ?? 1),
            format: options.format || 'encoded'
        };
        this.appendEvent(event);
        return event;
    }

    anchorGroup(groupId, startTime) {
        if (this.closed || !groupId) return null;
        const startTimeMs = Number(startTime);
        if (!Number.isFinite(startTimeMs)) return null;

        const event = {
            type: 'anchor',
            seq: ++this.sequence,
            groupId: String(groupId),
            startTime: new Date(startTimeMs).toISOString(),
            timelineOffsetMs: Math.max(0, startTimeMs - this.manifest.startedAtMs)
        };
        this.appendEvent(event);
        return event;
    }

    appendEvent(event) {
        fs.writeSync(this.eventFd, `${JSON.stringify(event)}\n`);
        this.maybeSync();
    }

    maybeSync() {
        const now = Date.now();
        if (now - this.lastSyncAt >= this.options.syncIntervalMs) {
            this.forceSync();
        }
    }

    forceSync() {
        for (const state of this.sourceStates.values()) {
            fs.fdatasyncSync(state.fd);
        }
        if (this.eventFd !== null) fs.fdatasyncSync(this.eventFd);
        this.lastSyncAt = Date.now();
    }

    close() {
        if (this.closed) return;
        this.forceSync();
        for (const state of this.sourceStates.values()) {
            fs.closeSync(state.fd);
        }
        this.sourceStates.clear();
        if (this.eventFd !== null) {
            fs.closeSync(this.eventFd);
            this.eventFd = null;
        }
        this.closed = true;
    }

    readEvents() {
        if (!fs.existsSync(this.eventsPath)) return [];
        return fs.readFileSync(this.eventsPath, 'utf8')
            .split(/\r?\n/)
            .filter(Boolean)
            .flatMap((line) => {
                try {
                    return [JSON.parse(line)];
                } catch {
                    return [];
                }
            })
            .sort((a, b) => Number(a.seq || 0) - Number(b.seq || 0));
    }

    resolveEventTimeline(event, anchors) {
        if (event.groupId && anchors.has(event.groupId) && Number.isFinite(Number(event.groupOffsetMs))) {
            return anchors.get(event.groupId) + Number(event.groupOffsetMs);
        }
        return Number(event.timelineOffsetMs || 0);
    }

    async renderPcmStems(events) {
        fs.mkdirSync(this.stemDir, { recursive: true });
        const anchors = new Map(
            events
                .filter((event) => event.type === 'anchor' && event.groupId)
                .map((event) => [event.groupId, Number(event.timelineOffsetMs || 0)])
        );
        const bySource = new Map();
        for (const event of events) {
            if (event.type !== 'pcm') continue;
            const key = `${event.sourceType}:${event.sourceId}`;
            if (!bySource.has(key)) bySource.set(key, []);
            bySource.get(key).push(event);
        }

        const stems = [];
        for (const [key, sourceEvents] of bySource.entries()) {
            const first = sourceEvents[0];
            const sampleRate = Number(first.sampleRate || this.options.sampleRate);
            const channels = Number(first.channels || this.options.channels);
            const frameSize = this.bytesPerFrame(sampleRate, channels);
            const rawPath = path.join(this.stemDir, `${safeName(first.sourceType)}-${safeName(first.sourceId)}.timeline.raw`);
            const wavPath = path.join(this.stemDir, `${safeName(first.sourceType)}-${safeName(first.sourceId)}.wav`);
            const rawFd = fs.openSync(rawPath, 'w');
            let finalByte = 0;

            try {
                for (const event of sourceEvents) {
                    const sourcePath = path.join(this.journalDir, event.file);
                    if (!fs.existsSync(sourcePath)) continue;
                    const sourceFd = fs.openSync(sourcePath, 'r');
                    const buffer = Buffer.alloc(Number(event.byteLength || 0));
                    let bytesRead = 0;
                    try {
                        bytesRead = fs.readSync(
                            sourceFd,
                            buffer,
                            0,
                            buffer.length,
                            Number(event.byteOffset || 0)
                        );
                    } finally {
                        fs.closeSync(sourceFd);
                    }
                    if (bytesRead <= 0) continue;

                    const timelineMs = Math.max(0, this.resolveEventTimeline(event, anchors));
                    const targetFrame = Math.round((timelineMs / 1000) * sampleRate);
                    const targetByte = targetFrame * frameSize;
                    const alignedLength = bytesRead - (bytesRead % frameSize);
                    if (alignedLength <= 0) continue;
                    fs.writeSync(rawFd, buffer, 0, alignedLength, targetByte);
                    finalByte = Math.max(finalByte, targetByte + alignedLength);
                }
                fs.ftruncateSync(rawFd, finalByte);
                fs.fdatasyncSync(rawFd);
            } finally {
                fs.closeSync(rawFd);
            }

            if (finalByte === 0) {
                fs.unlinkSync(rawPath);
                continue;
            }

            await runFfmpeg([
                '-y',
                '-f', 's16le',
                '-ar', String(sampleRate),
                '-ac', String(channels),
                '-i', rawPath,
                '-c:a', 'pcm_s16le',
                '-ar', String(this.options.sampleRate),
                '-ac', String(this.options.channels),
                wavPath
            ]);
            fs.unlinkSync(rawPath);
            stems.push({
                key,
                sourceType: first.sourceType,
                sourceId: first.sourceId,
                filePath: wavPath,
                volume: Number(first.volume ?? 1)
            });
        }
        return stems;
    }

    async mix(stems, events, outputPath, durationSeconds) {
        const encodedEvents = events.filter((event) => event.type === 'encoded');
        const args = [
            '-y',
            '-f', 'lavfi',
            '-t', String(Math.max(0.1, durationSeconds)),
            '-i', `anullsrc=r=${this.options.sampleRate}:cl=stereo`
        ];
        for (const stem of stems) args.push('-i', stem.filePath);
        for (const event of encodedEvents) {
            const inputPath = path.join(this.journalDir, event.file);
            if (fs.existsSync(inputPath)) args.push('-i', inputPath);
        }

        const filters = [];
        const mixLabels = ['[0:a]'];
        let inputIndex = 1;
        for (let i = 0; i < stems.length; i++) {
            const label = `stem${i}`;
            filters.push(`[${inputIndex}:a]volume=${stems[i].volume}[${label}]`);
            mixLabels.push(`[${label}]`);
            inputIndex++;
        }
        let encodedIndex = 0;
        for (const event of encodedEvents) {
            const inputPath = path.join(this.journalDir, event.file);
            if (!fs.existsSync(inputPath)) continue;
            const delay = Math.max(0, Math.round(Number(event.timelineOffsetMs || 0)));
            const label = `encoded${encodedIndex++}`;
            filters.push(`[${inputIndex}:a]adelay=delays=${delay}|${delay},volume=${Number(event.volume ?? 1)}[${label}]`);
            mixLabels.push(`[${label}]`);
            inputIndex++;
        }
        filters.push(
            `${mixLabels.join('')}amix=inputs=${mixLabels.length}:duration=longest:` +
            'dropout_transition=0.5:normalize=0,dynaudnorm=p=0.95[out]'
        );

        args.push(
            '-filter_complex', `${filters.join(';')}`,
            '-map', '[out]',
            '-c:a', 'pcm_s16le',
            '-ar', String(this.options.sampleRate),
            '-ac', String(this.options.channels),
            outputPath
        );
        await runFfmpeg(args);
    }

    async finalize(options = {}) {
        this.close();
        const recovered = Boolean(options.recovered);
        const stoppedAtMs = Number(options.stoppedAt || Date.now());
        this.manifest.status = 'finalizing';
        this.manifest.updatedAt = new Date().toISOString();
        this.manifest.stoppedAt = new Date(stoppedAtMs).toISOString();
        writeJsonAtomic(this.manifestPath, this.manifest);

        const events = this.readEvents();
        const stems = await this.renderPcmStems(events);
        const outputPath = path.join(this.outputPath, 'mixed-audio.wav');
        const eventEndMs = events.reduce((latest, event) => {
            if (event.type === 'pcm') {
                return Math.max(latest, Number(event.timelineOffsetMs || 0) + Number(event.durationMs || 0));
            }
            return Math.max(latest, Number(event.timelineOffsetMs || 0));
        }, 0);
        const wallDurationMs = Math.max(0, stoppedAtMs - this.manifest.startedAtMs);
        const durationMs = Math.max(eventEndMs, wallDurationMs, 100);
        await this.mix(stems, events, outputPath, durationMs / 1000);

        this.manifest.status = recovered ? 'recovered' : 'complete';
        this.manifest.updatedAt = new Date().toISOString();
        this.manifest.durationMs = durationMs;
        this.manifest.mixedAudio = path.basename(outputPath);
        this.manifest.stems = stems.map((stem) => path.relative(this.outputPath, stem.filePath).replace(/\\/g, '/'));
        writeJsonAtomic(this.manifestPath, this.manifest);
        return {
            outputPath,
            duration: durationMs / 1000,
            recovered,
            stems: this.manifest.stems,
            events: events.length
        };
    }

    static load(outputPath) {
        const manifestPath = path.join(outputPath, 'audio-journal', 'manifest.json');
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const journal = new AudioJournal(outputPath, manifest);
        journal.manifest = manifest;
        journal.sequence = journal.readEvents().reduce((max, event) => Math.max(max, Number(event.seq || 0)), 0);
        journal.closed = true;
        return journal;
    }

    static async recoverIncompleteRecordings(recordingDir) {
        if (!fs.existsSync(recordingDir)) return [];
        const recovered = [];
        const episodeDirs = fs.readdirSync(recordingDir, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && entry.name.startsWith('episode-'))
            .map((entry) => path.join(recordingDir, entry.name));

        for (const episodePath of episodeDirs) {
            const manifestPath = path.join(episodePath, 'audio-journal', 'manifest.json');
            if (!fs.existsSync(manifestPath)) continue;
            try {
                const journal = AudioJournal.load(episodePath);
                if (!['recording', 'finalizing'].includes(journal.manifest.status)) continue;
                const previousStatus = journal.manifest.status;
                const events = journal.readEvents();
                const latestAudioAt = events.reduce((latest, event) => {
                    const capturedAtMs = Number(event.capturedAtMs);
                    const durationMs = event.type === 'pcm' ? Number(event.durationMs || 0) : 0;
                    return Number.isFinite(capturedAtMs)
                        ? Math.max(latest, capturedAtMs + durationMs)
                        : latest;
                }, journal.manifest.startedAtMs);
                const recordedStopAt = Date.parse(journal.manifest.stoppedAt || '');
                const stoppedAt = Number.isFinite(recordedStopAt)
                    ? recordedStopAt
                    : Math.max(journal.manifest.startedAtMs, latestAudioAt);
                const result = await journal.finalize({ recovered: true, stoppedAt });
                const recoveryPath = path.join(episodePath, 'audio-recovery.json');
                writeJsonAtomic(recoveryPath, {
                    recoveredAt: new Date().toISOString(),
                    previousStatus,
                    mixedAudio: path.basename(result.outputPath),
                    duration: result.duration,
                    stems: result.stems,
                    eventCount: result.events
                });
                recovered.push({ episodePath, ...result });
            } catch (error) {
                console.error(`[AudioJournal] Failed to recover ${episodePath}: ${error.message}`);
            }
        }
        return recovered;
    }
}

module.exports = { AudioJournal };
