// Append acknowledgments follow the model timeline; elapsed time alone is not a connection failure.
class LiveContextQueue {
    constructor({ send, onLag = () => {}, onFailure = () => {}, onAccepted = () => {}, now = Date.now, maxPending = 4, maxAgeMs = 10000 }) {
        this.send = send;
        this.onLag = onLag;
        this.onFailure = onFailure;
        this.onAccepted = onAccepted;
        this.now = now;
        this.maxPending = maxPending;
        this.maxAgeMs = maxAgeMs;
        this.waiting = [];
        this.pending = new Map();
        this.timer = null;
        this.pumping = false;
    }

    enqueue(event) {
        this.waiting.push({ event, queuedAt: this.now() });
        this.pump();
        if (!this.timer && (this.pending.size || this.waiting.length)) {
            this.timer = setInterval(() => this.checkLag(), 25);
            this.timer.unref?.();
        }
    }

    cancelQueued(id) {
        this.waiting = this.waiting.filter(item => item.event.event_id !== id);
        this.clearTimerIfIdle();
    }

    accept(id, event = {}) {
        const item = this.pending.get(id);
        if (!item) return false;
        this.pending.delete(id);
        this.onAccepted({ eventId: id, queueMs: item.sentAt - item.queuedAt,
            deliveryMs: this.now() - item.sentAt, startMs: event.start_ms, endMs: event.end_ms });
        this.pump();
        this.clearTimerIfIdle();
        return true;
    }

    pump() {
        if (this.pumping) return;
        this.pumping = true;
        try {
            while (this.waiting.length && this.pending.size < this.maxPending) {
                const item = this.waiting.shift();
                item.sentAt = this.now();
                this.pending.set(item.event.event_id, item);
                if (!this.send(item.event)) {
                    this.fail('context-send-failed');
                    break;
                }
            }
        } finally { this.pumping = false; }
        this.clearTimerIfIdle();
    }

    checkLag() {
        let warned = false;
        for (const item of this.pending.values()) {
            if (!item.warned && this.now() - item.sentAt >= this.maxAgeMs) {
                item.warned = true;
                this.onLag({ reason: 'context-delivery-pending', eventId: item.event.event_id,
                    ageMs: this.now() - item.sentAt, pending: this.pending.size, queued: this.waiting.length });
                warned = true;
            }
        }
        return warned;
    }

    fail(reason, ageMs = 0) {
        const report = { reason, ageMs, pending: this.pending.size, queued: this.waiting.length };
        this.reset();
        this.onFailure(report);
    }

    clearTimerIfIdle() {
        if (!this.pending.size && !this.waiting.length) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    reset() {
        clearInterval(this.timer);
        this.timer = null;
        this.waiting = [];
        this.pending.clear();
    }
}
module.exports = { LiveContextQueue };
