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
        this.scopes = normalizeScopes(
            options.scopes || process.env.GATEWAY_WS_SCOPES || 'operator.read,operator.write'
        );
        this.grantedScopes = [];
        
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
            const response = await this.sendRequest('connect', {
                minProtocol: 3,
                maxProtocol: 3,
                client: {
                    id: this.clientId,
                    version: this.clientVersion,
                    platform: 'node',
                    mode: this.role
                },
                role: this.role,
                scopes: this.scopes,
                auth: {
                    token: this.authToken
                },
                caps: ['receiveEvents']
            });
            
            // Handle successful authentication
            if (response?.type === 'hello-ok') {
                this.isAuthenticated = true;
                this.grantedScopes = normalizeScopes(response.auth?.scopes || this.scopes);
                this.startHeartbeat();
                this.emit('authenticated');
                console.log(`[GatewayWsClient] Authenticated successfully (role=${this.role}, scopes=${this.grantedScopes.join(',') || 'none'})`);
            }
        } catch (error) {
            console.error('[GatewayWsClient] Authentication failed:', error.message);
            this.emit('error', error);
        }
    }

    hasScope(scope) {
        const scopes = this.grantedScopes.length > 0 ? this.grantedScopes : this.scopes;
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

module.exports = { GatewayWsClient };
