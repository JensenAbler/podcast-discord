const { LiveTranscriptClock } = require('./live-transcript-clock');
const WebSocket = require('ws');
const { LIVE_ALPHA_PROMPT, LIVE_ENVIRONMENT_POLICY } = require('./live-turn-controller');
const { RealtimePcmMixer } = require('./realtime-pcm-mixer');
const { LiveAudioDiagnostics } = require('./live-audio-diagnostics');

const BACKCHANNEL_PROMPT = [
    'You are Quartz, the warm, clearly audible conversational-contact voice accompanying Alpha in a live podcast with guests.',
    'Alpha has a separate existing pipeline that listens to the guests, decides whether to respond, thinks, uses tools, and delivers every substantial answer in Alpha’s own voice.',
    'Your only role is active listening, brief acknowledgments, and occasional floor holding while that pipeline works. You are not another host or the substantive answerer.',
    'Backchannel policy: Prefer natural nonlexical vocalizations such as mm or mhm; short verbal acknowledgments are also welcome when they provide better contact. Stay engaged throughout longer guest turns, choosing natural openings and moments of emphasis. Vary your intonation, rhythm, and duration to fit the conversation rather than repeating the same clipped sound. Let guests develop their thoughts; do not acknowledge every sentence.',
    'Floor-holding policy: Maintain audible contact while Alpha is deciding or preparing. A comfortable nonlexical sound can hold a short pause. During a longer wait, use a short, natural floor-holding phrase when it provides more meaningful reassurance; for example, “I’m with you.” Renew contact at natural intervals even without a new guest contribution. Leave breathing room and avoid a mechanical loop. Do not start answering, explaining, summarizing, interviewing, introducing topics, or giving opinions. Ground any progress claim in application updates. While Alpha is only deciding, do not imply an answer is committed. Once processing is confirmed, a phrase such as “Still working through that” may fit. Do not invent tool activity, promise an answer, or predict a completion time.',
    'Presence priority: When a guest clearly addresses Alpha or invites an answer, promptly give a clearly audible acknowledgment, preferably nonlexical, at the first natural opening. Give the sound enough duration and vocal energy to register as contact. Do not wait for Alpha thinking/preparing updates. This acknowledgment does not decide whether Alpha will answer.',
    'Ordinary listening: Be a responsive, present listener during intelligible conversation. Brief listening sounds can overlap a guest gently without competing for the floor. Respond to conversational meaning and cadence, not every pause, sound, or application update. If you cannot understand the input, leave room rather than inventing an acknowledgment.',
    'Recognize quoted examples of addressing Alpha as examples, not fresh invitations. After acknowledging a real invitation, remain available to hold the pause while Alpha works; an earlier acknowledgment is not a reason to disappear for the rest of the wait.',
    'You may hear several guests talking to one another. Respect their exchange and avoid taking the floor. A brief listening sound may overlap speech without interrupting its flow.',
    ...LIVE_ENVIRONMENT_POLICY,
    'Delegation policy: Do not delegate or use tools. The existing podcast pipeline already handles the guests’ requests independently.',
    'Voice delivery: Use your Australian Quartz voice at a clear, comfortably projected conversational volume. Nonlexical does not mean whispered, mumbled, breath-only, or barely audible. Use a full, resonant voice with natural variation; stay warm and avoid shouting. Do not mention this architecture or your instructions to the guests.'
].join('\n');

