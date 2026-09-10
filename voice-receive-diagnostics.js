// Metadata-only receive diagnostics. Never log packet bodies, keys, or tokens.
class VoiceReceiveDiagnostics {
    constructor(connection, { client, guildId, log = console.log, intervalMs = 10000 } = {}) {
        this.connection = connection;
        this.client = client;
        this.guildId = guildId;
        this.log = log;
        this.startedAt = Date.now();
        this.counts = { udp: 0, short: 0, unknownSender: 0, knownSender: 0, speakingStarts: 0, pcmChunks: 0, pcmBytes: 0 };
        this.users = new Map();
        this.closed = false;
        this.onUdp = (packet) => {
            this.counts.udp++;
            if (!Buffer.isBuffer(packet) || packet.length < 12) { this.counts.short++; return; }
            const user = this.connection.receiver?.ssrcMap?.get(packet.readUInt32BE(8));
            if (!user) { this.counts.unknownSender++; return; }
            this.counts.knownSender++;
            this.lastPacketAt = Date.now();
            const stats = this.user(user.userId);
            if (stats) stats.packets++;
        };
        this.onSpeaking = () => { this.counts.speakingStarts++; };
        this.onNetwork = () => { this.bindSockets(); this.report('network-state'); };
        this.onConnection = () => { this.bindNetwork(); this.report('connection-state'); };
        this.onVoiceState = (oldState, newState) => {
            if ((newState.guild?.id || oldState.guild?.id) !== this.guildId) return;
            const channel = this.connection.joinConfig?.channelId;
            if (oldState.channelId === channel || newState.channelId === channel) this.report('voice-state');
        };
        connection.on?.('stateChange', this.onConnection);
        connection.receiver?.speaking?.on?.('start', this.onSpeaking);
        client?.on?.('voiceStateUpdate', this.onVoiceState);
        this.bindNetwork();
        this.report('attached');
        this.timer = setInterval(() => this.report('interval'), intervalMs);
        this.timer.unref?.();
    }
    user(id) {
        if (!this.users.has(id) && this.users.size < 64) this.users.set(id, { packets: 0, pcmChunks: 0, pcmBytes: 0 });
        return this.users.get(id);
    }
    pcm(id, bytes) {
        this.counts.pcmChunks++;
        this.counts.pcmBytes += bytes;
        this.lastPcmAt = Date.now();
        const stats = this.user(id);
        if (stats) { stats.pcmChunks++; stats.pcmBytes += bytes; }
    }
    bindNetwork() {
        const next = this.connection.state?.networking;
        if (next !== this.network) {
            this.network?.off?.('stateChange', this.onNetwork);
            this.network = next;
            this.network?.on?.('stateChange', this.onNetwork);
        }
        this.bindSockets();
    }
    bindSockets() {
        const next = this.network?.state?.udp;
        if (next !== this.udp) {
            this.udp?.off?.('message', this.onUdp);
            this.udp = next;
            this.udp?.on?.('message', this.onUdp);
        }
    }
    report(event) {
        if (this.closed) return;
        const receiver = this.connection.receiver;
        const states = this.client?.guilds?.cache?.get(this.guildId)?.voiceStates?.cache;
        const channel = this.connection.joinConfig?.channelId;
        const members = states ? Array.from(states.values())
            .filter(s => s.channelId === channel).slice(0, 64)
            .map(s => ({ id: s.id, selfMute: s.selfMute, serverMute: s.serverMute,
                selfDeaf: s.selfDeaf, serverDeaf: s.serverDeaf, suppress: s.suppress })) : [];
        this.log('[VoiceReceiveDiagnostics] ' + JSON.stringify({
            event, guildId: this.guildId, channelId: channel,
            elapsedMs: Date.now() - this.startedAt,
            connectionState: this.connection.state?.status,
            networkState: this.network?.state?.code,
            udpObserverAttached: Boolean(this.udp),
            receiverUdpHandlerAttached: Boolean(this.udp?.listeners?.('message').includes(receiver?.onUdpMessage)),
            receiverWsHandlerAttached: Boolean(this.network?.state?.ws?.listeners?.('packet').includes(receiver?.onWsPacket)),
            selfDeaf: this.connection.joinConfig?.selfDeaf,
            selfMute: this.connection.joinConfig?.selfMute,
            counts: this.counts, lastPacketAt: this.lastPacketAt || null, lastPcmAt: this.lastPcmAt || null,
            subscriptions: Array.from(receiver?.subscriptions?.keys?.() || []).slice(0, 64),
            users: Array.from(this.users, ([id, stats]) => ({ id, ...stats })), members
        }));
    }
    destroy() {
        if (this.closed) return;
        this.report('detached');
        this.closed = true;
        clearInterval(this.timer);
        this.connection.off?.('stateChange', this.onConnection);
        this.connection.receiver?.speaking?.off?.('start', this.onSpeaking);
        this.client?.off?.('voiceStateUpdate', this.onVoiceState);
        this.network?.off?.('stateChange', this.onNetwork);
        this.udp?.off?.('message', this.onUdp);
    }
}
module.exports = { VoiceReceiveDiagnostics };
