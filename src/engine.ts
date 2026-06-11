/**
 * Bouncr Policy Engine — deterministic pricing core (Spec §4, Appendix A).
 *
 * Pure functions, ZERO dependencies. The LLM and the numbers never touch:
 * the conversation layer extracts a user's offer into a number, this engine
 * decides accept / counter / hold / walk, and the only price that ever reaches
 * Stripe is the amount in an `accept` Action.
 *
 * The load-bearing guarantees (Spec §4.4), enforced here and proven in tests:
 *   I1.  An accepted price is ALWAYS >= floorPrice. No exception path exists.
 *   I2.  The engine's ask is monotonically non-increasing across a cold-start
 *        negotiation (it never raises its ask mid-haggle).
 *   I3.  Rounds and the expiry timer are evaluated here (server-authoritative),
 *        never trusted from the client.
 *   I4.  decide() is a pure function of (state, offer, config, now) — fully
 *        deterministic and replayable. Same inputs → same Action.
 *
 * NOTE on the Appendix A sketch: this implementation fixes the concession-step
 * direction. To guarantee "never concede less than minConcession" the next ask
 * must drop by AT LEAST minConcession, i.e. `min(curve, currentAsk - minConcession)`,
 * not the `Math.max(...)` shown in the sketch. See `nextCurveAsk`.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Config {
  /** Public anchor reference (the "list" price shown on a normal pricing page). */
  listPrice: number;
  /** Absolute minimum. Never breached, on any path. */
  floorPrice: number;
  /** Where the curve aims. The engine optimizes toward this, not the floor. */
  targetPrice: number;
  /** Opening ask = listPrice * anchorMultiplier (Poke opened ~3–10x). */
  anchorMultiplier: number;
  /** Hard cap on negotiation rounds. */
  maxRounds: number;
  /** Deal expires after this many hours (urgency + anti-siege). */
  maxDurationH: number;
  /** Auto-accept if the user's offer >= acceptThreshold * currentAsk. e.g. 0.97 */
  acceptThreshold: number;
  /** Never concede less than this per round (a tiny concession reads as insulting). */
  minConcession: number;
  /** Decay rate of the concession curve. Larger => reaches target faster. */
  lambda: number;
}

export interface HistoryEntry {
  round: number;
  userOffer: number | null;
  ask: number;
}

export interface SessionState {
  /** 0-indexed round. Round 0 is the opening anchor. */
  round: number;
  /** The ask currently on the table (what the engine last asked for). */
  currentAsk: number;
  /** Epoch millis when the negotiation opened. */
  openedAt: number;
  history: HistoryEntry[];
}

export type Action =
  | { type: "accept"; amount: number }
  /** A new, lower ask. `isFinal` marks the last offer before the door closes. */
  | { type: "counter"; amount: number; isFinal: boolean }
  /** Repeat the standing ask (user asked a question / stalled — no number given). */
  | { type: "hold"; amount: number }
  /** Engine ends it (expiry, or rounds exhausted with no agreement). */
  | { type: "walk" };

// ---------------------------------------------------------------------------
// Small deterministic helpers
// ---------------------------------------------------------------------------

/** Round to cents. The only rounding in the engine; everything is in cents-precise dollars. */
export const round2 = (x: number): number => Math.round((x + Number.EPSILON) * 100) / 100;

/** Clamp into [lo, hi]. If lo > hi (degenerate band), returns lo. */
export const clamp = (x: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, x));

/** Opening ask before any decay. */
export const anchor = (c: Config): number => round2(c.listPrice * c.anchorMultiplier);

/**
 * The engine's ask at a given round, decaying from anchor toward target.
 *   ask(n) = target + (anchor - target) * e^(-lambda * n)
 * Strictly decreasing in n, asymptotically approaching (but never reaching) target,
 * so the natural curve never crosses below target — the floor is reached only via
 * the offer-responsive counters / final-round logic, not the curve itself.
 */
export const curveAsk = (round: number, c: Config): number =>
  round2(c.targetPrice + (anchor(c) - c.targetPrice) * Math.exp(-c.lambda * round));

