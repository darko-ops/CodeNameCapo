import { describe, it, expect } from "vitest";
import { RateLimiter, messageRateExceeded } from "./ratelimit.js";

describe("messageRateExceeded — per-session velocity wallet guard", () => {
  const NOW = 10_000_000;

  it("trips on a fast burst (>= perMin within the trailing minute)", () => {
    const burst = Array.from({ length: 12 }, (_, i) => NOW - i * 1000); // 12 in 12s
    expect(messageRateExceeded(burst, NOW, 12)).toBe(true);
    expect(messageRateExceeded(burst.slice(0, 11), NOW, 12)).toBe(false); // 11 < 12, still ok
  });

  it("NEVER trips a slow, days-long human haggle", () => {
    // 200 messages, one every 5 minutes — a genuine multi-day grind.
    const slow = Array.from({ length: 200 }, (_, i) => NOW - i * 5 * 60_000);
    expect(messageRateExceeded(slow, NOW, 12)).toBe(false);
    // even a brisk human (one every ~6s) stays under a 12/min limit
    const brisk = Array.from({ length: 9 }, (_, i) => NOW - i * 6000);
    expect(messageRateExceeded(brisk, NOW, 12)).toBe(false);
  });

  it("only counts messages inside the 60s window (old ones age out → resumes)", () => {
    const ts = [NOW - 70_000, NOW - 65_000, ...Array.from({ length: 5 }, (_, i) => NOW - i * 1000)];
    expect(messageRateExceeded(ts, NOW, 6)).toBe(false); // only 5 are recent
  });

  it("is disabled when perMin <= 0", () => {
    expect(messageRateExceeded([NOW, NOW, NOW], NOW, 0)).toBe(false);
  });
});

describe("RateLimiter", () => {
  it("allows up to max within a window, then blocks, then resets", () => {
    let t = 1000;
    const rl = new RateLimiter(() => t);
    const rule = { windowMs: 1000, max: 3 };
    expect([rl.hit("a", rule), rl.hit("a", rule), rl.hit("a", rule)]).toEqual([true, true, true]);
    expect(rl.hit("a", rule)).toBe(false); // 4th is over
    expect(rl.hit("a", rule)).toBe(false); // stays blocked for the window
    t += 1001; // window elapses
    expect(rl.hit("a", rule)).toBe(true); // fresh window
  });

  it("keeps keys independent", () => {
    let t = 0;
    const rl = new RateLimiter(() => t);
    const rule = { windowMs: 1000, max: 1 };
    expect(rl.hit("a", rule)).toBe(true);
    expect(rl.hit("a", rule)).toBe(false);
    expect(rl.hit("b", rule)).toBe(true); // different IP unaffected
  });

  it("namespaces rules so independent limits on one key don't collide", () => {
    let t = 0;
    const rl = new RateLimiter(() => t);
    expect(rl.hit("a", { windowMs: 1000, max: 1 })).toBe(true);
    expect(rl.hit("a", { windowMs: 60000, max: 5 })).toBe(true); // separate window, not consumed by the first
  });

  it("hitAll counts every rule and fails if any is exceeded", () => {
    let t = 0;
    const rl = new RateLimiter(() => t);
    const rules = [{ windowMs: 1000, max: 1 }, { windowMs: 60000, max: 10 }];
    expect(rl.hitAll("a", rules)).toBe(true);
    expect(rl.hitAll("a", rules)).toBe(false); // burst rule (max 1) trips
  });
});
