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
 * NOTE on concession sizing: each round's give is `appliedDrop` = base_band ×
 * list_price × room_factor — a piecewise list>target>floor curve (see `roomFactor`)
 * that is generous near list and grinds steeply below target. The endpoints
 * (list/target/floor) and the floor invariant are never moved by this sizing.
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
 * The give-band SCALE. A single buyer move is worth between MIN_BAND and MAX_BAND
 * of the list price, before room_factor scales it (applied_drop below). Feel knobs.
 */
export const MIN_BAND = 0.02; // 2% — even a flat lowball still nudges the number
export const MAX_BAND = 0.13; // 13% — the most a single move can ever be worth

/**
 * Special-situation bonus — added on top of the base band to lift a deal-making
 * move that landed in a LOW tier (e.g. a bare credible walk-away) up toward the
 * ceiling. Capped at MAX_BAND so it can't run away. Big audiences/commitments
 * don't need it — they already grade into the strong tier.
 */
export const SPECIAL_SITUATION_BONUS = 0.1; // +10 percentage points

/**
 * Per-move base "give band" as a PERCENT of list price. Bigger move → bigger band,
 * spread WIDE so different moves produce visibly different drops (variance is the
 * point — a flat lowball and a 50k-follower offer should not feel the same). The
 * tier is the interim source; the full give-band table plugs in at this seam.
 * Feel knob — tune by ear. Reach scales the tier (see extractor): a big audience /
 * mass referral grades up into moderate/strong, a vague shoutout stays weak.
 *   none 2% ≈ bare lowball / persistence / flattery
 *   weak 5% ≈ budget plea / flinch / a small or vague shoutout
 *   moderate 9% ≈ competitor price / loyalty / a real referral or audience
 *   strong 13% ≈ commitment/bundle / credible walk / a big, scaled audience
 */
export const BASE_BAND_BY_TIER: Record<Reasoning, number> = {
  none: 0.02,
  weak: 0.05,
  moderate: 0.09,
  strong: 0.13,
};

/**
 * The effective band for a move: base band + (special bonus), clamped to the
 * [MIN_BAND, MAX_BAND] scale. `special` marks a commitment / credible walk-away.
 */
export function bandFor(tier: Reasoning, special = false): number {
  const base = BASE_BAND_BY_TIER[tier];
  return clamp(base + (special ? SPECIAL_SITUATION_BONUS : 0), MIN_BAND, MAX_BAND);
}

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
 * The concession to hand over this round for a given move at a given price:
 *   applied_drop = band(tier, special) × full_price(list) × room_factor(price)
 * Generous near list (room ≈ 1), a token nudge near floor (room ≈ roomFloorMin),
 * and a much bigger move in a special situation (commitment / credible walk).
 * Always >= 0; the caller clamps the resulting price to never breach the floor.
 */
