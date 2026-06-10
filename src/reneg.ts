/**
 * Renegotiation pricing (Spec §6.2). Builds a reneg-specific engine Config so the
 * SAME deterministic `decide()` drives the haggle — no mirrored math needed.
 *
 * Up (usage breached the band): the engine asks high and concedes down, but the
 * floor is `max(currentPrice, trailing-COGS × margin)`, so the close is always
 * ≥ what they pay now AND ≥ cost. Anchor is RELATIVE to the current price
 * (current × 1.5–2.0), never the cold-start list anchor — a $9 user sees ~$15,
 * not $48.
 *
 * Down (usage cratered, opt-in §6.3): anchor = current, target below it — a
 * goodwill drop, floor at cost.
 *
 * All outputs satisfy floor < target < anchor, so every §4.4 invariant the
 * engine guarantees in cold-start carries over unchanged.
 */
import type { Config } from "./engine.js";

export type RenegDirection = "up" | "down";

export interface RenegInputs {
  direction: RenegDirection;
  currentPrice: number;
  /** Average usage over the trailing cycles (drives COGS + the target). */
  trailingAvgUsage: number;
  bandCeiling: number;
  costPerUnit: number;
  costPlusMargin: number;
  renegAnchorMultiplier: number;
  /** Carries maxRounds / maxDurationH / acceptThreshold / minConcession / lambda. */
  base: Config;
}

export interface RenegPlan {
  config: Config;
  summary: {
    direction: RenegDirection;
    currentPrice: number;
    floor: number;
    target: number;
    anchor: number;
    costFloor: number;
    usageRatio: number;
    /** The fair tier to grandfather to if the user walks/ghosts (Spec §6.2). */
    grandfatherPrice: number;
  };
}

const round2 = (x: number) => Math.round((x + Number.EPSILON) * 100) / 100;

export function buildRenegConfig(inp: RenegInputs): RenegPlan {
  const usageRatio = inp.bandCeiling > 0 ? inp.trailingAvgUsage / inp.bandCeiling : 1;
  const costFloor = round2(inp.trailingAvgUsage * inp.costPerUnit * inp.costPlusMargin);
  const cur = inp.currentPrice;

  let floor: number, anchor: number, target: number;

  if (inp.direction === "up") {
    // Never drop below the current price, never below cost.
    floor = round2(Math.max(cur, costFloor));
    anchor = round2(Math.max(cur * inp.renegAnchorMultiplier, floor * 1.25));
    // Scale the increase with how badly they overused, capped at the anchor multiple.
    const desired = round2(cur * Math.min(usageRatio, inp.renegAnchorMultiplier));
    target = clampInside(desired, floor, anchor);
  } else {
    // Downward goodwill: open at current, aim lower, floor at cost.
    floor = round2(Math.max(costFloor, 0.01));
    anchor = round2(Math.max(cur, floor * 1.25));
    const desired = round2(cur * 0.6);
    target = clampInside(desired, floor, anchor);
  }

  const config: Config = {
    listPrice: cur, // reference only; engine anchor = listPrice × anchorMultiplier
    // Full precision (not round2'd) so engine anchor == summary.anchor exactly.
    anchorMultiplier: anchor / cur,
    floorPrice: floor,
    targetPrice: target,
    maxRounds: inp.base.maxRounds,
    maxDurationH: inp.base.maxDurationH,
    acceptThreshold: inp.base.acceptThreshold,
    minConcession: inp.base.minConcession,
    lambda: inp.base.lambda,
  };

  return {
    config,
    summary: {
      direction: inp.direction,
      currentPrice: cur,
      floor,
      target,
      anchor,
      costFloor,
      usageRatio: round2(usageRatio),
      grandfatherPrice: target, // the fair tier — never hard-cut (§6.2)
    },
  };
}

/** Keep target strictly inside (lo, hi), biased to the lower-middle of the band. */
function clampInside(x: number, lo: number, hi: number): number {
  const min = round2(lo + (hi - lo) * 0.25);
  const max = round2(lo + (hi - lo) * 0.85);
  return round2(Math.min(Math.max(x, min), max));
}
