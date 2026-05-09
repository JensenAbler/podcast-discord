/**
 * Gateway WebSocket Client - Direct WebSocket connection to Clawdbot Gateway
 * 
 * Connects to ws://localhost:18789/ws and handles:
 * - Authentication with auth token
 * - Sending STT messages via chat.inject
 * - Receiving AI responses via chat.event
 * - Auto-reconnection on disconnect
 */

const WebSocket = require('ws');
const EventEmitter = require('events');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function base64UrlEncode(buffer) {
    return Buffer.from(buffer)
        .toString('base64')
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replace(/=+$/g, '');
}

function base64UrlDecode(input) {
    const normalized = String(input || '').replaceAll('-', '+').replaceAll('_', '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    return Buffer.from(padded, 'base64');
}

function derivePublicKeyRaw(publicKeyPem) {
    const key = crypto.createPublicKey(publicKeyPem);
    const spki = key.export({ type: 'spki', format: 'der' });
    if (
        spki.length === ED25519_SPKI_PREFIX.length + 32 &&
        spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
    ) {
        return spki.subarray(ED25519_SPKI_PREFIX.length);
    }
    return spki;
}

function fingerprintPublicKey(publicKeyPem) {
    return crypto.createHash('sha256').update(derivePublicKeyRaw(publicKeyPem)).digest('hex');
}

function publicKeyRawBase64UrlFromPem(publicKeyPem) {
    return base64UrlEncode(derivePublicKeyRaw(publicKeyPem));
}

function generateDeviceIdentity() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    return {
        version: 1,
        deviceId: fingerprintPublicKey(publicKeyPem),
        publicKeyPem,
        privateKeyPem,
        createdAtMs: Date.now()
    };
}

