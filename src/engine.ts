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
 * NOTE on concession sizing (gap-anchored): each round Vini negotiates TOWARD the
 * buyer's credible offer — `pullToward` moves a fraction of the gap, where the
 * fraction = pull_weight(move) × room_factor(price), capped at MAX_PULL_FRACTION.
 * So the buyer's number matters (responsive), wide room near list gives a real
 * leap, and the floor/endpoints are never moved. Insulting anchors are refused,
 * never chased (see `isInsultingOffer`).
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
  /**
   * A new, lower ask. `isFinal` marks the last offer before the door closes.
   * `agreed` marks a handshake: the engine came DOWN to meet the user's own
   * reasoned offer, so the price is settled but the deal isn't closed yet — the
   * conversation continues and the user confirms to seal it (then it accepts).
   */
  | { type: "counter"; amount: number; isFinal: boolean; agreed?: boolean }
  /** Repeat the standing ask (user asked a question / stalled — no number given). */
  | { type: "hold"; amount: number }
  /**
   * Engine ends it — DEAL EXPIRY only (the timer). Rounds pace the haggle but
   * never trigger a walk: a stubborn lowballer is met with a hold, not a quit, so
   * Vini keeps rapport and stands on his number. Abuse-walks ("rude / verbal
   * attack") are decided upstream in the pipeline, not here.
   */
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
 * Pull weights — how hard each move pulls Vini's counter TOWARD the buyer's
 * credible offer (the gap-anchored model). Spread WIDE for variance: a flat
 * lowball barely tugs, a commitment / credible walk yanks most of the gap. The
 * product `pull_weight × room_factor` is the per-round fraction of the gap closed,
 * capped at MAX_PULL_FRACTION (no instant capitulation). Reuses the reasoning
 * tiers as the source; feel knobs, tune by ear.
 *   none — bare lowball / persistence / flattery (barely tugs)
 *   weak — budget plea / flinch / a vague shoutout
 *   moderate — competitor price / loyalty / a real referral
 *   strong — commitment / credible walk / bulk-team
 */
export const PULL_WEIGHT_BY_TIER: Record<Reasoning, number> = {
  none: 0.2,
  weak: 0.35,
  moderate: 0.55,
  strong: 0.8,
};

/**
 * The hardest single-round pull, as a fraction of the gap to the buyer's offer.
 * Caps the leap so haggling stays multi-round — Vini never capitulates to a
 * buyer's number in one move, however strong the case. Feel knob.
 */
export const MAX_PULL_FRACTION = 0.6;

/**
 * A lifted pull for a deal-maker that grades into a LOW tier — e.g. a bare
 * credible walk-away ("I'm out") that extracts none/weak but should still move
 * Vini hard. The pipeline opts in via `special`; it pulls at strong-level.
 */
export const SPECIAL_PULL_WEIGHT = PULL_WEIGHT_BY_TIER.strong;

/**
 * Insulting-anchor guard: an offer below `LOWBALL_THRESHOLD × currentAsk` (or
 * below the floor) is not a real number — it's an insult. Vini refuses it (token
 * give + roast), never chases it with a proportional move. Feel knob.
 */
export const LOWBALL_THRESHOLD = 0.3;

/**
 * Concession-curve feel knobs — NOT engine endpoints (list/target/floor and the
 * floor invariant are untouched by these). They shape `roomFactor`, which scales
 * every give as the price descends the list > target > floor ladder. All four are
 * meant to be tuned by ear from live red-teaming.
 */
export const CURVE = {
  /** Shape of the gentle upper ramp (list → target). Higher = stays generous longer up top. */
  kHigh: 1.3,
  /** Shape of the steep lower grind (target → floor). MUST be > kHigh: a brutal
   *  acceleration toward the floor where only heavy stacked moves still move Vini. */
  kLow: 2.5,
  /** room_factor exactly AT target — the continuous handoff between the two regimes. */
  targetBand: 0.55,
  /** Hard minimum room_factor so even late moves still do *something*. */
  roomFloorMin: 0.2,
};

