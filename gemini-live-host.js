const { PassThrough } = require('stream');
const {
    GoogleGenAI,
    ActivityHandling,
    EndSensitivity,
    Modality,
    StartSensitivity
} = require('@google/genai');
const { RealtimePcmMixer } = require('./realtime-pcm-mixer');

function upsampleMono24kToStereo48k(buffer, carry = Buffer.alloc(0)) {
    const input = carry.length > 0
        ? Buffer.concat([carry, buffer], carry.length + buffer.length)
        : buffer;
    const completeBytes = input.length - (input.length % 2);
    const output = Buffer.alloc(completeBytes * 4);

    for (let inputOffset = 0, outputOffset = 0; inputOffset < completeBytes; inputOffset += 2) {
        const sample = input.readInt16LE(inputOffset);
        output.writeInt16LE(sample, outputOffset);
        output.writeInt16LE(sample, outputOffset + 2);
        output.writeInt16LE(sample, outputOffset + 4);
        output.writeInt16LE(sample, outputOffset + 6);
        outputOffset += 8;
    }

    return {
        audio: output,
        carry: completeBytes < input.length ? Buffer.from(input.subarray(completeBytes)) : Buffer.alloc(0)
    };
}

class GeminiLiveHost {
    constructor(options = {}) {
        this.apiKey = options.apiKey || process.env.GEMINI_API_KEY;
        this.model = options.model ||
            process.env.PODCAST_GEMINI_LIVE_MODEL ||
            'gemini-2.5-flash-native-audio-preview-12-2025';
        this.voice = options.voice || process.env.PODCAST_GEMINI_LIVE_VOICE || 'Aoede';
        this.systemInstruction = options.systemInstruction || '';
        this.client = options.client || null;
        this.clientFactory = options.clientFactory || ((apiKey) => new GoogleGenAI({
            apiKey,
            httpOptions: {
                apiVersion: 'v1alpha'
            }
        }));
        this.onAudioStream = options.onAudioStream || (() => {});
        this.onTurnComplete = options.onTurnComplete || (() => {});
        this.onInputTranscription = options.onInputTranscription || (() => {});
        this.onOutputTranscription = options.onOutputTranscription || (() => {});
        this.onError = options.onError || (() => {});
        this.onClose = options.onClose || (() => {});
        this.onLog = options.onLog || (() => {});
        this.proactiveAudio = options.proactiveAudio !== false;
        this.noInterruption = options.noInterruption !== false;
        this.session = null;
        this.connected = false;
        this.closing = false;
        this.turnSequence = 0;
        this.activeTurn = null;
        this.resumptionHandle = null;
        this.reconnectTimer = null;
        this.mixer = options.mixer || new RealtimePcmMixer({
            onFrame: (frame) => this.sendAudioFrame(frame),
            onDrop: ({ sourceId, droppedBytes }) => {
                this.onLog(`Dropped ${droppedBytes} buffered PCM bytes for ${sourceId}`);
            }
        });
    }

    async start() {
        if (!this.apiKey && !this.client) {
            throw new Error('GEMINI_API_KEY is required for Gemini Live mode');
        }
        if (this.connected || this.session) {
            return;
        }

        this.closing = false;
        await this.connect();
        this.mixer.start();
    }

    async connect(handle = null) {
        const client = this.client || this.clientFactory(this.apiKey);
        this.client = client;

        this.session = await client.live.connect({
            model: this.model,
            callbacks: {
                onopen: () => {
                    this.connected = true;
                    this.onLog(`Connected to ${this.model}`);
                },
                onmessage: (message) => this.handleMessage(message),
                onerror: (event) => {
                    const error = event?.error || new Error(event?.message || 'Gemini Live socket error');
                    this.onError(error);
                },
                onclose: (event) => {
                    this.connected = false;
                    this.session = null;
                    this.onClose(event);
                    if (!this.closing) {
                        this.scheduleReconnect();
                    }
                }
            },
            config: {
                responseModalities: [Modality.AUDIO],
                systemInstruction: this.systemInstruction,
                speechConfig: {
                    voiceConfig: {
                        prebuiltVoiceConfig: {
                            voiceName: this.voice
                        }
                    }
                },
                inputAudioTranscription: {},
                outputAudioTranscription: {},
                proactivity: {
                    proactiveAudio: this.proactiveAudio
                },
                realtimeInputConfig: {
                    automaticActivityDetection: {
                        startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_LOW,
                        endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_LOW,
                        prefixPaddingMs: 120,
                        silenceDurationMs: 700
                    },
                    activityHandling: this.noInterruption
                        ? ActivityHandling.NO_INTERRUPTION
                        : ActivityHandling.START_OF_ACTIVITY_INTERRUPTS
                },
                sessionResumption: {
                    handle: handle || undefined
                },
                contextWindowCompression: {
                    triggerTokens: '24000',
                    slidingWindow: {
                        targetTokens: '12000'
                    }
                }
            }
        });
    }

