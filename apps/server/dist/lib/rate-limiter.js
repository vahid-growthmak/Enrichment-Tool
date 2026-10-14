/**
 * Fixed-window rate limiter backed by Redis (shared across worker processes).
 * tryAcquire() never blocks; the caller decides whether to delay the job.
 */
export class RedisRateLimiter {
    redis;
    key;
    maxPerWindow;
    windowMs;
    constructor(redis, key, maxPerWindow, windowMs = 60_000) {
        this.redis = redis;
        this.key = key;
        this.maxPerWindow = maxPerWindow;
        this.windowMs = windowMs;
    }
    async tryAcquire() {
        if (this.maxPerWindow <= 0)
            return { ok: true };
        const now = Date.now();
        const window = Math.floor(now / this.windowMs);
        const k = `${this.key}:${window}`;
        const count = await this.redis.incr(k);
        if (count === 1)
            await this.redis.pexpire(k, this.windowMs * 2);
        if (count <= this.maxPerWindow)
            return { ok: true };
        const retryInMs = (window + 1) * this.windowMs - now + Math.floor(Math.random() * 250);
        return { ok: false, retryInMs };
    }
}
//# sourceMappingURL=rate-limiter.js.map