export function appliedDrop(
  price: number,
  tier: Reasoning,
  c: Config,
  opts: { special?: boolean } = {},
): number {
  return round2(bandFor(tier, opts.special ?? false) * c.listPrice * roomFactor(price, c));
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
 *        unresolved reprice terminates into a grandfather settlement (service §6.2)
 *        rather than hanging open forever.
 */
export function decide(
  s: SessionState,
  offer: number | null,
  c: Config,
  now: number,
  opts: { reasoning?: Reasoning; endOnRoundsExhausted?: boolean; special?: boolean } = {},
): Action {
  const tier: Reasoning = opts.reasoning ?? "strong";
  // Special situation = a deal-making move that arrives as a LOW tier but deserves
  // a top give — e.g. a bare "I'm out" credible walk-away (extracts as none/weak)
  // that should still move Vini a lot. It adds the band bonus (capped at MAX_BAND).
  // Off by default; the pipeline opts in once the give-band table detects the exact
  // move (a first credible walk vs. a repeat bluff). A big audience/commitment
  // already grades up to the strong tier (13%), so it needs no bonus.
  const special = opts.special ?? false;

  // I3: expiry is evaluated here, never trusted from the client.
  if (now - s.openedAt > c.maxDurationH * 3_600_000) return { type: "walk" };

  // No number on the table. A genuine reason (tier weak+) still earns a move
  // toward what it unlocks — word of mouth shouldn't be ignored just because they
  // didn't name a price. A question / stall (tier none, or unset) just holds.
  if (offer === null) {
    if (opts.reasoning && opts.reasoning !== "none") {
      const rf = Math.max(c.floorPrice, reachableFloor(tier, c));
      const amount = round2(Math.max(rf, s.currentAsk - appliedDrop(s.currentAsk, tier, c, { special })));
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

  // They named a price WITH genuine reasoning, and it's already at/above the
  // lowest that reasoning could ever talk us down to. Come DOWN to meet their
  // number — never haggle a user below their own offer (the curve may have
  // decayed past it; splitting against it would hand them a discount they didn't
  // ask for). This is a CONVERSATIONAL handshake, not an auto-close: the ask
  // drops to their price and the bouncer agrees on it, but the deal seals only
  // when they confirm (then `u >= currentAsk` closes via the rule above). Only
  // fires when reasoning is explicitly supplied and not "none", so bare
  // number-spitting still falls through to the no-case branch and holds.
  if (
    opts.reasoning &&
    opts.reasoning !== "none" &&
    u >= reachableFloor(tier, c) &&
    u >= c.floorPrice &&
    u < s.currentAsk // (>= currentAsk already closed via the acceptThreshold rule)
  ) {
    return { type: "counter", amount: round2(u), isFinal: false, agreed: true };
  }

  // --- Concede as part of the dance (ALL tiers, incl. "none") ---------------
  // Every genuine push earns a little give — the haggle is a ritual, not an
  // adjudication. The tier sets two things, never WHETHER Vini moves:
  //   - how FAR he can ultimately be talked: the reachable floor `rf`, and
  //   - how BIG each give is: the move's base_band, scaled by room_factor (below).
  // A bare number ("none") still walks him down toward the target; only a real
  // case (moderate/strong) unlocks the stubborn target→floor grind, and nothing
  // ever crosses `rf` (>= the hard floor — I1).
  const rf = Math.max(c.floorPrice, reachableFloor(tier, c));

  // Already as low as this tier's case unlocks → hold for a better case. Bites
  // only ABOVE the hard floor: weak/none bottom out at target, moderate at the
  // mid-band, and a stronger argument is required to go lower. strong's rf IS the
  // floor, so it falls through to the take-it-or-leave-it endgame, not a stall.
  if (rf > c.floorPrice && s.currentAsk <= rf + 0.01) {
    // Bottomed out for this tier with no better case: hold and keep haggling —
    // never walk on a haggler. A weak/no-case user just can't get below here.
    // (Reneg sessions terminate-on-exhaust into a grandfather; see opts doc.)
    if (opts.endOnRoundsExhausted && s.round >= c.maxRounds - 1) return { type: "walk" };
    return { type: "hold", amount: s.currentAsk };
  }

  // --- Final round: take-it-or-leave-it -----------------------------------
  // One more room_factor-sized give, marked final — same curve as any other round
  // (no dramatic cliff that would erase the move's weight). I2 holds: finalAsk <= currentAsk.
  if (s.round >= c.maxRounds - 1) {
    const finalAsk = round2(Math.max(rf, s.currentAsk - appliedDrop(s.currentAsk, tier, c, { special })));
    if (u >= finalAsk) return accept(Math.max(u, c.floorPrice), c);
    // Rounds pace the concession curve; they are NOT a hard exit. The first time
    // we hit the limit Vini makes his "final offer" (isFinal); after that he just
    // HOLDS on that number, round after round — standing firm but keeping the door
    // open and the rapport intact. He does not walk on a stubborn haggler. (Walks
    // are abuse-only, in the pipeline, plus deal expiry above.) Reneg sessions opt
    // into a terminal walk so an unresolved reprice grandfathers (service §6.2).
    if (s.round >= c.maxRounds)
      return opts.endOnRoundsExhausted ? { type: "walk" } : { type: "hold", amount: s.currentAsk };
    return { type: "counter", amount: finalAsk, isFinal: true };
  }

  // --- Ordinary counter: applied_drop = base_band × full_price × room_factor --
  // room_factor is the piecewise list>target>floor curve: gentle wiggle up near
  // list, a steep grind below target. So the SAME move gives a juicy drop early
  // and a token nudge near the bottom, with the resistance concentrated in the
  // target→floor zone — and the give still never crosses `rf` (>= floor, I1/I2).
  // The user's lowball number doesn't drag the counter down; persistence does.
  const amount = round2(Math.max(rf, s.currentAsk - appliedDrop(s.currentAsk, tier, c, { special })));
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
