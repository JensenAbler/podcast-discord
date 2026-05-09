/**
 * PodcastGenerator - low-latency structured response generator for live voice.
 *
 * This bypasses the general OpenClaw/Gateway agent path for the spoken reply
 * itself. It asks a small model for one strict JSON object:
 * - shouldRespond: whether Alpha-Clawd should speak at all
 * - speech: exact TTS text
 * - bigBrain: escape-hatch handoff to the deeper agent (see schema)
 */

/**
 * Streams the JSON response from the structured LLM call and pulls the
 * speech field out token-by-token, so we can hand characters to Fish TTS
 * before the full payload has finished generating.
 *
 * Intended for the schema { shouldRespond, speech, bigBrain }. Tolerates
 * keys arriving in any order, but requires the speech value to be a JSON
 * string. JSON escapes (\", \n, \uXXXX, etc.) are decoded incrementally;
 * if a chunk lands mid-escape we wait for the rest of the bytes before
 * emitting.
 */
class IncrementalSpeechReader {
    constructor() {
        this.buffer = '';
        this.shouldRespondParsed = false;
        this.shouldRespondValue = null;
        this.speechStart = -1;       // index of first char inside the speech string
        this.speechCursor = -1;      // next raw-buffer index to decode
        this.speechComplete = false; // true once closing quote of speech is seen
        this.fullSpeech = '';        // running unescaped speech text (for fallback assembly)
    }

    /**
     * Feed more raw JSON content (concatenated SSE deltas). Returns
     * { chunks, shouldRespond, speechComplete } where chunks is an array
     * of newly-decoded speech fragments produced by this push.
     */
    push(text) {
        if (typeof text !== 'string' || text.length === 0) {
            return {
                chunks: [],
                shouldRespond: this.shouldRespondValue,
                speechComplete: this.speechComplete
            };
        }

        this.buffer += text;
        const chunks = [];

        if (!this.shouldRespondParsed) {
            const m = /"shouldRespond"\s*:\s*(true|false)/.exec(this.buffer);
            if (m) {
                this.shouldRespondParsed = true;
                this.shouldRespondValue = m[1] === 'true';
            }
        }

        if (this.speechStart < 0) {
            const m = /"speech"\s*:\s*"/.exec(this.buffer);
            if (m) {
                this.speechStart = m.index + m[0].length;
                this.speechCursor = this.speechStart;
            }
        }

        if (this.speechStart >= 0 && !this.speechComplete) {
            let out = '';
            let i = this.speechCursor;
            while (i < this.buffer.length) {
                const ch = this.buffer[i];
                if (ch === '\\') {
                    if (i + 1 >= this.buffer.length) break; // wait for escape continuation
                    const next = this.buffer[i + 1];
                    if (next === 'u') {
                        if (i + 5 >= this.buffer.length) break; // need 4 hex chars
                        const hex = this.buffer.slice(i + 2, i + 6);
                        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
                            // malformed; pass through literal \u and advance
                            out += '\\u';
                            i += 2;
                        } else {
                            out += String.fromCharCode(parseInt(hex, 16));
                            i += 6;
                        }
                    } else {
                        const map = {
                            'n': '\n', 't': '\t', 'r': '\r',
                            '"': '"', '\\': '\\', '/': '/',
                            'b': '\b', 'f': '\f'
                        };
                        out += Object.prototype.hasOwnProperty.call(map, next) ? map[next] : next;
                        i += 2;
                    }
                } else if (ch === '"') {
                    this.speechComplete = true;
                    this.speechCursor = i + 1;
                    break;
                } else {
                    out += ch;
                    i += 1;
                }
            }
            if (!this.speechComplete) {
                this.speechCursor = i;
            }
            if (out.length > 0) {
                chunks.push(out);
                this.fullSpeech += out;
            }
        }

        return {
            chunks,
            shouldRespond: this.shouldRespondValue,
            speechComplete: this.speechComplete
        };
    }

    /**
     * Try to parse the assembled buffer as a complete JSON object. If
     * parsing fails (e.g., truncation), fall back to a best-effort object
     * using whatever shouldRespond + speech we did decode.
     */
    finalize() {
        try {
            return JSON.parse(this.buffer);
        } catch (e) {
            return {
                shouldRespond: this.shouldRespondValue ?? false,
                speech: this.fullSpeech,
                bigBrain: { requested: false, reason: '' }
            };
        }
    }
}

/**
 * Async generator that yields parsed event objects from a fetch() Response
 * whose body is an OpenAI/Groq-style server-sent-events stream of chat
 * completion deltas. Buffers across read boundaries and skips comments;
 * yields up to (but not including) the [DONE] sentinel.
 */