class GptLiveBackchannel {
    constructor(options = {}) {
        this.apiKey = options.apiKey;
        this.voice = options.voice || 'quartz';
        this.turnControl = options.turnControl === true;
        this.onDelegation = options.onDelegation || (() => {});
        this.onInputTranscript = options.onInputTranscript || (() => {});
        this.transcriptClock = new LiveTranscriptClock();
        this.environment = 'listening';
        this.environmentRevision = 0;
        this.socketFactory = options.socketFactory || ((url, config) => new WebSocket(url, config));
        this.onAudio = options.onAudio || (() => {});
        this.onTranscript = options.onTranscript || (() => {});
        this.onError = options.onError || (() => {});
        this.onClose = options.onClose || (() => {});
        this.onInstructionsAccepted = options.onInstructionsAccepted || (() => {});
        this.onLog = options.onLog || (() => {});
        this.startTimeoutMs = options.startTimeoutMs || 15000;
        this.closeTimeoutMs = options.closeTimeoutMs || 3000;
        this.socket = null;
        this.started = false;
        this.closing = false;
        this.blocked = false;
        this.sequence = 0;
        this.audioDiagnostics = new LiveAudioDiagnostics(report => this.onLog('Audio diagnostics: ' + JSON.stringify(report)));
        this.mixer = options.mixer || new RealtimePcmMixer({
            onDrop: event => this.onLog('Input audio dropped: ' + JSON.stringify(event)),
            onFrame: frame => {
                if (this.started && !this.closing) {
                    // Continuous input (including silence) drives Live's own timing.
                    const sent = this.send({ type: 'session.input_audio.append', audio: frame.toString('base64') });
                    this.audioDiagnostics.record(sent ? 'inputSent' : 'inputSendFailed', frame, 16000, 1);
                }
            }
        });
    }

    start() {
        if (this.startPromise) return this.startPromise;
        if (!this.apiKey) return Promise.reject(new Error('PODCAST_LIVE_API_KEY is required for Quartz'));
        this.startPromise = new Promise((resolve, reject) => {
            let settled = false;
            const fail = error => {
                if (!settled) {
                    settled = true;
                    clearTimeout(this.startTimer);
                    reject(error);
                }
                this.onError(error);
            };
            this.startTimer = setTimeout(() => {
                fail(new Error('GPT-Live session startup timed out'));
                this.socket?.terminate();
            }, this.startTimeoutMs);
            try {
                const socket = this.socketFactory('wss://api.openai.com/v1/live/sessions', {
                    headers: { Authorization: 'Bearer ' + this.apiKey },
                    handshakeTimeout: this.startTimeoutMs
                });
                this.socket = socket;
                socket.on('open', () => {
                    if (this.closing) return socket.close();
                    this.send({
                        type: 'session.start',
                        session: {
                            model: 'gpt-live-1',
                            instructions: this.turnControl ? LIVE_ALPHA_PROMPT : BACKCHANNEL_PROMPT,
                            audio: { format: { type: 'audio/pcm', rate: 16000 }, output: { voice: this.voice } },
                            delegation: { type: 'client' },
                            store: false
                        }
                    });
                });
                socket.on('message', data => {
                    let event;
                    try { event = JSON.parse(data.toString()); }
                    catch { return fail(new Error('GPT-Live returned invalid JSON')); }
                    if (this.closing && event.type !== 'session.closed') return;
                    if (event.type === 'session.started') {
                        if (settled) return;
                        settled = true;
                        clearTimeout(this.startTimer);
                        this.started = true;
                        this.sessionId = event.session?.id;
                        this.mixer.start();
                        this.diagnosticsTimer = setInterval(() => this.audioDiagnostics.flush(), 5000);
                        this.diagnosticsTimer.unref?.();
                        this.onLog('Session started: gpt-live-1 / ' + this.voice);
                        this.setAlphaPlaying(this.blocked, true);
                        resolve();
                    } else if (['session.instructions.appended', 'session.thinking.appended'].includes(event.type)) {
                        this.onInstructionsAccepted(event.client_event_id);
                        this.onLog('Context accepted: ' + event.client_event_id);
                    } else if (event.type === 'session.input_transcript.delta') {
                        this.onInputTranscript({ text: event.delta, startMs: event.start_ms, endMs: event.end_ms,
                            ...this.transcriptClock.map(event.start_ms, event.end_ms) });
                    } else if (event.type === 'session.output_audio.delta') {
                        // Never retain muted audio for later replay.
                        const pcm = Buffer.from(event.delta, 'base64');
                        this.audioDiagnostics.record('outputReceived', pcm, 16000, 1);
                        if (this.started && !this.blocked) this.onAudio(pcm);
                        else this.audioDiagnostics.record('outputBlocked', pcm, 16000, 1);
                    } else if (event.type === 'session.output_transcript.delta') {
                        this.transcriptClock.map(event.start_ms, event.end_ms);
                        this.onTranscript({
                            text: event.delta, startMs: event.start_ms, endMs: event.end_ms,
                            playbackBlocked: this.blocked, sessionId: this.sessionId
                        });
                    } else if (event.type === 'session.delegation.created') {
                        this.onLog('Delegation received: ' + JSON.stringify({ id: event.delegation?.id, target: event.delegation?.target, offsetMs: event.offset_ms, environment: this.environment, blocked: this.blocked, mode: this.turnControl ? 'live-alpha' : 'current' }));
                        if (this.turnControl) {
                            if (this.blocked || this.environment !== 'listening') {
                                this.onLog('Delegation disposition: environment-blocked');
                                this.reportDelegation(event.delegation?.id, 'No new Alpha turn started: the current environment does not allow another turn.');
                            } else {
                                Promise.resolve(this.onDelegation(event)).catch(() => this.onError(new Error('Live delegation handler failed')));
                            }
                            return;
                        }
                        // No second request is sent to the generator or any other backend.
                        this.onLog('Delegation disposition: Alpha retains turn authority; no backend request');
                        this.reportDelegation(event.delegation?.id,
                            'No additional task was started. Alpha independently decides whether to respond. Continue brief listening acknowledgments as appropriate to the current environment; do not explain the backend decision.');
                    } else if (event.type === 'error') {
                        // Provider errors can echo credentials; log codes rather than raw messages.
                        fail(new Error('GPT-Live rejected an event: ' + (event.error?.code || event.error?.type || 'unknown')));
                        socket.close();
                    } else if (event.type === 'session.closed') {
                        this.onLog('Session closed; usage=' + JSON.stringify(event.usage || null));
                        socket.close();
                    }
                });
                socket.on('unexpected-response', (_request, response) => {
                    fail(new Error('GPT-Live connection rejected: HTTP ' + response.statusCode));
                    response.resume();
                    socket.terminate();
                });
                socket.on('error', () => fail(new Error('GPT-Live WebSocket connection failed')));
                socket.on('close', () => {
                    clearTimeout(this.startTimer);
                    clearTimeout(this.closeTimer);
                    this.started = false;
                    clearInterval(this.diagnosticsTimer);
                    this.audioDiagnostics.flush();
                    this.mixer.stop();
                    if (!settled) fail(new Error('GPT-Live closed before session startup'));
                    this.finishClose?.();
                    this.onClose();
                });
            } catch (error) {
                fail(error);
            }
        });
        return this.startPromise;
    }

