/**
 * Config linting (Spec §12: "Config linting + warnings + sane minimums").
 *
 * Pure validation of a plan's pricing Config + policy. Errors are showstoppers
 * (the engine's invariants would break, or money could leak); warnings are
 * smells the merchant should look at. `floor = $0` is the canonical footgun
 * (§12 "Merchant misconfig") and is a hard error.
 */
import type { Config } from "./engine.js";
import type { NegotiationPolicy } from "./store/types.js";

export interface LintResult {
  ok: boolean; // no errors (warnings are allowed)
  errors: string[];
  warnings: string[];
}

/** Sane absolute minimum floor — below this, a "deal" isn't worth settling. */
const MIN_FLOOR = 1;

export function lintConfig(c: Config, policy?: NegotiationPolicy): LintResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const anchor = c.listPrice * c.anchorMultiplier;

  // --- hard errors: these break the engine's guarantees or leak margin ------
  if (!(c.floorPrice > 0)) errors.push(`floorPrice must be > 0 (got ${c.floorPrice}) — a $0 floor lets the bouncer give it away`);
  if (!(c.targetPrice > c.floorPrice))
    errors.push(`targetPrice (${c.targetPrice}) must be greater than floorPrice (${c.floorPrice})`);
  if (!(anchor > c.targetPrice))
    errors.push(`anchor (listPrice × anchorMultiplier = ${round2(anchor)}) must exceed targetPrice (${c.targetPrice}) — no room to negotiate`);
  if (!(c.anchorMultiplier >= 1)) errors.push(`anchorMultiplier must be ≥ 1 (got ${c.anchorMultiplier})`);
  if (!(c.maxRounds >= 1)) errors.push(`maxRounds must be ≥ 1 (got ${c.maxRounds})`);
  if (!(c.maxDurationH > 0)) errors.push(`maxDurationH must be > 0 (got ${c.maxDurationH})`);
  if (!(c.acceptThreshold > 0 && c.acceptThreshold <= 1))
    errors.push(`acceptThreshold must be in (0, 1] (got ${c.acceptThreshold})`);
  if (!(c.minConcession > 0)) errors.push(`minConcession must be > 0 (got ${c.minConcession})`);
  if (!(c.lambda > 0)) errors.push(`lambda must be > 0 (got ${c.lambda})`);

  // --- warnings: legal but suspicious --------------------------------------
  if (c.floorPrice > 0 && c.floorPrice < MIN_FLOOR)
    warnings.push(`floorPrice $${c.floorPrice} is below the suggested minimum of $${MIN_FLOOR}`);
  // anchorMultiplier 1 = open at list price (a discount-only model) — that's a
  // valid, intended setup, so we don't warn on it. Only flag an absurdly high open.
  if (c.anchorMultiplier > 12)
    warnings.push(`anchorMultiplier ${c.anchorMultiplier} is very high — the opening ask may feel absurd`);
  if (c.acceptThreshold < 0.85)
    warnings.push(`acceptThreshold ${c.acceptThreshold} is generous — you'll accept well under your ask`);
  if (c.maxRounds < 2) warnings.push(`maxRounds ${c.maxRounds} leaves no room to haggle`);
  if (c.maxRounds > 12) warnings.push(`maxRounds ${c.maxRounds} is high — negotiations may drag`);
  if (c.maxDurationH > 168) warnings.push(`maxDurationH ${c.maxDurationH} exceeds a week — weak urgency`);
  const band = c.targetPrice - c.floorPrice;
  if (band > 0 && c.minConcession > band / 2)
    warnings.push(`minConcession $${c.minConcession} is large relative to the floor→target band ($${round2(band)}) — concessions may overshoot`);

  if (policy) {
    if (!(policy.cooldownHours >= 0)) errors.push(`policy.cooldownHours must be ≥ 0 (got ${policy.cooldownHours})`);
    if (!(policy.maxMessages >= 1)) errors.push(`policy.maxMessages must be ≥ 1 (got ${policy.maxMessages})`);
    if (policy.maxMessages > 100) warnings.push(`policy.maxMessages ${policy.maxMessages} is high — invites siege behavior`);
  }

  return { ok: errors.length === 0, errors, warnings };
}

const round2 = (x: number) => Math.round((x + Number.EPSILON) * 100) / 100;
