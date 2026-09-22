// Preload for offline test runs: loopback test servers are permitted, external sockets are not.
const net = require('node:net');
const original = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
    let a = args[0];
    if (Array.isArray(a)) a = a[0];
    const host = typeof a === 'object' ? a.host : typeof args[1] === 'string' ? args[1] : 'localhost';
    if (host && !['localhost','127.0.0.1','::1'].includes(host)) {
        throw new Error('OFFLINE TEST: external network blocked: ' + host);
    }
    return original.apply(this, args);
};
const tls = require('node:tls');
tls.connect = () => { throw new Error('OFFLINE TEST: TLS/API calls blocked'); };
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, ...args) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (!['localhost','127.0.0.1','[::1]'].includes(url.hostname)) {
        throw new Error('OFFLINE TEST: fetch/API calls blocked');
    }
    return originalFetch(input, ...args);
};
