'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { FishAudioProvider } = require('./fish-audio-provider');

// Fish ASR responses carry no confidence; the provider must not invent one.
function stubProvider(responseBody) {
    const p = Object.create(FishAudioProvider.prototype);
    p.baseUrl = 'https://fish.invalid';
    p.apiKey = 'test';
    p.language = 'en';
    p.prepareAudioForSTT = async () => Buffer.alloc(44);
    p.fetchWithTimeout = async () => ({ ok: true, json: async () => responseBody });
    return p;
}

test('Fish ASR result reports confidence as unknown, not a fixed 0.8', async () => {
    const p = stubProvider({
        text: 'hello there', duration: 1.2,
        segments: [{ text: 'hello', start: 0, end: 0.5 }, { text: 'there', start: 0.5, end: 1.2 }]
    });
    const { result } = await p.transcribeAudioVariant(Buffer.alloc(10), {}, { label: 't', sampleRate: 16000, channels: 1 });
    assert.equal(result.text, 'hello there');
    assert.equal(result.confidence, null);
    assert.equal(result.confidenceSource, 'unavailable');
    assert.equal(result.words.length, 2);
    for (const w of result.words) assert.equal(w.confidence, null);
    assert.deepEqual(result.words.map(w => [w.text, w.start, w.end]), [['hello', 0, 0.5], ['there', 0.5, 1.2]]);
});

test('Fish ASR text-only fallback segment also has unknown confidence', () => {
    const words = FishAudioProvider.prototype.extractSegments.call({}, { text: 'just text', duration: 2 });
    assert.equal(words.length, 1);
    assert.equal(words[0].confidence, null);
    assert.equal(words[0].end, 2);
});

test('empty Fish ASR result stays empty with unknown confidence', async () => {
    const p = stubProvider({ text: '', duration: 0.3, segments: [] });
    const { result } = await p.transcribeAudioVariant(Buffer.alloc(10), {}, { label: 't', sampleRate: 16000, channels: 1 });
    assert.equal(result.confidence, null);
    assert.deepEqual(result.words, []);
});