function loadOrCreateDeviceIdentity(filePath) {
    if (fs.existsSync(filePath)) {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (
            parsed?.version === 1 &&
            typeof parsed.publicKeyPem === 'string' &&
            typeof parsed.privateKeyPem === 'string'
        ) {
            const deviceId = fingerprintPublicKey(parsed.publicKeyPem);
            return {
                deviceId,
                publicKeyPem: parsed.publicKeyPem,
                privateKeyPem: parsed.privateKeyPem
            };
        }
    }

    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const identity = generateDeviceIdentity();
    fs.writeFileSync(filePath, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
    try {
        fs.chmodSync(filePath, 0o600);
    } catch {
        // best effort
    }
    return {
        deviceId: identity.deviceId,
        publicKeyPem: identity.publicKeyPem,
        privateKeyPem: identity.privateKeyPem
    };
}

function signDevicePayload(privateKeyPem, payload) {
    const key = crypto.createPrivateKey(privateKeyPem);
    return base64UrlEncode(crypto.sign(null, Buffer.from(payload, 'utf8'), key));
}

function verifyDeviceSignature(publicKey, payload, signatureBase64Url) {
    const key = publicKey.includes('BEGIN')
        ? crypto.createPublicKey(publicKey)
        : crypto.createPublicKey({
            key: Buffer.concat([ED25519_SPKI_PREFIX, base64UrlDecode(publicKey)]),
            type: 'spki',
            format: 'der'
        });
    return crypto.verify(
        null,
        Buffer.from(payload, 'utf8'),
        key,
        base64UrlDecode(signatureBase64Url)
    );
}

function normalizeScopes(scopes) {
    if (Array.isArray(scopes)) {
        return scopes.map(scope => String(scope || '').trim()).filter(Boolean);
    }

    return String(scopes || '')
        .split(',')
        .map(scope => scope.trim())
        .filter(Boolean);
}

class GatewayWsClient extends EventEmitter {
    constructor(options = {}) {
        super();
        
        this.gatewayUrl = options.gatewayUrl || 'ws://localhost:18789/ws';
        this.authToken = options.authToken || process.env.GATEWAY_AUTH_TOKEN || 'dev-token';
        this.sessionKey = options.sessionKey || 'agent:main:main';
        this.role = options.role || process.env.GATEWAY_WS_ROLE || 'operator';
        this.clientMode = options.clientMode || process.env.GATEWAY_WS_CLIENT_MODE || 'backend';
        this.scopes = normalizeScopes(
            options.scopes || process.env.GATEWAY_WS_SCOPES || 'operator.read,operator.write'
        );
        this.grantedScopes = [];
        this.useDeviceIdentity = options.useDeviceIdentity !== undefined
            ? Boolean(options.useDeviceIdentity)
            : process.env.GATEWAY_WS_DEVICE_IDENTITY !== 'false';
        this.deviceIdentityPath = options.deviceIdentityPath
            || process.env.GATEWAY_WS_DEVICE_IDENTITY_PATH
            || path.join(os.homedir(), '.podcast-discord', 'gateway-device.json');
        this.deviceIdentity = options.deviceIdentity || null;
        
        this.ws = null;
        this.isConnected = false;
        this.isAuthenticated = false;
        this.reconnectInterval = options.reconnectInterval || 5000;
        this.maxReconnectAttempts = options.maxReconnectAttempts || 10;
        this.reconnectAttempts = 0;
        this.requestId = 0;
        this.pendingRequests = new Map();
        
        // Heartbeat
        this.heartbeatInterval = null;
        this.heartbeatIntervalMs = 30000; // 30 seconds
        
        this.clientId = options.clientId || 'gateway-client';
        this.clientVersion = options.clientVersion || '1.0.0';
    }

    /**
     * Connect to the Gateway WebSocket
     */
    async connect() {
        if (this.ws?.readyState === WebSocket.OPEN) {
            console.log('[GatewayWsClient] Already connected');
            return;
        }

        console.log(`[GatewayWsClient] Connecting to ${this.gatewayUrl}...`);

        return new Promise((resolve, reject) => {
            try {
                this.ws = new WebSocket(this.gatewayUrl);

                this.ws.on('open', () => {
                    console.log('[GatewayWsClient] WebSocket connected');
                    this.isConnected = true;
                    this.reconnectAttempts = 0;
                    this.emit('connected');
                    // Wait for connect.challenge before resolving
                });

                this.ws.on('message', (data) => {
                    this.handleMessage(data);
                });

                this.ws.on('close', (code, reason) => {
                    console.log(`[GatewayWsClient] WebSocket closed: ${code} ${reason}`);
                    this.isConnected = false;
                    this.isAuthenticated = false;
                    this.stopHeartbeat();
                    this.emit('disconnected', { code, reason });
                    this.scheduleReconnect();
                });

                this.ws.on('error', (error) => {
                    console.error('[GatewayWsClient] WebSocket error:', error.message);
                    this.emit('error', error);
                    reject(error);
                });

                // Resolve when authenticated (after connect.challenge + hello.ok)
                this.once('authenticated', () => {
                    resolve();
                });

                // Timeout if authentication fails
                setTimeout(() => {
                    if (!this.isAuthenticated) {
                        reject(new Error('Authentication timeout'));
                    }
                }, 10000);

            } catch (error) {
                reject(error);
            }
        });
    }

    /**
     * Handle incoming WebSocket messages
     */
    handleMessage(data) {
        try {
            const message = JSON.parse(data.toString());
            console.log(`[GatewayWsClient] Received: ${message.type}/${message.event || message.method || ''}`);

            // Handle connect challenge
            if (message.type === 'event' && message.event === 'connect.challenge') {
                this.handleConnectChallenge(message.payload);
                return;
            }

            // Handle responses to pending requests
            if (message.type === 'res' && message.ok && this.pendingRequests.has(message.id)) {
                const pending = this.pendingRequests.get(message.id);
                this.pendingRequests.delete(message.id);
                pending.resolve(message.payload);
                return;
            }

            // Handle chat events (AI responses)
            if (message.type === 'event' && message.event === 'chat') {
                this.handleChatEvent(message.payload);
                return;
            }

            // Handle responses to our requests
            if (message.type === 'res' && message.id) {
                const pending = this.pendingRequests.get(message.id);
                if (pending) {
                    this.pendingRequests.delete(message.id);
                    if (!message.ok && message.error) {
                        pending.reject(new Error(message.error.message || 'Request failed'));
                    } else {
                        pending.resolve(message.payload);
                    }
                }
                return;
            }

            // Handle errors
            if (message.type === 'event' && message.event === 'error') {
                console.error('[GatewayWsClient] Gateway error:', message.payload);
                this.emit('gatewayError', message.payload);
                return;
            }

        } catch (error) {
            console.error('[GatewayWsClient] Error parsing message:', error);
        }
    }

    /**
     * Handle connect challenge - send authentication
     */
    async handleConnectChallenge(payload) {
        console.log('[GatewayWsClient] Got connect challenge, sending auth...');
        
        try {
            const connectParams = this.buildConnectParams(payload);
            const response = await this.sendRequest('connect', connectParams);
            
            // Handle successful authentication
            if (response?.type === 'hello-ok') {
                this.isAuthenticated = true;
                this.grantedScopes = this.resolveGrantedScopes(response);
                this.startHeartbeat();
                this.emit('authenticated');
                console.log(`[GatewayWsClient] Authenticated successfully (role=${this.role}, scopes=${this.grantedScopes.join(',') || 'none'})`);
            }
        } catch (error) {
            console.error('[GatewayWsClient] Authentication failed:', error.message);
            this.emit('error', error);
        }
    }

    getDeviceIdentity() {
        if (!this.useDeviceIdentity) {
            return null;
        }
        if (!this.deviceIdentity) {
            this.deviceIdentity = loadOrCreateDeviceIdentity(this.deviceIdentityPath);
        }
        return this.deviceIdentity;
    }

    buildDeviceAuthPayload({ deviceId, signedAtMs, token, nonce }) {
        const version = nonce ? 'v2' : 'v1';
        const parts = [
            version,
            deviceId,
            this.clientId,
            this.clientMode,
            this.role,
            this.scopes.join(','),
            String(signedAtMs),
            token || ''
        ];
        if (version === 'v2') {
            parts.push(nonce || '');
        }
        return parts.join('|');
    }

    buildConnectDevice(payload = {}) {
        const identity = this.getDeviceIdentity();
        if (!identity) {
            return undefined;
        }

        const signedAtMs = Date.now();
        const nonce = typeof payload?.nonce === 'string' ? payload.nonce : undefined;
        const authPayload = this.buildDeviceAuthPayload({
            deviceId: identity.deviceId,
            signedAtMs,
            token: this.authToken,
            nonce
        });

        return {
            id: identity.deviceId,
            publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
            signature: signDevicePayload(identity.privateKeyPem, authPayload),
            signedAt: signedAtMs,
            nonce
        };
    }

    buildConnectParams(payload = {}) {
        const params = {
            minProtocol: 3,
            maxProtocol: 3,
            client: {
                id: this.clientId,
                version: this.clientVersion,
                platform: 'node',
                mode: this.clientMode
            },
            role: this.role,
            scopes: this.scopes,
            auth: {
                token: this.authToken
            },
            caps: ['receiveEvents']
        };

        const device = this.buildConnectDevice(payload);
        if (device) {
            params.device = device;
        }

        return params;
    }

    resolveGrantedScopes(response = {}) {
        const authScopes = normalizeScopes(response.auth?.scopes);
        if (authScopes.length > 0) {
            return authScopes;
        }

        const deviceId = this.deviceIdentity?.deviceId;
        const presenceScopes = response.snapshot?.presence
            ?.find?.((entry) => entry?.deviceId === deviceId && Array.isArray(entry?.scopes))
            ?.scopes;
        return normalizeScopes(presenceScopes);
    }

    hasScope(scope) {
        const scopes = this.isAuthenticated ? this.grantedScopes : this.scopes;
        return scopes.includes(scope) || scopes.includes('operator.admin');
    }

    canInjectMessages() {
        // The current Gateway build gates chat.inject behind operator.admin.
        return this.hasScope('operator.admin');
    }

    /**
     * Handle chat events (AI responses)
     */
    handleChatEvent(payload) {
        if (!payload) {
            return;
        }

        this.emit('chatEvent', {
            state: payload.state,
            sessionKey: payload.sessionKey,
            runId: payload.runId,
            usage: payload.usage,
            message: payload.message,
            errorMessage: payload.errorMessage,
            stopReason: payload.stopReason
        });

        // Extract text from message
        // Gateway sends: { role, content: [{type, text}], timestamp }
        let messageText = '';
        let structuredContent = null;
        
        if (typeof payload.message === 'string') {
            messageText = payload.message;
        } else if (payload.message?.content && Array.isArray(payload.message.content)) {
            // Handle structured content blocks
            const textBlocks = payload.message.content.filter(block => block.type === 'text');
            messageText = textBlocks.map(block => block.text).join('');
            
            // Preserve non-text content blocks (podcast_event, etc.)
            const nonTextBlocks = payload.message.content.filter(block => block.type !== 'text');
            if (nonTextBlocks.length > 0) {
                structuredContent = nonTextBlocks;
            }
        } else if (Array.isArray(payload.message)) {
            // Direct array of content blocks
            const textBlocks = payload.message.filter(block => block.type === 'text');
            messageText = textBlocks.map(block => block.text).join('');
            
            const nonTextBlocks = payload.message.filter(block => block.type !== 'text');
            if (nonTextBlocks.length > 0) {
                structuredContent = nonTextBlocks;
            }
        }
        
        console.log(`[GatewayWsClient] Chat event: ${payload.state}, text: "${messageText?.substring(0, 50)}..."`);
        console.log(`[GatewayWsClient] Chat event payload: runId=${payload.runId}, state=${payload.state}`);
        
        // Only process final responses
        if (payload.state === 'final') {
            // Emit structured events even if no text (for podcast_event, etc.)
            if (messageText || structuredContent) {
                console.log(`[GatewayWsClient] Emitting response event (runId=${payload.runId})`);
                this.emit('response', {
                    text: messageText,
                    sessionKey: payload.sessionKey,
                    runId: payload.runId,
                    usage: payload.usage,
                    message: payload.message,
                    structuredContent
                });
            }
        }
    }

    /**
     * Send a message via WebSocket
     */
    send(message) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            throw new Error('WebSocket not connected');
        }
        
        this.ws.send(JSON.stringify(message));
    }

    /**
     * Send a request and wait for response
     */
    async sendRequest(method, params) {
        const id = `req-${++this.requestId}`;
        
        return new Promise((resolve, reject) => {
            this.pendingRequests.set(id, { resolve, reject });
            
            // Timeout after 30 seconds
            setTimeout(() => {
                if (this.pendingRequests.has(id)) {
                    this.pendingRequests.delete(id);
                    reject(new Error('Request timeout'));
                }
            }, 30000);

            this.send({
                type: 'req',
                method,
                params,
                id
            });
        });
    }

    /**
     * Send a message into a session (for STT)
     * This adds the message to context as user role (patched Gateway)
     */
    async injectMessage(message, options = {}) {
        if (!this.isAuthenticated) {
            throw new Error('Not authenticated');
        }

        // Use chat.inject to add voice transcript to context
        return this.sendRequest('chat.inject', {
            sessionKey: this.sessionKey,
            message,
            label: options.label || 'discord-voice'
        });
    }

    /**
     * Inject a podcast event into the session as plain text
     * Uses text format to ensure AI receives the context (structured content blocks
     * may be filtered out during API serialization)
     */
    async injectPodcastEvent(eventData) {
        if (!this.isAuthenticated) {
            throw new Error('Not authenticated');
        }

        const { event, recording, guidelines, topic, speakers } = eventData;
        
        // Build plain text message that the AI will actually receive
        let text = `[PODCAST SESSION ${event.toUpperCase()}]`;
        
        if (event === 'session_start') {
            text += '\n\n';
            text += `Recording: ${recording ? 'ON' : 'OFF'}\n`;
            if (topic) {
                text += `Topic: ${topic}\n`;
            }
            if (guidelines && guidelines.length > 0) {
                text += '\nGuidelines:\n';
                for (const guideline of guidelines) {
                    if (guideline.trim()) {
                        text += `- ${guideline}\n`;
                    }
                }
            }
        } else if (event === 'session_end') {
            text += `\n\nRecording: ${recording ? 'ON' : 'OFF'}`;
        }
        
        text += `\n\nTimestamp: ${new Date().toISOString()}`;

        if (speakers && speakers.length > 0) {
            text += `\nSpeakers: ${speakers.join(', ')}`;
        }

        // Use chat.inject with the gateway-native message/label shape.
        return this.sendRequest('chat.inject', {
            sessionKey: this.sessionKey,
            message: text,
            label: 'podcast-session'
        });
    }

    /**
     * Send a chat message and wait for response
     */
    async sendChat(message, options = {}) {
        if (!this.isAuthenticated) {
            throw new Error('Not authenticated');
        }

        const params = {
            sessionKey: this.sessionKey,
            message,
            thinking: options.thinking || 'medium',
            deliver: true,
            idempotencyKey: options.idempotencyKey || `discord-${Date.now()}`
        };

        if (Number.isFinite(Number(options.timeoutMs))) {
            params.timeoutMs = Number(options.timeoutMs);
        }

        return this.sendRequest('chat.send', params);
    }

    /**
     * Abort a chat run in a session.
     */
    async abortChat(runId, options = {}) {
        if (!this.isAuthenticated) {
            throw new Error('Not authenticated');
        }

        return this.sendRequest('chat.abort', {
            sessionKey: options.sessionKey || this.sessionKey,
            runId
        });
    }

    /**
     * Start heartbeat to keep connection alive
     */
    startHeartbeat() {
        this.stopHeartbeat();
        // Use WebSocket built-in ping/pong instead of application-level heartbeat
        // The Gateway sends tick events periodically
        this.heartbeatInterval = setInterval(() => {
            if (this.isConnected && this.ws?.readyState === WebSocket.OPEN) {
                // Send a simple ping frame (WebSocket protocol level)
                this.ws.ping();
            }
        }, this.heartbeatIntervalMs);
    }

    /**
     * Stop heartbeat
     */
    stopHeartbeat() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
    }

    /**
     * Schedule reconnection
     */
    scheduleReconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.error('[GatewayWsClient] Max reconnect attempts reached');
            this.emit('maxReconnectAttemptsReached');
            return;
        }

        this.reconnectAttempts++;
        console.log(`[GatewayWsClient] Reconnecting in ${this.reconnectInterval}ms (attempt ${this.reconnectAttempts})...`);
        
        setTimeout(() => {
            this.connect().catch(error => {
                console.error('[GatewayWsClient] Reconnect failed:', error.message);
            });
        }, this.reconnectInterval);
    }

    /**
     * Disconnect from WebSocket
     */
    disconnect() {
        this.stopHeartbeat();
        if (this.ws) {
            this.ws.close(1000, 'Client disconnect');
            this.ws = null;
        }
        this.isConnected = false;
        this.isAuthenticated = false;
    }

    /**
     * Check if connected and authenticated
     */
    getStatus() {
        return {
            connected: this.isConnected,
            authenticated: this.isAuthenticated,
            url: this.gatewayUrl,
            sessionKey: this.sessionKey
        };
    }
}

module.exports = {
    GatewayWsClient,
    verifyDeviceSignature
};
