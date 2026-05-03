const path = require('path');

const BOT_DIR = __dirname;
const DEFAULT_CONTENT_ROOT = path.resolve(BOT_DIR, '..', 'clawcast-network', 'content');

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

function getRecordingDir(explicitDir) {
    const configured = explicitDir || process.env.RECORDING_DIR;

    if (configured) {
        return resolveFromBotDir(configured);
    }

    return path.join(getPodcastRoot(), 'recordings');
}

module.exports = {
    getPodcastRoot,
    getRecordingDir
};
