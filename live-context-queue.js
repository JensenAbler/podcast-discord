// Preserve all context while the provider keeps up. Sacrifice it only on measured lag.
class LiveContextQueue {
    constructor({ send, onLag, now = Date.now, maxPending = 4, maxAgeMs = 2000 }) {
        this.send = send;
        this.onLag = onLag;
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

    accept(id) {
        if (!this.pending.has(id)) return false;
        if (this.checkLag()) return true;
        this.pending.delete(id);
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
        const oldest = Math.min(this.waiting[0]?.queuedAt ?? Infinity,
            ...Array.from(this.pending.values(), x => x.queuedAt));
        if (Number.isFinite(oldest) && this.now() - oldest >= this.maxAgeMs) {
            this.fail('context-delivery-lag', this.now() - oldest);
            return true;
        }
        return false;
    }

    fail(reason, ageMs = 0) {
        const report = { reason, ageMs, pending: this.pending.size, queued: this.waiting.length };
        this.reset();
        this.onLag(report);
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
