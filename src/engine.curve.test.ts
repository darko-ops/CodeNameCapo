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
  roomFactor,
  appliedDrop,
  bandFor,
  CURVE,
  MIN_BAND,
  MAX_BAND,
  SPECIAL_SITUATION_BONUS,
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

describe("appliedDrop = base_band × list × room_factor", () => {
  it("scales the give with room: same move drops more near list than at target than near floor", () => {
    const t = "strong" as const;
    const nearList = appliedDrop(CFG.listPrice - 0.5, t, CFG);
    const atTarget = appliedDrop(CFG.targetPrice, t, CFG);
    const nearFloor = appliedDrop(CFG.floorPrice + 0.5, t, CFG);
    expect(nearList).toBeGreaterThan(atTarget);
    expect(atTarget).toBeGreaterThan(nearFloor);
    expect(nearFloor).toBeGreaterThan(0); // a nudge, never nothing (room_floor_min)
  });

  it("a bigger base_band gives a bigger drop at the same price", () => {
    const at = CFG.listPrice - 0.5;
    expect(appliedDrop(at, "strong", CFG)).toBeGreaterThan(appliedDrop(at, "weak", CFG));
    expect(appliedDrop(at, "weak", CFG)).toBeGreaterThan(appliedDrop(at, "none", CFG));
  });

  it("the special bonus on a low-tier deal-maker drops much more than that tier ordinarily", () => {
    const at = CFG.listPrice - 0.5;
    // e.g. a bare credible walk-away extracts weak, but special lifts it big.
    expect(appliedDrop(at, "weak", CFG, { special: true })).toBeGreaterThan(
      appliedDrop(at, "weak", CFG) * 2,
    );
  });
});

describe("give-band scale: wide variance, 2% min, 13% max", () => {
  it("bands span MIN_BAND (2%) → MAX_BAND (13%), strictly increasing by tier (variance)", () => {
    expect(bandFor("none")).toBe(MIN_BAND);
    expect(MIN_BAND).toBeCloseTo(0.02, 9);
    expect(bandFor("strong")).toBe(MAX_BAND);
    expect(MAX_BAND).toBeCloseTo(0.13, 9);
    // a flat lowball and a big-audience offer must NOT feel the same — strict spread
    expect(bandFor("weak")).toBeGreaterThan(bandFor("none"));
    expect(bandFor("moderate")).toBeGreaterThan(bandFor("weak"));
    expect(bandFor("strong")).toBeGreaterThan(bandFor("moderate"));
  });

  it("the special bonus (+10%) lifts a low tier toward the ceiling, clamped at MAX_BAND", () => {
    expect(SPECIAL_SITUATION_BONUS).toBeCloseTo(0.1, 9);
    expect(bandFor("weak", true)).toBeGreaterThan(bandFor("weak", false)); // +10pp lift
    expect(bandFor("weak", true)).toBeLessThanOrEqual(MAX_BAND + 1e-9); // never past the ceiling
    expect(bandFor("strong", true)).toBeCloseTo(MAX_BAND, 9); // already at the cap
  });
});