/** Fresh session state for a new cold-start negotiation. */
export function openSession(c: Config, now: number): SessionState {
  const ask = curveAsk(0, c); // == anchor
  return { round: 0, currentAsk: ask, openedAt: now, history: [] };
}

/**
 * The next ask along the curve, but stepped down by at least minConcession and
 * never below the target (the target is the curve's destination; we only go
 * below it via offer-responsive counters, see decide()).
 */
function nextCurveAsk(s: SessionState, c: Config): number {
  const natural = curveAsk(s.round + 1, c);
  const minStepped = s.currentAsk - Math.max(c.minConcession, 0);
  // Drop by at least minConcession; clamp to the target so the *curve* never
  // overshoots its destination.
  return round2(Math.max(c.targetPrice, Math.min(natural, minStepped)));
}

// ---------------------------------------------------------------------------
// The decision function (Spec §4.3, Appendix A)
// ---------------------------------------------------------------------------

/**
 * Reasoning tiers — how strong a case the user made for a discount THIS turn.
 * Stronger reasoning unlocks a lower price (see `reachableFloor`). The conversation
 * layer (Extractor) classifies into these; the engine never reads free text.
 */
export type Reasoning = "none" | "weak" | "moderate" | "strong";

/**
 * The lowest price a given reasoning tier can talk the engine down to. Always
 * >= floorPrice (I1). "none" never gets below the soft floor (handled inline);
 * weak ≈ target, moderate ≈ halfway to floor, strong ≈ the real floor.
 */
export function reachableFloor(tier: Reasoning, c: Config): number {
  switch (tier) {
    case "strong":
      return c.floorPrice;
    case "moderate":
      return round2((c.targetPrice + c.floorPrice) / 2);
    case "weak":
      return c.targetPrice;
    case "none":
    default:
      return c.targetPrice;
  }
}

/**
 * Decide the engine's action for one turn. Pure & deterministic.
 *
 * @param s     current session state (server-authoritative)
 * @param offer the user's proposed monthly price, or null if they gave no number
 * @param c     merchant config (versioned upstream)
 * @param now   epoch millis, for expiry evaluation
 * @param opts.reasoning  how strong the user's case was this turn (Extractor-rated).
 *        Defaults to "strong" (full concession to the hard floor) so existing
 *        callers/tests are unchanged. Lower tiers unlock less of a discount, so the
 *        price can't be walked to the floor without genuinely good reasoning.
 */
