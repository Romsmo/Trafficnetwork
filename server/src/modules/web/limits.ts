/**
 * In-memory sliding-window limiter for web sessions. In-process only, consistent with the rest of the
 * server's single-instance scope (see modules/realtime/registry.ts): a restart forgets the counters,
 * which costs an attacker at most one extra window of quota.
 */
export interface LimitCheck {
  key: string;
  max: number;
  windowMs: number;
  /** Which limit this is, for the error message ("session", "network", "node", ...). */
  scope: string;
}

export type LimitResult = { allowed: true } | { allowed: false; scope: string; retryAfterSeconds: number };

const MAX_KEYS = 50_000;

export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * All-or-nothing: the request is only counted against every limit if it fits into all of them, so a
   * request rejected by one limit does not also eat quota from the others.
   */
  tryConsume(checks: LimitCheck[]): LimitResult {
    const t = this.now();
    for (const check of checks) {
      const recent = this.recent(check.key, check.windowMs, t);
      if (recent.length >= check.max) {
        const oldest = recent[0] ?? t;
        return { allowed: false, scope: check.scope, retryAfterSeconds: Math.max(1, Math.ceil((oldest + check.windowMs - t) / 1000)) };
      }
    }
    for (const check of checks) {
      const recent = this.recent(check.key, check.windowMs, t);
      recent.push(t);
      this.hits.set(check.key, recent);
    }
    if (this.hits.size > MAX_KEYS) this.prune(3_600_000);
    return { allowed: true };
  }

  private recent(key: string, windowMs: number, t: number): number[] {
    const list = this.hits.get(key);
    if (!list) return [];
    return list.filter((ts) => ts > t - windowMs);
  }

  /** Drops keys whose newest hit is older than `maxWindowMs`. Called periodically and when the map grows large. */
  prune(maxWindowMs: number): void {
    const cutoff = this.now() - maxWindowMs;
    for (const [key, list] of this.hits) {
      const newest = list[list.length - 1];
      if (newest === undefined || newest <= cutoff) this.hits.delete(key);
    }
  }

  get size(): number {
    return this.hits.size;
  }
}
