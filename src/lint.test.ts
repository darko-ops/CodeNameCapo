import { describe, it, expect } from "vitest";
import { lintConfig } from "./lint.js";
import { demoPlan } from "./config.js";
import type { Config } from "./engine.js";

const base = (): Config => ({ ...demoPlan().config });

describe("lintConfig (Spec §12)", () => {
  it("passes the shipped demo config clean", () => {
    const p = demoPlan();
    const r = lintConfig(p.config, p.policy);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it("flags floor = $0 as a hard error (the canonical footgun)", () => {
    const r = lintConfig({ ...base(), floorPrice: 0 });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/floorPrice/);
  });

  it("errors when target <= floor", () => {
    const r = lintConfig({ ...base(), floorPrice: 25, targetPrice: 22 });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/targetPrice/);
  });

  it("errors when the anchor has no room above target", () => {
    // list 20 × 1.0 = 20 anchor, target 22 → anchor below target
    const r = lintConfig({ ...base(), listPrice: 20, anchorMultiplier: 1, targetPrice: 22 });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/anchor/);
  });

  it("warns on a low anchor multiplier and a too-generous accept threshold", () => {
    const r = lintConfig({ ...base(), anchorMultiplier: 1.6 }); // still >1.5? 1.6 ok; use 1.4
    const r2 = lintConfig({ ...base(), anchorMultiplier: 1.4, acceptThreshold: 0.7 });
    expect(r.ok).toBe(true);
    expect(r2.warnings.join(" ")).toMatch(/anchorMultiplier/);
    expect(r2.warnings.join(" ")).toMatch(/acceptThreshold/);
  });

  it("validates the negotiation policy", () => {
    const r = lintConfig(base(), { cooldownHours: -1, maxMessages: 0 });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/cooldownHours/);
    expect(r.errors.join(" ")).toMatch(/maxMessages/);
  });
});
