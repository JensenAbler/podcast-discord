const path = require('path');

const BOT_DIR = __dirname;
const DEFAULT_CONTENT_ROOT = path.resolve(BOT_DIR, '..', 'clawcast-network', 'content');
const ALLOW_LEGACY_RECORDING_DIR = 'ALLOW_LEGACY_RECORDING_DIR';

function resolveFromBotDir(value) {
    if (!value) {
        return null;
    }

    return path.isAbsolute(value) ? value : path.resolve(BOT_DIR, value);
}

function getPodcastRoot() {
    return (
        resolveFromBotDir(process.env.CLAWCAST_CONTENT_ROOT) ||
        resolveFromBotDir(process.env.PODCAST_ROOT) ||
        resolveFromBotDir(process.env.PODCAST_CONTENT_ROOT) ||
        DEFAULT_CONTENT_ROOT
    );
}

function getContractRecordingDir() {
    return path.join(getPodcastRoot(), 'recordings');
}

function getEpisodePlanDir() {
    return path.join(getPodcastRoot(), 'episode-plans');
}

function isTruthyEnv(value) {
    return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function isLegacyEpisodesRecordingDir(recordingDir) {
    if (!recordingDir) {
        return false;
    }

    const podcastRoot = getPodcastRoot();
    const legacyDir = path.resolve(podcastRoot, 'episodes', 'recordings');
    return path.resolve(recordingDir) === legacyDir;
}

function getRecordingDir(explicitDir) {
    const configured = explicitDir || process.env.RECORDING_DIR;

    if (configured) {
        const resolved = resolveFromBotDir(configured);
        if (
            isLegacyEpisodesRecordingDir(resolved) &&
            !isTruthyEnv(process.env[ALLOW_LEGACY_RECORDING_DIR])
        ) {
            const contractDir = getContractRecordingDir();
            console.warn(
                `[paths] RECORDING_DIR points at legacy episodes/recordings; using contract path instead: ${contractDir}`
            );
            return contractDir;
        }

        return resolved;
    }

    return getContractRecordingDir();
}

module.exports = {
    getPodcastRoot,
    getContractRecordingDir,
    getEpisodePlanDir,
    getRecordingDir,
    isLegacyEpisodesRecordingDir
};
