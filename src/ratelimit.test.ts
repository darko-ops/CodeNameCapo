import { describe, it, expect } from "vitest";
import { RateLimiter } from "./ratelimit.js";

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
