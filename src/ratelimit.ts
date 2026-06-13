/**
 * Invisible rate limiting (demo abuse protection).
 *
 * The negotiation endpoints cost real money — every message fans out to two LLM
 * calls (Extractor + Renderer). A bare public demo is a free API key for anyone
 * who scripts it. This blunts that without ever showing a human an error: a
 * throttled message gets a canned, in-character "slow down" reply instead of a
 * 429, so to a real user it just looks like the bouncer telling them to chill.
 *
 * Fixed-window, in-memory, keyed by client IP. Per-process: on a serverless host
 * each warm instance keeps its own counters, which is enough to break the
 * damaging pattern (one client hammering a warm instance in a burst) cheaply.
 * Swap the internal Map for a shared store (Redis/Postgres) when cross-instance
 * precision is needed — the interface stays the same.
 */

export interface RateRule {
  /** Window length in milliseconds. */
  windowMs: number;
  /** Max events allowed within a window. */
  max: number;
}

interface Window {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  private windows = new Map<string, Window>();
  constructor(private readonly now: () => number = () => Date.now()) {}

  /**
   * Record a hit against `key` for `rule`. Returns true if the hit is within the
   * limit, false if it's over. Over-limit hits still count, so sustained abuse
   * stays blocked for the rest of the window. Each distinct rule gets its own
   * window for a given key (namespaced internally), so independent limits — e.g.
   * a burst rule and a per-minute rule — don't collide.
   */
  hit(key: string, rule: RateRule): boolean {
    const bk = `${key}#${rule.windowMs}:${rule.max}`;
    const t = this.now();
    let w = this.windows.get(bk);
    if (!w || t >= w.resetAt) {
      w = { count: 0, resetAt: t + rule.windowMs };
      this.windows.set(bk, w);
    }
    w.count++;
    if (this.windows.size > 10_000) this.sweep(t); // cheap unbounded-growth guard
    return w.count <= rule.max;
  }

  /**
   * Apply several rules at once. Every rule is counted (no short-circuit, so each
   * window stays accurate); returns true only if ALL rules permit the hit.
   */
  hitAll(key: string, rules: readonly RateRule[]): boolean {
    let ok = true;
    for (const r of rules) ok = this.hit(key, r) && ok;
    return ok;
  }

  private sweep(t: number): void {
    for (const [k, w] of this.windows) if (t >= w.resetAt) this.windows.delete(k);
  }
}

/**
 * Per-session message-VELOCITY guard (wallet protection), computed from persisted
 * turn timestamps — so it's exact across serverless instances and survives
 * restarts (unlike the in-memory RateLimiter above). True ⇒ the incoming message
 * would exceed `perMin` user messages in the trailing 60s, so it should be
 * throttled (a cheap canned reply, no LLM). Pure & deterministic.
 *
 * This keys off RATE, not lifetime volume: a human grinding a haggle over hours or
 * days is always slow and never trips it; a bot firing messages fast trips it
 * instantly and hits a free wall. `perMin <= 0` disables the guard.
 */
export function messageRateExceeded(userMsgTimestamps: number[], now: number, perMin: number): boolean {
  if (!(perMin > 0)) return false;
  const since = now - 60_000;
  let inWindow = 0;
  for (const t of userMsgTimestamps) if (t > since) inWindow++;
  return inWindow >= perMin;
}