/**
 * Piecewise concession "room" at a given price. Continuous in VALUE at `target`
 * (both regimes meet at `targetBand`, no jump) but with a steeper SLOPE below it
 * — the gear-change. `target` is the inflection point, not a wall; `floor` is the
 * only wall. Returns a factor in [roomFloorMin, 1.0]:
 *   - at/above list → 1.0          (full wiggle, juicy)
 *   - at target     → targetBand   (the handoff)
 *   - near floor    → roomFloorMin (brutal; only heavy moves still bite)
 * Pure & deterministic. Endpoints come straight from Config — this never moves them.
 */
export function roomFactor(price: number, c: Config): number {
  const { kHigh, kLow, targetBand, roomFloorMin } = CURVE;
  let rf: number;
  if (price >= c.targetPrice) {
    // list → target (gentle). t: 1.0 at list → 0.0 at target (clamped above list).
    const denom = Math.max(c.listPrice - c.targetPrice, 1e-9);
    const t = clamp((price - c.targetPrice) / denom, 0, 1);
    rf = targetBand + (1 - targetBand) * Math.pow(t, kHigh);
  } else {
    // target → floor (steep). t: 1.0 at target → 0.0 at floor.
    const denom = Math.max(c.targetPrice - c.floorPrice, 1e-9);
    const t = clamp((price - c.floorPrice) / denom, 0, 1);
    rf = targetBand * Math.pow(t, kLow);
  }
  return clamp(rf, roomFloorMin, 1);
}

/**
 * Whether a buyer offer is an INSULT rather than a real number — below the floor,
 * or wildly below the standing ask (< LOWBALL_THRESHOLD × currentAsk). Insulting
 * anchors are refused, never chased with a proportional move (see decide()).
 */
export function isInsultingOffer(offer: number, currentAsk: number, c: Config): boolean {
  return offer < c.floorPrice || offer < currentAsk * LOWBALL_THRESHOLD;
}

/**
 * Gap-anchored concession: pull Vini's price a fraction of the way TOWARD a
 * CREDIBLE buyer offer, instead of chipping his own number. The fraction is
 *   pull = clamp(pull_weight × room_factor(current), 0, MAX_PULL_FRACTION)
 * so it's a big LEAP up near list (wide room) and a token nudge near the floor
 * (steep room), and it scales with the move's strength. Never lands below `bound`
 * (>= floor) and, since pull < 1, never below the buyer's own offer. Pure.
 */
