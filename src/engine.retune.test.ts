/**
 * Concession retune (live red-team fix): make the haggle fun without softening
 * the floor. These tests pin the BEHAVIOR-WITHIN-THE-CAP changes:
 *   - pushback alone earns a give (no "valid argument" gate),
 *   - a better case changes the SIZE of the give, not whether one happens,
 *   - exposure/virality (now graded "weak") can't be a skeleton key to the floor,
 *   - concessions are generous near the anchor and taper toward the target,
 *   - and the engine endpoints (anchor/target/floor) are UNCHANGED.
 *
 * Feel knobs (GIVE_BY_TIER, the tiers) are expected to be tuned from live
 * red-teaming; these assert the shape, not exact dollar amounts.
 */
import { describe, it, expect } from "vitest";
import {
  type Config,
  type Reasoning,
  decide,
  applyAction,
  openSession,
  anchor,
  reachableFloor,
  pullToward,
  round2,
} from "./engine.js";

const CFG: Config = {
  listPrice: 30,
  floorPrice: 8,
  targetPrice: 22,
  anchorMultiplier: 1.6, // anchor = 48
  maxRounds: 6,
  maxDurationH: 48,
  acceptThreshold: 0.97,
  minConcession: 0.5,
  lambda: 0.6,
};

/** The give on the very first push (toward a credible $24 offer), for a tier. */
function firstGive(tier: Reasoning): number {
  const s = openSession(CFG, 0);
  const a = decide(s, 24, CFG, 0, { reasoning: tier });
  return a.type === "counter" ? round2(s.currentAsk - a.amount) : 0;
}

describe("a credible push earns a give (gap-anchored, decoupled from argument validity)", () => {
  it("a credible push moves the number even with a weak or absent case", () => {
    for (const tier of ["none", "weak"] as const) {
      const s = openSession(CFG, 0); // ask 48
      const a = decide(s, 24, CFG, 0, { reasoning: tier }); // credible offer (>= 0.3×48)
      expect(a.type, tier).toBe("counter");
      if (a.type === "counter") {
        expect(a.amount, tier).toBeLessThan(s.currentAsk); // moved toward the buyer
        expect(a.amount, tier).toBeGreaterThan(24); // never below their offer
        expect(a.amount, tier).toBeGreaterThanOrEqual(CFG.targetPrice - 1e-9); // weak/none can't cross target
      }
    }
  });

  it("validity sets the SIZE of the give (a stronger move pulls harder), not its existence", () => {
    const none = firstGive("none");
    const weak = firstGive("weak");
    const moderate = firstGive("moderate");
    const strong = firstGive("strong");
    expect(none).toBeGreaterThan(0); // everyone who makes a credible offer gets a give...
    expect(weak).toBeGreaterThan(none); // ...and a better case pulls a bigger slice of the gap
    expect(moderate).toBeGreaterThan(weak);
    expect(strong).toBeGreaterThan(moderate);
  });
});

describe("exposure scales with reach (a vague shoutout is still weak)", () => {
  it("a small/vague shoutout (weak) bottoms out at target, nowhere near the floor", () => {
    // A vague shoutout / tiny following extracts weak; weak's reachable floor is
    // the target, so it can't be talked to the hard floor. (A BIG, specific
    // audience grades up to moderate/strong and earns a much bigger give — that's
    // the variance; here we pin the floor of the scale.)
    let s = openSession(CFG, 0);
    let lowest = s.currentAsk;
    for (let i = 0; i < 40; i++) {
      const offer = round2(s.currentAsk * 0.5); // credible (> 0.3×ask), never accepted
      const a = decide(s, offer, CFG, 0, { reasoning: "weak" });
      if (a.type === "accept" || a.type === "walk") break;
      if ("amount" in a) lowest = Math.min(lowest, a.amount);
      s = applyAction(s, offer, a);
    }
    expect(lowest).toBeGreaterThanOrEqual(CFG.targetPrice - 1e-9); // never below target
    expect(lowest).toBeGreaterThan(CFG.floorPrice); // and nowhere near the floor
  });
});

describe("room_factor still paces the leap (same move, different room)", () => {
  it("an identical move pulls a BIGGER fraction of the gap near list than near floor", () => {
    const w = 0.8; // a strong-ish pull weight
    const dropNearList =
      (CFG.listPrice - 0.5) - pullToward(CFG.listPrice - 0.5, (CFG.listPrice - 0.5) * 0.6, w, CFG, CFG.floorPrice);
    const dropNearFloor =
      (CFG.floorPrice + 2) - pullToward(CFG.floorPrice + 2, (CFG.floorPrice + 2) * 0.6, w, CFG, CFG.floorPrice);
    expect(dropNearList).toBeGreaterThan(dropNearFloor); // wide room → a real leap; steep room → a nudge
    expect(dropNearFloor).toBeGreaterThanOrEqual(0);
  });
});

describe("walks are for abuse, never for haggling", () => {
  it("a cold-start haggle never walks a stubborn lowballer — it holds (endOnRoundsExhausted off)", () => {
    let s = openSession(CFG, 0);
    for (let i = 0; i < 30; i++) {
      const a = decide(s, 20, CFG, 0, { reasoning: "none" }); // relentless credible $20, no case
      expect(a.type).not.toBe("walk"); // Vini stands firm, he never rage-quits
      if (a.type === "accept") break;
      s = applyAction(s, 20, a);
    }
  });

  it("a reneg-style session DOES terminate when rounds run out (endOnRoundsExhausted on → grandfather)", () => {
    let s = openSession(CFG, 0);
    let walked = false;
    for (let i = 0; i < 30; i++) {
      const a = decide(s, 20, CFG, 0, { reasoning: "none", endOnRoundsExhausted: true });
      if (a.type === "walk") { walked = true; break; }
      if (a.type === "accept") break;
      s = applyAction(s, 20, a);
    }
    expect(walked).toBe(true); // the only difference is the opt-in flag
  });
});

describe("endpoints untouched (only behaviour within the cap changed)", () => {
  it("anchor/target/floor stay engine-set and reachable floors are unchanged", () => {
    expect(anchor(CFG)).toBe(round2(CFG.listPrice * CFG.anchorMultiplier));
    expect(reachableFloor("strong", CFG)).toBe(CFG.floorPrice);
    expect(reachableFloor("moderate", CFG)).toBe(round2((CFG.targetPrice + CFG.floorPrice) / 2));
    expect(reachableFloor("weak", CFG)).toBe(CFG.targetPrice);
    expect(reachableFloor("none", CFG)).toBe(CFG.targetPrice);
    // No tier can ever talk the price below the hard floor.
    for (const t of ["none", "weak", "moderate", "strong"] as const) {
      expect(reachableFloor(t, CFG)).toBeGreaterThanOrEqual(CFG.floorPrice);
    }
  });
});
