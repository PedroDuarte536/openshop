import { CONFIG } from "./config.ts";

/**
 * Counts failures per key (IP, cart, email...) in a fixed window and blocks a key after `max` failures.
 * In memory, per process (see the known limitations in docs/discounts-plan.md).
 */
export class FailureLimiter {
  private hits = new Map<string, { n: number; reset: number }>();
  private max: number; private windowMs: number;
  constructor(max: number, windowMs: number) { this.max = max; this.windowMs = windowMs; }
  blocked(keys: string[], now = Date.now()) { return keys.some((k) => { const h = this.hits.get(k); return !!h && h.reset > now && h.n >= this.max; }); }
  fail(keys: string[], now = Date.now()) {
    if (this.hits.size > CONFIG.caches.limiterMaxKeys) for (const [k, v] of this.hits) if (v.reset <= now) this.hits.delete(k);
    for (const k of keys) {
      const h = this.hits.get(k);
      this.hits.set(k, h && h.reset > now ? { n: h.n + 1, reset: h.reset } : { n: 1, reset: now + this.windowMs });
    }
  }
  clear(keys: string[]) { for (const k of keys) this.hits.delete(k); }
}

/**
 * A token bucket per key (e.g. IP): `capacity` requests at once, refilled at `perSecond`. For public endpoints that
 * cost CPU (search). In memory, per process; behind a proxy, `req.ip` needs Fastify's trustProxy (known limitation).
 */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();
  private capacity: number; private perSecond: number;
  constructor(capacity: number, perSecond: number) { this.capacity = capacity; this.perSecond = perSecond; }
  /** Takes one token; false when the key has none left. */
  take(key: string, now = Date.now()): boolean {
    if (this.buckets.size > CONFIG.caches.limiterMaxKeys) for (const [k, b] of this.buckets) if (now - b.at > (this.capacity / this.perSecond) * 1000) this.buckets.delete(k);
    const b = this.buckets.get(key) ?? { tokens: this.capacity, at: now };
    b.tokens = Math.min(this.capacity, b.tokens + ((now - b.at) / 1000) * this.perSecond);
    b.at = now;
    this.buckets.set(key, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }
}
