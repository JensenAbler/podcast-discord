/**
 * Fish Audio Provider - TTS and STT using Fish Audio.
 *
 * TTS uses /v1/tts with a saved voice model reference_id.
 * STT uses the beta /v1/asr endpoint and returns segment-level timing.
 */

class FishAudioProvider {
    constructor(options = {}) {
        this.apiKey = options.apiKey || process.env.FISH_AUDIO_API_KEY || process.env.FISH_API_KEY;
        this.baseUrl = options.baseUrl || process.env.FISH_AUDIO_BASE_URL || 'https://api.fish.audio';
        this.voiceId = options.defaultVoice ||
            options.referenceId ||
            process.env.FISH_AUDIO_VOICE_ID ||
            process.env.FISH_AUDIO_REFERENCE_ID ||
            process.env.FISH_AUDIO_MODEL_ID ||
            'e127c1a13d0b415da7d6c4c16861295f';
        this.model = options.model || process.env.FISH_AUDIO_MODEL || 's2-pro';
        this.format = options.format || process.env.FISH_AUDIO_FORMAT || 'mp3';
        this.latency = options.latency || process.env.FISH_AUDIO_LATENCY || 'balanced';
        this.mp3Bitrate = Number(options.mp3Bitrate || process.env.FISH_AUDIO_MP3_BITRATE || 128);
        this.chunkLength = Number(options.chunkLength || process.env.FISH_AUDIO_CHUNK_LENGTH || 200);
        this.normalize = options.normalize;
        if (this.normalize === undefined && process.env.FISH_AUDIO_NORMALIZE !== undefined) {
            this.normalize = process.env.FISH_AUDIO_NORMALIZE === 'true';
        }
        this.language = options.language || process.env.FISH_AUDIO_LANGUAGE || 'en';
        this.timeout = Number(options.timeout || process.env.FISH_AUDIO_TIMEOUT_MS || 30000);

        if (!this.apiKey) {
            throw new Error('Fish Audio API key not provided. Set FISH_AUDIO_API_KEY or FISH_API_KEY.');
        }
    }

    async synthesize(text, options = {}) {
        const startTime = Date.now();
        const processedText = this.preprocessText(text);
        const voiceId = options.voiceId || options.referenceId || this.voiceId;

        console.log(`[Fish Audio] Synthesizing: "${processedText.substring(0, 50)}..."`);

        const body = {
            text: processedText,
            reference_id: voiceId,
            format: options.format || this.format,
            latency: options.latency || this.latency,
            chunk_length: Number(options.chunkLength || this.chunkLength),
            normalize: options.normalize ?? this.normalize ?? !this.hasFishInlineControls(processedText),
            mp3_bitrate: Number(options.mp3Bitrate || this.mp3Bitrate),
            prosody: {
                speed: Number(options.speed || process.env.FISH_AUDIO_SPEED || 1),
                volume: Number(options.volume || process.env.FISH_AUDIO_VOLUME || 0),
                normalize_loudness: options.normalizeLoudness ?? process.env.FISH_AUDIO_NORMALIZE_LOUDNESS !== 'false'
            }
        };

        const response = await this.fetchWithTimeout(`${this.baseUrl}/v1/tts`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${this.apiKey}`,
                'Content-Type': 'application/json',
                model: options.model || this.model
            },
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Fish Audio TTS API error: ${response.status} - ${errorText}`);
        }

        const audioBuffer = Buffer.from(await response.arrayBuffer());
        const duration = Date.now() - startTime;
        console.log(`[Fish Audio] Synthesis complete in ${duration}ms (${audioBuffer.length} bytes)`);

        return audioBuffer;
    }

    async transcribe(audioBuffer, options = {}) {
        const startTime = Date.now();

        console.log(`[Fish Audio ASR] Transcribing ${audioBuffer.length} bytes...`);

        const audioData = await this.prepareAudioForSTT(audioBuffer, options);
        const form = new FormData();
        const blob = new Blob([audioData], { type: 'audio/wav' });

        form.append('audio', blob, options.filename || 'audio.wav');
        form.append('language', options.language || this.language);
        form.append('ignore_timestamps', String(options.ignoreTimestamps ?? true));

        const response = await this.fetchWithTimeout(`${this.baseUrl}/v1/asr`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${this.apiKey}`
            },
            body: form
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Fish Audio ASR API error: ${response.status} - ${errorText}`);
        }

        const result = await response.json();
        const duration = Date.now() - startTime;
        console.log(`[Fish Audio ASR] Transcription complete in ${duration}ms`);

        return {
            text: result.text || '',
            language: options.language || this.language,
            confidence: result.text ? 0.8 : 0,
            words: this.extractSegments(result),
            duration: result.duration || duration,
            raw: result
        };
    }

    extractSegments(result) {
        if (Array.isArray(result.segments) && result.segments.length > 0) {
            return result.segments.map(segment => ({
                text: segment.text,
                start: segment.start,
                end: segment.end,
                confidence: 0.8,
                type: 'segment'
            }));
        }

        if (result.text) {
            return [{
                text: result.text,
                start: 0,
                end: result.duration || 0,
                confidence: 0.8,
                type: 'segment'
            }];
        }

        return [];
    }

    preprocessText(text) {
        if (!text) return '';

        return text
            .replace(/<break\s+time=["']?([\d.]+)s["']?\s*\/?>/gi, (_, seconds) => {
                return Number(seconds) >= 2 ? '[long pause]' : '[pause]';
            })
            .replace(/<[^>]+>/g, '')
            .replace(/\*([^*]+)\*/g, '$1')
            .replace(/\s+/g, ' ')
            .trim();
    }

    hasFishInlineControls(text) {
        return /\[[^\]]+\]/.test(text);
    }

    async prepareAudioForSTT(audioBuffer, options = {}) {
        if (audioBuffer.slice(0, 4).toString('ascii') === 'RIFF') {
            return audioBuffer;
        }

        const sampleRate = options.sampleRate || 48000;
        const channels = options.channels || 2;
        const bitsPerSample = 16;
        const byteRate = sampleRate * channels * bitsPerSample / 8;
        const blockAlign = channels * bitsPerSample / 8;
        const dataSize = audioBuffer.length;
        const fileSize = 36 + dataSize;
        const header = Buffer.alloc(44);

        header.write('RIFF', 0);
        header.writeUInt32LE(fileSize, 4);
        header.write('WAVE', 8);
        header.write('fmt ', 12);
        header.writeUInt32LE(16, 16);
        header.writeUInt16LE(1, 20);
        header.writeUInt16LE(channels, 22);
        header.writeUInt32LE(sampleRate, 24);
        header.writeUInt32LE(byteRate, 28);
        header.writeUInt16LE(blockAlign, 32);
        header.writeUInt16LE(bitsPerSample, 34);
        header.write('data', 36);
        header.writeUInt32LE(dataSize, 40);

        return Buffer.concat([header, audioBuffer]);
    }

    async fetchWithTimeout(url, options) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.timeout);

        try {
            return await fetch(url, {
                ...options,
                signal: controller.signal
            });
        } finally {
            clearTimeout(timeout);
        }
    }

    async validateApiKey() {
        return Boolean(this.apiKey && this.apiKey.length >= 20);
    }

    getVoices() {
        return [
            {
                id: this.voiceId,
                name: 'Alpha-Clawd Aussie Fijo',
                provider: 'fish-audio'
            }
        ];
    }
}

module.exports = { FishAudioProvider };
