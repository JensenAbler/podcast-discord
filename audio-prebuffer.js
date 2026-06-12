const { Transform } = require('stream');

const OGG_CAPTURE_PATTERN = Buffer.from('OggS');
const OPUS_HEAD_PATTERN = Buffer.from('OpusHead');
const UNKNOWN_GRANULE_POSITION = 0xffffffffffffffffn;
const OPUS_SAMPLE_RATE = 48000;

function estimateOggOpusDurationSeconds(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 27) {
        return 0;
    }

    let preSkip = 0;
    const opusHeadIndex = buffer.indexOf(OPUS_HEAD_PATTERN);
    if (opusHeadIndex >= 0 && opusHeadIndex + 12 <= buffer.length) {
        preSkip = buffer.readUInt16LE(opusHeadIndex + 10);
    }

    let offset = 0;
    let maxGranule = null;
    while (offset + 27 <= buffer.length) {
        const pageIndex = buffer.indexOf(OGG_CAPTURE_PATTERN, offset);
        if (pageIndex < 0 || pageIndex + 27 > buffer.length) {
            break;
        }

        const segmentCount = buffer[pageIndex + 26];
        const segmentTableEnd = pageIndex + 27 + segmentCount;
        if (segmentTableEnd > buffer.length) {
            break;
        }

        let payloadLength = 0;
        for (let i = pageIndex + 27; i < segmentTableEnd; i++) {
            payloadLength += buffer[i];
        }
        const pageEnd = segmentTableEnd + payloadLength;
        if (pageEnd > buffer.length) {
            break;
        }

        const granule = buffer.readBigUInt64LE(pageIndex + 6);
        if (
            granule !== UNKNOWN_GRANULE_POSITION &&
            (maxGranule === null || granule > maxGranule)
        ) {
            maxGranule = granule;
        }
        offset = pageEnd;
    }

    if (maxGranule === null) {
        return 0;
    }

    const audibleSamples = maxGranule > BigInt(preSkip)
        ? maxGranule - BigInt(preSkip)
        : 0n;
    return Number(audibleSamples) / OPUS_SAMPLE_RATE;
}

class OggOpusPrebufferTransform extends Transform {
    constructor(options = {}) {
        super();
        const requestedSeconds = Number(options.targetSeconds);
        this.targetSeconds = Number.isFinite(requestedSeconds) && requestedSeconds > 0
            ? requestedSeconds
            : 3;
        this.onRelease = typeof options.onRelease === 'function'
            ? options.onRelease
            : null;
        this.bufferedChunks = [];
        this.bufferedBytes = 0;
        this.bufferedDurationSeconds = 0;
        this.released = false;
    }

    _transform(chunk, encoding, callback) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
        if (this.released) {
            this.push(buffer);
            callback();
            return;
        }

        this.bufferedChunks.push(buffer);
        this.bufferedBytes += buffer.length;
        const combined = Buffer.concat(this.bufferedChunks, this.bufferedBytes);
        this.bufferedDurationSeconds = estimateOggOpusDurationSeconds(combined);
        if (this.bufferedDurationSeconds >= this.targetSeconds) {
            this.releaseBufferedAudio('duration-threshold', combined);
        }
        callback();
    }

    _flush(callback) {
        if (!this.released) {
            this.releaseBufferedAudio(
                'synthesis-complete',
                Buffer.concat(this.bufferedChunks, this.bufferedBytes)
            );
        }
        callback();
    }

    releaseBufferedAudio(reason, combined) {
        if (this.released) {
            return;
        }

        this.released = true;
        this.bufferedChunks = [];
        const metadata = {
            reason,
            bytes: this.bufferedBytes,
            durationSeconds: this.bufferedDurationSeconds,
            targetSeconds: this.targetSeconds
        };
        if (combined.length > 0) {
            this.push(combined);
        }
        this.onRelease?.(metadata);
    }
}

module.exports = {
    OggOpusPrebufferTransform,
    estimateOggOpusDurationSeconds
};
