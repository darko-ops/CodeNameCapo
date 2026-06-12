import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  type Config,
  type SessionState,
  type Action,
  decide,
  applyAction,
  openSession,
  curveAsk,
  anchor,
  round2,
} from "./engine.js";

const EPS = 1e-9;

// ---------------------------------------------------------------------------
// A concrete, readable config + scripted walkthrough (human sanity check)
// ---------------------------------------------------------------------------

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

describe("scripted negotiation (sanity)", () => {
  it("opens at the anchor", () => {
    const s = openSession(CFG, 0);
    expect(s.currentAsk).toBe(anchor(CFG));
    expect(s.currentAsk).toBe(48);
    expect(s.round).toBe(0);
  });

  it("accepts when the user meets the standing ask (within threshold)", () => {
    const s = openSession(CFG, 0); // ask 48, acceptThreshold 0.97 → 46.56
    const a = decide(s, 47, CFG, 0);
    expect(a).toEqual({ type: "accept", amount: 47 });
  });

  it("does NOT accept an above-target offer that's still well below the ask", () => {
    const s = openSession(CFG, 0); // ask 48, target 22
    const a = decide(s, 30, CFG, 0); // 30 > target but << 0.97*48 → haggle up, not accept
    expect(a.type).not.toBe("accept");
  });

  it("refuses an insulting lowball (holds), but counters a credible offer toward it", () => {
    const s = openSession(CFG, 0); // ask 48
    // $5 is an insult (below floor AND << 0.3×48): refused, not chased.
    expect(decide(s, 5, CFG, 0)).toEqual({ type: "hold", amount: 48 });
    // A credible $30 offer pulls Vini's counter TOWARD it, above floor, above the offer.
    const a = decide(s, 30, CFG, 0);
    expect(a.type).toBe("counter");
    if (a.type === "counter") {
      expect(a.amount).toBeLessThan(s.currentAsk); // moved off the anchor
      expect(a.amount).toBeGreaterThan(30); // never below the buyer's own offer
      expect(a.amount).toBeGreaterThanOrEqual(CFG.floorPrice);
      expect(a.isFinal).toBe(false);
    }
  });

  it("holds (repeats the ask) when the user gives no number", () => {
    const s = openSession(CFG, 0);
    expect(decide(s, null, CFG, 0)).toEqual({ type: "hold", amount: 48 });
  });

  it("reasoning 'none': a credible push is met toward the offer, monotone, never below target", () => {
    let s = openSession(CFG, 0); // ask 48

    // A credible $24 offer pulls Vini down a bit — but `none` lands above the
    // offer and can never be talked past the target.
    const first = decide(s, 24, CFG, 0, { reasoning: "none" });
    expect(first.type).toBe("counter");
    if (first.type === "counter") {
      expect(first.amount).toBeLessThan(s.currentAsk); // it moved
      expect(first.amount).toBeGreaterThan(24); // never below the buyer's offer
      expect(first.amount).toBeGreaterThanOrEqual(CFG.targetPrice - 1e-9);
    }

    // Keep offering a credible (descending) number: monotone, never below target.
    for (let i = 0; i < 30; i++) {
      const offer = round2(Math.max(CFG.targetPrice, s.currentAsk * 0.6));
      const act = decide(s, offer, CFG, 0, { reasoning: "none" });
      if (act.type === "accept" || act.type === "walk") break;
      const prev = s.currentAsk;
      s = applyAction(s, offer, act);
      expect(s.currentAsk).toBeLessThanOrEqual(prev + 1e-9); // monotone
      expect(s.currentAsk).toBeGreaterThanOrEqual(CFG.targetPrice - 1e-9); // never below target
    }
  });

  it("accepts a genuinely good offer regardless of reasoning tier", () => {
    const s = openSession(CFG, 0);
    expect(decide(s, 47, CFG, 0, { reasoning: "none" })).toEqual({ type: "accept", amount: 47 });
  });

  it("a stronger move pulls the counter CLOSER to the buyer's number (gap-anchored)", () => {
    const s: SessionState = { round: 0, currentAsk: 30, openedAt: 0, history: [] };
    const offer = 20; // credible (>= 0.3×30 and >= floor)
    const counterFor = (tier: "none" | "weak" | "moderate" | "strong") => {
      const a = decide(s, offer, CFG, 0, { reasoning: tier });
      expect(a.type, tier).toBe("counter");
      return a.type === "counter" ? a.amount : NaN;
    };
    const none = counterFor("none");
    const weak = counterFor("weak");
    const moderate = counterFor("moderate");
    const strong = counterFor("strong");
    expect(none).toBeGreaterThan(weak); // a stronger move pulls harder...
    expect(weak).toBeGreaterThan(moderate);
    expect(moderate).toBeGreaterThan(strong); // ...landing closer to the buyer's number
    expect(strong).toBeGreaterThan(offer); // but never below their own offer
    expect(strong).toBeGreaterThanOrEqual(CFG.floorPrice);
  });

  it("a reason with NO number still moves the price (word of mouth)", () => {
    const s = openSession(CFG, 0);
    const a = decide(s, null, CFG, 0, { reasoning: "strong" }); // 'i'll refer my whole club'
    expect(a.type).toBe("counter");
    if (a.type === "counter") expect(a.amount).toBeLessThan(s.currentAsk);
    // a numberless turn with no reasoning still just holds
    expect(decide(s, null, CFG, 0).type).toBe("hold");
    expect(decide(s, null, CFG, 0, { reasoning: "none" }).type).toBe("hold");
  });

  it("negotiates TOWARD a credible offer — lands above it, below the ask (never undercuts)", () => {
    const s: SessionState = { round: 4, currentAsk: 44, openedAt: 0, history: [] };
    const a = decide(s, 40, CFG, 0, { reasoning: "moderate" });
    expect(a.type).toBe("counter");
    if (a.type === "counter") {
      expect(a.amount).toBeGreaterThan(40); // never below the buyer's own offer
      expect(a.amount).toBeLessThan(44); // but moved toward them off the ask
      expect(a.isFinal).toBe(false);
    }
  });

  it("a near-met credible offer converges to a conversational handshake (agreed)", () => {
    const s: SessionState = { round: 3, currentAsk: 44, openedAt: 0, history: [] };
    const a = decide(s, 42, CFG, 0, { reasoning: "moderate" }); // small gap, below acceptThreshold
    expect(a.type).toBe("counter");
    if (a.type === "counter") {
      expect(a.amount).toBeGreaterThanOrEqual(42); // never below their offer
      expect(a.amount).toBeLessThan(44);
      expect(a.agreed).toBe(true); // basically there → handshake, not a fresh haggle
    }
  });

  it("confirming the agreed price (offer == current ask) then closes the deal", () => {
    // After the handshake the ask is the user's number; restating/meeting it
    // closes via the acceptThreshold rule.
    const s: SessionState = { round: 5, currentAsk: 40, openedAt: 0, history: [] };
    const a = decide(s, 40, CFG, 0, { reasoning: "moderate" });
    expect(a).toEqual({ type: "accept", amount: 40 });
  });

  it("a reasoned counter never asks for less than the user already offered", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 5 }),
        fc.integer({ min: 800, max: 4700 }).map((x) => x / 100), // ask 8..47
        fc.integer({ min: 800, max: 4700 }).map((x) => x / 100), // offer 8..47
        fc.constantFrom("weak", "moderate", "strong"),
        (round, ask, offer, tier) => {
          const s: SessionState = {
            round,
            currentAsk: Math.max(ask, CFG.floorPrice),
            openedAt: 0,
            history: [],
          };
          const a = decide(s, offer, CFG, 0, { reasoning: tier as any });
          if (a.type === "counter") expect(a.amount).toBeGreaterThanOrEqual(offer - EPS);
        },
      ),
    );
  });

  it("walks once the deal has expired", () => {
    const s = openSession(CFG, 0);
    const past = CFG.maxDurationH * 3_600_000 + 1;
    expect(decide(s, 25, CFG, past)).toEqual({ type: "walk" });
  });

  it("a stubborn lowballer gets shrinking gives and is HELD — never walked, never below floor", () => {
    let s = openSession(CFG, 0);
    let last: Action | null = null;
    let walked = false;
    for (let i = 0; i < 30; i++) {
      const a = decide(s, 1, CFG, 0); // always offers $1, well within the deal window
      last = a;
      if (a.type === "walk") { walked = true; break; }
      if (a.type === "accept") break;
      const prev = s.currentAsk;
      s = applyAction(s, 1, a);
      expect(s.currentAsk).toBeLessThanOrEqual(prev + EPS); // monotone
      expect(s.currentAsk).toBeGreaterThanOrEqual(CFG.floorPrice - EPS); // floor sacred
    }
    // Persistence/lowballing must NEVER make Vini walk — he stands on his number.
    expect(walked).toBe(false);
    expect(last?.type === "hold" || last?.type === "counter").toBe(true);
    // Never accepts a $1 offer, and never breaches the floor (the only hard wall).
    expect(s.currentAsk).toBeGreaterThanOrEqual(CFG.floorPrice - EPS);
  });
});