export function decide(
  s: SessionState,
  offer: number | null,
  c: Config,
  now: number,
  opts: { reasoning?: Reasoning } = {},
): Action {
  const tier: Reasoning = opts.reasoning ?? "strong";

  // I3: expiry is evaluated here, never trusted from the client.
  if (now - s.openedAt > c.maxDurationH * 3_600_000) return { type: "walk" };

  // No number on the table. A genuine reason (tier weak+) still earns a move
  // toward what it unlocks — word of mouth shouldn't be ignored just because they
  // didn't name a price. A question / stall (tier none, or unset) just holds.
  if (offer === null) {
    if (opts.reasoning && opts.reasoning !== "none") {
      const rf = Math.max(c.floorPrice, Math.min(reachableFloor(tier, c), s.currentAsk));
      const step = Math.max(c.minConcession, round2((s.currentAsk - rf) * 0.3));
      const amount = round2(Math.max(rf, s.currentAsk - step));
      if (amount < s.currentAsk - 0.01) return { type: "counter", amount, isFinal: false };
    }
    return { type: "hold", amount: s.currentAsk };
  }

  const u = Math.max(offer, 0); // a negative "offer" is meaningless; treat as 0.

  // --- Acceptance (I1: never accept below the floor) -----------------------
  // Close ONLY when the offer is within acceptThreshold of our CURRENT ask — i.e.
  // they genuinely met us. An offer that beats the target but still sits well
  // below our standing ask gets haggled UP (countered), not instantly pocketed.
  // (Offering at/above the ask closes at the ask, never overcharging.)
  // Acceptance is independent of reasoning: meeting the ask closes either way.
  if (u >= c.floorPrice && u >= c.acceptThreshold * s.currentAsk) {
    return accept(Math.min(u, s.currentAsk), c);
  }

  // --- No reasoning => small goodwill room, then hold ----------------------
  // The opening move is partly free: drift down a couple points to start the
  // dance. But never below a SOFT FLOOR without a case — the price can't be
  // walked down just by naming numbers. Persisting with no case runs out -> walk.
  if (tier === "none") {
    const a = anchor(c);
    const softFloor = round2(Math.max(c.targetPrice, a - (a - c.targetPrice) * 0.25));
    if (s.currentAsk > softFloor + 0.01) {
      const step = Math.max(2, c.minConcession); // "settle a couple points"
      const amount = round2(Math.max(softFloor, s.currentAsk - step));
      return { type: "counter", amount, isFinal: false };
    }
    if (s.round >= c.maxRounds) return { type: "walk" };
    return { type: "hold", amount: s.currentAsk };
  }

  // --- Justified (weak/moderate/strong): concede toward the tier's floor ----
  const rf = Math.max(c.floorPrice, reachableFloor(tier, c));
  // If the ask is already as low as this reason unlocks, hold — a better reason
  // is needed to go lower. (Only bites for weak/moderate; strong's rf is the hard
  // floor, so this is skipped there and the legacy behavior + invariants hold.)
  if (rf > c.floorPrice && s.currentAsk <= rf + 0.01) {
    if (s.round >= c.maxRounds - 1) return { type: "walk" };
    return { type: "hold", amount: s.currentAsk };
  }

  // --- Final round: take-it-or-leave-it -----------------------------------
  // I2 still holds: finalAsk <= currentAsk.
  if (s.round >= c.maxRounds - 1) {
    const finalAsk = round2(clamp(Math.max(rf, nextCurveAsk(s, c)), rf, s.currentAsk));
    if (u >= finalAsk) return accept(Math.max(u, c.floorPrice), c);
    if (s.round >= c.maxRounds) return { type: "walk" };
    return { type: "counter", amount: finalAsk, isFinal: true };
  }

  // --- Ordinary counter: split the difference, biased toward our ask -------
  // Bias 0.7 toward our side, softening slightly per round but never past the
  // true midpoint. Pure midpoint converges too fast and trains lowballing.
  // Clamped to the tier's reachable floor so reasoning quality bounds the discount.
  const ourSide = Math.min(curveAsk(s.round + 1, c), s.currentAsk);
  const bias = Math.max(0.5, 0.7 - 0.02 * s.round);
  const raw = bias * ourSide + (1 - bias) * u;
  const upper = Math.max(rf, s.currentAsk - c.minConcession);
  const amount = round2(clamp(raw, rf, upper));
  return { type: "counter", amount, isFinal: false };
}

/** Construct an accept Action with a hard floor assertion (defense in depth for I1). */
function accept(amount: number, c: Config): Action {
  const amt = round2(amount);
  // I1 is structural, but assert anyway: there is no code path that should ever
  // produce an accept below the floor. If this throws, a test caught a real bug.
  if (amt < c.floorPrice) {
    throw new Error(`INVARIANT I1 VIOLATED: accept ${amt} < floor ${c.floorPrice}`);
  }
  return { type: "accept", amount: amt };
}

// ---------------------------------------------------------------------------
// State transition (for replay / simulation / tests)
// ---------------------------------------------------------------------------

/**
 * Apply an Action to produce the next SessionState. Terminal actions
 * (accept / walk) return the state unchanged — the caller stops the loop.
 * A `counter` advances the round and lowers the standing ask; a `hold`
 * advances the round but keeps the ask (so stalls still march toward the
 * round/timer limits).
 */
export function applyAction(s: SessionState, offer: number | null, a: Action): SessionState {
  switch (a.type) {
    case "accept":
    case "walk":
      return s;
    case "hold":
      return {
        ...s,
        round: s.round + 1,
        history: [...s.history, { round: s.round, userOffer: offer, ask: s.currentAsk }],
      };
    case "counter":
      return {
        round: s.round + 1,
        currentAsk: a.amount,
        openedAt: s.openedAt,
        history: [...s.history, { round: s.round, userOffer: offer, ask: a.amount }],
      };
  }
}