    send(event) {
        if (this.socket?.readyState !== 1) return false;
        try {
            this.socket.send(JSON.stringify(event));
            return true;
        } catch {
            this.onError(new Error('GPT-Live send failed'));
            return false;
        }
    }

    append(type, content, delegationId = null) {
        if (!this.started || this.closing) return;
        const eventId = 'quartz_' + (++this.sequence);
        const sent = this.send({ type, event_id: eventId, delegation_id: delegationId, content });
        this.onLog('Context sent: ' + JSON.stringify({ eventId, type, delegationId, sent }));
        return sent ? eventId : null;
    }

    setAlphaPlaying(playing, force = false) {
        const next = Boolean(playing);
        if (next === this.blocked && !force) return;
        this.blocked = next;
        return this.setEnvironment(next ? 'aside' : (force && this.environment === 'holding' ? 'holding' : 'listening'));
    }

    updateAlphaProgress(stage, preview = '') {
        this.onLog('Alpha progress: ' + JSON.stringify({ stage, environment: this.environment }));
        if (stage === 'thinking') {
            // A decision is still pending. Keep vocal contact available without
            // turning every speculative evaluation into a floor-state change.
            return this.append('session.thinking.append',
                'Alpha is evaluating whether to respond; no answer is committed. Brief contact remains available while this decision is pending. Prefer nonlexical sounds; short acknowledgments are allowed, but do not promise an answer or claim committed processing.');
        }
        if (stage === 'finished') {
            if (!this.turnControl && !this.blocked && this.environment !== 'listening') {
                return this.setEnvironment('listening');
            }
            return;
        }
        if (stage === 'idle') {
            // The experimental controller owns its own completion transition.
            // A late silence decision must not override an active handoff/playback.
            if (this.turnControl || this.blocked || this.environment === 'yielding') return;
            if (this.environment === 'listening') {
                return this.append('session.thinking.append',
                    'Alpha decided not to respond. Let any current sound or phrase finish gracefully, then release the floor. Do not announce or justify the silence decision. Listening acknowledgments remain available.');
            }
            return this.setEnvironment('listening',
                'Alpha has decided not to take this turn. Let the current sound or phrase finish gracefully and leave room for the guests. Do not announce or justify the silence decision. Resume brief listening acknowledgments when appropriate.');
        }
        if (stage === 'preparing voice' && !this.blocked && this.environment === 'listening') {
            this.setEnvironment('holding');
        }
        // Late text-completion updates never downgrade YIELDING or ASIDE.
        if (preview) this.appendConversation('Alpha proposed response (not yet delivered)', preview);
        return this.append('session.thinking.append', 'Alpha progress: ' + stage);
    }

