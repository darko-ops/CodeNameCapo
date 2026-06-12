/**
 * Concession curve — the piecewise room_factor (gentle list→target, steep
 * target→floor). These assert the SHAPE of the curve directly (continuity at
 * target, the gear-change in slope, end behavior, no div-by-zero), independent of
 * the full decide() dynamics. The constants (k_high/k_low/target_band/
 * room_floor_min) are feel knobs tuned by ear — these tests pin the shape, not
 * exact dollar amounts.
 */
import { describe, it, expect } from "vitest";
import {
  type Config,
  type SessionState,
  roomFactor,
  pullToward,
  isInsultingOffer,
  decide,
  applyAction,
  openSession,
  CURVE,
  PULL_WEIGHT_BY_TIER,
  MAX_PULL_FRACTION,
  LOWBALL_THRESHOLD,
} from "./engine.js";

const CFG: Config = {
  listPrice: 30,
  floorPrice: 8,
  targetPrice: 22,
  anchorMultiplier: 1.6,
  maxRounds: 6,
  maxDurationH: 48,
  acceptThreshold: 0.97,
  minConcession: 0.5,
  lambda: 0.6,
};

describe("roomFactor — end behavior", () => {
  it("≈1.0 at/above list, =target_band at target, ≈room_floor_min at floor", () => {
    expect(roomFactor(CFG.listPrice, CFG)).toBeCloseTo(1.0, 6);
    expect(roomFactor(CFG.listPrice + 10, CFG)).toBe(1.0); // clamped above list
    expect(roomFactor(CFG.targetPrice, CFG)).toBeCloseTo(CURVE.targetBand, 6);
    expect(roomFactor(CFG.floorPrice, CFG)).toBeCloseTo(CURVE.roomFloorMin, 6); // clamped at floor
  });

  it("stays within [room_floor_min, 1.0] across the whole ladder", () => {
    for (let p = CFG.floorPrice; p <= CFG.listPrice + 5; p += 0.25) {
      const r = roomFactor(p, CFG);
      expect(r).toBeGreaterThanOrEqual(CURVE.roomFloorMin - 1e-9);
      expect(r).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it("is monotonic in price — a higher price always has at least as much room", () => {
    let prev = roomFactor(CFG.floorPrice, CFG);
    for (let p = CFG.floorPrice; p <= CFG.listPrice + 2; p += 0.25) {
      const r = roomFactor(p, CFG);
      expect(r).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = r;
    }
  });
});

describe("roomFactor — continuity + the gear-change at target", () => {
  it("is continuous in VALUE at target (no jump — both regimes meet at target_band)", () => {
    const eps = 0.01;
    const above = roomFactor(CFG.targetPrice + eps, CFG);
    const below = roomFactor(CFG.targetPrice - eps, CFG);
    expect(Math.abs(above - below)).toBeLessThan(0.02); // ~equal across the seam
    expect(roomFactor(CFG.targetPrice, CFG)).toBeCloseTo(CURVE.targetBand, 6);
  });

  it("SLOPE steepens crossing below target (the gear-change): avg slope below > above", () => {
    const d = 0.5;
    const slope = (p: number) => (roomFactor(p + d, CFG) - roomFactor(p, CFG)) / d;
    const aboveSlope = (slope(CFG.targetPrice + 1) + slope(CFG.targetPrice + 3)) / 2;
    const belowSlope = (slope(CFG.targetPrice - 3) + slope(CFG.targetPrice - 1)) / 2;
    expect(aboveSlope).toBeGreaterThan(0); // room grows with price both sides
    expect(belowSlope).toBeGreaterThan(aboveSlope); // ...but steeper below target
  });
});

describe("roomFactor — robustness", () => {
  it("a degenerate ladder (list == target) doesn't divide by zero", () => {
    const degen = { ...CFG, listPrice: 22, targetPrice: 22 };
    const r = roomFactor(30, degen);
    expect(Number.isFinite(r)).toBe(true);
    expect(r).toBeLessThanOrEqual(1 + 1e-9);
    expect(r).toBeGreaterThanOrEqual(CURVE.roomFloorMin - 1e-9);
  });
});

describe("pullToward — gap-anchored, room_factor as the scaler", () => {
  it("pulls a fraction of the gap toward the buyer; bigger move → closer to the offer", () => {
    const cur = 30, offer = 20;
    const none = pullToward(cur, offer, PULL_WEIGHT_BY_TIER.none, CFG, CFG.floorPrice);
    const strong = pullToward(cur, offer, PULL_WEIGHT_BY_TIER.strong, CFG, CFG.floorPrice);
    expect(none).toBeLessThan(cur); // it moved
    expect(strong).toBeLessThan(none); // a stronger pull lands closer to the buyer
    expect(strong).toBeGreaterThan(offer); // but never below the offer (pull < 1)
  });

  it("room_factor still paces it: the SAME move pulls a bigger fraction near list than near floor", () => {
    const w = PULL_WEIGHT_BY_TIER.strong;
    // hold the gap ratio fixed (offer = 60% of current) so only room_factor varies
    const nearList = (CFG.listPrice - 0.5) - pullToward(CFG.listPrice - 0.5, (CFG.listPrice - 0.5) * 0.6, w, CFG, CFG.floorPrice);
    const nearFloor = (CFG.floorPrice + 2) - pullToward(CFG.floorPrice + 2, (CFG.floorPrice + 2) * 0.6, w, CFG, CFG.floorPrice);
    expect(nearList).toBeGreaterThan(nearFloor); // wider room → bigger leap
    expect(nearFloor).toBeGreaterThanOrEqual(0);
  });

  it("never moves more than MAX_PULL_FRACTION of the gap in one round (no capitulation)", () => {
    const cur = 48, offer = 10; // huge gap, strongest possible pull
    const next = pullToward(cur, offer, 5 /* absurdly high weight */, CFG, CFG.floorPrice);
    const movedFraction = (cur - next) / (cur - offer);
    expect(movedFraction).toBeLessThanOrEqual(MAX_PULL_FRACTION + 1e-9);
  });

  it("never lands below the bound (floor) nor below the buyer's offer", () => {
    expect(pullToward(30, 9, 5, CFG, CFG.floorPrice)).toBeGreaterThanOrEqual(CFG.floorPrice);
    expect(pullToward(30, 25, PULL_WEIGHT_BY_TIER.strong, CFG, CFG.floorPrice)).toBeGreaterThan(25);
    expect(pullToward(30, 35, PULL_WEIGHT_BY_TIER.strong, CFG, CFG.floorPrice)).toBe(30); // offer above ask → no move
  });
});

describe("insulting-anchor guard", () => {
  it("flags offers below floor or below LOWBALL_THRESHOLD × ask as insults", () => {
    expect(LOWBALL_THRESHOLD).toBeCloseTo(0.3, 9);
    expect(isInsultingOffer(5, 30, CFG)).toBe(true); // below floor (8) and << 0.3×30
    expect(isInsultingOffer(8, 30, CFG)).toBe(true); // 8 < 0.3×30 = 9
    expect(isInsultingOffer(20, 30, CFG)).toBe(false); // credible
  });

  it("decide() REFUSES an insult (holds, no give) and does not chase it", () => {
    const s = openSession(CFG, 0); // ask 48
    const refused = decide(s, 5, CFG, 0, { reasoning: "strong" });
    expect(refused).toEqual({ type: "hold", amount: 48 }); // near-zero give, not a move toward $5
  });

  it("repeated insults stay refused — never softer", () => {
    let s = openSession(CFG, 0);
    for (let i = 0; i < 6; i++) {
      const a = decide(s, 3, CFG, 0, { reasoning: "strong" }); // relentless $3 insult
      expect(a.type).toBe("hold");
      expect(a.type === "hold" ? a.amount : 0).toBe(s.currentAsk); // price never drops for an insult
      s = applyAction(s, 3, a);
    }
  });
});

describe("responsiveness: the buyer's number matters", () => {
  it("a higher credible offer is met CLOSER than a lower one (same move, same room)", () => {
    const s: SessionState = { round: 0, currentAsk: 30, openedAt: 0, history: [] };
    const high = decide(s, 27, CFG, 0, { reasoning: "moderate" }); // 27 below acceptThreshold (0.97×30=29.1)
    const low = decide(s, 15, CFG, 0, { reasoning: "moderate" });
    const ch = high.type === "counter" ? high.amount : NaN;
    const cl = low.type === "counter" ? low.amount : NaN;
    expect(ch).not.toBe(cl); // DIFFERENT counters — the buyer's number matters (the core fix)
    expect(ch).toBeGreaterThan(cl); // the counter tracks the offer: higher offer → higher counter
    expect(Math.abs(ch - 27)).toBeLessThan(Math.abs(cl - 15)); // higher offer met proportionally closer
    expect(ch).toBeGreaterThan(27); // each counter still sits above its own offer
    expect(cl).toBeGreaterThan(15);
  });
});

describe("exposure is priced as a token (split tone from price)", () => {
  it("an exposure move never moves price below an identical non-reach (none) haggle", () => {
    const s: SessionState = { round: 0, currentAsk: 30, openedAt: 0, history: [] };
    const offer = 20;
    // big-reach exposure graded strong for TONE, but priced as none via exposure flag
    const exposed = decide(s, offer, CFG, 0, { reasoning: "strong", exposure: true });
    const plainNone = decide(s, offer, CFG, 0, { reasoning: "none" });
    const ce = exposed.type === "counter" ? exposed.amount : NaN;
    const cn = plainNone.type === "counter" ? plainNone.amount : NaN;
    expect(ce).toBeCloseTo(cn, 6); // exposure pulls no harder than a bare none move
    // ...and far less than a real strong move would (which is NOT exposure)
    const realStrong = decide(s, offer, CFG, 0, { reasoning: "strong" });
    expect(ce).toBeGreaterThan(realStrong.type === "counter" ? realStrong.amount : 0);
  });
});
