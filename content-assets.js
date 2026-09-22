'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function contained(root, relative) {
    if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)) throw new Error('Asset paths must be relative to the podcast content directory');
    const base = fs.realpathSync(root);
    const resolved = fs.realpathSync(path.resolve(base, relative));
    if (resolved !== base && !resolved.startsWith(base + path.sep)) throw new Error('Asset path escapes podcast content directory');
    if (!fs.statSync(resolved).isFile()) throw new Error('Asset must be a file');
    return resolved;
}

module.exports = { contained, hash };