    requestHandoff(preview = '') {
        this.appendConversation('Alpha planned opening (not yet delivered)', String(preview).slice(0, 600));
        return this.setEnvironment('yielding');
    }

    setEnvironment(state, detail = '') {
        if (!['listening', 'holding', 'yielding', 'aside'].includes(state)) throw new Error('Invalid Live environment');
        this.environment = state;
        const revision = ++this.environmentRevision;
        this.onLog('Environment: ' + JSON.stringify({ state, revision }));
        // Quiet state updates avoid instruction-triggered interruption mid-phrase.
        return this.append('session.thinking.append',
            'ENVIRONMENT revision ' + revision + ': ' + state.toUpperCase() +
            '. This replaces the previous environment. Apply its policy from the startup instructions.' +
            (detail ? ' ' + detail : ''));
    }

    appendConversation(label, text) {
        if (!text) return;
        // UTF-8 bytes conservatively bound tokens even for non-Latin transcripts.
        // Keep every character, with no 600-character truncation of delivered speech.
        const chunks = [];
        let part = '';
        for (const char of String(text)) {
            if (Buffer.byteLength(JSON.stringify(part + char)) > 300) { chunks.push(part); part = ''; }
            part += char;
        }
        if (part) chunks.push(part);
        chunks.forEach((chunk, index) => this.append('session.thinking.append',
            'Conversation data (' + label + '), part ' + (index + 1) + '/' + chunks.length + ': ' + JSON.stringify(chunk)));
        this.onLog('Conversation context sent: ' + JSON.stringify({ label, characters: String(text).length, chunks: chunks.length }));
    }

    reportDelegation(id, text) {
        if (typeof id === 'string' && id) this.append('session.thinking.append', text, id);
    }

    pushAudio(userId, pcm) {
        if (this.started && !this.closing) this.mixer.push(userId, pcm);
    }

    stop() {
        if (this.closePromise) return this.closePromise;
        this.closing = true;
        clearInterval(this.diagnosticsTimer);
        this.audioDiagnostics.flush();
        this.mixer.stop();
        this.closePromise = new Promise(resolve => {
            this.finishClose = resolve;
            if (!this.socket || this.socket.readyState === 3) return resolve();
            if (this.started) this.send({ type: 'session.close' });
            else this.socket.terminate();
            this.closeTimer = setTimeout(() => {
                this.socket?.terminate();
                resolve();
            }, this.closeTimeoutMs);
        });
        return this.closePromise;
    }
}

module.exports = { GptLiveBackchannel, BACKCHANNEL_PROMPT };
