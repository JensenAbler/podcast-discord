/**
 * Gateway Bridge - Stub HTTP server for future endpoints
 * 
 * WebSocket communication is now handled by gateway-ws-client.js.
 * This server is kept as a placeholder for future HTTP endpoints.
 */

const http = require('http');

class GatewayBridge {
    constructor(options = {}) {
        this.responsePort = options.responsePort || parseInt(process.env.DISCORD_BOT_RESPONSE_PORT) || 4567;
        this.authToken = options.authToken || process.env.GATEWAY_AUTH_TOKEN || 'dev-token';
        this.gatewayUrl = options.gatewayUrl || process.env.GATEWAY_URL || 'http://localhost:3000';
        this.responseServer = null;
        this.isServerRunning = false;
    }

    /**
     * Initialize the Gateway bridge - starts HTTP server
     */
    async initialize() {
        console.log('[GatewayBridge] Initializing...');
        console.log(`[GatewayBridge] Response port: ${this.responsePort}`);
        await this.startResponseServer();
        console.log('[GatewayBridge] Initialized successfully');
    }

    /**
     * Start HTTP server (placeholder for future endpoints)
     */
    async startResponseServer() {
        if (this.isServerRunning) return;

        return new Promise((resolve, reject) => {
            this.responseServer = http.createServer((req, res) => {
                this.handleIncomingRequest(req, res);
            });

            this.responseServer.on('error', (error) => {
                if (error.code === 'EADDRINUSE') {
                    console.warn(`[GatewayBridge] Port ${this.responsePort} in use, using existing server`);
                    this.isServerRunning = true;
                    resolve();
                } else {
                    console.error('[GatewayBridge] Server error:', error);
                    reject(error);
                }
            });

            this.responseServer.listen(this.responsePort, () => {
                console.log(`[GatewayBridge] Server listening on port ${this.responsePort}`);
                this.isServerRunning = true;
                resolve();
            });
        });
    }

    /**
     * Handle incoming HTTP request
     */
    handleIncomingRequest(req, res) {
        // Set CORS headers
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

        if (req.method === 'OPTIONS') {
            res.writeHead(200);
            res.end();
            return;
        }

        // Check auth token
        const authHeader = req.headers['authorization'];
        if (authHeader !== `Bearer ${this.authToken}`) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Unauthorized' }));
            return;
        }

        // Placeholder - no endpoints defined yet
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
    }

    /**
     * Check if Gateway is available
     */
    async isGatewayAvailable() {
        try {
            const httpModule = require('http');
            const url = new URL('/health', this.gatewayUrl);
            
            return new Promise((resolve) => {
                httpModule.get(url, (res) => {
                    resolve(res.statusCode === 200);
                }).on('error', () => {
                    resolve(false);
                }).setTimeout(3000, function() {
                    this.abort();
                    resolve(false);
                });
            });
        } catch {
            return false;
        }
    }

    /**
     * Call Gateway cron API
     * @param {string} action - 'list', 'update', etc.
     * @param {object} params - API parameters
     * @returns {Promise<object>}
     */
    async callCronApi(action, params = {}) {
        return new Promise((resolve, reject) => {
            const httpModule = require('http');
            const postData = JSON.stringify({ action, ...params });
            
            const options = {
                hostname: new URL(this.gatewayUrl).hostname,
                port: new URL(this.gatewayUrl).port || 18789,
                path: '/api/cron',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.authToken}`,
                    'Content-Length': Buffer.byteLength(postData)
                }
            };

            const req = httpModule.request(options, (res) => {
                let data = '';
                res.on('data', (chunk) => data += chunk);
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        resolve(json);
                    } catch (e) {
                        resolve({ raw: data });
                    }
                });
            });

            req.on('error', (error) => reject(error));
            req.setTimeout(10000, () => {
                req.abort();
                reject(new Error('Cron API timeout'));
            });

            req.write(postData);
            req.end();
        });
    }

    /**
     * Disable all cron jobs
     * @returns {Promise<string[]>} - IDs of disabled jobs
     */
    async disableAllCronJobs() {
        try {
            console.log('[GatewayBridge] Disabling all cron jobs...');
            const listResult = await this.callCronApi('list');
            
            if (!listResult.jobs || listResult.jobs.length === 0) {
                console.log('[GatewayBridge] No cron jobs found to disable');
                return [];
            }

            const disabledIds = [];
            for (const job of listResult.jobs) {
                if (job.enabled) {
                    await this.callCronApi('update', {
                        jobId: job.id,
                        patch: { enabled: false }
                    });
                    disabledIds.push(job.id);
                    console.log(`[GatewayBridge] Disabled cron job: ${job.name} (${job.id})`);
                }
            }

            console.log(`[GatewayBridge] Disabled ${disabledIds.length} cron job(s)`);
            return disabledIds;
        } catch (error) {
            console.error('[GatewayBridge] Failed to disable cron jobs:', error.message);
            throw error;
        }
    }

    /**
     * Enable all cron jobs
     * @returns {Promise<string[]>} - IDs of enabled jobs
     */
    async enableAllCronJobs() {
        try {
            console.log('[GatewayBridge] Enabling all cron jobs...');
            const listResult = await this.callCronApi('list');
            
            if (!listResult.jobs || listResult.jobs.length === 0) {
                console.log('[GatewayBridge] No cron jobs found to enable');
                return [];
            }

            const enabledIds = [];
            for (const job of listResult.jobs) {
                if (!job.enabled) {
                    await this.callCronApi('update', {
                        jobId: job.id,
                        patch: { enabled: true }
                    });
                    enabledIds.push(job.id);
                    console.log(`[GatewayBridge] Enabled cron job: ${job.name} (${job.id})`);
                }
            }

            console.log(`[GatewayBridge] Enabled ${enabledIds.length} cron job(s)`);
            return enabledIds;
        } catch (error) {
            console.error('[GatewayBridge] Failed to enable cron jobs:', error.message);
            throw error;
        }
    }

    /**
     * Destroy and clean up
     */
    destroy() {
        if (this.responseServer) {
            this.responseServer.close();
            this.responseServer = null;
        }
        this.isServerRunning = false;
        console.log('[GatewayBridge] Destroyed');
    }
}

module.exports = { GatewayBridge };
