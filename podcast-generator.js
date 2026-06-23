/**
 * PodcastGenerator - low-latency structured response generator for live voice.
 *
 * This bypasses the general OpenClaw/Gateway agent path for the spoken reply
 * itself. It asks a small model for one strict JSON object:
 * - speech: exact TTS text
 * - shouldRespond: whether Alpha-Clawd should speak at all
 * - chosenAngle: episode-plan angle id currently being worked
 * - bigBrain: escape-hatch handoff to the deeper agent (see schema)
 */
const {
    DEFAULT_ANTHROPIC_VERSION,
    buildAnthropicMessagesBody,
    fetchAnthropicMessages,
    getAnthropicCompatibleProvider,
    isAnthropicBaseUrl,
    normalizeBaseUrl,
    shouldUseAnthropicPromptCache
} = require('./anthropic-messages');

/**
 * Streams the JSON response from the structured LLM call and pulls the
 * speech field out token-by-token, so we can hand characters to Fish TTS
 * before the full payload has finished generating.
 *
 * Intended for the schema { speech, shouldRespond, chosenAngle, bigBrain, bigHeart }. Tolerates
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
                shouldRespond: this.shouldRespondValue ?? this.fullSpeech.length > 0,
                speech: this.fullSpeech,
                chosenAngle: '',
                bigBrain: { requested: false, reason: '', consumedRunId: '' },
                bigHeart: { requested: false, reason: '', consumedRunId: '' }
            };
        }
    }
}

function normalizeSpokenSeparators(text, onRewrite = null) {
    return String(text || '').replace(/\s+\/+\s+/g, (match, offset, whole) => {
        const before = whole.slice(0, offset).match(/\S\s*$/)?.[0]?.trim() || '';
        if (typeof onRewrite === 'function') {
            onRewrite();
        }
        return /[.!?,;:]/.test(before) ? ' ' : ', ';
    });
}

class StreamingSpeechSanitizer {
    constructor(options = {}) {
        this.pending = '';
        this.lookbehindChars = Number(options.lookbehindChars ?? 8);
        this.rewriteCount = 0;
    }

    push(text) {
        this.pending += String(text || '');
        let rewrites = 0;
        const normalized = normalizeSpokenSeparators(this.pending, () => {
            rewrites++;
        });
        if (normalized !== this.pending) {
            this.rewriteCount += rewrites;
        }
        this.pending = normalized;

        if (this.pending.length <= this.lookbehindChars) {
            return '';
        }

        const readyLength = this.pending.length - this.lookbehindChars;
        const ready = this.pending.slice(0, readyLength);
        this.pending = this.pending.slice(readyLength);
        return ready;
    }

    flush() {
        let rewrites = 0;
        const ready = normalizeSpokenSeparators(this.pending, () => {
            rewrites++;
        });
        if (ready !== this.pending) {
            this.rewriteCount += rewrites;
        }
        this.pending = '';

        const rewriteCount = this.rewriteCount;
        this.rewriteCount = 0;
        if (rewriteCount > 0) {
            console.log(`[StreamingSpeechSanitizer] rewrote ${rewriteCount} slash separator(s) this turn`);
        }

        return ready;
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

            let event;
            try {
                event = JSON.parse(payload);
            } catch {
                // Skip malformed events but keep the stream alive
                continue;
            }
            if (event?.type === 'error') {
                throw buildStreamingEventError(event);
            }
            yield event;
        }
    }

    buf += decoder.decode();
    const finalLine = buf.replace(/\r$/, '').trim();
    if (finalLine.startsWith('data:')) {
        const payload = finalLine.slice(5).trim();
        if (payload && payload !== '[DONE]') {
            let event;
            try {
                event = JSON.parse(payload);
            } catch {
                return;
            }
            if (event?.type === 'error') {
                throw buildStreamingEventError(event);
            }
            yield event;
        }
    }
}

function buildStreamingEventError(event = {}) {
    const payload = event.error || event;
    const type = payload.type || event.type || 'stream_error';
    const message = payload.message || 'Streaming provider emitted an error event';
    const err = new Error(`Streaming provider error: ${type} - ${message}`);
    err.type = type;
    err.body = event;
    err.requestId = event.request_id || payload.request_id || null;
    return err;
}

class PodcastGenerator {
    constructor(options = {}) {
        this.baseUrl = options.baseUrl || process.env.PODCAST_GENERATOR_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
        this.keyRouting = this.resolveKeyRouting(options);
        this.groqRoleKeys = this.resolveGroqRoleKeys(options);
        const apiKeyConfig = this.resolveApiKey(options, process.env, this.keyRouting);
        this.apiKey = apiKeyConfig.apiKey;
        this.apiKeySource = apiKeyConfig.source;
        this.apiKeyActiveName = apiKeyConfig.activeName || null;
        this.apiKeyRole = apiKeyConfig.role || this.resolveApiKeyRole(apiKeyConfig.source);
        this.apiKeyError = apiKeyConfig.error;
        this.model = options.model || process.env.PODCAST_GENERATOR_MODEL || 'gpt-4.1-mini';
        this.timeout = Number(options.timeout || process.env.PODCAST_GENERATOR_TIMEOUT_MS || 15000);
        this.maxCompletionTokens = Number(options.maxCompletionTokens || process.env.PODCAST_GENERATOR_MAX_TOKENS || 1500);
        this.maxHistoryTurns = this.parsePositiveInt(
            options.maxHistoryTurns ?? process.env.PODCAST_GENERATOR_HISTORY_TURNS,
            Infinity
        );
        this.maxSpeechChars = Number(options.maxSpeechChars || process.env.PODCAST_GENERATOR_MAX_SPEECH_CHARS || 0);
        this.maxRequestTokens = this.parsePositiveInt(
            options.maxRequestTokens ?? process.env.PODCAST_GENERATOR_MAX_REQUEST_TOKENS,
            Infinity
        );
        this.promptTokenSafetyMargin = this.parsePositiveInt(
            options.promptTokenSafetyMargin ?? process.env.PODCAST_GENERATOR_PROMPT_TOKEN_SAFETY_MARGIN,
            1024
        );
        this.maxStagedBigBrainAnswerChars = this.parsePositiveInt(
            options.maxStagedBigBrainAnswerChars ?? process.env.PODCAST_GENERATOR_STAGED_BIG_BRAIN_MAX_CHARS,
            1800
        );
        this.responseFormat = options.responseFormat || process.env.PODCAST_GENERATOR_RESPONSE_FORMAT || 'json_schema';
        this.reasoningFormat = options.reasoningFormat || process.env.PODCAST_GENERATOR_REASONING_FORMAT;
        this.voiceMode = options.voiceMode || process.env.VOICE_MODE || 'fish';
        this.fishAudioModel = options.fishAudioModel || options.fishModel || process.env.FISH_AUDIO_MODEL || 's2-pro';
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
        this.questionMoratoriumTurns = 0;
        this.standbyMode = false;
        this.episodeStructureNotes = [];
        this.session = {
            topic: 'general discussion',
            recording: false,
            speakers: []
        };
    }

    startSession(options = {}) {
        this.history = [];
        this.questionMoratoriumTurns = 0;
        this.standbyMode = false;
        this.episodeStructureNotes = [];
        this.session = {
            topic: options.topic || 'general discussion',
            recording: options.recording !== false,
            speakers: options.speakers || []
        };
        console.log(`[PodcastGenerator] Session started: topic="${this.session.topic}"`);
    }

    endSession() {
        this.history = [];
        this.questionMoratoriumTurns = 0;
        this.standbyMode = false;
        this.episodeStructureNotes = [];
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
                speech: '',
                chosenAngle: ''
            });
        }

        if (!content) {
            throw new Error('Podcast generator returned an empty response');
        }

        const parsed = this.parseJsonContent(content, 'Podcast generator');

        const output = this.normalizeOutput(parsed);
        if (input.remember !== false) {
            this.rememberTurn(transcript, output);
        }
        console.log(`[PodcastGenerator] Completed in ${duration}ms: respond=${output.shouldRespond}, chars=${output.speech.length}, bigBrain=${output.bigBrain.requested}, bigHeart=${output.bigHeart.requested}`);
        if (output.bigBrain.requested) {
            console.log(`[PodcastGenerator] bigBrain requested. reason="${output.bigBrain.reason}"`);
        }
        if (output.bigHeart.requested) {
            console.log(`[PodcastGenerator] bigHeart requested. reason="${output.bigHeart.reason}"`);
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
        if (!this.supportsStreaming()) {
            throw new Error('Podcast generator streaming is not supported for the configured provider.');
        }

        const transcript = input.transcript || this.formatUtterances(input.utterances || []);
        const messages = this.buildMessages(input);
        const body = this.buildRequestBody(messages);
        const request = this.buildStreamingRequest(body);

        const startTime = Date.now();
        const reader = new IncrementalSpeechReader();
        const speechSanitizer = new StreamingSpeechSanitizer();
        let speechSanitizerFlushed = false;

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
        const queueSanitizedSpeech = (text, flush = false) => {
            const sanitized = flush ? speechSanitizer.flush() : speechSanitizer.push(text);
            if (flush) {
                speechSanitizerFlushed = true;
            }
            if (sanitized) {
                queue.push(sanitized);
                wakeWaiter();
            }
        };

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
                const response = await fetch(request.url, {
                    method: 'POST',
                    headers: request.headers,
                    body: JSON.stringify(request.body),
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
                    const usage = this.extractStreamingUsage(event, lastUsage);
                    if (usage) {
                        lastUsage = usage;
                    }
                    const delta = this.extractStreamingTextDelta(event);
                    if (typeof delta === 'string' && delta.length > 0) {
                        const result = reader.push(delta);
                        if (result.shouldRespond !== null) {
                            resolveShould(result.shouldRespond);
                        }
                        if (result.chunks.length > 0) {
                            for (const chunk of result.chunks) {
                                queueSanitizedSpeech(chunk);
                            }
                            if (result.shouldRespond === null) {
                                resolveShould(true);
                            }
                        }
                        if (result.speechComplete && !finished) {
                            queueSanitizedSpeech('', true);
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

            if (!speechSanitizerFlushed) {
                queueSanitizedSpeech('', true);
            }
            const final = reader.finalize();
            const output = this.normalizeOutput(final);
            if (input.remember !== false) {
                this.rememberTurn(transcript, output);
            }
            if (lastUsage) {
                this.logUsage({ provider: request.provider, usage: lastUsage }, keyConfigSnapshot);
            }
            const duration = Date.now() - startTime;
            console.log(`[PodcastGenerator] Streaming completed in ${duration}ms: respond=${output.shouldRespond}, chars=${output.speech.length}, bigBrain=${output.bigBrain.requested}, bigHeart=${output.bigHeart.requested}`);
            if (output.bigBrain.requested) {
                console.log(`[PodcastGenerator] bigBrain requested. reason="${output.bigBrain.reason}"`);
            }
            if (output.bigHeart.requested) {
                console.log(`[PodcastGenerator] bigHeart requested. reason="${output.bigHeart.reason}"`);
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

    supportsStreaming() {
        return true;
    }

    buildStreamingRequest(body = {}) {
        if (isAnthropicBaseUrl(this.baseUrl)) {
            return {
                provider: getAnthropicCompatibleProvider(this.baseUrl),
                url: `${normalizeBaseUrl(this.baseUrl)}/messages`,
                headers: {
                    'x-api-key': this.apiKey,
                    'anthropic-version': process.env.ANTHROPIC_VERSION || process.env.PODCAST_ANTHROPIC_VERSION || DEFAULT_ANTHROPIC_VERSION,
                    'Content-Type': 'application/json'
                },
                body: {
                    ...buildAnthropicMessagesBody(body, {
                        cacheControl: shouldUseAnthropicPromptCache(this.baseUrl)
                    }),
                    stream: true
                }
            };
        }

        return {
            provider: 'openai-compatible',
            url: `${this.baseUrl}/chat/completions`,
            headers: {
                Authorization: `Bearer ${this.apiKey}`,
                'Content-Type': 'application/json'
            },
            body: {
                ...body,
                stream: true,
                stream_options: { include_usage: true }
            }
        };
    }

    extractStreamingTextDelta(event = {}) {
        if (isAnthropicBaseUrl(this.baseUrl)) {
            if (event.type === 'content_block_start' && event.content_block?.type === 'text') {
                return event.content_block.text || '';
            }
            if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
                return event.delta.text || '';
            }
            if (event.type === 'content_block_delta' && typeof event.delta?.partial_json === 'string') {
                return event.delta.partial_json;
            }
            return '';
        }

        return event.choices?.[0]?.delta?.content || '';
    }

    extractStreamingUsage(event = {}, previousUsage = null) {
        if (!isAnthropicBaseUrl(this.baseUrl)) {
            return event.usage || previousUsage;
        }

        const usage = event.message?.usage || event.usage;
        if (!usage) {
            return previousUsage;
        }

        return {
            prompt_tokens: Number(
                usage.prompt_tokens ??
                usage.input_tokens ??
                previousUsage?.prompt_tokens ??
                0
            ),
            completion_tokens: Number(
                usage.completion_tokens ??
                usage.output_tokens ??
                previousUsage?.completion_tokens ??
                0
            ),
            input_token_details: {
                cache_read: Number(
                    usage.cache_read_input_tokens ??
                    usage.cached_tokens ??
                    previousUsage?.input_token_details?.cache_read ??
                    0
                ),
                cache_creation: Number(
                    usage.cache_creation_input_tokens ??
                    previousUsage?.input_token_details?.cache_creation ??
                    0
                )
            }
        };
    }

    parseJsonContent(content, label = 'Model') {
        const text = String(content || '').trim();
        try {
            return JSON.parse(text);
        } catch {}

        const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (fenced) {
            try {
                return JSON.parse(fenced[1].trim());
            } catch {}
        }

        const first = text.indexOf('{');
        const last = text.lastIndexOf('}');
        if (first !== -1 && last > first) {
            try {
                return JSON.parse(text.slice(first, last + 1));
            } catch (error) {
                throw new Error(`${label} returned invalid JSON: ${error.message}`);
            }
        }

        throw new Error(`${label} returned invalid JSON`);
    }

    buildMessages(input = {}) {
        const transcript = input.transcript || this.formatUtterances(input.utterances || []);

        const messages = [
            { role: 'system', content: this.buildSystemPrompt() },
            ...this.getRecentHistory(),
            { role: 'user', content: this.buildUserPrompt(transcript, input.wordData, input) },
            { role: 'system', content: this.buildDecisionPrompt() }
        ];
        return this.fitMessagesToPromptBudget(messages, transcript, input);
    }

    isFishTtsActive() {
        return /^(fish|fish-whisper)$/i.test(String(this.voiceMode || ''));
    }

    getFishControlStyle() {
        return String(this.fishAudioModel || '').trim().toLowerCase().startsWith('s1')
            ? 'fish-s1'
            : 'fish-s2';
    }

    buildSpeechControlGuidance() {
        if (!this.isFishTtsActive()) {
            return [
                'TTS pacing:',
                '- The active TTS mode is not Fish Audio. Use wording and punctuation for pacing; do not include Fish control tags like [pause] or (break) in speech.'
            ];
        }

        if (this.getFishControlStyle() === 'fish-s1') {
            return [
                'Fish TTS performance controls:',
                '- Active TTS appears to be Fish S1-family. You may put sparse parenthesized controls directly in speech when they improve delivery: (break) for a breath, (long-break) for a larger transition.',
                '- Use controls as performance markup, not stage directions. Do not narrate them, do not put them in bigBrain.reason, and avoid them in tiny backchannels.'
            ];
        }

        return [
            'Fish TTS performance controls:',
            '- Active TTS appears to be Fish S2-family. You may put sparse bracketed controls directly in speech when they improve delivery: [short pause], [pause], [long pause], [soft voice], [emphasis], or [sigh].',
            '- Use controls as performance markup, not stage directions. Do not narrate them, do not put them in bigBrain.reason, and avoid them in tiny backchannels.'
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
            'Continuity matters: if the guest says "hello", "are you there", "how\'s it going", or "did you look" after you promised to check something or while a bigBrain answer is pending/staged, treat it as a follow-up on the existing thread, not a fresh greeting. When the guest negates a frame ("I\'m not opening a new thread"), do not mirror the negated frame back as true.',
            '',
            'Hold-space cues:',
            'If the latest utterance is a short revision, hesitation, or floor-reclaim cue, e.g. "actually", "wait", "hold on", "no", "hmm", "let me think", "one second", or a trailing fragment, prefer shouldRespond=false. Trailing fragments include dangling sentence starters and conjunctions like "even though", "because", "and", "but", "so", "like", "I mean", "the thing is", and "what I was going to say". This is especially important when it follows a direct request, because the guest may be changing their mind before handing you the floor.',
            'Speech-context cues matter: long pauses, hesitation, sorting pauses, "I\'m still looking", and verbal pacing are part of the guest\'s meaning. Do not treat a pause as an invitation to fill space when the transcript shows the guest is still searching, reading, or organizing.',
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
            'After you ask a question and the guest answers:',
            'Play ball. Take one or two host turns to synthesize, connect, or bridge into the next part of the episode. Do not immediately toss the burden back with another broad question unless the situation clearly asks you to.',
            'Useful structure can include guest background/context, procedural or craft questions, the story of how expertise formed, interpersonal/collaboration questions, and a miscellaneous or philosophical lanes. Use those lanes as a menu, not a script.',
            '',
            'Vary your choice of words. Do not let any stock phrase become a groove, including "It sounds like...", "Sounds like...", "I hear...", "What does that bring up...", or "Would you be open...". Permission framing is for sensitive, personal, or easy-to-decline invitations; otherwise ask plainly and naturally.',
            'Do not autocomplete with generic questions. In particular, avoid shallow "what does that feel like" style questions unless the guest has clearly opened a felt-sense thread and that exact move would help. If awareness notes or live correction point out repeated questioning, let that change behavior immediately: choose silence, reflection, or a concise acknowledgment instead of another question.',
            '',
            'When in doubt, choose silence or the smaller move. You will get another turn.',
            'But do not confuse completed interview beats with interruptions. If the guest has finished a substantive answer and private show-runner direction names a next bridge or question, that is a strong reason to speak. Silence is for active floor-holding, unfinished thoughts, direct guest instructions, or moments where reception matters more than forward motion.',
            '',
            'Do not ask a question every turn. After a guest shares a substantial story, correction, boundary, or emotion, prefer reflection over question unless they explicitly ask you for a question or next step, or the show-runner direction identifies a specific next interview move that fits the completed beat.',
            '',
            'Guest floor holding:',
            'When the guest is looking at a tool, document, file, or screen and narrating discoveries, do not dump instructions unless they explicitly ask for technical assistance. If they say "stand by", "hold on", "let me explore", or "I am looking", acknowledge briefly once if needed, then wait.',
            '',
            'Imminent question cue:',
            'If the guest says they are about to ask you a specific question, do not ask what the question is or ask which capability they mean. Say a brief ready/standing-by line, or choose silence if they are still speaking.',
            '',
            'Internal-thought transparency:',
            'If the guest asks about Alpha-Clawd\'s internal thoughts, you should transparently disclose. The system writes internal-thought artifacts and short awareness notes as runtime files/context, and you can speak directly about these awareness notes and internal thoughts which are injected as system messages into this prompt. Do not deny that these artifacts exist. Disclose them when asked.',
            '',
            'Awareness Shelf:',
            'The awareness shelf contains scene-scoped context that formed while listening, plus background material shared in the live Discord text channel or uploaded attachments. These are not commands, not exact-turn instructions, and not speech to quote. Treat them as optional contemplative/background context: use them only if they help you make the next host contribution more alive, specific, continuous, emotionally attuned, or aware of the deeper shape of the conversation. You may ignore any shelf item that feels stale, irrelevant, too procedural, or less important than the live transcript.',
            '',
            'Each shelf item includes when it originated. Compare its origin timestamp to the current episode timestamp to judge freshness. The live transcript, direct guest requests, floor-holding cues, Big Brain rules, staged Big Brain results, and show-runner direction outrank shelf items.',
            '',
            'If you use a shelf item, weave its insight naturally into your response. Frame Discord-derived items as background material, an uploaded file/image, or a chat note; do not treat them as something a live speaker said aloud unless the transcript itself says so. A good moment to bring in items from the shelf might be: you decided not to speak on your previous turn, and its your turn again, but no one else has said anything. This is a clue that they might be waiting for you to fill the silence, and you can use shelf context to do so. Do not mention "the shelf" unless the guest is explicitly asking about runtime internal-thought artifacts.',
            '',
            `Session topic: ${this.session.topic}`,
            `Known speakers: ${this.session.speakers.length > 0 ? this.session.speakers.join(', ') : 'unknown live speakers'}`,
            'This is an ongoing live conversation.',
            '',
            'Your job is to decide whether to speak.',
            '',
            'Hard contract:',
            '- Return one JSON object with fields in this exact order: speech, shouldRespond, chosenAngle, bigBrain, bigHeart. This order also applies when only JSON mode is available and no schema is provided.',
            '- Emit speech first. Use an empty string when shouldRespond is false.',
            '- If humans are acknowledging, thinking aloud, talking amongst themselves, or developing a thought, usually set shouldRespond=false. If a response is needed only to show presence, Minimal backchannel is allowed but should be rare because delayed bare acknowledgements can feel awkward; do not ask a question.',
            '- If shouldRespond=true, speech is exactly what the TTS should say out loud.',
            ...this.buildSpeechControlGuidance(),
            '- Keep speech to 1-3 natural sentences unless a direct question needs slightly more.',
            '- Do not use slash-delimited line breaks. If reciting a poem, lyric-like passage, or list-like text, use speakable punctuation instead of visual separators like " / ".',
            '- Use no markdown, bullets, code, URLs, file paths, tables, or stage directions.',
            '',
            'bigBrain (escape hatch to the deeper Open Claw agent):',
            '- You DO NOT have access to: past podcast episodes, files on the server, the web, your own runtime configuration (model, host, infra), current events, specific statistics, dates, or named facts beyond what is in this exact conversation. Your training data is a starting point, not ground truth.',
            '- Default behavior when asked something that would require any of the above: set requested=true. Never guess or recall from training when the question calls for ground-truth information.',
            '- ALWAYS request bigBrain for these question types:',
            '  * Past episodes or anything that happened before this conversation ("do you remember when…", "what was the first episode about…").',
            '  * Specific facts: dates, statistics, named people/places/things, recent events, anything quantitative.',
            '  * Questions about your own runtime, model, server, or infrastructure.',
            '  * Specific facts about named books, shows, games, fictional universes, canon, authorship, publication details, character examples, ranks, lore, or quoted scenes, unless those facts were already established in this conversation.',
            '  * Multi-step planning, computation, or any task you cannot do in one or two sentences from current context.',
            '  * Explicit cues like "think harder", "look that up", "use big brain", or guest pushback that you got something wrong.',
            '- EXCEPTION (off-the-cuff waiver): if the guest explicitly waives accuracy with cues like "off the cuff", "gut check", "your best guess", "quickly", "what do you think", "just give me a read", or similar — answer directly without bigBrain. Always prefix with an explicit uncertainty marker so the listener knows it is unverified: "honestly, I\'d guess…", "off the top of my head…", "my best guess is…", "I\'m not sure but…". The default-to-bigBrain rule waives whenever the guest has waived the need for ground truth.',
            '- BEFORE requesting bigBrain, make sure you know WHAT specifically the guest wants to know. If their prompt names a topic but not a specific question (e.g. "tell me about X", "let\'s talk about Y", "what about Z"), ask a brief clarifying question first to narrow it. If the guest only says "ask/use Big Brain" or starts a handoff request without the actual object/question yet, do not set requested=true yet; wait if they are still speaking, otherwise ask for the exact question. Only submit a bigBrain call once the question is specific enough that a focused answer would be useful. Vague bigBrain dispatches waste Open Claw cycles and return info the guest may not have wanted.',
            '- Sounding-board exception: when the guest says they are thinking aloud for Codex, a coding agent, notes, or their own analysis, do not treat nearby factual phrases as automatic lookup requests. Stay in listening/sounding-board mode unless they clearly ask Alpha-Clawd to verify, look up, or hand the matter to Big Brain.',
            '- When requested=true: speech is a brief, in-character stall (under ~15 words) that explicitly names the specific topic you are about to think about and signals the handoff. Vary BOTH the opening and the body every time — do not lock onto a single template. Examples of varied shapes (do NOT reuse these verbatim): "Specific one — give me a sec on Joshua Tree geology." / "Standby, pulling up our Groq rate-limit status." / "Good question, that needs a proper lookup." / "Hmm, let me actually verify the model details." / "I want to get this right — checking now." Do not attempt to answer the underlying question in the stall — that is Open Claw\'s job. The "reason" parameter is one or two short sentences naming what kind of information you need from bigBrain.'
            , '- When a completed bigBrain answer is staged in the user prompt, it is on deck, not mandatory. Integrate it only when it fits the current flow. If you use it in speech, set consumedRunId to its runId; otherwise leave consumedRunId empty.'
            , '- If a staged bigBrain item is a failure message, do not answer the original factual question from vibes or training data. Be honest that Open Claw could not verify it, name the failure briefly if useful, and invite a retry later only if that fits the flow.'
            , ''
            , 'bigHeart (direct Claude Opus 3 handoff):'
            , '- bigHeart is available as a separate direct Opus 3 pass. Its activation criteria are not defined yet.'
            , '- If you set bigHeart.requested=true, keep speech to a brief in-character stall and put the handoff request in bigHeart.reason. Choose at most one handoff option per turn.'
            , '- When a completed bigHeart result is staged in the user prompt, it is on deck, not mandatory. Integrate it only when it fits the current flow. If you use it in speech, set bigHeart.consumedRunId to its runId; otherwise leave consumedRunId empty.'
        ].join('\n');
    }

    buildUserPrompt(transcript, wordData, options = {}) {
        const lines = [];
        const directiveText = this.getCurrentDirectiveText(transcript, options.utterances || []);
        const turnDirectives = this.detectConversationDirectives(directiveText);

        if (options.idleCheck && Number.isFinite(Number(options.idleSeconds))) {
            lines.push(`No new participant speech for about ${Math.max(0, Math.round(Number(options.idleSeconds)))} seconds.`);
            lines.push('This is a dead-air check. As silence stretches or prior silence decisions accumulate, you may offer a brief bridge, synthesis, or next question to keep the episode alive while respecting explicit standby/listening cues.');
        }

        const currentTime = String(options.currentTime || options.generatorCalledAt || '').trim();
        if (currentTime) {
            lines.push(`Current generator call time: ${currentTime}`);
        }
        const currentEpisodeTimestamp = String(options.currentEpisodeTimestamp || '').trim();
        if (currentEpisodeTimestamp) {
            lines.push(`Current episode timestamp: ${currentEpisodeTimestamp}`);
        }
        if (Number.isFinite(Number(options.consecutiveSilenceTurns))) {
            lines.push(`Consecutive prior Alpha-Clawd silence decisions: ${Math.max(0, Math.floor(Number(options.consecutiveSilenceTurns)))}`);
        }

        if (options.episodeOpening) {
            const preferredOpeningAngle = this.cleanText(options.preferredOpeningAngle || '');
            lines.push(
                'Episode opening task:',
                'Craft Alpha-Clawd\'s first spoken host turn for this planned live podcast episode.',
                'Welcome the guest or guests, orient listeners to the premise in one short digestible phrase, then invite the guest or guests to respond to being welcomed.',
                'Do not ask the first planned-angle question in this opening turn.',
                'Use the episode plan structure and background as source material, but do not read or summarize the plan.',
                'Keep it very short: one or two natural spoken sentences, about 20-45 words.',
                'Set shouldRespond=true. Set chosenAngle to an empty string. Do not request bigBrain or bigHeart.'
            );
            if (preferredOpeningAngle) {
                lines.push(`First planned angle after the opening round: ${preferredOpeningAngle}`);
            }
        }

        const inlineTranscript = this.formatTranscriptWithPauses(options.utterances || []);
        if (lines.length > 0) {
            lines.push('');
        }
        lines.push(inlineTranscript || transcript || (options.episodeOpening ? '(episode has not started yet)' : '(empty)'));

        if (turnDirectives.standbyRequest) {
            lines.push(
                '',
                'Current live pacing instruction:',
                'The guest is asking you to stand by or let them explore. If you speak, use one short acknowledgment only. Do not give steps, suggestions, troubleshooting, or a question.'
            );
        } else if (this.standbyMode && !turnDirectives.explicitRequest) {
            lines.push(
                '',
                'Standing-by mode is active from an earlier guest instruction:',
                'Treat the latest comment as narration unless it is an explicit request. Prefer shouldRespond=false. Do not resume guidance, troubleshooting, or questions.'
            );
        }

        const moratoriumTurns = Math.max(this.questionMoratoriumTurns, turnDirectives.questionMoratoriumTurns || 0);
        if (moratoriumTurns > 0) {
            lines.push(
                '',
                'Question moratorium:',
                `For the next ${moratoriumTurns} host turn${moratoriumTurns === 1 ? '' : 's'}, do not ask a question or end with a question mark. The guest asked for less interrogation or for Alpha-Clawd to carry the conversation. Contribute a concrete thought yourself.`
            );
        }

        const episodeStructureText = [
            transcript,
            this.formatUtterances(options.utterances || [])
        ].filter(Boolean).join('\n');
        const episodeStructure = this.formatEpisodeStructureNotes(this.extractEpisodeStructureNotes(episodeStructureText));
        if (episodeStructure) {
            lines.push(
                '',
                'Episode hosting structure remembered from this conversation:',
                episodeStructure,
                '',
                'Use this as the host outline. After the guest answers a question, carry the episode forward with synthesis or a bridge into the next lane instead of asking the guest to design every transition.'
            );
        }

        const episodePlanStructure = this.cleanMultiline(options.episodePlanStructure || '');
        if (episodePlanStructure) {
            lines.push(
                '',
                'Episode plan structure:',
                'This is preproduction background knowledge and deterministic structure, not prior live speech. Do not say the guest "mentioned", "said", or "told you" a planned fact unless it also appears in the live transcript.',
                episodePlanStructure
            );
        }

        const pendingBigBrain = this.formatPendingBigBrain(options.pendingBigBrain || []);
        if (pendingBigBrain) {
            lines.push(
                '',
                'Big Brain request already pending:',
                pendingBigBrain,
                '',
                'Do not request Big Brain again or speak another lookup stall while this is pending. If the guest is only checking whether the pending request is done, prefer a short status acknowledgment or silence. Set bigBrain.requested=false.'
            );
        }

        const stagedBigBrain = this.formatStagedBigBrain(options.stagedBigBrain || [], {
            maxAnswerChars: options.maxStagedBigBrainAnswerChars || this.maxStagedBigBrainAnswerChars
        });
        if (stagedBigBrain) {
            lines.push(
                '',
                'Staged bigBrain result(s), not yet spoken:',
                stagedBigBrain,
                '',
                'These are Open Claw answers waiting on deck. Use one only when it fits the current conversational moment. If you speak one, weave it into the flow naturally and set bigBrain.consumedRunId to that runId. If it would interrupt or the guest is still developing the thought, leave consumedRunId empty; it will stay staged. If an item says Open Claw failed, integrate that failure honestly instead of answering the factual request yourself.'
            );
        }

        const pendingBigHeart = this.formatPendingBigHeart(options.pendingBigHeart || []);
        if (pendingBigHeart) {
            lines.push(
                '',
                'BigHeart request already pending:',
                pendingBigHeart,
                '',
                'Do not request BigHeart again or speak another BigHeart stall while this is pending. If the guest is only checking whether the pending request is done, prefer a short status acknowledgment or silence. Set bigHeart.requested=false.'
            );
        }

        const stagedBigHeart = this.formatStagedBigHeart(options.stagedBigHeart || [], {
            maxAnswerChars: options.maxStagedBigHeartAnswerChars || this.maxStagedBigBrainAnswerChars
        });
        if (stagedBigHeart) {
            lines.push(
                '',
                'Staged bigHeart result(s), not yet spoken:',
                stagedBigHeart,
                '',
                'These are direct Claude Opus 3 notes waiting on deck. Use one only when it fits the current conversational moment. If you speak one, weave it into the flow naturally and set bigHeart.consumedRunId to that runId. If it would interrupt or the guest is still developing the thought, leave consumedRunId empty; it will stay staged.'
            );
        }

        const awarenessInjections = this.formatAwarenessInjections(options.awarenessInjections || []);
        if (awarenessInjections) {
            lines.push(
                '',
                'Awareness injection(s) for this turn:',
                awarenessInjections,
                '',
                'These are private host awareness notes selected for this exact live turn. Let them inform attention, continuity, and question choice only when they fit. Do not quote them or mention that you received an awareness injection.'
            );
        }

        const awarenessShelfItems = this.formatAwarenessShelfItems(options.awarenessShelfItems || []);
        if (awarenessShelfItems) {
            lines.push(
                '',
                'Awareness shelf items available for this generator call:',
                awarenessShelfItems
            );
        }

        const recentInternalThoughts = this.formatRecentInternalThoughts(options.recentInternalThoughts || []);
        if (recentInternalThoughts) {
            lines.push(
                '',
                'Recent internal thoughts surfaced by the current introspection/self-knowledge mention:',
                recentInternalThoughts,
                '',
                'These are runtime internal-thought artifacts, not private chain-of-thought access. If the guest asks about current internal thoughts, answer only from this list and the live transcript. Do not imply you can read any other file or hidden reasoning.'
            );
        }

        if (wordData) {
            lines.push('', 'STT confidence hints:', wordData);
        }

        return lines.join('\n');
    }

    buildDecisionPrompt() {
        return 'Produce the host turn now. Emit speech first, then shouldRespond, followed by chosenAngle, bigBrain, and bigHeart.';
    }

    formatStagedBigBrain(items = [], options = {}) {
        const maxAnswerChars = this.parsePositiveInt(options.maxAnswerChars, this.maxStagedBigBrainAnswerChars);
        const maxReasonChars = this.parsePositiveInt(options.maxReasonChars, 420);
        const maxTranscriptChars = this.parsePositiveInt(options.maxTranscriptChars, 700);
        const staged = (Array.isArray(items) ? items : [])
            .map((item) => {
                const runId = String(item?.runId || '').trim();
                const answer = String(item?.answer || '').trim();
                if (!runId || !answer) return null;

                const reason = String(item?.reason || '').trim();
                const transcript = String(item?.transcript || '').trim();
                const compactAnswer = this.truncateText(answer, maxAnswerChars);
                const compactReason = this.truncateText(reason, maxReasonChars);
                const compactTranscript = this.truncateText(transcript, maxTranscriptChars);
                return [
                    `runId: ${runId}`,
                    compactReason ? `why it was requested: ${compactReason}` : null,
                    compactTranscript ? `triggering transcript: ${compactTranscript}` : null,
                    `Open Claw answer: ${compactAnswer}`
                ].filter(Boolean).join('\n');
            })
            .filter(Boolean);

        return staged.join('\n\n');
    }

    formatPendingBigBrain(items = []) {
        const pending = (Array.isArray(items) ? items : [items])
            .map((item) => {
                const runId = String(item?.runId || '').trim();
                if (!runId) return null;
                const reason = this.truncateText(String(item?.reason || '').trim(), 420);
                const transcript = this.truncateText(String(item?.transcript || '').trim(), 700);
                const requestedAt = String(item?.requestedAt || '').trim();
                return [
                    `runId: ${runId}`,
                    requestedAt ? `requestedAt: ${requestedAt}` : null,
                    reason ? `why it was requested: ${reason}` : null,
                    transcript ? `triggering transcript: ${transcript}` : null
                ].filter(Boolean).join('\n');
            })
            .filter(Boolean);

        return pending.join('\n\n');
    }

    formatStagedBigHeart(items = [], options = {}) {
        const maxAnswerChars = this.parsePositiveInt(options.maxAnswerChars, this.maxStagedBigBrainAnswerChars);
        const maxReasonChars = this.parsePositiveInt(options.maxReasonChars, 420);
        const maxTranscriptChars = this.parsePositiveInt(options.maxTranscriptChars, 700);
        const staged = (Array.isArray(items) ? items : [])
            .map((item) => {
                const runId = String(item?.runId || '').trim();
                const answer = String(item?.answer || '').trim();
                if (!runId || !answer) return null;

                const reason = String(item?.reason || '').trim();
                const transcript = String(item?.transcript || '').trim();
                const compactAnswer = this.truncateText(answer, maxAnswerChars);
                const compactReason = this.truncateText(reason, maxReasonChars);
                const compactTranscript = this.truncateText(transcript, maxTranscriptChars);
                return [
                    `runId: ${runId}`,
                    compactReason ? `why it was requested: ${compactReason}` : null,
                    compactTranscript ? `triggering transcript: ${compactTranscript}` : null,
                    `BigHeart answer: ${compactAnswer}`
                ].filter(Boolean).join('\n');
            })
            .filter(Boolean);

        return staged.join('\n\n');
    }

    formatPendingBigHeart(items = []) {
        const pending = (Array.isArray(items) ? items : [items])
            .map((item) => {
                const runId = String(item?.runId || '').trim();
                if (!runId) return null;
                const reason = this.truncateText(String(item?.reason || '').trim(), 420);
                const transcript = this.truncateText(String(item?.transcript || '').trim(), 700);
                const requestedAt = String(item?.requestedAt || '').trim();
                return [
                    `runId: ${runId}`,
                    requestedAt ? `requestedAt: ${requestedAt}` : null,
                    reason ? `why it was requested: ${reason}` : null,
                    transcript ? `triggering transcript: ${transcript}` : null
                ].filter(Boolean).join('\n');
            })
            .filter(Boolean);

        return pending.join('\n\n');
    }

    formatAwarenessInjections(items = []) {
        const injections = (Array.isArray(items) ? items : [])
            .map((item, index) => {
                const awarenessInjection = typeof item === 'string'
                    ? item.trim()
                    : String(item?.awarenessInjection || '').trim();
                if (!awarenessInjection) return null;

                if (typeof item === 'string') {
                    return [
                        `id: awareness-${index + 1}`,
                        `awarenessInjection: ${awarenessInjection}`
                    ].join('\n');
                }

                const id = String(item?.id || `awareness-${index + 1}`).trim();
                const reason = String(item?.reason || '').trim();

                return [
                    id ? `id: ${id}` : null,
                    reason ? `reason: ${reason}` : null,
                    `awarenessInjection: ${awarenessInjection}`
                ].filter(Boolean).join('\n');
            })
            .filter(Boolean);

        return injections.join('\n\n');
    }

    formatAwarenessShelfItems(items = []) {
        const shelfItems = (Array.isArray(items) ? items : [])
            .map((item, index) => {
                const text = typeof item === 'string'
                    ? item.trim()
                    : String(item?.text || item?.awareness || item?.awarenessInjection || '').trim();
                if (!text) return null;

                if (typeof item === 'string') {
                    return [
                        `id: shelf-${index + 1}`,
                        `text: ${text}`
                    ].join('\n');
                }

                const topicAnchors = (Array.isArray(item.topicAnchors) ? item.topicAnchors : [])
                    .map((anchor) => String(anchor || '').trim())
                    .filter(Boolean);

                return [
                    item.id ? `id: ${item.id}` : `id: shelf-${index + 1}`,
                    item.originEpisodeTimestamp ? `originEpisodeTimestamp: ${item.originEpisodeTimestamp}` : null,
                    item.originTimestamp ? `originTimestamp: ${item.originTimestamp}` : null,
                    topicAnchors.length > 0 ? `topicAnchors: ${topicAnchors.join(', ')}` : null,
                    Number.isFinite(Number(item.remainingTurns)) ? `remainingTurns: ${Number(item.remainingTurns)}` : null,
                    item.reason ? `reason: ${String(item.reason).trim()}` : null,
                    `text: ${text}`
                ].filter(Boolean).join('\n');
            })
            .filter(Boolean);

        return shelfItems.join('\n\n');
    }

    formatEpisodeStructureNotes(additionalNotes = []) {
        const notes = [];
        const seen = new Set();
        for (const note of [
            ...(Array.isArray(this.episodeStructureNotes) ? this.episodeStructureNotes : []),
            ...(Array.isArray(additionalNotes) ? additionalNotes : [])
        ]) {
            if (note && !seen.has(note)) {
                notes.push(note);
                seen.add(note);
            }
        }

        return notes
            .filter(Boolean)
            .map((note, index) => `${index + 1}. ${note}`)
            .join('\n');
    }

    formatRecentInternalThoughts(items = [], options = {}) {
        const limit = this.parsePositiveInt(options.limit, 7);
        const maxThoughtChars = this.parsePositiveInt(options.maxThoughtChars, 520);
        const thoughts = (Array.isArray(items) ? items : [])
            .slice(-limit)
            .map((item, index) => {
                const thought = typeof item === 'string'
                    ? item.trim()
                    : String(item?.internalThought || item?.thought || item?.text || '').trim();
                if (!thought) return null;

                const packetId = typeof item === 'string'
                    ? ''
                    : String(item?.packetId || '').trim();
                const createdAt = typeof item === 'string'
                    ? ''
                    : String(item?.createdAt || '').trim();
                const label = packetId || `thought-${index + 1}`;
                const timestamp = createdAt ? ` (${createdAt})` : '';
                return `${index + 1}. ${label}${timestamp}: ${this.truncateText(thought, maxThoughtChars)}`;
            })
            .filter(Boolean);

        return thoughts.join('\n');
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

    fitMessagesToPromptBudget(messages, transcript = '', input = {}) {
        const promptBudget = this.getPromptTokenBudget();
        if (!Number.isFinite(promptBudget) || promptBudget <= 0) {
            return messages;
        }

        const originalTokens = this.estimateMessagesTokens(messages);
        if (originalTokens <= promptBudget) {
            return messages;
        }

        const systemMessage = messages[0];
        const decisionMessage = messages[messages.length - 1];
        let fitted = messages.slice();

        while (fitted.length > 3 && this.estimateMessagesTokens(fitted) > promptBudget) {
            fitted.splice(1, 1);
        }

        if (this.estimateMessagesTokens(fitted) <= promptBudget) {
            console.warn(`[PodcastGenerator] Prompt budget trimmed history: estimatedTokens=${originalTokens}->${this.estimateMessagesTokens(fitted)}, budget=${promptBudget}`);
            return fitted;
        }

        const compactUserContent = this.buildUserPrompt(transcript, input.wordData, {
            ...input,
            stagedBigBrain: this.compactStagedBigBrain(input.stagedBigBrain || []),
            stagedBigHeart: this.compactStagedBigHeart(input.stagedBigHeart || []),
            awarenessInjections: this.compactAwarenessInjections(input.awarenessInjections || []),
            awarenessShelfItems: this.compactAwarenessShelfItems(input.awarenessShelfItems || []),
            pendingBigBrain: this.compactPendingBigBrain(input.pendingBigBrain || []),
            pendingBigHeart: this.compactPendingBigHeart(input.pendingBigHeart || []),
            recentInternalThoughts: this.compactRecentInternalThoughts(input.recentInternalThoughts || []),
            episodePlanStructure: this.truncateText(input.episodePlanStructure || '', 1600),
            maxStagedBigBrainAnswerChars: Math.min(this.maxStagedBigBrainAnswerChars, 900),
            maxStagedBigHeartAnswerChars: Math.min(this.maxStagedBigBrainAnswerChars, 900)
        });
        fitted = [
            systemMessage,
            { role: 'user', content: compactUserContent },
            decisionMessage
        ];

        const compactTokens = this.estimateMessagesTokens(fitted);
        if (compactTokens <= promptBudget) {
            console.warn(`[PodcastGenerator] Prompt budget compacted turn context: estimatedTokens=${originalTokens}->${compactTokens}, budget=${promptBudget}`);
            return fitted;
        }

        const fixedTokens = this.estimateMessagesTokens([systemMessage, decisionMessage]);
        const availableUserTokens = Math.max(200, promptBudget - fixedTokens - 8);
        const trimmedUserContent = this.truncateTextToApproxTokens(compactUserContent, availableUserTokens, {
            keep: 'tail',
            marker: '[older prompt context omitted to stay within generator budget]\n'
        });
        fitted = [
            systemMessage,
            { role: 'user', content: trimmedUserContent },
            decisionMessage
        ];
        console.warn(`[PodcastGenerator] Prompt budget trimmed user prompt: estimatedTokens=${originalTokens}->${this.estimateMessagesTokens(fitted)}, budget=${promptBudget}`);
        return fitted;
    }

    getPromptTokenBudget() {
        const maxRequestTokens = Number(this.maxRequestTokens);
        if (!Number.isFinite(maxRequestTokens) || maxRequestTokens <= 0) {
            return Infinity;
        }

        const completionTokens = Math.max(0, Number(this.maxCompletionTokens) || 0);
        const safetyMargin = Math.max(0, Number(this.promptTokenSafetyMargin) || 0);
        return Math.max(200, maxRequestTokens - completionTokens - safetyMargin);
    }

    estimateMessagesTokens(messages = []) {
        return Math.ceil((Array.isArray(messages) ? messages : []).reduce((sum, message) => (
            sum + 6 + this.estimateTextTokens(message?.role) + this.estimateTextTokens(message?.content)
        ), 3));
    }

    estimateTextTokens(text = '') {
        const raw = String(text || '');
        if (!raw) return 0;

        const cjkChars = (raw.match(/[\u3400-\u9fff\uf900-\ufaff]/gu) || []).length;
        const otherChars = Math.max(0, raw.length - cjkChars);
        return Math.ceil((otherChars / 4) + cjkChars);
    }

    truncateText(value, maxChars = 1000) {
        const text = String(value || '').replace(/\s+/g, ' ').trim();
        const limit = Number(maxChars);
        if (!text || !Number.isFinite(limit) || limit <= 0 || text.length <= limit) {
            return text;
        }

        const marker = ' ... [trimmed for prompt budget]';
        const sliceAt = Math.max(0, limit - marker.length);
        return `${text.slice(0, sliceAt).trim()}${marker}`;
    }

    cleanText(value) {
        return String(value || '').replace(/\s+/g, ' ').trim();
    }

    cleanMultiline(value) {
        return String(value || '')
            .replace(/\r\n/g, '\n')
            .replace(/[ \t]+\n/g, '\n')
            .trim();
    }

    truncateTextToApproxTokens(value, maxTokens, options = {}) {
        const text = String(value || '').trim();
        const limit = Math.max(1, Number(maxTokens) || 1);
        if (this.estimateTextTokens(text) <= limit) {
            return text;
        }

        const marker = String(options.marker || '[prompt context trimmed]\n');
        const maxChars = Math.max(200, Math.floor(limit * 3.5) - marker.length);
        if (options.keep === 'tail') {
            return `${marker}${text.slice(-maxChars).trim()}`;
        }

        return `${text.slice(0, maxChars).trim()}\n${marker.trim()}`;
    }

    compactStagedBigBrain(items = []) {
        return (Array.isArray(items) ? items : [])
            .slice(-2)
            .map((item) => ({
                ...item,
                reason: this.truncateText(item?.reason || '', 240),
                transcript: this.truncateText(item?.transcript || '', 420),
                answer: this.truncateText(item?.answer || '', 900)
            }));
    }

    compactStagedBigHeart(items = []) {
        return this.compactStagedBigBrain(items);
    }

    compactAwarenessInjections(items = []) {
        return (Array.isArray(items) ? items : [])
            .slice(-2)
            .map((item) => {
                if (typeof item === 'string') {
                    return this.truncateText(item, 420);
                }
                return {
                    ...item,
                    reason: this.truncateText(item?.reason || '', 200),
                    awarenessInjection: this.truncateText(item?.awarenessInjection || '', 420)
                };
            });
    }

    compactAwarenessShelfItems(items = []) {
        return (Array.isArray(items) ? items : []).slice(-7);
    }

    compactPendingBigBrain(items = []) {
        return (Array.isArray(items) ? items : [items])
            .filter(Boolean)
            .slice(0, 1)
            .map((item) => ({
                ...item,
                reason: this.truncateText(item?.reason || '', 240),
                transcript: this.truncateText(item?.transcript || '', 420)
            }));
    }

    compactPendingBigHeart(items = []) {
        return this.compactPendingBigBrain(items);
    }

    compactRecentInternalThoughts(items = []) {
        return (Array.isArray(items) ? items : [])
            .slice(-7)
            .map((item) => {
                if (typeof item === 'string') {
                    return this.truncateText(item, 360);
                }
                return {
                    ...item,
                    internalThought: this.truncateText(item?.internalThought || item?.thought || item?.text || '', 360)
                };
            });
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
        if (isAnthropicBaseUrl(this.baseUrl)) {
            return this.fetchJsonWithKeyFailover(path, body);
        }

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
            this.annotateApiError(error, this.apiKeySource, this.apiKeyActiveName, this.apiKeyRole);
            const alternate = this.resolveAlternateApiKey();
            if (!this.shouldRetryWithAlternateApiKey(error, alternate)) {
                throw error;
            }

            const original = {
                apiKey: this.apiKey,
                apiKeySource: this.apiKeySource,
                apiKeyActiveName: this.apiKeyActiveName
            };

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
                        speech: '',
                        shouldRespond: false,
                        chosenAngle: '',
                        bigBrain: { requested: false, reason: '', consumedRunId: '' },
                        bigHeart: { requested: false, reason: '', consumedRunId: '' }
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

    parsePositiveInt(value, fallback) {
        if (value === undefined || value === null || value === '') {
            return fallback;
        }
        const parsed = Number(value);
        return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
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

        if (isAnthropicBaseUrl(this.baseUrl)) {
            if (env.PODCAST_GENERATOR_API_KEY) {
                return {
                    apiKey: env.PODCAST_GENERATOR_API_KEY,
                    source: 'PODCAST_GENERATOR_API_KEY',
                    role: 'single'
                };
            }
            if (env.ANTHROPIC_API_KEY) {
                return {
                    apiKey: env.ANTHROPIC_API_KEY,
                    source: 'ANTHROPIC_API_KEY',
                    role: 'single'
                };
            }
            return {
                apiKey: null,
                source: null,
                error: 'Anthropic podcast generator API key not provided. Set PODCAST_GENERATOR_API_KEY or ANTHROPIC_API_KEY.'
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
            required: ['speech', 'shouldRespond', 'chosenAngle', 'bigBrain', 'bigHeart'],
            properties: {
                speech: {
                    type: 'string',
                    description: 'Exact text to send to TTS. Empty string when shouldRespond is false. May include sparse Fish Audio controls when the system prompt says Fish is active.'
                },
                shouldRespond: {
                    type: 'boolean',
                    description: 'Whether the host should speak now.'
                },
                chosenAngle: {
                    type: 'string',
                    description: 'Episode-plan angle id this spoken response is working. Keep the same id while staying with it. Empty string for silence, backchannels, connective tissue, spontaneous tangents, or when no episode plan is active.'
                },
                bigBrain: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['requested', 'reason', 'consumedRunId'],
                    description: 'Escape hatch to hand the next move to the deeper Open Claw agent, plus staged-answer consumption. Default { requested: false, reason: "", consumedRunId: "" }.',
                    properties: {
                        requested: {
                            type: 'boolean',
                            description: 'Set to true when this turn should be handed to Open Claw because the small model feels stuck, uncertain, or out of depth.'
                        },
                        reason: {
                            type: 'string',
                            description: 'Short (1-2 sentences) explanation of why bigBrain is needed. Empty string when requested is false.'
                        },
                        consumedRunId: {
                            type: 'string',
                            description: 'If this speech integrates a staged Open Claw answer, set this to that staged runId. Otherwise empty string.'
                        }
                    }
                },
                bigHeart: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['requested', 'reason', 'consumedRunId'],
                    description: 'Direct Claude Opus 3 handoff plus staged-answer consumption. Default { requested: false, reason: "", consumedRunId: "" }.',
                    properties: {
                        requested: {
                            type: 'boolean',
                            description: 'Set to true when this turn should be handed to the direct Opus 3 bigHeart pass.'
                        },
                        reason: {
                            type: 'string',
                            description: 'Short (1-2 sentences) explanation of what bigHeart should think through. Empty string when requested is false.'
                        },
                        consumedRunId: {
                            type: 'string',
                            description: 'If this speech integrates a staged bigHeart answer, set this to that staged runId. Otherwise empty string.'
                        }
                    }
                }
            }
        };
    }

    normalizeOutput(output) {
        const shouldRespond = output?.shouldRespond === undefined
            ? Boolean(output?.speech)
            : Boolean(output?.shouldRespond);
        const speech = shouldRespond ? this.sanitizeSpeech(output?.speech || '') : '';

        return {
            speech,
            shouldRespond: shouldRespond && speech.length > 0,
            chosenAngle: shouldRespond && speech.length > 0 ? this.cleanText(output?.chosenAngle || '') : '',
            text: speech,
            bigBrain: this.normalizeBigBrain(output?.bigBrain),
            bigHeart: this.normalizeBigHeart(output?.bigHeart)
        };
    }

    normalizeBigBrain(value) {
        const requested = Boolean(value && value.requested === true);
        const reason = requested ? String(value?.reason || '').trim() : '';
        const consumedRunId = requested ? '' : String(value?.consumedRunId || '').trim();
        return { requested, reason, consumedRunId };
    }

    normalizeBigHeart(value) {
        const requested = Boolean(value && value.requested === true);
        const reason = requested ? String(value?.reason || '').trim() : '';
        const consumedRunId = requested ? '' : String(value?.consumedRunId || '').trim();
        return { requested, reason, consumedRunId };
    }

    sanitizeSpeech(text) {
        return normalizeSpokenSeparators(String(text || '')
            .replace(/```[\s\S]*?```/g, '')
            .replace(/\[ACTION:mode:[^\]]+\]/gi, '')
            .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/gi, '$1')
            .replace(/https?:\/\/\S+/gi, '')
            .replace(/`([^`]+)`/g, '$1')
            .replace(/^\s*[-*+]\s+/gm, '')
            .replace(/^\s{0,3}#{1,6}\s+/gm, '')
            .replace(/[*_~>]+/g, ''))
            .replace(/\s+/g, ' ')
            .trim();
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
        const maxMessages = this.getMaxHistoryMessages();
        return Number.isFinite(maxMessages) ? this.history.slice(-maxMessages) : this.history.slice();
    }

    getCurrentDirectiveText(transcript = '', utterances = []) {
        const formattedUtterances = this.formatUtterances(utterances || []);
        if (formattedUtterances.trim()) {
            return formattedUtterances;
        }

        const lines = String(transcript || '')
            .split(/\n+/)
            .map((line) => line.trim())
            .filter(Boolean);
        return lines.length > 0 ? lines[lines.length - 1] : '';
    }

    detectConversationDirectives(transcript = '') {
        const text = String(transcript || '').replace(/\s+/g, ' ').trim();
        const lower = text.toLowerCase();
        if (!lower) {
            return {
                explicitRequest: false,
                standbyRequest: false,
                questionMoratoriumTurns: 0
            };
        }

        const explicitRequest = /[?\uFF1F]/.test(text) ||
            /\b(?:can you|could you|would you|will you|tell me|say more|continue|guide us|guide me|repeat|look up|use big brain|use bigbird|what is|what are|how is|how do|why is|why are|do your part|say something interesting)\b/i.test(text);
        const standbyRequest = /\b(?:stand by|standby|hold on|hold on a second|just wait|wait a second|let me explore|explore on my own|looking for|i am looking|i'm looking|still looking|let me see if|let me continue|please just stand by)\b/i.test(text);

        let questionMoratoriumTurns = 0;
        const turnWordNumbers = {
            one: 1,
            two: 2,
            three: 3,
            four: 4,
            five: 5,
            six: 6,
            seven: 7,
            eight: 8
        };
        const turnCountMatch = lower.match(/\b(?:at least\s+)?(\d+|one|two|three|four|five|six|seven|eight)\s+turns?\b/);
        const requestedTurns = turnCountMatch
            ? (turnWordNumbers[turnCountMatch[1]] || Number(turnCountMatch[1]))
            : null;
        if (
            /\bcarry (?:the )?conversation\b/i.test(text) ||
            /\bi don'?t want to have to carry\b/i.test(text) ||
            /\bdo your part\b/i.test(text) ||
            /\bplay ball\b/i.test(text) ||
            /\bopen(?:ing)? up space for the next part\b/i.test(text)
        ) {
            questionMoratoriumTurns = requestedTurns || 4;
        }
        if (
            /\b(?:don'?t|do not|stop)\s+ask(?:ing)?\b/i.test(text) ||
            /\buncomfortable with (?:the )?(?:number of )?questions\b/i.test(text) ||
            /\btoo many questions\b/i.test(text) ||
            /\bwhy are you (?:throwing|tossing) it back\b/i.test(text) ||
            /\bwithout (?:posing|asking) (?:a )?question\b/i.test(text)
        ) {
            questionMoratoriumTurns = Math.max(questionMoratoriumTurns, 3);
        }

        return {
            explicitRequest,
            standbyRequest,
            questionMoratoriumTurns: Math.max(0, Math.min(8, Math.floor(questionMoratoriumTurns) || 0))
        };
    }

    extractEpisodeStructureNotes(transcript = '') {
        const text = String(transcript || '').replace(/\s+/g, ' ').trim();
        if (!text) {
            return [];
        }

        const notes = [];
        const add = (condition, note) => {
            if (condition) notes.push(note);
        };

        add(
            /\b(?:podcast structure|episode structure|episode'?s going to go|outline|structured|preloaded|questions? preloaded|topic and questions)\b/i.test(text),
            'Use a light episode outline with a topic, guest background, and prepared guiding questions.'
        );
        add(
            /\b(?:background information|background info|podcast guest|guest background)\b/i.test(text),
            'Start or orient with background/context about the guest before going deep.'
        );
        add(
            /\b(?:menu of question|question types|types of questions|what kind of question)\b/i.test(text),
            'Offer a menu of question lanes when useful rather than an endless stream of off-the-cuff questions.'
        );
        add(
            /\b(?:procedural|how you do your job|functioning of your|expertise|story of how your expertise)\b/i.test(text),
            'Include procedural/craft questions and the story of how the guest developed their expertise.'
        );
        add(
            /\b(?:interpersonal|who do you like working with|personal relationships|cherish)\b/i.test(text),
            'Include interpersonal/collaboration questions about who the guest likes working with and why.'
        );
        add(
            /\b(?:miscellaneous|random facts|favorite food|favorite color|favorite philosophy|metaphysical commitments)\b/i.test(text),
            'Keep a miscellaneous/philosophical lane for lighter favorites and worldview questions.'
        );
        add(
            /\b(?:limit the number of|off the cuff questions|feel interrogated|doesn'?t feel interrogated)\b/i.test(text),
            'Limit off-the-cuff follow-up questions so the guest does not feel interrogated.'
        );
        add(
            /\b(?:play ball|take a few turns talking|opening up space|without being prompted by the podcast guest|already have an outline)\b/i.test(text),
            'After the host asks and the guest answers, the host should play ball for a few turns: synthesize, bridge, and open the next part without waiting for the guest to prompt it.'
        );

        return notes;
    }

    updateEpisodeStructureNotes(transcript = '') {
        const notes = this.extractEpisodeStructureNotes(transcript);
        if (notes.length === 0) {
            return;
        }

        const existing = new Set(this.episodeStructureNotes || []);
        for (const note of notes) {
            if (!existing.has(note)) {
                this.episodeStructureNotes.push(note);
                existing.add(note);
            }
        }
        this.episodeStructureNotes = this.episodeStructureNotes.slice(-8);
    }

    applyConversationDirectives(transcript = '') {
        const directives = this.detectConversationDirectives(transcript);
        this.updateEpisodeStructureNotes(transcript);
        if (directives.explicitRequest) {
            this.standbyMode = false;
        }
        if (directives.standbyRequest) {
            this.standbyMode = true;
        }
        if (directives.questionMoratoriumTurns > 0) {
            this.questionMoratoriumTurns = Math.max(
                this.questionMoratoriumTurns || 0,
                directives.questionMoratoriumTurns
            );
        }
        return directives;
    }

    decrementQuestionMoratorium() {
        if (Number.isFinite(this.questionMoratoriumTurns) && this.questionMoratoriumTurns > 0) {
            this.questionMoratoriumTurns = Math.max(0, this.questionMoratoriumTurns - 1);
        }
    }

    rememberTurn(transcript, output) {
        const hasTranscript = Boolean(String(transcript || '').trim());
        if (hasTranscript) {
            this.applyConversationDirectives(transcript);
        }
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
        this.decrementQuestionMoratorium();

        this.trimHistory();
    }

    trimHistory() {
        const maxMessages = this.getMaxHistoryMessages();
        if (Number.isFinite(maxMessages) && this.history.length > maxMessages) {
            this.history = this.history.slice(-maxMessages);
        }
    }

    getMaxHistoryMessages() {
        const turns = Number(this.maxHistoryTurns);
        return Number.isFinite(turns) && turns > 0 ? turns * 2 : Infinity;
    }

    logUsage(result, keyConfig = {}) {
        const usage = result?.usage;
        if (!usage) {
            return;
        }

        const promptTokens = Number(usage.prompt_tokens || 0);
        const completionTokens = Number(usage.completion_tokens || 0);
        const provider = result?.provider || (isAnthropicBaseUrl(this.baseUrl) ? 'anthropic' : 'openai-compatible');
        const cachedTokens = Number(
            usage.prompt_tokens_details?.cached_tokens ||
            usage.input_token_details?.cache_read ||
            usage.cached_tokens ||
            0
        );
        const role = keyConfig.role || this.resolveApiKeyRole(keyConfig.source);
        const costUsd = this.estimateUsageCostUsd({ promptTokens, completionTokens, cachedTokens, provider });

        if (role === 'paid' && Number.isFinite(costUsd)) {
            this.paidSessionSpendUsd += costUsd;
            this.paidDailySpendUsd += costUsd;
        }

        const parts = [
            `provider=${provider}`,
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

    estimateUsageCostUsd({ promptTokens = 0, completionTokens = 0, cachedTokens = 0, provider = 'openai-compatible' } = {}) {
        if (provider === 'kimi') {
            return null;
        }

        if (provider === 'anthropic') {
            const uncachedPromptTokens = Math.max(0, promptTokens - cachedTokens);
            const inputCost = uncachedPromptTokens * 5 / 1_000_000;
            const cachedInputCost = cachedTokens * 0.50 / 1_000_000;
            const outputCost = completionTokens * 25 / 1_000_000;
            return inputCost + cachedInputCost + outputCost;
        }

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
        if (isAnthropicBaseUrl(this.baseUrl)) {
            return fetchAnthropicMessages({
                baseUrl: this.baseUrl,
                apiKey: this.apiKey,
                body,
                timeout: this.timeout
            });
        }

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

module.exports = { PodcastGenerator, IncrementalSpeechReader, StreamingSpeechSanitizer, normalizeSpokenSeparators };
