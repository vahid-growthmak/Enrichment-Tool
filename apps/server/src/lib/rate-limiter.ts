import type { Redis } from "ioredis";

/**
 * Fixed-window rate limiter backed by Redis (shared across worker processes).
 * tryAcquire() never blocks; the caller decides whether to delay the job.
 */
export class RedisRateLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly key: string,
    private readonly maxPerWindow: number,
    private readonly windowMs = 60_000,
  ) {}

  async tryAcquire(): Promise<{ ok: true } | { ok: false; retryInMs: number }> {
    if (this.maxPerWindow <= 0) return { ok: true };
    const now = Date.now();
    const window = Math.floor(now / this.windowMs);
    const k = `${this.key}:${window}`;
    const count = await this.redis.incr(k);
    if (count === 1) await this.redis.pexpire(k, this.windowMs * 2);
    if (count <= this.maxPerWindow) return { ok: true };
    const retryInMs = (window + 1) * this.windowMs - now + Math.floor(Math.random() * 250);
    return { ok: false, retryInMs };
  }
}
