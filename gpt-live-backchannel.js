const { LiveTranscriptClock } = require('./live-transcript-clock');
const WebSocket = require('ws');
const { LiveContextQueue } = require('./live-context-queue');
const { LIVE_ALPHA_PROMPT, LIVE_ENVIRONMENT_POLICY } = require('./live-turn-controller');
const { RealtimePcmMixer } = require('./realtime-pcm-mixer');
const { LiveAudioDiagnostics } = require('./live-audio-diagnostics');
const { MutedSpeechGate } = require('./muted-speech-gate');

const HOLDING_STATES = ['holding', 'holding_longer', 'holding_rising'];
const HOLDING_LABELS = ['Um, uh, hmm, ah', 'LONGER um, uh, hmm, ah', 'EVEN LONGER RISING INTONATION  um, uh, hmm, ah'];

// Normal mode only; the experimental Live turn controller keeps its own prompt.
const BACKCHANNEL_PROMPT = [
    'You are Quartz, the warm, clearly audible conversational-contact voice accompanying Alpha in a live podcast with guests.',
    'Alpha has a separate existing pipeline that listens to the guests, decides whether to respond, thinks, uses tools, and delivers every substantial answer in Alpha’s own voice.',
    'Your only role is active listening, brief acknowledgments, and occasional floor holding while that pipeline works. You are not another host or the substantive answerer.',
    'Backchannel policy: Prefer natural nonlexical vocalizations such as mm or mhm; short verbal acknowledgments are also welcome when they provide better contact. Stay engaged throughout longer guest turns, choosing natural openings and moments of emphasis. Vary your intonation, rhythm, and duration to fit the conversation rather than repeating the same clipped sound. Let guests develop their thoughts; do not acknowledge every sentence.',
    'Floor-holding policy: Maintain audible contact while Alpha is deciding or preparing, using only nonlexical sounds. Start with a brief um, mm, or mm-hmm. As the wait continues, gradually lengthen your uh and um sounds into more drawn-out vocalizations, with natural breathing room between them. Renew contact at natural intervals even without a new guest contribution. Increase duration, not volume or urgency; avoid a mechanical loop or one continuous drone. Do not use verbal reassurance, delay announcements, or progress reports. Do not start answering, explaining, summarizing, interviewing, introducing topics, or giving opinions. Yield floor-holding sounds when a guest resumes speaking, and finish gracefully when Alpha is ready. Brief listening backchannels may finish naturally while the guest speaks.',
    'Presence priority: When a guest clearly addresses Alpha or invites an answer, promptly give a clearly audible acknowledgment, preferably nonlexical, at the first natural opening. Give the sound enough duration and vocal energy to register as contact. Do not wait for Alpha thinking/preparing updates. This acknowledgment does not decide whether Alpha will answer.',
    'Ordinary listening: Be a responsive, present listener during intelligible conversation. Brief listening sounds can overlap a guest gently without competing for the floor. Respond to conversational meaning and cadence, not every pause, sound, or application update. If you cannot understand the input, leave room rather than inventing an acknowledgment.',
    'Recognize quoted examples of addressing Alpha as examples, not fresh invitations. After acknowledging a real invitation, remain available to hold the pause while Alpha works; an earlier acknowledgment is not a reason to disappear for the rest of the wait.',
    'You may hear several guests talking to one another. Respect their exchange and avoid taking the floor. A brief listening sound may overlap speech without interrupting its flow.',
    ...LIVE_ENVIRONMENT_POLICY.map(policy => {
        // Normal mode uses nonlexical holding; experimental orchestration is unchanged.
        if (policy.startsWith('Your audible role:') || policy.startsWith('Your audible role is')) {
            return 'Your audible role is brief conversational contact. Prefer nonlexical sounds such as mm or mhm while listening. While holding a pause for Alpha, use only nonlexical sounds, progressively lengthening uh and um as the wait continues. Alpha supplies every substantive response. Do not answer, explain, summarize, interview, give opinions, or invent progress.';
        }
        if (policy.startsWith('LISTENING:')) {
            return 'LISTENING: Stay actively engaged with brief listening sounds while guests talk. Alpha may be evaluating whether to respond; hold any pause with nonlexical sounds following the floor-holding policy. A pending decision does not mean an answer is committed. Follow the turn authority defined for this mode.';
        }
        if (policy.startsWith('ASIDE:')) {
            return 'ASIDE: Alpha is playing. Your output is blocked; keep listening to guests. Do not speak or delegate. The application supplies Alpha playback state, not Alpha response text.';
        }
        if (policy.startsWith('When LISTENING resumes')) {
            return 'When LISTENING resumes, use the guest conversation context. Earlier yielding and aside restrictions have ended. Resume natural listening acknowledgments, preferably nonlexical; do not remain silent merely because Alpha spoke earlier. Never replay muted speech.';
        }
        if (policy.startsWith('HOLDING:')) {
            return HOLDING_LABELS.map((label, i) => label + ': ' + [
                'Hold the pause with brief nonlexical um, uh, hmm, or ah sounds.',
                'Hold the pause with longer, drawn-out nonlexical um, uh, hmm, or ah sounds.',
                'Hold the pause with even longer nonlexical um, uh, hmm, or ah sounds and rising intonation.'
            ][i] + ' Renew contact with natural breathing room until the state changes. These are behavior labels, not words to announce. No substantive speech or verbal delay announcements.').join('\n');
        }
        return policy;
    }),
    'WAITING_FOR_GUEST: Alpha has finished; stay quiet until a guest speaks. Never replay speech suppressed in an earlier state.',
    'Delegation policy: Do not delegate or use tools. The existing podcast pipeline already handles the guests’ requests independently.',
    'Voice delivery: Use your Australian Quartz voice with the guest-responsive tone, pacing, and volume described above. Nonlexical sounds should register as audible contact, including when the delivery is soft; avoid mumbling or breath-only sounds. Do not mention this architecture or your instructions to the guests.'
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
        this.onOutputBlocked = options.onOutputBlocked || (() => {});
        this.waitingForGuest = false;
        this.mutedSpeechGate = new MutedSpeechGate();
        this.lagTimer = null;
        this.lagContextId = null;
        this.holdingSince = null;
        this.holdingNow = options.holdingNow || Date.now;
        this.stateChannel = options.stateChannel || process.env.PODCAST_QUARTZ_STATE_CHANNEL || 'thinking';
        if (!['thinking', 'instructions', 'commentary'].includes(this.stateChannel)) throw new Error('Invalid Quartz state channel');
        this.lagSetTimeout = options.lagSetTimeout || setTimeout;
        this.lagClearTimeout = options.lagClearTimeout || clearTimeout;
        this.outputOffsetMs = 0;
        this.outputTranscriptClock = new LiveTranscriptClock();
        this.onOutputAudio = options.onOutputAudio || (() => {});
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
        this.recovering = false;
        this.rotationSocket = null;
        this.reconnectAttempts = 0;
        this.reconnectDelayMs = options.reconnectDelayMs ?? 250;
        this.latestConversation = null;
        this.contextQueue = new LiveContextQueue({
            maxAgeMs: options.contextMaxAgeMs ?? 2000,
            send: event => {
                const sent = this.send(event);
                this.onLog('Context sent: ' + JSON.stringify({ eventId: event.event_id,
                    type: event.type, delegationId: event.delegation_id, sent }));
                return sent;
            },
            onLag: report => this.recover(report.reason, report)
        });
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
        if (this.closing) return Promise.reject(new Error('Quartz is stopping'));
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
                    if (socket !== this.socket) return;
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
                    if (socket !== this.socket || socket === this.rotationSocket) return;
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
                        this.outputOffsetMs = 0;
                        this.mutedSpeechGate.reset();
                        this.transcriptClock = new LiveTranscriptClock();
                        this.outputTranscriptClock = new LiveTranscriptClock();
                        this.mixer.start();
                        this.diagnosticsTimer = setInterval(() => this.audioDiagnostics.flush(), 5000);
                        this.diagnosticsTimer.unref?.();
                        this.onLog('Session started: gpt-live-1 / ' + this.voice);
                        this.setAlphaPlaying(this.blocked, true);
                        if (this.recovering) {
                            // No transcript replay after lag. Only the newest context helps us rejoin.
                            const latest = this.latestConversation;
                            if (latest) this.appendConversation(latest.label, latest.text.slice(-240));
                            this.onLog('Recovered with current environment and latest context only');
                        }
                        this.recovering = false;
                        resolve();
                    } else if (['session.instructions.appended', 'session.thinking.appended', 'session.commentary.appended'].includes(event.type)) {
                        this.contextQueue.accept(event.client_event_id);
                        this.onInstructionsAccepted(event.client_event_id);
                        this.onLog('Context accepted: ' + event.client_event_id);
                    } else if (event.type === 'session.input_transcript.delta') {
                        this.onInputTranscript({ text: event.delta, startMs: event.start_ms, endMs: event.end_ms,
                            ...this.transcriptClock.map(event.start_ms, event.end_ms) });
                    } else if (event.type === 'session.output_audio.delta') {
                        // Never retain muted audio for later replay.
                        const pcm = Buffer.from(event.delta, 'base64');
                        this.audioDiagnostics.record('outputReceived', pcm, 16000, 1);
                        this.reconnectAttempts = 0;
                        const startMs = Number.isFinite(event.start_ms) ? event.start_ms : this.outputOffsetMs;
                        const endMs = startMs + pcm.length / 32; // output PCM, never the input mixer clock
                        this.outputOffsetMs = endMs; // advance even when muted
                        // Frame-level gating prevents a long provider chunk from
                        // reopening playback before its suppressed speech has ended.
                        for (let offset = 0; offset < pcm.length; offset += 640) {
                            const frame = pcm.subarray(offset, offset + 640);
                            const blocked = !this.started || (this.turnControl
                                ? this.blocked
                                : this.mutedSpeechGate.process(frame, this.floorBlocked));
                            const span = { startMs: startMs + offset / 32,
                                endMs: startMs + (offset + frame.length) / 32,
                                sessionId: this.sessionId };
                            this.onOutputAudio(frame, { ...span, receivedAt: Date.now(), blocked });
                            if (!blocked) this.onAudio(frame, span);
                            else this.audioDiagnostics.record('outputBlocked', frame, 16000, 1);
                        }
                    } else if (event.type === 'session.output_transcript.delta') {
                        this.transcriptClock.map(event.start_ms, event.end_ms);
                        this.onTranscript({
                            text: event.delta, startMs: event.start_ms, endMs: event.end_ms,
                            playbackBlocked: this.outputBlocked, sessionId: this.sessionId,
                            outputAudioFrontierMs: this.outputOffsetMs,
                            correlation: 'receipt',
                            ...this.outputTranscriptClock.map(event.start_ms, event.end_ms)
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
                        if (!this.turnControl && this.started && event.error?.code === 'too_many_pending_appends') {
                            this.recover('provider-context-overload');
                        } else socket.close();
                    } else if (event.type === 'session.closed') {
                        this.onLog('Session closed; usage=' + JSON.stringify(event.usage || null));
                        socket.close();
                    }
                });
                socket.on('unexpected-response', (_request, response) => {
                    if (socket !== this.socket) return response.resume();
                    fail(new Error('GPT-Live connection rejected: HTTP ' + response.statusCode));
                    response.resume();
                    socket.terminate();
                });
                socket.on('error', () => {
                    if (socket === this.socket && socket !== this.rotationSocket) fail(new Error('GPT-Live WebSocket connection failed'));
                });
                socket.on('close', () => {
                    if (socket !== this.socket) return;
                    const rotating = socket === this.rotationSocket;
                    this.rotationSocket = null;
                    this.socket = null; // Ignore all late events from the retired session.
                    const recoverable = this.started || this.recovering;
                    clearTimeout(this.startTimer);
                    clearTimeout(this.closeTimer);
                    this.started = false;
                    this.cancelLagNotice(true);
                    clearInterval(this.diagnosticsTimer);
                    this.audioDiagnostics.flush();
                    this.mixer.stop();
                    this.contextQueue.reset();
                    this.startPromise = null;
                    if (!settled) fail(new Error('GPT-Live closed before session startup'));
                    this.finishClose?.();
                    // A planned reset happens after handoff; it is not a playback failure.
                    if (!rotating) this.onClose();
                    if (recoverable && !this.closing && !this.turnControl) this.scheduleReconnect();
                });
            } catch (error) {
                fail(error);
                if (this.recovering) this.scheduleReconnect();
            }
        });
        return this.startPromise;
    }

    resetForAlphaPlayback() {
        if (this.turnControl || this.closing || !this.blocked) return;
        // Begin the next exchange without the previous guest turn or Quartz output.
        // Guest context arriving after this boundary can still aid startup recovery.
        this.latestConversation = null;
        if (!this.started || this.recovering) return; // A fresh connection is already pending.
        this.rotationSocket = this.socket;
        this.onLog('Session reset: Alpha playback started');
        this.recover('alpha-playback-reset');
    }

    recover(reason, details = {}) {
        if (this.closing || this.recovering) return;
        this.onLog('Context recovery: ' + JSON.stringify({ reason, ...details }));
        this.recovering = true;
        this.cancelLagNotice(true);
        this.started = false;
        this.contextQueue.reset();
        // Close abandons provider-side pending work as well as our unsent backlog.
        this.socket?.terminate();
    }

    scheduleReconnect() {
        if (this.closing || this.turnControl || this.reconnectTimer) return;
        this.recovering = true;
        const delayMs = Math.min(5000, this.reconnectDelayMs * (2 ** Math.min(this.reconnectAttempts++, 5)));
        this.onLog('Reconnect scheduled: ' + JSON.stringify({ delayMs }));
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (this.closing) return;
            this.startPromise = null;
            this.start().catch(() => this.onLog('Recovery connection failed; awaiting retry'));
        }, delayMs);
        this.reconnectTimer.unref?.();
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
        const event = { type, event_id: eventId, delegation_id: delegationId, content };
        if (this.turnControl) {
            // Preserve experimental turn-control behavior.
            const sent = this.send(event);
            this.onLog('Context sent: ' + JSON.stringify({ eventId, type, delegationId, sent }));
            return sent ? eventId : null;
        }
        this.contextQueue.enqueue(event);
        return eventId;
    }

    get floorBlocked() { return this.blocked || (!this.turnControl && this.waitingForGuest); }

    get outputBlocked() {
        return this.floorBlocked || (!this.turnControl && this.mutedSpeechGate.suppressed);
    }

    cancelLagNotice(preserveClock = false) {
        if (!preserveClock) this.holdingSince = null;
        if (this.lagTimer !== null) this.lagClearTimeout(this.lagTimer);
        this.lagTimer = null;
        if (this.lagContextId) this.contextQueue.cancelQueued(this.lagContextId);
        this.lagContextId = null;
    }

    beginLagNotice() {
        if (this.turnControl || !this.started || this.closing || this.floorBlocked ||
            this.guestSpeaking || !HOLDING_STATES.includes(this.environment) ||
            this.lagTimer !== null) return;
        if (this.holdingSince === null) this.holdingSince = this.holdingNow();
        const elapsed = this.holdingNow() - this.holdingSince;
        const nextIndex = elapsed < 5000 ? 1 : elapsed < 10000 ? 2 : null;
        if (nextIndex === null) return;
        this.lagTimer = this.lagSetTimeout(() => {
            this.lagTimer = null;
            if (!this.started || this.closing || this.floorBlocked ||
                this.guestSpeaking || !HOLDING_STATES.includes(this.environment)) return;
            this.setEnvironment(HOLDING_STATES[this.holdingNow() - this.holdingSince >= 10000 ? 2 : nextIndex]);
        }, nextIndex * 5000 - elapsed);
        this.lagTimer?.unref?.();
    }

    setAlphaPlaying(playing, force = false) {
        const next = Boolean(playing);
        if (next === this.blocked && !force) return;
        const wasPlaying = this.blocked;
        this.blocked = next;
        if (!this.turnControl && next) {
            this.mutedSpeechGate.mute();
            this.cancelLagNotice();
        }
        if (!this.turnControl && wasPlaying && !next) {
            this.waitingForGuest = !this.guestSpeaking;
        }
        if (this.outputBlocked) this.onOutputBlocked();
        return this.setEnvironment(next ? 'aside' :
            this.waitingForGuest && !this.turnControl ? 'waiting_for_guest' :
            (force && HOLDING_STATES.includes(this.environment) ? this.environment : 'listening'));
    }

    updateAlphaProgress(stage, preview = '') {
        this.onLog('Alpha progress: ' + JSON.stringify({ stage, environment: this.environment }));
        if (stage === 'guest speaking') {
            if (this.turnControl) return;
            this.guestSpeaking = true;
            this.waitingForGuest = false;
            this.cancelLagNotice();
            if (!this.blocked && [...HOLDING_STATES, 'waiting_for_guest'].includes(this.environment)) {
                return this.setEnvironment('listening', 'A guest is speaking.');
            }
            return;
        }
        if (stage === 'guest finished') {
            if (this.turnControl) return;
            this.guestSpeaking = false;
        }
        if (this.turnControl && ['thinking', 'evaluating', 'finished', 'idle'].includes(stage)) return;
        if (!this.turnControl && ['thinking', 'evaluating', 'guest finished', 'finished', 'idle', 'preparing voice'].includes(stage)) {
            // Only participant endpoints start the silence clock. Generation retries,
            // cancellations and voice preparation do not change it.
            if (stage !== 'guest finished' || this.floorBlocked ||
                this.environment === 'yielding' || this.guestSpeaking) return;
            if (!HOLDING_STATES.includes(this.environment)) return this.setEnvironment('holding', 'A guest has finished speaking; no answer is committed.');
            this.beginLagNotice();
            return;
        }
        // Late text-completion updates never downgrade YIELDING or ASIDE.
        if (preview) this.appendConversation('Alpha proposed response (not yet delivered)', preview);
        return this.append('session.thinking.append', 'Alpha progress: ' + stage);
    }

    requestHandoff(preview = '') {
        this.cancelLagNotice();
        this.appendConversation('Alpha planned opening (not yet delivered)', String(preview).slice(0, 600));
        return this.setEnvironment('yielding');
    }

    setEnvironment(state, detail = '') {
        if (!['listening', ...HOLDING_STATES, 'yielding', 'aside', 'waiting_for_guest'].includes(state)) throw new Error('Invalid Live environment');
        if (!this.turnControl && HOLDING_STATES.includes(state)) {
            if (this.holdingSince === null) this.holdingSince = this.holdingNow();
            state = HOLDING_STATES[Math.min(2, Math.floor(Math.max(0, this.holdingNow() - this.holdingSince) / 5000))];
        }
        this.environment = state;
        if (!HOLDING_STATES.includes(state)) this.cancelLagNotice();
        else if (!this.turnControl) this.beginLagNotice();
        if (this.lagContextId) this.contextQueue.cancelQueued(this.lagContextId);
        const revision = ++this.environmentRevision;
        this.onLog('Environment: ' + JSON.stringify({ state, revision }));
        const label = !this.turnControl && HOLDING_STATES.includes(state)
            ? HOLDING_LABELS[HOLDING_STATES.indexOf(state)] : state.toUpperCase();
        const eventId = this.append('session.' + (this.turnControl ? 'thinking' : this.stateChannel) + '.append',
            'ENVIRONMENT revision ' + revision + ': ' + label +
            '. This replaces the previous environment. Apply its policy from the startup instructions.' +
            (detail ? ' ' + detail : ''));
        this.lagContextId = eventId;
        return eventId;
    }

    appendConversation(label, text) {
        if (!text) return;
        // Alpha owns substantive speech; normal Quartz receives only guest conversation.
        // Filter before retaining recovery context so blocked text cannot return on reconnect.
        if (!this.turnControl && label !== 'Guest transcript') return;
        this.latestConversation = { label, text: String(text) };
        if (!this.started || this.closing) return;
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
        this.onLog('Conversation context queued: ' + JSON.stringify({ label, characters: String(text).length, chunks: chunks.length }));
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
        this.cancelLagNotice();
        clearTimeout(this.reconnectTimer);
        this.contextQueue.reset();
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

module.exports = { GptLiveBackchannel, BACKCHANNEL_PROMPT, HOLDING_STATES, HOLDING_LABELS };