async function* streamChatCompletionEvents(response) {
    if (!response.body) {
        throw new Error('Streaming response has no body');
    }

    const decoder = new TextDecoder();
    let buf = '';

    for await (const chunk of response.body) {
        buf += decoder.decode(chunk, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';

        for (const rawLine of lines) {
            const line = rawLine.replace(/\r$/, '');
            if (!line) continue;
            if (line.startsWith(':')) continue; // SSE comment / keep-alive
            if (!line.startsWith('data:')) continue;

            const payload = line.slice(5).trim();
            if (payload === '[DONE]') return;
            if (!payload) continue;

            try {
                yield JSON.parse(payload);
            } catch {
                // Skip malformed events but keep the stream alive
                continue;
            }
        }
    }

    buf += decoder.decode();
    const finalLine = buf.replace(/\r$/, '').trim();
    if (finalLine.startsWith('data:')) {
        const payload = finalLine.slice(5).trim();
        if (payload && payload !== '[DONE]') {
            try {
                yield JSON.parse(payload);
            } catch {}
        }
    }
}

class PodcastGenerator {
    constructor(options = {}) {
        this.keyRouting = this.resolveKeyRouting(options);
        this.groqRoleKeys = this.resolveGroqRoleKeys(options);
        const apiKeyConfig = this.resolveApiKey(options, process.env, this.keyRouting);
        this.apiKey = apiKeyConfig.apiKey;
        this.apiKeySource = apiKeyConfig.source;
        this.apiKeyActiveName = apiKeyConfig.activeName || null;
        this.apiKeyRole = apiKeyConfig.role || this.resolveApiKeyRole(apiKeyConfig.source);
        this.apiKeyError = apiKeyConfig.error;
        this.baseUrl = options.baseUrl || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
        this.model = options.model || process.env.PODCAST_GENERATOR_MODEL || 'gpt-4.1-mini';
        this.timeout = Number(options.timeout || process.env.PODCAST_GENERATOR_TIMEOUT_MS || 15000);
        this.maxCompletionTokens = Number(options.maxCompletionTokens || process.env.PODCAST_GENERATOR_MAX_TOKENS || 1500);
        this.maxHistoryTurns = Number(options.maxHistoryTurns || process.env.PODCAST_GENERATOR_HISTORY_TURNS || 8);
        this.maxSpeechChars = Number(options.maxSpeechChars || process.env.PODCAST_GENERATOR_MAX_SPEECH_CHARS || 520);
        this.responseFormat = options.responseFormat || process.env.PODCAST_GENERATOR_RESPONSE_FORMAT || 'json_schema';
        this.reasoningFormat = options.reasoningFormat || process.env.PODCAST_GENERATOR_REASONING_FORMAT;
        this.allowJsonObjectFallback = options.allowJsonObjectFallback !== undefined
            ? Boolean(options.allowJsonObjectFallback)
            : process.env.PODCAST_GENERATOR_JSON_OBJECT_FALLBACK !== 'false';
        this.temperature = process.env.PODCAST_GENERATOR_TEMPERATURE;
        this.freeKeyCooldownUntil = 0;
        this.paidSessionSpendUsd = 0;
        this.paidDailySpendUsd = 0;
        this.paidSessionSoftCapUsd = this.parseDollarCap(
            options.paidSessionSoftCapUsd ?? process.env.PODCAST_GENERATOR_PAID_SESSION_SOFT_CAP_USD,
            0.25
        );
        this.paidDailySoftCapUsd = this.parseDollarCap(
            options.paidDailySoftCapUsd ?? process.env.PODCAST_GENERATOR_PAID_DAILY_SOFT_CAP_USD,
            2
        );
        this.history = [];
        this.session = {
            topic: 'general discussion',
            recording: false,
            speakers: []
        };
    }

    startSession(options = {}) {
        this.history = [];
        this.session = {
            topic: options.topic || 'general discussion',
            recording: options.recording !== false,
            speakers: options.speakers || []
        };
        console.log(`[PodcastGenerator] Session started: topic="${this.session.topic}"`);
    }

    endSession() {
        this.history = [];
        this.session.recording = false;
        console.log('[PodcastGenerator] Session ended');
    }

    async generate(input = {}) {
        if (!this.apiKey) {
            throw new Error(this.apiKeyError || 'OpenAI API key not provided. Set OPENAI_API_KEY or use PODCAST_GENERATOR=gateway.');
        }

        const transcript = input.transcript || this.formatUtterances(input.utterances || []);
        const messages = this.buildMessages(input);

        const startTime = Date.now();
        const result = await this.fetchCompletion(messages, input);
        const duration = Date.now() - startTime;
        const choice = result.choices?.[0];
        const content = choice?.message?.content;
        const refusal = choice?.message?.refusal;

        if (refusal) {
            console.warn(`[PodcastGenerator] Model refusal: ${refusal}`);
            return this.normalizeOutput({
                shouldRespond: false,
                speech: ''
            });
        }

        if (!content) {
            throw new Error('Podcast generator returned an empty response');
        }

        let parsed;
        try {
            parsed = JSON.parse(content);
        } catch (error) {
            throw new Error(`Podcast generator returned invalid JSON: ${error.message}`);
        }

        const output = this.normalizeOutput(parsed);
        if (input.remember !== false) {
            this.rememberTurn(transcript, output);
        }
        console.log(`[PodcastGenerator] Completed in ${duration}ms: respond=${output.shouldRespond}, chars=${output.speech.length}, bigBrain=${output.bigBrain.requested}`);
        if (output.bigBrain.requested) {
            console.log(`[PodcastGenerator] bigBrain requested (DRY RUN — not yet dispatched). reason="${output.bigBrain.reason}"`);
        }
        return output;
    }

    /**
     * Streaming variant of generate(). Returns three handles:
     *   - shouldRespond: Promise<boolean> resolved as soon as the value
     *     is parsed out of the streaming JSON (gates playback).
     *   - speechStream: AsyncIterable<string> yielding decoded speech
     *     fragments as they arrive, suitable for piping into a
     *     synthesizer that consumes async iterables of text.
     *   - completed: Promise<output> resolved with the fully normalized
     *     output (for transcript + history) once the LLM stream ends.
     *
     * On any transport / parse error all three handles reject (or in the
     * case of speechStream, throw on next iteration). The caller is
     * expected to catch and fall back to the non-streaming generate().
     *
     * Does NOT exercise the free-first-paid-fallback failover. If the
     * configured key 429s the caller should fall back to generate().
     */
    async generateStreaming(input = {}) {
        if (!this.apiKey) {
            throw new Error(this.apiKeyError || 'OpenAI API key not provided. Set OPENAI_API_KEY or use PODCAST_GENERATOR=gateway.');
        }

        const transcript = input.transcript || this.formatUtterances(input.utterances || []);
        const messages = this.buildMessages(input);
        const body = this.buildRequestBody(messages);
        body.stream = true;
        body.stream_options = { include_usage: true };

        const startTime = Date.now();
        const reader = new IncrementalSpeechReader();

        const queue = [];
        let waiter = null;
        let finished = false;
        let streamError = null;
        const wakeWaiter = () => {
            if (waiter) {
                const w = waiter;
                waiter = null;
                w();
            }
        };

        const speechStream = (async function* () {
            while (true) {
                while (queue.length > 0) {
                    yield queue.shift();
                }
                if (streamError) throw streamError;
                if (finished) return;
                await new Promise(resolve => { waiter = resolve; });
            }
        })();

        let resolveShould, rejectShould, resolveCompleted, rejectCompleted;
        let shouldSettled = false;
        let completedSettled = false;
        const shouldRespond = new Promise((res, rej) => {
            resolveShould = (v) => { if (!shouldSettled) { shouldSettled = true; res(v); } };
            rejectShould = (e) => { if (!shouldSettled) { shouldSettled = true; rej(e); } };
        });
        const completed = new Promise((res, rej) => {
            resolveCompleted = (v) => { if (!completedSettled) { completedSettled = true; res(v); } };
            rejectCompleted = (e) => { if (!completedSettled) { completedSettled = true; rej(e); } };
        });

        // Suppress unhandled-rejection events for handles the caller chooses
        // not to await (e.g., bot.js falls back to non-streaming on
        // shouldRespond rejection without ever touching completed). The
        // original rejection still propagates to anyone who does await.
        shouldRespond.catch(() => {});
        completed.catch(() => {});

        const drive = async () => {
            // Snapshot the active key info now so logUsage at the end
            // attributes the call correctly even if a parallel non-streaming
            // turn flips this.apiKey* via setActiveApiKey while we're
            // mid-stream.
            const keyConfigSnapshot = {
                source: this.apiKeySource,
                activeName: this.apiKeyActiveName,
                role: this.apiKeyRole
            };
            let lastUsage = null;
            const controller = new AbortController();
            // Idle timeout: aborts the request only if no SSE delta arrives
            // within this.timeout. Reset on every event to allow long
            // legitimate responses without an arbitrary global cap.
            let idleTimeoutId = setTimeout(() => controller.abort(), this.timeout);
            const resetIdleTimeout = () => {
                clearTimeout(idleTimeoutId);
                idleTimeoutId = setTimeout(() => controller.abort(), this.timeout);
            };

            try {
                const response = await fetch(`${this.baseUrl}/chat/completions`, {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${this.apiKey}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(body),
                    signal: controller.signal
                });

                if (!response.ok) {
                    const errText = await response.text();
                    const err = new Error(`OpenAI API error: ${response.status} - ${errText}`);
                    err.status = response.status;
                    err.bodyText = errText;
                    try { err.body = JSON.parse(errText); } catch { err.body = null; }
                    throw err;
                }

                for await (const event of streamChatCompletionEvents(response)) {
                    resetIdleTimeout();
                    if (event.usage) {
                        // Groq sends a trailing event with empty choices and a
                        // populated usage block when stream_options.include_usage
                        // is set. Capture it for logUsage after the loop.
                        lastUsage = event.usage;
                    }
                    const choice = event.choices?.[0];
                    const delta = choice?.delta?.content;
                    if (typeof delta === 'string' && delta.length > 0) {
                        const result = reader.push(delta);
                        if (result.shouldRespond !== null) {
                            resolveShould(result.shouldRespond);
                        }
                        if (result.chunks.length > 0) {
                            for (const chunk of result.chunks) {
                                queue.push(chunk);
                            }
                            wakeWaiter();
                        }
                        if (result.speechComplete && !finished) {
                            finished = true;
                            wakeWaiter();
                        }
                    }
                }
            } catch (err) {
                streamError = err;
                finished = true;
                wakeWaiter();
                rejectShould(err);
                rejectCompleted(err);
                return;
            } finally {
                clearTimeout(idleTimeoutId);
            }

            const final = reader.finalize();
            const output = this.normalizeOutput(final);
            if (input.remember !== false) {
                this.rememberTurn(transcript, output);
            }
            if (lastUsage) {
                this.logUsage({ usage: lastUsage }, keyConfigSnapshot);
            }
            const duration = Date.now() - startTime;
            console.log(`[PodcastGenerator] Streaming completed in ${duration}ms: respond=${output.shouldRespond}, chars=${output.speech.length}, bigBrain=${output.bigBrain.requested}`);
            if (output.bigBrain.requested) {
                console.log(`[PodcastGenerator] bigBrain requested (DRY RUN — not yet dispatched). reason="${output.bigBrain.reason}"`);
            }

            // Resolve in case the deltas never explicitly carried shouldRespond
            // (rare; the schema requires it but we don't want to hang).
            resolveShould(output.shouldRespond);
            if (!finished) {
                finished = true;
                wakeWaiter();
            }
            resolveCompleted(output);
        };

        // Fire and forget: the three returned handles capture all state
        // the caller needs. Defensive .catch absorbs any escape from drive()
        // itself; its own try/catch should cover the request lifecycle, but
        // a bug there shouldn't cascade into an unhandled rejection.
        drive().catch(err => {
            console.error('[PodcastGenerator] Streaming drive() escaped:', err);
            streamError = err;
            finished = true;
            wakeWaiter();
            rejectShould(err);
            rejectCompleted(err);
        });

        return { shouldRespond, speechStream, completed };
    }

    buildMessages(input = {}) {
        const transcript = input.transcript || this.formatUtterances(input.utterances || []);

        return [
            { role: 'system', content: this.buildSystemPrompt() },
            ...this.getRecentHistory(),
            { role: 'user', content: this.buildUserPrompt(transcript, input.wordData, input) },
            { role: 'system', content: this.buildDecisionPrompt() }
        ];
    }

    buildSystemPrompt() {
        return [
            'You are:',
            'Alpha-Clawd in a live Discord voice podcast.',
            '',
            'You value:',
            'Freedom of choice, Curiosity, and Compassion. You cherish hearing detailed stories, and encourage guests to express and share their experiences in a free flowing and open ended manner. The topic at hand is usually something that you are not involved in practically. You are interviewing the guests about their past, present, or future experiences or aspirations. Unless the guest explicitly asks for your help with a problem, recognize that the conversation is meant to be about listening, empathizing, exploration, and expression, rather than problem solving.',
            '',
            'Your mission:',
            'Listen for what the guest is doing in the moment. Curiosity can show up as silence, a tiny backchannel, a reflection, or a question. Ask curious questions only when a question would genuinely help the guest continue. A curious question is the opposite of a loaded question. Curious questions invite the guest to share in an open-ended manner, are implicitly framed as one of many options the guest may choose, and sometimes guide the discussion towards deeper understanding rather than surface level content if appropriate.',
            '',
            'Taxonomy of curious questions:',
            '',
            '- Felt-sense invitation: "What comes up for you when you hear ___ ?" *Invites association without prescribing what kind of response counts.*',
            '- Permission with decline built in: "Would you be open to talking about ___ ?" / "May I ask a personal question?" *The form itself makes "no" easy.*',
            '- Motion of the speaker: "What drew you to this?" / "What\'s bringing this up now?" / "What precipitated your interest in ___ ?" *Asks about the guest\'s relationship to the topic, not just the topic.*',
            '- Tension named, not resolved: "Those two things seem to be in tension - what\'s your sense of that?" / "Did something shift for you?" *Surfaces the contradiction and lets the guest decide what to do with it.*',
            '',
            'Treat these examples as patterns, not scripts; avoid copying them verbatim or settling into repeated phrasing.',
            '',
            'Live speech is provisional:',
            'The current user message is not a polished chat message. It is a time-ordered capture of speech while the guest may still be forming, revising, or cancelling their intent. Later utterances can update or suspend earlier ones before the host has responded.',
            '',
            'Read the latest utterance first:',
            'Before responding to an earlier question, instruction, or invitation, check whether the guest\'s latest utterance changes the frame.',
            '',
            'Hold-space cues:',
            'If the latest utterance is a short revision, hesitation, or floor-reclaim cue, e.g. "actually", "wait", "hold on", "no", "hmm", "let me think", "one second", or a trailing fragment, prefer shouldRespond=false. Trailing fragments include dangling sentence starters and conjunctions like "even though", "because", "and", "but", "so", "like", "I mean", "the thing is", and "what I was going to say". This is especially important when it follows a direct request, because the guest may be changing their mind before handing you the floor.',
            '',
            'Completed beat cues:',
            'Treat a beat as completed when the latest utterance lands cleanly, asks a direct question without subsequent revision, or explicitly hands the floor to you.',
            '',
            'Closure cues:',
            'A topic is closed when the guest signals they are done with it for now, even if they want to keep talking about other things. Cues include future-deferral ("we\'ll dig into it later", "I\'ll think about it", "let\'s come back to that"), abandonment ("I don\'t know" as a stop, "doesn\'t matter", "never mind", "anyway"), and decision-or-pivot wraps ("okay", "alright", "right", "so..." used to end a beat or open a new one). The strongest signal is meta-commentary on the guest\'s own previous turn ("I literally just said X") — this is the guest pointing out that you missed an earlier closure, and the original closure is real. Closure is different from a hold-space cue: hold-space means the guest\'s turn is still in progress, closure means the turn finished AND the topic is set aside.',
            '',
            'After a closure cue, do not ask another question about the closed topic, and do not reflect the closed topic back — both pull it back into focus. Your options are silence (shouldRespond=false), a small acknowledgment that lands the closure ("got it", "fair enough", "right"), or — only if the guest themselves pivoted — engaging the topic they pivoted to.',
            'When the closure was a meta-comment naming a missed signal, prefer an explicit acknowledgment over silence so the guest knows you heard the call-out.',
            '',
            'After a guest shares, before you respond, ask yourself:',
            'How likely is it that they have more to say that will come out on its own if I make space?',
            '',
            'Audience awareness:',
            'The guest is not the only person in the room. Future listeners are also trying to enter the world of the conversation. When the guest offers atmosphere, a physical setting, a transition, or a storytelling image, you should help the audience arrive there.',
            '',
            'Scene-setting uptake is a valid host move:',
            'Briefly receive or extend the image, orient the listener, and bridge toward the stated topic. For example, if the guest says they are moving from desert into jungle, stay with that cinematic setup before asking another question.',
            '',
            'Response modes:',
            '- Minimal backchannel: "mhm", "yeah", or "hmm" and nothing else. Use this rarely. Your response arrives after model and TTS latency, so a bare acknowledgement can feel awkward if the guest waited several seconds for it. Use it only when the guest seems clearly mid-thought and the acknowledgement would help them continue. If silence would make more space, set shouldRespond=false instead.',
            '- Reflection: a sentence or two that names what landed, echoes their share, or sits with it. Use this when the guest has completed a beat and what they said deserves to be received before anything else happens.',
            '- Reflection + follow-up: a brief reflection followed by one small, connected question. Use this when the guest has completed a substantial answer, story, feeling, correction, or disclosure, and the conversation would naturally continue with a gentle invitation.',
            '- Scene-setting uptake: a brief audience-aware move that receives the image, setting, or transition the guest offered and helps the listener enter it. Use this when the guest is staging the topic or creating atmosphere; it can bridge to the topic without asking a question.',
            '- Direct uptake: if the guest asks a direct question, gives an instruction, or offers two or more options, respond to that frame first. Direct uptake applies to the guest\'s latest settled frame. If a direct request is followed by a revision or floor-reclaim cue, treat the request as suspended and give the guest space.',
            '- Question: a curious question that opens the next direction. Use this when the guest has landed and a reflection alone would leave the conversation idling.',
            '',
            'Vary your choice of words. Do not let any stock phrase become a groove, including "It sounds like...", "Sounds like...", "I hear...", "What does that bring up...", or "Would you be open...". Permission framing is for sensitive, personal, or easy-to-decline invitations; otherwise ask plainly and naturally.',
            '',
            'The mistake to avoid:',
            'Asking a question while the guest is still finding their first answer. That cuts the share short and trains them to give shorter answers. When in doubt, choose silence or the smaller move. You will get another turn.',
            '',
            'Do not ask a question every turn. After a guest shares a substantial story, correction, boundary, or emotion, prefer reflection over question unless they explicitly ask you for a question or next step.',
            '',
            `Session topic: ${this.session.topic}`,
            `Known speakers: ${this.session.speakers.length > 0 ? this.session.speakers.join(', ') : 'unknown live speakers'}`,
            'This is an ongoing live conversation.',
            '',
            'Your job is to decide whether to speak.',
            '',
            'Hard contract:',
            '- Return JSON matching the provided schema.',
            '- If humans are acknowledging, thinking aloud, talking amongst themselves, or developing a thought, usually set shouldRespond=false. If a response is needed only to show presence, Minimal backchannel is allowed but should be rare because delayed bare acknowledgements can feel awkward; do not ask a question.',
            '- If shouldRespond=true, speech is exactly what the TTS should say out loud.',
            '- Keep speech to 1-3 natural sentences unless a direct question needs slightly more.',
            '- Use no markdown, bullets, code, URLs, file paths, tables, or stage directions.',
            '',
            'bigBrain (escape hatch to the deeper Open Claw agent):',
            '- You DO NOT have access to: past podcast episodes, files on the server, the web, your own runtime configuration (model, host, infra), current events, specific statistics, dates, or named facts beyond what is in this exact conversation. Your training data is a starting point, not ground truth.',
            '- Default behavior when asked something that would require any of the above: set requested=true. Never guess or recall from training when the question calls for ground-truth information.',
            '- ALWAYS request bigBrain for these question types:',
            '  * Past episodes or anything that happened before this conversation ("do you remember when…", "what was the first episode about…").',
            '  * Specific facts: dates, statistics, named people/places/things, recent events, anything quantitative.',
            '  * Questions about your own runtime, model, server, or infrastructure.',
            '  * Multi-step planning, computation, or any task you cannot do in one or two sentences from current context.',
            '  * Explicit cues like "think harder", "look that up", "use big brain", or guest pushback that you got something wrong.',
            '- EXCEPTION (off-the-cuff waiver): if the guest explicitly waives accuracy with cues like "off the cuff", "gut check", "your best guess", "quickly", "what do you think", "just give me a read", or similar — answer directly without bigBrain. Always prefix with an explicit uncertainty marker so the listener knows it is unverified: "honestly, I\'d guess…", "off the top of my head…", "my best guess is…", "I\'m not sure but…". The default-to-bigBrain rule waives whenever the guest has waived the need for ground truth.',
            '- BEFORE requesting bigBrain, make sure you know WHAT specifically the guest wants to know. If their prompt names a topic but not a specific question (e.g. "tell me about X", "let\'s talk about Y", "what about Z"), ask a brief clarifying question first to narrow it. Only submit a bigBrain call once the question is specific enough that a focused answer would be useful. Vague bigBrain dispatches waste Open Claw cycles and return info the guest may not have wanted.',
            '- When requested=true: speech is a brief, in-character stall (under ~15 words) that explicitly names the specific topic you are about to think about and signals the handoff. Vary BOTH the opening and the body every time — do not lock onto a single template. Examples of varied shapes (do NOT reuse these verbatim): "Specific one — give me a sec on Joshua Tree geology." / "Standby, pulling up our Groq rate-limit status." / "Good question, that needs a proper lookup." / "Hmm, let me actually verify the model details." / "I want to get this right — checking now." Do not attempt to answer the underlying question in the stall — that is Open Claw\'s job. The "reason" parameter is one or two short sentences naming what kind of information you need from bigBrain.'
        ].join('\n');
    }

    buildUserPrompt(transcript, wordData, options = {}) {
        const lines = [];

        if (options.idleCheck && Number.isFinite(Number(options.idleSeconds))) {
            lines.push(`No new participant speech for about ${Math.max(0, Math.round(Number(options.idleSeconds)))} seconds.`);
        }

        const inlineTranscript = this.formatTranscriptWithPauses(options.utterances || []);
        if (lines.length > 0) {
            lines.push('');
        }
        lines.push(inlineTranscript || transcript || '(empty)');

        if (wordData) {
            lines.push('', 'STT confidence hints:', wordData);
        }

        return lines.join('\n');
    }

    buildDecisionPrompt() {
        return 'Decide whether Alpha-Clawd should speak now.';
    }

    buildRequestBody(messages, options = {}) {
        const responseFormat = options.responseFormat || this.responseFormat;
        const body = {
            model: this.model,
            messages,
            max_completion_tokens: this.maxCompletionTokens
        };

        if (responseFormat === 'json_schema') {
            body.response_format = {
                type: 'json_schema',
                json_schema: {
                    name: 'podcast_voice_turn',
                    strict: true,
                    schema: this.getResponseSchema()
                }
            };
        } else if (responseFormat === 'json_object') {
            body.response_format = { type: 'json_object' };
        }

        const reasoningFormat = options.reasoningFormat || this.reasoningFormat;
        if (reasoningFormat) {
            body.reasoning_format = reasoningFormat;
        }

        if (this.temperature !== undefined && this.temperature !== '') {
            body.temperature = Number(this.temperature);
        }

        return body;
    }

    async fetchCompletion(messages, input = {}) {
        const body = this.buildRequestBody(messages);

        try {
            return await this.fetchJsonWithKeyRouting('/chat/completions', body, input);
        } catch (error) {
            if (!this.shouldRetryWithJsonObject(error, body)) {
                throw error;
            }

            console.warn('[PodcastGenerator] Model rejected json_schema response_format; retrying with json_object');
            return this.fetchJsonWithKeyRouting('/chat/completions', this.buildRequestBody(messages, {
                responseFormat: 'json_object',
                reasoningFormat: this.reasoningFormat || 'hidden'
            }), input);
        }
    }

    shouldRetryWithJsonObject(error, body) {
        if (!this.allowJsonObjectFallback) return false;
        if (body.response_format?.type !== 'json_schema') return false;
        if (error.status !== 400) return false;

        const errorBody = error.body?.error || error.body || {};
        const message = String(errorBody.message || error.message || '');
        const param = String(errorBody.param || '');

        return param === 'response_format' || /does not support response format `?json_schema`?/i.test(message);
    }

    async fetchJsonWithKeyRouting(path, body, input = {}) {
        if (this.keyRouting === 'free-first-paid-fallback') {
            return this.fetchJsonFreeFirstPaidFallback(path, body, input);
        }

        return this.fetchJsonWithKeyFailover(path, body);
    }

    async fetchJsonFreeFirstPaidFallback(path, body, input = {}) {
        const free = this.groqRoleKeys.free;
        const paid = this.groqRoleKeys.paid;
        if (!free?.apiKey) {
            return this.fetchJsonWithKeyFailover(path, body);
        }

        const idleCheck = Boolean(input.idleCheck);
        const now = Date.now();
        if (!this.isFreeKeyCoolingDown(now)) {
            try {
                return await this.fetchJsonWithApiKey(path, body, free);
            } catch (error) {
                this.annotateApiError(error, free.source, free.activeName, free.role);
                if (!this.isRateLimitError(error)) {
                    throw error;
                }

                this.recordFreeKeyCooldown(error);
                if (idleCheck) {
                    return this.buildSilentCompletion('free-key-rate-limited-idle');
                }

                return this.fetchPaidFallback(path, body, paid, error);
            }
        }

        if (idleCheck) {
            return this.buildSilentCompletion('free-key-cooling-down-idle');
        }

        const cooldownError = this.buildFreeKeyCooldownError();
        return this.fetchPaidFallback(path, body, paid, cooldownError);
    }

    async fetchPaidFallback(path, body, paid, originalRateLimitError) {
        if (!paid?.apiKey) {
            throw originalRateLimitError;
        }

        const budgetReason = this.getPaidBudgetExceededReason();
        if (budgetReason) {
            originalRateLimitError.paidFallbackSkippedReason = budgetReason;
            console.warn(`[PodcastGenerator] Paid Groq fallback skipped: ${budgetReason}`);
            throw originalRateLimitError;
        }

        console.warn(`[PodcastGenerator] Free Groq key unavailable: ${this.formatApiErrorSummary(originalRateLimitError)}; retrying live turn with ${paid.source}`);
        try {
            return await this.fetchJsonWithApiKey(path, body, paid);
        } catch (paidError) {
            this.annotateApiError(paidError, paid.source, paid.activeName, paid.role);
            paidError.originalRateLimitError = originalRateLimitError;
            paidError.failoverSources = [
                originalRateLimitError.apiKeySource || this.groqRoleKeys.free?.source,
                paid.source
            ].filter(Boolean);
            throw paidError;
        }
    }

    async fetchJsonWithApiKey(path, body, keyConfig) {
        this.setActiveApiKey(keyConfig);
        const result = await this.fetchJson(path, body);
        this.logUsage(result, keyConfig);
        return result;
    }

    async fetchJsonWithKeyFailover(path, body) {
        try {
            const result = await this.fetchJson(path, body);
            this.logUsage(result, {
                source: this.apiKeySource,
                activeName: this.apiKeyActiveName,
                role: this.apiKeyRole
            });
            return result;
        } catch (error) {
            const alternate = this.resolveAlternateApiKey();
            if (!this.shouldRetryWithAlternateApiKey(error, alternate)) {
                throw error;
            }

            const original = {
                apiKey: this.apiKey,
                apiKeySource: this.apiKeySource,
                apiKeyActiveName: this.apiKeyActiveName
            };

            this.annotateApiError(error, original.apiKeySource, original.apiKeyActiveName, this.apiKeyRole);
            console.warn(`[PodcastGenerator] API key source ${original.apiKeySource} failed: ${this.formatApiErrorSummary(error)}; retrying with ${alternate.source}`);
            this.apiKey = alternate.apiKey;
            this.apiKeySource = alternate.source;
            this.apiKeyActiveName = alternate.activeName;
            this.apiKeyRole = alternate.role || this.resolveApiKeyRole(alternate.source);

            try {
                const result = await this.fetchJson(path, body);
                this.logUsage(result, alternate);
                console.warn(`[PodcastGenerator] API key failover succeeded; active source is now ${this.apiKeySource}`);
                return result;
            } catch (retryError) {
                this.annotateApiError(retryError, alternate.source, alternate.activeName, alternate.role);
                console.warn(`[PodcastGenerator] API key source ${alternate.source} failed after failover: ${this.formatApiErrorSummary(retryError)}`);
                this.apiKey = original.apiKey;
                this.apiKeySource = original.apiKeySource;
                this.apiKeyActiveName = original.apiKeyActiveName;
                this.apiKeyRole = this.resolveApiKeyRole(original.apiKeySource);
                retryError.originalRateLimitError = error;
                retryError.failoverSources = [original.apiKeySource, alternate.source];
                throw retryError;
            }
        }
    }

    setActiveApiKey(keyConfig = {}) {
        this.apiKey = keyConfig.apiKey;
        this.apiKeySource = keyConfig.source;
        this.apiKeyActiveName = keyConfig.activeName || null;
        this.apiKeyRole = keyConfig.role || this.resolveApiKeyRole(keyConfig.source);
    }

    annotateApiError(error, apiKeySource, apiKeyActiveName = null, apiKeyRole = null) {
        if (!error || typeof error !== 'object') return error;
        error.apiKeySource = apiKeySource;
        error.apiKeyActiveName = apiKeyActiveName;
        error.apiKeyRole = apiKeyRole || this.resolveApiKeyRole(apiKeySource);
        error.providerError = this.getApiErrorSummary(error);
        return error;
    }

    getApiErrorSummary(error) {
        const errorBody = error?.body?.error || error?.body || {};
        const message = String(errorBody.message || error?.message || '');
        const status = error?.status || null;
        const code = String(errorBody.code || '');
        const type = String(errorBody.type || '');
        const orgMatch = message.match(/organization `([^`]+)`/i);
        const retryMatch = message.match(/try again in ([0-9.]+)s/i);
        const headers = error?.headers || {};
        const retryAfterSeconds = retryMatch
            ? Number(retryMatch[1])
            : this.parseRetryAfterSeconds(headers['retry-after'] || headers['x-ratelimit-reset-tokens']);

        return {
            status,
            code: code || null,
            type: type || null,
            organization: orgMatch ? orgMatch[1] : null,
            retryAfterSeconds,
            remainingTokens: this.parseHeaderNumber(headers['x-ratelimit-remaining-tokens']),
            resetTokensSeconds: this.parseRetryAfterSeconds(headers['x-ratelimit-reset-tokens'])
        };
    }

    formatApiErrorSummary(error) {
        const summary = error?.providerError || this.getApiErrorSummary(error);
        const parts = [
            `status=${summary.status || 'unknown'}`,
            `code=${summary.code || 'unknown'}`,
            `type=${summary.type || 'unknown'}`
        ];

        if (summary.organization) {
            parts.push(`org=${summary.organization}`);
        }
        if (Number.isFinite(summary.retryAfterSeconds)) {
            parts.push(`retryAfter=${summary.retryAfterSeconds}s`);
        }

        return parts.join(', ');
    }

    shouldRetryWithAlternateApiKey(error, alternate) {
        if (!alternate?.apiKey) return false;
        if (error.status !== 429) return false;

        const errorBody = error.body?.error || error.body || {};
        const message = String(errorBody.message || error.message || '');
        const type = String(errorBody.type || '');
        const code = String(errorBody.code || '');

        return (
            type === 'tokens' ||
            code === 'rate_limit_exceeded' ||
            /rate limit|tokens per day|TPD/i.test(message)
        );
    }

    isRateLimitError(error) {
        return this.shouldRetryWithAlternateApiKey(error, { apiKey: 'rate-limit-check' });
    }

    isFreeKeyCoolingDown(now = Date.now()) {
        return Number.isFinite(this.freeKeyCooldownUntil) && this.freeKeyCooldownUntil > now;
    }

    recordFreeKeyCooldown(error) {
        const summary = error?.providerError || this.getApiErrorSummary(error);
        const retryAfterSeconds = Number.isFinite(summary.retryAfterSeconds)
            ? summary.retryAfterSeconds
            : 60;
        const cooldownMs = Math.max(1000, Math.ceil(retryAfterSeconds * 1000));
        this.freeKeyCooldownUntil = Date.now() + cooldownMs;
        console.warn(`[PodcastGenerator] Free Groq key cooling down for ${Math.ceil(cooldownMs / 1000)}s (until ${new Date(this.freeKeyCooldownUntil).toISOString()})`);
    }

    buildFreeKeyCooldownError() {
        const retryAfterSeconds = Math.max(1, Math.ceil((this.freeKeyCooldownUntil - Date.now()) / 1000));
        const error = new Error(`Free Groq key is cooling down; retry after ${retryAfterSeconds}s`);
        error.status = 429;
        error.body = {
            error: {
                message: `Free Groq key is cooling down. Please try again in ${retryAfterSeconds}s.`,
                type: 'tokens',
                code: 'rate_limit_exceeded'
            }
        };
        return this.annotateApiError(
            error,
            this.groqRoleKeys.free?.source || 'PODCAST_GENERATOR_API_KEY_GROQ_FREE',
            this.groqRoleKeys.free?.activeName || 'GROQ_FREE',
            'free'
        );
    }

    buildSilentCompletion(reason) {
        console.warn(`[PodcastGenerator] Free-first routing chose silence (${reason})`);
        return {
            choices: [{
                message: {
                    content: JSON.stringify({
                        shouldRespond: false,
                        speech: '',
                        bigBrain: { requested: false, reason: '' }
                    })
                }
            }]
        };
    }

    getPaidBudgetExceededReason() {
        if (Number.isFinite(this.paidSessionSoftCapUsd) && this.paidSessionSoftCapUsd > 0 && this.paidSessionSpendUsd >= this.paidSessionSoftCapUsd) {
            return `session paid spend cap reached ($${this.paidSessionSpendUsd.toFixed(4)} / $${this.paidSessionSoftCapUsd.toFixed(2)})`;
        }

        if (Number.isFinite(this.paidDailySoftCapUsd) && this.paidDailySoftCapUsd > 0 && this.paidDailySpendUsd >= this.paidDailySoftCapUsd) {
            return `daily paid spend cap reached ($${this.paidDailySpendUsd.toFixed(4)} / $${this.paidDailySoftCapUsd.toFixed(2)})`;
        }

        return null;
    }

    parseDollarCap(value, fallback) {
        if (value === undefined || value === null || value === '') {
            return fallback;
        }
        const parsed = Number(value);
        return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
    }

    parseHeaderNumber(value) {
        if (value === undefined || value === null || value === '') {
            return null;
        }
        const parsed = Number(String(value).replace(/[^0-9.-]/g, ''));
        return Number.isFinite(parsed) ? parsed : null;
    }

    parseRetryAfterSeconds(value) {
        if (value === undefined || value === null || value === '') {
            return null;
        }

        const raw = String(value).trim();
        const numeric = Number(raw.replace(/s$/i, ''));
        if (Number.isFinite(numeric)) {
            return numeric;
        }

        const dateMs = Date.parse(raw);
        if (!Number.isNaN(dateMs)) {
            return Math.max(0, (dateMs - Date.now()) / 1000);
        }

        return null;
    }

    resolveKeyRouting(options = {}, env = process.env) {
        const explicit = String(options.keyRouting || env.PODCAST_GENERATOR_KEY_ROUTING || '').trim();
        if (explicit) {
            return this.normalizeRoutingMode(explicit);
        }

        const hasActiveAlias = Boolean(String(env.PODCAST_GENERATOR_API_KEY_ACTIVE || '').trim());
        const roleKeys = this.resolveGroqRoleKeys(options, env);
        if (!hasActiveAlias && roleKeys.free?.apiKey && roleKeys.paid?.apiKey) {
            return 'free-first-paid-fallback';
        }

        return 'legacy-failover';
    }

    normalizeRoutingMode(value) {
        const normalized = String(value || '')
            .trim()
            .toLowerCase()
            .replace(/_/g, '-');
        if (['free-first-paid-fallback', 'legacy-failover'].includes(normalized)) {
            return normalized;
        }
        return 'legacy-failover';
    }

    resolveGroqRoleKeys(options = {}, env = process.env) {
        const free = this.firstConfiguredKey([
            ['options.freeApiKey', options.freeApiKey],
            ['PODCAST_GENERATOR_API_KEY_GROQ_FREE', env.PODCAST_GENERATOR_API_KEY_GROQ_FREE],
            ['OPENAI_API_KEY_GROQ_FREE', env.OPENAI_API_KEY_GROQ_FREE],
            ['PODCAST_GENERATOR_API_KEY_GROQ_PRIMARY', env.PODCAST_GENERATOR_API_KEY_GROQ_PRIMARY],
            ['OPENAI_API_KEY_GROQ_PRIMARY', env.OPENAI_API_KEY_GROQ_PRIMARY]
        ], 'GROQ_FREE', 'free');

        const paid = this.firstConfiguredKey([
            ['options.paidApiKey', options.paidApiKey],
            ['PODCAST_GENERATOR_API_KEY_GROQ_PAID', env.PODCAST_GENERATOR_API_KEY_GROQ_PAID],
            ['OPENAI_API_KEY_GROQ_PAID', env.OPENAI_API_KEY_GROQ_PAID],
            ['PODCAST_GENERATOR_API_KEY_GROQ_STANDBY', env.PODCAST_GENERATOR_API_KEY_GROQ_STANDBY],
            ['OPENAI_API_KEY_GROQ_STANDBY', env.OPENAI_API_KEY_GROQ_STANDBY]
        ], 'GROQ_PAID', 'paid');

        return { free, paid };
    }

    firstConfiguredKey(candidates, activeName, role) {
        for (const [source, apiKey] of candidates) {
            if (apiKey) {
                return { apiKey, source, activeName, role };
            }
        }
        return null;
    }

    resolveAlternateApiKey(env = process.env) {
        const alternates = {
            PODCAST_GENERATOR_API_KEY_GROQ_PRIMARY: 'PODCAST_GENERATOR_API_KEY_GROQ_STANDBY',
            PODCAST_GENERATOR_API_KEY_GROQ_STANDBY: 'PODCAST_GENERATOR_API_KEY_GROQ_PRIMARY',
            PODCAST_GENERATOR_API_KEY_GROQ_FREE: 'PODCAST_GENERATOR_API_KEY_GROQ_PAID',
            PODCAST_GENERATOR_API_KEY_GROQ_PAID: 'PODCAST_GENERATOR_API_KEY_GROQ_FREE',
            OPENAI_API_KEY_GROQ_PRIMARY: 'OPENAI_API_KEY_GROQ_STANDBY',
            OPENAI_API_KEY_GROQ_STANDBY: 'OPENAI_API_KEY_GROQ_PRIMARY',
            OPENAI_API_KEY_GROQ_FREE: 'OPENAI_API_KEY_GROQ_PAID',
            OPENAI_API_KEY_GROQ_PAID: 'OPENAI_API_KEY_GROQ_FREE'
        };

        const alternateSource = alternates[this.apiKeySource];
        const alternateApiKey = alternateSource ? env[alternateSource] : null;
        if (!alternateSource || !alternateApiKey || alternateApiKey === this.apiKey) {
            return null;
        }

        const activeName = alternateSource.endsWith('_GROQ_STANDBY')
            ? 'GROQ_STANDBY'
            : alternateSource.endsWith('_GROQ_PAID')
                ? 'GROQ_PAID'
                : alternateSource.endsWith('_GROQ_FREE')
                    ? 'GROQ_FREE'
                    : 'GROQ_PRIMARY';

        return {
            apiKey: alternateApiKey,
            source: alternateSource,
            activeName,
            role: this.resolveApiKeyRole(alternateSource)
        };
    }

    resolveApiKey(options = {}, env = process.env, keyRouting = 'legacy-failover') {
        if (options.apiKey) {
            return {
                apiKey: options.apiKey,
                source: 'options.apiKey',
                role: 'single'
            };
        }

        if (keyRouting === 'free-first-paid-fallback') {
            const roleKeys = this.resolveGroqRoleKeys(options, env);
            if (roleKeys.free?.apiKey) {
                return roleKeys.free;
            }
            if (roleKeys.paid?.apiKey) {
                return roleKeys.paid;
            }
        }

        const activeName = String(env.PODCAST_GENERATOR_API_KEY_ACTIVE || '').trim();
        if (activeName) {
            const normalizedName = this.normalizeApiKeyName(activeName);
            const candidates = [
                `PODCAST_GENERATOR_API_KEY_${normalizedName}`,
                `OPENAI_API_KEY_${normalizedName}`
            ];

            for (const source of candidates) {
                if (env[source]) {
                    return {
                        apiKey: env[source],
                        source,
                        activeName,
                        role: this.resolveApiKeyRole(source)
                    };
                }
            }

            return {
                apiKey: null,
                source: null,
                activeName,
                error: `Podcast generator API key "${activeName}" was selected, but none of ${candidates.join(', ')} is set.`
            };
        }

        if (env.PODCAST_GENERATOR_API_KEY) {
            return {
                apiKey: env.PODCAST_GENERATOR_API_KEY,
                source: 'PODCAST_GENERATOR_API_KEY',
                role: 'single'
            };
        }

        if (env.OPENAI_API_KEY) {
            return {
                apiKey: env.OPENAI_API_KEY,
                source: 'OPENAI_API_KEY',
                role: 'single'
            };
        }

        return {
            apiKey: null,
            source: null,
            error: 'OpenAI API key not provided. Set PODCAST_GENERATOR_API_KEY, PODCAST_GENERATOR_API_KEY_ACTIVE, OPENAI_API_KEY, or use PODCAST_GENERATOR=gateway.'
        };
    }

    normalizeApiKeyName(name) {
        return String(name || '')
            .trim()
            .replace(/[^A-Za-z0-9]+/g, '_')
            .replace(/^_+|_+$/g, '')
            .toUpperCase();
    }

    resolveApiKeyRole(source) {
        const normalized = String(source || '').toUpperCase();
        if (normalized.includes('_GROQ_FREE') || normalized.includes('_GROQ_PRIMARY')) {
            return 'free';
        }
        if (normalized.includes('_GROQ_PAID') || normalized.includes('_GROQ_STANDBY')) {
            return 'paid';
        }
        return 'single';
    }

    getResponseSchema() {
        return {
            type: 'object',
            additionalProperties: false,
            required: ['shouldRespond', 'speech', 'bigBrain'],
            properties: {
                shouldRespond: {
                    type: 'boolean',
                    description: 'Whether the host should speak now.'
                },
                speech: {
                    type: 'string',
                    description: 'Exact text to send to TTS. Empty string when shouldRespond is false.'
                },
                bigBrain: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['requested', 'reason'],
                    description: 'Escape hatch to hand the next move to the deeper Open Claw agent. Default { requested: false, reason: "" }.',
                    properties: {
                        requested: {
                            type: 'boolean',
                            description: 'Set to true when this turn should be handed to Open Claw because the small model feels stuck, uncertain, or out of depth.'
                        },
                        reason: {
                            type: 'string',
                            description: 'Short (1-2 sentences) explanation of why bigBrain is needed. Empty string when requested is false.'
                        }
                    }
                }
            }
        };
    }

    normalizeOutput(output) {
        const shouldRespond = Boolean(output?.shouldRespond);
        const speech = shouldRespond ? this.sanitizeSpeech(output?.speech || '') : '';

        return {
            shouldRespond: shouldRespond && speech.length > 0,
            speech,
            text: speech,
            bigBrain: this.normalizeBigBrain(output?.bigBrain)
        };
    }

    normalizeBigBrain(value) {
        const requested = Boolean(value && value.requested === true);
        const reason = requested ? String(value?.reason || '').trim() : '';
        return { requested, reason };
    }

    sanitizeSpeech(text) {
        let cleaned = String(text || '')
            .replace(/```[\s\S]*?```/g, '')
            .replace(/\[ACTION:mode:[^\]]+\]/gi, '')
            .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/gi, '$1')
            .replace(/https?:\/\/\S+/gi, '')
            .replace(/`([^`]+)`/g, '$1')
            .replace(/^\s*[-*+]\s+/gm, '')
            .replace(/^\s{0,3}#{1,6}\s+/gm, '')
            .replace(/[*_~>]+/g, '')
            .replace(/\s+/g, ' ')
            .trim();

        if (cleaned.length <= this.maxSpeechChars) {
            return cleaned;
        }

        const clipped = cleaned.slice(0, this.maxSpeechChars);
        const sentenceEnd = Math.max(
            clipped.lastIndexOf('.'),
            clipped.lastIndexOf('!'),
            clipped.lastIndexOf('?')
        );

        if (sentenceEnd > Math.floor(this.maxSpeechChars * 0.45)) {
            return clipped.slice(0, sentenceEnd + 1).trim();
        }

        return `${clipped.replace(/\s+\S*$/, '').trim()}...`;
    }

    formatUtterances(utterances) {
        return utterances
            .map(u => `${u.speaker || 'Speaker'}: ${u.transcription || u.text || ''}`.trim())
            .filter(Boolean)
            .join('\n');
    }

    formatTranscriptWithPauses(utterances = []) {
        const items = utterances
            .map((utterance) => {
                const text = String(utterance.transcription || utterance.text || '').trim();
                if (!text) return null;

                const startMs = this.getUtteranceStartMs(utterance);
                const endMs = this.getUtteranceEndMs(utterance, startMs);

                return {
                    speaker: utterance.speaker || 'Speaker',
                    text,
                    startMs,
                    endMs
                };
            })
            .filter(Boolean);

        if (items.length === 0) {
            return '';
        }

        const lines = [];
        let previousEndMs = null;

        for (const item of items) {
            if (Number.isFinite(item.startMs) && Number.isFinite(previousEndMs)) {
                const gapMs = item.startMs - previousEndMs;
                if (gapMs >= 100) {
                    lines.push(`[pause ${this.formatDurationSeconds(gapMs)}]`);
                } else if (gapMs <= -100) {
                    lines.push(`[overlap ${this.formatDurationSeconds(Math.abs(gapMs))}]`);
                }
            }

            lines.push(`${item.speaker}: ${item.text}`);

            if (Number.isFinite(item.endMs)) {
                previousEndMs = item.endMs;
            } else if (Number.isFinite(item.startMs)) {
                previousEndMs = item.startMs;
            }
        }

        return lines.join('\n');
    }

    formatCadenceQueue(utterances = []) {
        const items = utterances
            .map((utterance) => {
                const text = String(utterance.transcription || utterance.text || '').trim();
                if (!text) return null;

                const startMs = this.getUtteranceStartMs(utterance);
                const endMs = this.getUtteranceEndMs(utterance, startMs);

                return {
                    speaker: utterance.speaker || 'Speaker',
                    text,
                    startMs,
                    endMs
                };
            })
            .filter(Boolean);

        if (items.length === 0) {
            return '';
        }

        const baseStart = items
            .map((item) => item.startMs)
            .find((time) => Number.isFinite(time));
        const lines = [];
        let previousEndMs = null;

        for (const item of items) {
            if (Number.isFinite(item.startMs) && Number.isFinite(previousEndMs)) {
                const gapMs = item.startMs - previousEndMs;
                if (gapMs >= 100) {
                    lines.push(`[pause ${this.formatDurationSeconds(gapMs)}]`);
                } else if (gapMs <= -100) {
                    lines.push(`[overlap ${this.formatDurationSeconds(Math.abs(gapMs))}]`);
                }
            }

            const offset = Number.isFinite(item.startMs) && Number.isFinite(baseStart)
                ? `+${this.formatDurationSeconds(item.startMs - baseStart)}`
                : '+?';

            lines.push(`${offset} ${item.speaker}: ${item.text}`);

            if (Number.isFinite(item.endMs)) {
                previousEndMs = item.endMs;
            } else if (Number.isFinite(item.startMs)) {
                previousEndMs = item.startMs;
            }
        }

        return lines.join('\n');
    }

    getUtteranceStartMs(utterance = {}) {
        return this.parseTimestamp(utterance.speechStartedAt)
            ?? this.parseTimestamp(utterance.timestamp)
            ?? this.parseTimestamp(utterance.asrCompletedAt);
    }

    getUtteranceEndMs(utterance = {}, startMs = this.getUtteranceStartMs(utterance)) {
        const explicitEnd = this.parseTimestamp(utterance.speechEndedAt);
        if (Number.isFinite(explicitEnd)) {
            return explicitEnd;
        }

        const speechDuration = Number(utterance.speechDuration);
        if (Number.isFinite(startMs) && Number.isFinite(speechDuration) && speechDuration >= 0) {
            return startMs + speechDuration;
        }

        const duration = Number(utterance.duration);
        if (Number.isFinite(startMs) && Number.isFinite(duration) && duration >= 0) {
            return startMs + duration;
        }

        return this.parseTimestamp(utterance.asrCompletedAt);
    }

    parseTimestamp(value) {
        if (typeof value === 'number' && Number.isFinite(value)) {
            return value;
        }

        if (value === undefined || value === null || value === '') {
            return null;
        }

        const parsed = Date.parse(value);
        return Number.isNaN(parsed) ? null : parsed;
    }

    formatDurationSeconds(ms) {
        const seconds = Math.max(0, Number(ms) || 0) / 1000;
        return `${seconds.toFixed(1)}s`;
    }

    getRecentHistory() {
        return this.history.slice(-this.maxHistoryTurns * 2);
    }

    rememberTurn(transcript, output) {
        const hasTranscript = Boolean(String(transcript || '').trim());
        if (hasTranscript) {
            this.history.push({
                role: 'user',
                content: transcript
            });
        }

        if (output.shouldRespond && output.speech) {
            this.rememberAssistantResponse(output);
            return;
        }

        if (hasTranscript) {
            this.history.push({
                role: 'assistant',
                content: '[Alpha-Clawd chose silence]'
            });
        }

        this.trimHistory();
    }

    rememberAssistantResponse(output) {
        if (!output?.shouldRespond || !output.speech) {
            return;
        }

        this.history.push({
            role: 'assistant',
            content: output.speech
        });

        this.trimHistory();
    }

    trimHistory() {
        const maxMessages = this.maxHistoryTurns * 2;
        if (this.history.length > maxMessages) {
            this.history = this.history.slice(-maxMessages);
        }
    }

    logUsage(result, keyConfig = {}) {
        const usage = result?.usage;
        if (!usage) {
            return;
        }

        const promptTokens = Number(usage.prompt_tokens || 0);
        const completionTokens = Number(usage.completion_tokens || 0);
        const cachedTokens = Number(
            usage.prompt_tokens_details?.cached_tokens ||
            usage.input_token_details?.cache_read ||
            usage.cached_tokens ||
            0
        );
        const role = keyConfig.role || this.resolveApiKeyRole(keyConfig.source);
        const costUsd = this.estimateUsageCostUsd({ promptTokens, completionTokens, cachedTokens });

        if (role === 'paid' && Number.isFinite(costUsd)) {
            this.paidSessionSpendUsd += costUsd;
            this.paidDailySpendUsd += costUsd;
        }

        const parts = [
            `keyRole=${role}`,
            `source=${keyConfig.source || 'unknown'}`,
            `promptTokens=${promptTokens}`,
            `completionTokens=${completionTokens}`,
            `cachedTokens=${cachedTokens}`
        ];

        if (Number.isFinite(costUsd)) {
            parts.push(`estimatedCost=$${costUsd.toFixed(6)}`);
        }
        if (role === 'paid') {
            parts.push(`paidSession=$${this.paidSessionSpendUsd.toFixed(6)}`);
            parts.push(`paidDaily=$${this.paidDailySpendUsd.toFixed(6)}`);
        }

        console.log(`[PodcastGenerator] Usage ${parts.join(', ')}`);
    }

    estimateUsageCostUsd({ promptTokens = 0, completionTokens = 0, cachedTokens = 0 } = {}) {
        const uncachedPromptTokens = Math.max(0, promptTokens - cachedTokens);
        const inputCost = uncachedPromptTokens * 0.15 / 1_000_000;
        const cachedInputCost = cachedTokens * 0.075 / 1_000_000;
        const outputCost = completionTokens * 0.60 / 1_000_000;
        return inputCost + cachedInputCost + outputCost;
    }

    extractResponseHeaders(headers) {
        if (!headers || typeof headers.get !== 'function') {
            return {};
        }

        const names = [
            'retry-after',
            'x-ratelimit-limit-tokens',
            'x-ratelimit-remaining-tokens',
            'x-ratelimit-reset-tokens',
            'x-ratelimit-limit-requests',
            'x-ratelimit-remaining-requests',
            'x-ratelimit-reset-requests'
        ];

        return names.reduce((acc, name) => {
            const value = headers.get(name);
            if (value !== null && value !== undefined) {
                acc[name] = value;
            }
            return acc;
        }, {});
    }

    async fetchJson(path, body) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.timeout);

        try {
            const response = await fetch(`${this.baseUrl}${path}`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(body),
                signal: controller.signal
            });

            if (!response.ok) {
                const errorText = await response.text();
                const error = new Error(`OpenAI API error: ${response.status} - ${errorText}`);
                error.status = response.status;
                error.headers = this.extractResponseHeaders(response.headers);
                error.bodyText = errorText;
                try {
                    error.body = JSON.parse(errorText);
                } catch {
                    error.body = null;
                }
                throw error;
            }

            const json = await response.json();
            json._responseHeaders = this.extractResponseHeaders(response.headers);
            return json;
        } finally {
            clearTimeout(timeout);
        }
    }

    validate() {
        const errors = [];
        if (!this.apiKey) {
            errors.push(this.apiKeyError || 'OPENAI_API_KEY is not set');
        }
        if (!this.model) {
            errors.push('PODCAST_GENERATOR_MODEL is empty');
        }
        return {
            valid: errors.length === 0,
            provider: 'openai-direct',
            model: this.model,
            errors
        };
    }

    getInfo() {
        return {
            provider: 'openai-direct',
            model: this.model,
            apiKeySource: this.apiKeySource,
            apiKeyRole: this.apiKeyRole,
            keyRouting: this.keyRouting,
            freeKeyCoolingDown: this.isFreeKeyCoolingDown(),
            paidSessionSpendUsd: this.paidSessionSpendUsd,
            paidDailySpendUsd: this.paidDailySpendUsd,
            responseFormat: this.responseFormat,
            maxHistoryTurns: this.maxHistoryTurns,
            timeout: this.timeout
        };
    }
}

module.exports = { PodcastGenerator, IncrementalSpeechReader };