export function pullToward(
  current: number,
  offer: number,
  pullWeight: number,
  c: Config,
  bound: number,
): number {
  const gap = current - offer;
  if (gap <= 0) return current; // offer at/above the ask — nothing to pull toward
  const pull = clamp(pullWeight * roomFactor(current, c), 0, MAX_PULL_FRACTION);
  return round2(Math.max(bound, current - gap * pull));
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
 * @param opts.endOnRoundsExhausted  when the rounds run out with no agreement,
 *        WALK instead of holding. Off by default: a cold-start haggle should never
 *        rage-quit a stubborn lowballer — Vini holds his number and keeps rapport
 *        (walking is for abuse, handled upstream). Renegotiations turn it ON so an
 *        unresolved reprice terminates into a grandfather settlement (service §6.2).
 * @param opts.special  a deal-maker that graded into a LOW tier (e.g. a bare
 *        credible walk-away) — pulls at strong strength regardless of tier.
 * @param opts.exposure  the move is an exposure/reach offer. It is priced as a
 *        TOKEN (none-tier) move and never sets the pull — reach's reward is the
 *        renderer's tone + a future loss-leader budget, NOT a price cut here.
 */
export function decide(
  s: SessionState,
  offer: number | null,
  c: Config,
  now: number,
  opts: { reasoning?: Reasoning; endOnRoundsExhausted?: boolean; special?: boolean; exposure?: boolean } = {},
): Action {
  const tier: Reasoning = opts.reasoning ?? "strong";
  const special = opts.special ?? false;
  // Split tone from price: exposure/reach drives the renderer's tone (acknowledge
  // big / deflect vague), but is priced as a TOKEN none-tier move here — it never
  // sets the pull. Real reach reward comes only from the loss-leader budget (TODO).
  const exposure = opts.exposure ?? false;
  const pricingTier: Reasoning = exposure ? "none" : tier;
  const pullWeight = special ? SPECIAL_PULL_WEIGHT : PULL_WEIGHT_BY_TIER[pricingTier];
  // The lowest this move can ultimately talk Vini to (>= floor). Below target only
  // for moderate/strong, and only reachable because room_factor is steep there.
  const rf = Math.max(c.floorPrice, reachableFloor(pricingTier, c));

  // I3: expiry is evaluated here, never trusted from the client.
  if (now - s.openedAt > c.maxDurationH * 3_600_000) return { type: "walk" };

  // No number on the table. A reasoned numberless push (word of mouth, no price)
  // earns a token pull toward the tier's floor; a bare stall/question just holds.
  if (offer === null) {
    if (opts.reasoning && opts.reasoning !== "none") {
      const amount = pullToward(s.currentAsk, rf, pullWeight, c, rf);
      if (amount < s.currentAsk - 0.01) return { type: "counter", amount, isFinal: false };
    }
    return { type: "hold", amount: s.currentAsk };
  }

  const u = Math.max(offer, 0); // a negative "offer" is meaningless; treat as 0.

  // --- Acceptance (I1: never accept below the floor) -----------------------
  // Close ONLY when the offer is within acceptThreshold of our CURRENT ask.
  if (u >= c.floorPrice && u >= c.acceptThreshold * s.currentAsk) {
    return accept(Math.min(u, s.currentAsk), c);
  }

  // --- Insulting-anchor defense -------------------------------------------
  // An offer below the floor, or wildly below the standing ask, is not a real
  // number — it's an insult. Refuse it: near-zero give (hold), never a move TOWARD
  // it. Repeated insults stay refused (the firmer tone is the renderer's, off the
  // visible history) — Vini doesn't chase lowballs, and doesn't soften on repeat.
  if (isInsultingOffer(u, s.currentAsk, c)) {
    return { type: "hold", amount: s.currentAsk };
  }

  // --- Gap-anchored concession: negotiate TOWARD the credible offer --------
  // Already as low as this move can unlock → hold for a better case (above floor
  // only; strong's rf is the floor, so it falls through to the endgame).
  if (rf > c.floorPrice && s.currentAsk <= rf + 0.01) {
    if (opts.endOnRoundsExhausted && s.round >= c.maxRounds - 1) return { type: "walk" };
    return { type: "hold", amount: s.currentAsk };
  }

  // Final round: one more pull toward the buyer, marked final.
  if (s.round >= c.maxRounds - 1) {
    const finalAsk = pullToward(s.currentAsk, u, pullWeight, c, rf);
    if (u >= finalAsk) return accept(Math.max(u, c.floorPrice), c);
    if (s.round >= c.maxRounds)
      return opts.endOnRoundsExhausted ? { type: "walk" } : { type: "hold", amount: s.currentAsk };
    return { type: "counter", amount: finalAsk, isFinal: true };
  }

  // Ordinary counter: LEAP a room-scaled fraction of the gap toward the buyer.
  // Wide room near list → a big satisfying jump; steep room near floor → a nudge.
  // The buyer's number genuinely matters (a higher offer is met closer), the leap
  // is capped at MAX_PULL_FRACTION (no one-round capitulation), and it never lands
  // below `rf` (>= floor) nor below the buyer's own offer (pull < 1).
  const amount = pullToward(s.currentAsk, u, pullWeight, c, rf);
  if (amount < s.currentAsk - 0.01) {
    // Converged near their number → a conversational handshake (agree, await yes).
    const agreed = amount - u <= Math.max(0.5, 0.04 * u);
    return agreed
      ? { type: "counter", amount, isFinal: false, agreed: true }
      : { type: "counter", amount, isFinal: false };
  }
  return { type: "hold", amount: s.currentAsk };
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
