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
  appliedDrop,
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

/** The give on the very first push, for a given reasoning tier. */
function firstGive(tier: Reasoning): number {
  const s = openSession(CFG, 0);
  const a = decide(s, 1, CFG, 0, { reasoning: tier });
  return a.type === "counter" ? round2(s.currentAsk - a.amount) : 0;
}

describe("pushback earns a give (decoupled from argument validity)", () => {
  it("a genuine push moves the number even with a weak or absent case", () => {
    for (const tier of ["none", "weak"] as const) {
      const s = openSession(CFG, 0);
      const a = decide(s, 10, CFG, 0, { reasoning: tier });
      expect(a.type, tier).toBe("counter");
      if (a.type === "counter") {
        // Moved off the anchor — not the old wall that held until a case was
        // graded "valid". (Magnitude is room_factor-scaled; here we only assert
        // it moved — the size/shape is covered by the room_factor tests below.)
        expect(a.amount, tier).toBeLessThan(s.currentAsk);
        // ...but a weak/no case can't cross the target.
        expect(a.amount, tier).toBeGreaterThanOrEqual(CFG.targetPrice - 1e-9);
      }
    }
  });

  it("validity sets the SIZE of the give, not its existence", () => {
    const none = firstGive("none");
    const weak = firstGive("weak");
    const moderate = firstGive("moderate");
    const strong = firstGive("strong");
    // Everyone gets something...
    expect(none).toBeGreaterThan(0);
    // ...and a better case gives a strictly bigger slice.
    expect(weak).toBeGreaterThan(none);
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
      const a = decide(s, 1, CFG, 0, { reasoning: "weak" });
      if (a.type === "accept" || a.type === "walk") break;
      if ("amount" in a) lowest = Math.min(lowest, a.amount);
      s = applyAction(s, 1, a);
    }
    expect(lowest).toBeGreaterThanOrEqual(CFG.targetPrice - 1e-9); // never below target
    expect(lowest).toBeGreaterThan(CFG.floorPrice); // and nowhere near the floor
  });
});

describe("curve shape: generous early, stubborn near target/floor (same move, different room)", () => {
  it("an identical move drops MORE near list than at target, and much less near floor", () => {
    const tier = "strong" as const;
    const nearList = appliedDrop(CFG.listPrice - 0.5, tier, CFG);     // top of the band
    const atTarget = appliedDrop(CFG.targetPrice, tier, CFG);          // the handoff
    const nearFloor = appliedDrop(CFG.floorPrice + 0.5, tier, CFG);    // the grind
    expect(nearList).toBeGreaterThan(atTarget);   // gentler resistance up top
    expect(atTarget).toBeGreaterThan(nearFloor);  // brutal near the floor
    // The near-floor give is a small nudge, but never zero (room_floor_min).
    expect(nearFloor).toBeGreaterThan(0);
  });
});

describe("walks are for abuse, never for haggling", () => {
  it("a cold-start haggle never walks a stubborn lowballer — it holds (endOnRoundsExhausted off)", () => {
    let s = openSession(CFG, 0);
    for (let i = 0; i < 30; i++) {
      const a = decide(s, 1, CFG, 0, { reasoning: "none" }); // relentless $1, no case
      expect(a.type).not.toBe("walk"); // Vini stands firm, he never rage-quits
      if (a.type === "accept") break;
      s = applyAction(s, 1, a);
    }
  });

  it("a reneg-style session DOES terminate when rounds run out (endOnRoundsExhausted on → grandfather)", () => {
    let s = openSession(CFG, 0);
    let walked = false;
    for (let i = 0; i < 30; i++) {
      const a = decide(s, 1, CFG, 0, { reasoning: "none", endOnRoundsExhausted: true });
      if (a.type === "walk") { walked = true; break; }
      if (a.type === "accept") break;
      s = applyAction(s, 1, a);
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