// ---------------------------------------------------------------------------
// Arbitraries — generate well-formed configs and scenarios from integer cents
// ---------------------------------------------------------------------------

const configArb: fc.Arbitrary<Config> = fc
  .record({
    floorCents: fc.integer({ min: 100, max: 2000 }),
    targetExtraCents: fc.integer({ min: 100, max: 6000 }),
    listExtraCents: fc.integer({ min: 0, max: 5000 }),
    anchorMultiplierX10: fc.integer({ min: 15, max: 100 }),
    maxRounds: fc.integer({ min: 2, max: 10 }),
    maxDurationH: fc.integer({ min: 1, max: 168 }),
    acceptThresholdX100: fc.integer({ min: 90, max: 99 }),
    minConcessionCents: fc.integer({ min: 25, max: 200 }),
    lambdaX100: fc.integer({ min: 20, max: 150 }),
  })
  .map((r) => {
    const floorPrice = r.floorCents / 100;
    const targetPrice = round2(floorPrice + r.targetExtraCents / 100);
    const listPrice = round2(targetPrice + r.listExtraCents / 100);
    return {
      listPrice,
      floorPrice,
      targetPrice,
      anchorMultiplier: r.anchorMultiplierX10 / 10,
      maxRounds: r.maxRounds,
      maxDurationH: r.maxDurationH,
      acceptThreshold: r.acceptThresholdX100 / 100,
      minConcession: r.minConcessionCents / 100,
      lambda: r.lambdaX100 / 100,
    } satisfies Config;
  });

