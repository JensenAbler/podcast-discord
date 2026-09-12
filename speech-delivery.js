'use strict';

// Capture the synthesis input as its consumer pulls it, independently of the
// generator's final JSON. This is not a word-level audibility measurement.
function captureSynthesisInput(source) {
    const capture = { text: '', complete: false, error: null, source };
    if (!source || typeof source[Symbol.asyncIterator] !== 'function') {
        capture.text = String(source || '');
        capture.complete = true;
        return capture;
    }
    capture.source = (async function* () {
        try {
            for await (const chunk of source) {
                capture.text += String(chunk);
                yield chunk;
            }
            capture.complete = true;
        } catch (error) {
            capture.error = { stage: 'speech_input', message: error.message || String(error) };
            throw error;
        }
    })();
    return capture;
}

function deliveryRecord(capture, { timing = {}, finalResponse = {}, underrun = false,
    providerError = null } = {}) {
    const error = providerError || capture.error || finalResponse.providerError || null;
    const started = Boolean(timing.playbackStartedAt);
    const complete = started && Boolean(timing.playbackEndedAt) &&
        !timing.playbackInterrupted && !timing.playbackErrorAt &&
        !underrun && capture.complete && !capture.error &&
        (!providerError || providerError.stage === 'generator');
    const playbackStatus = complete ? 'completed' : started ? 'incomplete' :
        (error ? 'failed' : 'not_started');
    return {
        synthesisText: capture.text,
        synthesisInputComplete: capture.complete,
        generatedTranscription: finalResponse.speech || null,
        providerError: error,
        playbackStatus,
        playbackUnderrunDetected: underrun,
        playbackInterrupted: timing.playbackInterrupted === true,
        transcription: complete ? capture.text :
            started ? '[Host playback incomplete; synthesis text retained, audible words unverified.]' :
                '[Host response did not start playback; synthesis text retained.]',
        audioEvents: complete ? [] : [underrun ? 'playback_underrun' :
            started ? 'playback_incomplete' : 'playback_not_started']
    };
}
module.exports = { captureSynthesisInput, deliveryRecord };
