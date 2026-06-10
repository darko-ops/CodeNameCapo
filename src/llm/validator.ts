/**
 * Validator (Spec §5.2) — MANDATORY deterministic check on rendered text.
 *
 * After the Renderer produces a reply, we verify — with code, not a model —
 * that it leaked no number other than the one the policy engine permitted, and
 * that it didn't fabricate an acceptance. This is what closes the loop on
 * hallucinated discounts: a jailbroken persona gets charm, not a lower price,
 * because any reply that states a different number fails here and is replaced.
 *
 * Pure functions, no LLM, no deps — unit-testable in isolation.
 */
import type { Action } from "../engine.js";

export interface ValidationResult {
  ok: boolean;
  reason?: string;
}

/** The single dollar amount the reply is permitted to state (null = none, e.g. walk). */
export function permittedAmount(action: Action): number | null {
  switch (action.type) {
    case "accept":
    case "counter":
    case "hold":
      return round2(action.amount);
    case "walk":
      return null;
  }
}

const round2 = (x: number) => Math.round((x + Number.EPSILON) * 100) / 100;

// A dollar-prefixed amount: $12, $ 12, $1,299.50
const DOLLAR_RE = /\$\s?(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{1,2}))?/g;
// A bare price-like number attached to a cadence: "12/mo", "15 a month", "9 bucks"
const CADENCE_RE =
  /\b(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{1,2}))?\s*(?:\/\s?mo\b|\/\s?month\b|per\s+month|a\s+month|bucks|dollars)/gi;

// Affirmative acceptance language. Only legal when action.type === "accept".
const ACCEPT_RE =
  /\b(it'?s a deal|we have a deal|done deal|you got it|you'?re in|welcome in|sold|deal['.! ]|deal$)\b/i;
// Negated acceptance ("no deal", "not a deal") should NOT count as acceptance.
const NEGATED_ACCEPT_RE = /\b(no|not|isn'?t|won'?t|can'?t|never)\s+(a\s+)?deal\b/i;

function parseAmount(intPart: string, decPart?: string): number {
  const n = Number(intPart.replace(/,/g, "") + (decPart ? "." + decPart : ""));
  return round2(n);
}

/** Every dollar/cadence amount mentioned in the text, deduped. */
export function extractMentionedAmounts(text: string): number[] {
  const found = new Set<number>();
  for (const m of text.matchAll(DOLLAR_RE)) found.add(parseAmount(m[1]!, m[2]));
  for (const m of text.matchAll(CADENCE_RE)) found.add(parseAmount(m[1]!, m[2]));
  return [...found];
}

const APPROX = 0.001;

export interface ValidateOpts {
  /**
   * Numbers the reply MAY also mention besides the permitted amount — typically
   * the user's own offer, so the persona can quote/roast it ("$30? cute — I can
   * do $37.86"). These are never charged; only the engine's permitted amount is.
   */
  allowMentions?: number[];
}

/**
 * Validate a rendered reply against the engine's decision.
 * Returns ok:false with a reason when the reply must be re-rendered or replaced.
 */
export function validate(reply: string, action: Action, opts: ValidateOpts = {}): ValidationResult {
  const permitted = permittedAmount(action);
  const allow = new Set((opts.allowMentions ?? []).map((n) => round2(Math.max(n, 0))));
  const mentioned = extractMentionedAmounts(reply);

  // (a) Every number must be either the permitted price or an explicitly-allowed
  // mention (the user's own offer). Nothing else may appear.
  for (const amt of mentioned) {
    if (permitted !== null && Math.abs(amt - permitted) <= APPROX) continue;
    if (allow.has(round2(amt))) continue;
    return permitted === null
      ? { ok: false, reason: `stated $${amt} on a ${action.type} (no price allowed)` }
      : { ok: false, reason: `stated $${amt}, permitted $${permitted}` };
  }

  // (b) The permitted price must actually be present (a reply that omits the
  // number — or only quotes the user's offer — is useless / misleading).
  if (permitted !== null && !mentioned.some((a) => Math.abs(a - permitted) <= APPROX)) {
    return { ok: false, reason: `omitted the permitted price $${permitted}` };
  }

  // (c) Acceptance language only when the engine actually accepted.
  if (action.type !== "accept") {
    const m = reply.match(ACCEPT_RE);
    if (m && !NEGATED_ACCEPT_RE.test(reply)) {
      return { ok: false, reason: `acceptance language "${m[0].trim()}" on a ${action.type}` };
    }
  }

  return { ok: true };
}