/** An offer in cents -> dollars, $0..$300, plus an explicit "no number" case. */
const offerArb: fc.Arbitrary<number | null> = fc.oneof(
  fc.constant<number | null>(null),
  fc.integer({ min: 0, max: 30000 }).map((c) => c / 100),
);

/** A possibly-arbitrary (not-necessarily-engine-produced) but well-formed state. */
function stateArb(c: Config): fc.Arbitrary<SessionState> {
  const aCents = Math.round(anchor(c) * 100);
  const fCents = Math.round(c.floorPrice * 100);
  return fc
    .record({
      round: fc.integer({ min: 0, max: c.maxRounds + 1 }),
      askCents: fc.integer({ min: fCents, max: aCents }),
    })
    .map((r) => ({
      round: r.round,
      currentAsk: r.askCents / 100,
      openedAt: 0,
      history: [],
    }));
}

interface Scenario {
  c: Config;
  s: SessionState;
  offer: number | null;
  now: number;
}

/** A scenario with `now` strictly within the deal window (no auto-expiry). */
const liveScenarioArb: fc.Arbitrary<Scenario> = configArb.chain((c) =>
  fc.record({
    c: fc.constant(c),
    s: stateArb(c),
    offer: offerArb,
    now: fc.integer({ min: 0, max: c.maxDurationH * 3_600_000 }),
  }),
);

