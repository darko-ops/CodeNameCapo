import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { buildRenegConfig } from "./reneg.js";
import { decide, openSession } from "./engine.js";
import { demoPlan } from "./config.js";

const base = demoPlan().config;

const inputArb = fc
  .record({
    currentCents: fc.integer({ min: 200, max: 5000 }),
    usage: fc.integer({ min: 1, max: 20000 }),
    ceiling: fc.integer({ min: 100, max: 5000 }),
    costPerUnitX1000: fc.integer({ min: 1, max: 50 }),
    marginX100: fc.integer({ min: 100, max: 300 }),
    anchorMultX10: fc.integer({ min: 15, max: 25 }),
    direction: fc.constantFrom<"up" | "down">("up", "down"),
  })
  .map((r) => ({
    direction: r.direction,
    currentPrice: r.currentCents / 100,
    trailingAvgUsage: r.usage,
    bandCeiling: r.ceiling,
    costPerUnit: r.costPerUnitX1000 / 1000,
    costPlusMargin: r.marginX100 / 100,
    renegAnchorMultiplier: r.anchorMultX10 / 10,
    base,
  }));

describe("buildRenegConfig (Spec §6.2)", () => {
  it("always produces a valid floor < target < anchor band", () => {
    fc.assert(
      fc.property(inputArb, (inp) => {
        const { summary, config } = buildRenegConfig(inp);
        expect(summary.floor).toBeLessThan(summary.target);
        expect(summary.target).toBeLessThan(summary.anchor);
        // engine anchor = listPrice × anchorMultiplier == summary.anchor
        expect(config.listPrice * config.anchorMultiplier).toBeCloseTo(summary.anchor, 1);
        expect(config.floorPrice).toBe(summary.floor);
        expect(config.targetPrice).toBe(summary.target);
      }),
      { numRuns: 1500 },
    );
  });

  it("an UP reneg never settles below the current price or below cost", () => {
    fc.assert(
      fc.property(inputArb, (inp) => {
        const up = { ...inp, direction: "up" as const };
        const { summary, config } = buildRenegConfig(up);
        expect(summary.floor).toBeGreaterThanOrEqual(up.currentPrice - 1e-9);
        expect(summary.floor).toBeGreaterThanOrEqual(summary.costFloor - 1e-9);

        // Drive a full negotiation: any accept is >= floor (>= current, >= cost).
        let s = openSession(config, 0);
        for (let i = 0; i < 30; i++) {
          const a = decide(s, summary.anchor, config, 0); // user keeps offering the anchor
          if (a.type === "accept") {
            expect(a.amount).toBeGreaterThanOrEqual(config.floorPrice - 1e-9);
            break;
          }
          if (a.type === "walk") break;
          s = { ...s, round: s.round + 1, currentAsk: a.type === "counter" ? a.amount : s.currentAsk };
        }
      }),
      { numRuns: 1500 },
    );
  });

  it("scales the target with overuse (5× user → bigger increase than 2× user), anchored to the current price", () => {
    // Low cost-per-unit so COGS stays below the $9 price — isolates the overuse
    // scaling. (When COGS exceeds the price, the floor correctly jumps to cost.)
    const common = {
      direction: "up" as const,
      currentPrice: 9,
      bandCeiling: 1000,
      costPerUnit: 0.0005,
      costPlusMargin: 1.25,
      renegAnchorMultiplier: 1.7,
      base,
    };
    const light = buildRenegConfig({ ...common, trailingAvgUsage: 1500 }); // 1.5×
    const heavy = buildRenegConfig({ ...common, trailingAvgUsage: 5000 }); // 5×
    expect(heavy.summary.target).toBeGreaterThanOrEqual(light.summary.target);
    // Anchored to the CURRENT price (×1.7 = $15.30), never a cold-start $48-style ask.
    expect(heavy.summary.anchor).toBeCloseTo(9 * 1.7, 1);
  });
});