    scheduleReconnect() {
        if (this.reconnectTimer || this.closing) return;

        this.reconnectTimer = setTimeout(async () => {
            this.reconnectTimer = null;
            try {
                await this.connect(this.resumptionHandle);
                this.onLog(`Reconnected${this.resumptionHandle ? ' with session resumption' : ''}`);
            } catch (error) {
                this.onError(error);
                this.scheduleReconnect();
            }
        }, 1000);
        if (typeof this.reconnectTimer.unref === 'function') {
            this.reconnectTimer.unref();
        }
    }

    pushAudio(sourceId, pcm48kStereo) {
        this.mixer.push(sourceId, pcm48kStereo);
    }

    sendAudioFrame(frame) {
        if (!this.connected || !this.session) return;

        try {
            this.session.sendRealtimeInput({
                audio: {
                    data: frame.toString('base64'),
                    mimeType: 'audio/pcm;rate=16000'
                }
            });
        } catch (error) {
            this.onError(error);
        }
    }

    handleMessage(message = {}) {
        const resumption = message.sessionResumptionUpdate;
        if (resumption?.resumable && resumption.newHandle) {
            this.resumptionHandle = resumption.newHandle;
        }

        if (message.goAway) {
            this.onLog(`Server requested reconnect; timeLeft=${message.goAway.timeLeft || 'unknown'}`);
        }

        const content = message.serverContent;
        if (!content) return;

        if (content.inputTranscription?.text) {
            this.onInputTranscription(content.inputTranscription);
        }
        if (content.outputTranscription?.text) {
            this.ensureActiveTurn();
            this.activeTurn.transcript += content.outputTranscription.text;
            this.onOutputTranscription(content.outputTranscription);
        }

        for (const part of content.modelTurn?.parts || []) {
            if (part.inlineData?.data && String(part.inlineData.mimeType || '').startsWith('audio/')) {
                this.handleAudioChunk(part.inlineData);
            }
        }

        if (content.interrupted) {
            this.finishActiveTurn({ interrupted: true });
        } else if (content.turnComplete) {
            this.finishActiveTurn({
                interrupted: false,
                reason: content.turnCompleteReason || null
            });
        }
    }

    ensureActiveTurn() {
        if (this.activeTurn) return this.activeTurn;

        const turn = {
            id: `gemini-live-${++this.turnSequence}`,
            generatedAt: new Date().toISOString(),
            stream: new PassThrough(),
            audioChunks: [],
            transcript: '',
            carry: Buffer.alloc(0)
        };
        this.activeTurn = turn;
        this.onAudioStream({
            id: turn.id,
            stream: turn.stream,
            generatedAt: turn.generatedAt
        });
        return turn;
    }

    handleAudioChunk(inlineData) {
        const turn = this.ensureActiveTurn();
        const input = Buffer.from(inlineData.data, 'base64');
        const converted = upsampleMono24kToStereo48k(input, turn.carry);
        turn.carry = converted.carry;

        if (converted.audio.length > 0) {
            turn.audioChunks.push(converted.audio);
            turn.stream.write(converted.audio);
        }
    }

    finishActiveTurn(metadata = {}) {
        const turn = this.activeTurn;
        if (!turn) return;
        this.activeTurn = null;

        turn.stream.end();
        const audio = turn.audioChunks.length > 0
            ? Buffer.concat(turn.audioChunks)
            : Buffer.alloc(0);
        this.onTurnComplete({
            id: turn.id,
            generatedAt: turn.generatedAt,
            transcription: turn.transcript.trim(),
            audio,
            interrupted: Boolean(metadata.interrupted),
            reason: metadata.reason || null
        });
    }

    stop() {
        this.closing = true;
        this.mixer.stop();
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.activeTurn) {
            this.finishActiveTurn({ interrupted: true, reason: 'host_stopped' });
        }
        if (this.session) {
            try {
                this.session.sendRealtimeInput({ audioStreamEnd: true });
            } catch (error) {
                this.onError(error);
            }
            this.session.close();
            this.session = null;
        }
        this.connected = false;
    }
}

module.exports = {
    GeminiLiveHost,
    upsampleMono24kToStereo48k
};