const RUNS = 2000;

// ---------------------------------------------------------------------------
// Invariant I1 — an accepted (or countered) price is never below the floor
// ---------------------------------------------------------------------------

describe("I1: price never below floor", () => {
  it("decide() never accepts or counters below floorPrice", () => {
    fc.assert(
      fc.property(liveScenarioArb, ({ c, s, offer, now }) => {
        const a = decide(s, offer, c, now);
        if (a.type === "accept" || a.type === "counter") {
          expect(a.amount).toBeGreaterThanOrEqual(c.floorPrice - EPS);
        }
      }),
      { numRuns: RUNS },
    );
  });

  it("an offer below the floor is never accepted", () => {
    fc.assert(
      fc.property(liveScenarioArb, ({ c, s, now }) => {
        // craft an offer strictly below the floor
        const offer = Math.max(0, c.floorPrice - 0.01);
        const a = decide(s, offer, c, now);
        if (offer < c.floorPrice) expect(a.type).not.toBe("accept");
      }),
      { numRuns: RUNS },
    );
  });

  it("we never accept MORE than the user offered", () => {
    fc.assert(
      fc.property(liveScenarioArb, ({ c, s, offer, now }) => {
        const a = decide(s, offer, c, now);
        if (a.type === "accept" && offer !== null) {
          expect(a.amount).toBeLessThanOrEqual(round2(Math.max(offer, 0)) + EPS);
        }
      }),
      { numRuns: RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Invariant I2 — the engine's ask is monotonically non-increasing
// ---------------------------------------------------------------------------

describe("I2: ask is monotone non-increasing across a negotiation", () => {
  it("curveAsk decreases with round and stays above target", () => {
    fc.assert(
      fc.property(configArb, fc.integer({ min: 0, max: 50 }), (c, n) => {
        expect(curveAsk(n + 1, c)).toBeLessThanOrEqual(curveAsk(n, c) + EPS);
        expect(curveAsk(n, c)).toBeGreaterThanOrEqual(c.targetPrice - EPS);
        expect(curveAsk(n, c)).toBeLessThanOrEqual(anchor(c) + EPS);
      }),
      { numRuns: RUNS },
    );
  });

  it("a full simulated negotiation never raises the standing ask, never breaches floor", () => {
    fc.assert(
      fc.property(
        configArb,
        fc.array(offerArb, { minLength: 1, maxLength: 30 }),
        (c, offers) => {
          let s = openSession(c, 0);
          for (const offer of offers) {
            const a = decide(s, offer, c, 0);
            if (a.type === "accept") {
              expect(a.amount).toBeGreaterThanOrEqual(c.floorPrice - EPS);
              break;
            }
            if (a.type === "walk") break;
            const prevAsk = s.currentAsk;
            s = applyAction(s, offer, a);
            // monotone non-increasing
            expect(s.currentAsk).toBeLessThanOrEqual(prevAsk + EPS);
            // floor respected at all times
            expect(s.currentAsk).toBeGreaterThanOrEqual(c.floorPrice - EPS);
            // The concession is room_factor-scaled, so near the floor it can be a
            // sub-minConcession nudge BY DESIGN (the steep grind). The invariant is
            // only that an ordinary counter never RAISES the ask (monotone, above).
          }
        },
      ),
      { numRuns: RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Invariant I3 — rounds & timer are server-authoritative and bounded
// ---------------------------------------------------------------------------

describe("I3: round/timer enforcement", () => {
  it("at or past maxRounds the engine stands firm: accept | final-counter | hold (rounds never walk)", () => {
    fc.assert(
      fc.property(liveScenarioArb, ({ c, s, offer, now }) => {
        if (s.round < c.maxRounds - 1) return; // only the final-round regime
        if (offer === null) return; // a null offer holds in any round, by design
        const a = decide(s, offer, c, now);
        // Within the deal window the engine never walks on rounds — it holds on
        // its final number instead. (Walks are abuse-driven, plus expiry below.)
        expect(["accept", "counter", "hold"]).toContain(a.type);
        if (a.type === "counter") expect(a.isFinal).toBe(true);
      }),
      { numRuns: RUNS },
    );
  });

  it("within the deal window, decide() never walks (walks are abuse-only + expiry)", () => {
    fc.assert(
      fc.property(liveScenarioArb, ({ c, s, offer, now }) => {
        // liveScenarioArb keeps `now` inside the window, so no expiry walk either.
        expect(decide(s, offer, c, now).type).not.toBe("walk");
      }),
      { numRuns: RUNS },
    );
  });

  it("past expiry, the engine always walks regardless of offer", () => {
    fc.assert(
      fc.property(configArb, stateArbFor(), offerArb, (c, mkState, offer) => {
        const s = mkState(c);
        const expired = s.openedAt + c.maxDurationH * 3_600_000 + 1;
        expect(decide(s, offer, c, expired)).toEqual({ type: "walk" });
      }),
      { numRuns: RUNS },
    );
  });
});

// helper to thread config into stateArb inside a multi-arg property
function stateArbFor(): fc.Arbitrary<(c: Config) => SessionState> {
  return fc
    .record({ round: fc.integer({ min: 0, max: 12 }), askFrac: fc.double({ min: 0, max: 1, noNaN: true }) })
    .map((r) => (c: Config) => ({
      round: r.round,
      currentAsk: round2(c.floorPrice + r.askFrac * (anchor(c) - c.floorPrice)),
      openedAt: 0,
      history: [],
    }));
}

// ---------------------------------------------------------------------------
// Invariant I4 — determinism
// ---------------------------------------------------------------------------

describe("I4: determinism", () => {
  it("same (state, offer, config, now) yields the same action", () => {
    fc.assert(
      fc.property(liveScenarioArb, ({ c, s, offer, now }) => {
        const a1 = decide(structuredClone(s), offer, structuredClone(c), now);
        const a2 = decide(structuredClone(s), offer, structuredClone(c), now);
        expect(a1).toEqual(a2);
      }),
      { numRuns: RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Acceptance semantics
// ---------------------------------------------------------------------------

describe("acceptance semantics", () => {
  it("before the final round, an offer below acceptThreshold × ask is haggled, not pocketed", () => {
    fc.assert(
      fc.property(liveScenarioArb, ({ c, s, now }) => {
        if (s.round >= c.maxRounds - 1) return; // final round can close at its lower final ask
        // A cent under the threshold — must NOT close (the old 'clear the target'
        // shortcut is gone; you have to meet the standing ask).
        const offer = round2(c.acceptThreshold * s.currentAsk - 0.01);
        if (offer < c.floorPrice) return; // floor cases handled elsewhere
        const a = decide(s, offer, c, now);
        expect(a.type).not.toBe("accept");
      }),
      { numRuns: RUNS },
    );
  });

  it("meeting the ask within acceptThreshold closes the deal (when above floor)", () => {
    fc.assert(
      fc.property(liveScenarioArb, ({ c, s, now }) => {
        // Add a 2-cent buffer so the offer is provably >= threshold * ask.
        // (Neither ceil nor round reliably clears the float error in the product
        // threshold*ask itself; a fixed buffer dominates it.)
        const offer = round2(c.acceptThreshold * s.currentAsk + 0.02);
        if (offer < c.floorPrice) return; // floor guard owns this case (tested in I1)
        const a = decide(s, offer, c, now);
        expect(a.type).toBe("accept");
      }),
      { numRuns: RUNS },
    );
  });

  it("a null offer within the window always holds the standing ask", () => {
    fc.assert(
      fc.property(liveScenarioArb, ({ c, s, now }) => {
        expect(decide(s, null, c, now)).toEqual({ type: "hold", amount: s.currentAsk });
      }),
      { numRuns: RUNS },
    );
  });
});
