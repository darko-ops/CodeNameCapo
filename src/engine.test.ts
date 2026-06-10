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

  it("accepts immediately when the user clears the target", () => {
    const s = openSession(CFG, 0);
    const a = decide(s, 25, CFG, 0); // 25 >= target 22
    expect(a).toEqual({ type: "accept", amount: 25 });
  });

  it("counters a lowball with a smaller-than-anchor, floor-respecting ask", () => {
    const s = openSession(CFG, 0);
    const a = decide(s, 5, CFG, 0); // way below floor
    expect(a.type).toBe("counter");
    if (a.type === "counter") {
      expect(a.amount).toBeLessThan(s.currentAsk);
      expect(a.amount).toBeGreaterThanOrEqual(CFG.floorPrice);
      expect(a.isFinal).toBe(false);
    }
  });

  it("holds (repeats the ask) when the user gives no number", () => {
    const s = openSession(CFG, 0);
    expect(decide(s, null, CFG, 0)).toEqual({ type: "hold", amount: 48 });
  });

  it("walks once the deal has expired", () => {
    const s = openSession(CFG, 0);
    const past = CFG.maxDurationH * 3_600_000 + 1;
    expect(decide(s, 25, CFG, past)).toEqual({ type: "walk" });
  });

  it("a stubborn lowballer is driven toward (never below) the floor, then walked", () => {
    let s = openSession(CFG, 0);
    let last: Action | null = null;
    for (let i = 0; i < 20; i++) {
      const a = decide(s, 1, CFG, 0); // always offers $1
      last = a;
      if (a.type === "accept" || a.type === "walk") break;
      const prev = s.currentAsk;
      s = applyAction(s, 1, a);
      expect(s.currentAsk).toBeLessThanOrEqual(prev + EPS); // monotone
      expect(s.currentAsk).toBeGreaterThanOrEqual(CFG.floorPrice - EPS); // floor
    }
    // Never accepts a $1 offer; ends in a final counter or a walk, never below floor.
    expect(last?.type === "counter" || last?.type === "walk").toBe(true);
    if (last?.type === "counter") expect(last.amount).toBeGreaterThanOrEqual(CFG.floorPrice);
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
            // ordinary (non-final) counters concede at least minConcession,
            // unless they've bottomed out at the floor.
            if (a.type === "counter" && !a.isFinal) {
              const concededEnough = s.currentAsk <= prevAsk - c.minConcession + EPS;
              const atFloor = Math.abs(s.currentAsk - c.floorPrice) < 1e-6;
              expect(concededEnough || atFloor).toBe(true);
            }
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
  it("at or past maxRounds the action is accept | final-counter | walk", () => {
    fc.assert(
      fc.property(liveScenarioArb, ({ c, s, offer, now }) => {
        if (s.round < c.maxRounds - 1) return; // only the final-round regime
        if (offer === null) return; // a null offer holds in any round, by design
        const a = decide(s, offer, c, now);
        expect(["accept", "counter", "walk"]).toContain(a.type);
        if (a.type === "counter") expect(a.isFinal).toBe(true);
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
  it("clearing the target (within the window) always closes the deal at the offer", () => {
    fc.assert(
      fc.property(liveScenarioArb, ({ c, s, now }) => {
        const offer = c.targetPrice; // exactly the target
        const a = decide(s, offer, c, now);
        expect(a).toEqual({ type: "accept", amount: round2(offer) });
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
