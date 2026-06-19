/**
 * A/B lift experiment (Spec §11) — the proof-of-lift harness. Verifies the
 * revenue-PER-VISITOR math, distinct-visitor dedup, lift sign, and the honest
 * degradation when the merchant's control-arm conversion callback isn't wired.
 * Pure over MemoryStore — no keys, no network, CI-safe.
 */
import { describe, it, expect } from "vitest";
import { BouncrService } from "./service.js";
import { MemoryStore } from "./store/memory.js";
import { FakeStripeGateway } from "./stripe/fake.js";
import { makeTemplateNegotiator } from "./llm/negotiator.js";
import { computeAnalytics } from "./analytics.js";
import { demoPlan, demoMerchant } from "./config.js";
import type { NewDeal } from "./store/types.js";

function setup() {
  const plan = demoPlan();
  const store = new MemoryStore([plan], [demoMerchant()]);
  const service = new BouncrService({
    store,
    stripe: new FakeStripeGateway(),
    negotiator: makeTemplateNegotiator(),
    baseUrl: "http://localhost:8787",
    now: () => Date.now(),
  });
  return { plan, store, service };
}

// A settled treatment deal — analytics only reads status + price + sessionId.
function settledDeal(planId: string, merchantId: string, user: string, price: number): NewDeal {
  return {
    sessionId: `sess_${user}`,
    merchantId,
    planId,
    endUserRef: user,
    price,
    currency: "usd",
    status: "settled",
    kind: "initial",
    stripeCheckoutId: `cs_${user}`,
    stripeSubscriptionId: `sub_${user}`,
    renegSessionId: null,
    settledAt: Date.now(),
  };
}

describe("A/B lift experiment analytics (§11)", () => {
  it("omits the experiment block entirely until an impression is beaconed", async () => {
    const { plan, store } = setup();
    const a = await computeAnalytics(store, plan);
    expect(a.experiment).toBeUndefined();
  });

  it("dedups visitors by distinct user — a refresh is not a new visitor", async () => {
    const { plan, service, store } = setup();
    await service.recordImpression({ planId: plan.id, endUserRef: "v1", cohort: "treatment" });
    await service.recordImpression({ planId: plan.id, endUserRef: "v1", cohort: "treatment" }); // refresh
    await service.recordImpression({ planId: plan.id, endUserRef: "v2", cohort: "treatment" });
    const a = await computeAnalytics(store, plan);
    expect(a.experiment?.treatment.visitors).toBe(2); // not 3
  });

  it("computes revenue-per-visitor and a positive lift when treatment beats flat", async () => {
    const { plan, store, service } = setup();
    // 10 treatment visitors, 2 buy at $30 → rev/visitor = 60/10 = 6.
    for (let i = 0; i < 10; i++) {
      await service.recordImpression({ planId: plan.id, endUserRef: `t${i}`, cohort: "treatment" });
    }
    await store.createDeal(settledDeal(plan.id, plan.merchantId, "t0", 30));
    await store.createDeal(settledDeal(plan.id, plan.merchantId, "t1", 30));
    // 10 control visitors, 1 buys at $40 on the flat page → rev/visitor = 40/10 = 4.
    for (let i = 0; i < 10; i++) {
      await service.recordImpression({ planId: plan.id, endUserRef: `c${i}`, cohort: "control" });
    }
    await service.recordConversion({ planId: plan.id, endUserRef: "c0", amount: 40 });

    const e = (await computeAnalytics(store, plan)).experiment!;
    expect(e.treatment.revPerVisitor).toBe(6);
    expect(e.control.revPerVisitor).toBe(4);
    expect(e.controlReported).toBe(true);
    expect(e.liftPct).toBe(50); // (6 - 4) / 4 = +50%
    expect(e.split).toBe(0.5); // 10 treatment / 20 total
    expect(e.treatment.conversions).toBe(2);
    expect(e.control.conversions).toBe(1);
  });

  it("reports a NEGATIVE lift when flat pricing wins — never hides a bad result", async () => {
    const { plan, store, service } = setup();
    for (let i = 0; i < 5; i++) await service.recordImpression({ planId: plan.id, endUserRef: `t${i}`, cohort: "treatment" });
    await store.createDeal(settledDeal(plan.id, plan.merchantId, "t0", 10)); // rev/visitor = 10/5 = 2
    for (let i = 0; i < 5; i++) await service.recordImpression({ planId: plan.id, endUserRef: `c${i}`, cohort: "control" });
    await service.recordConversion({ planId: plan.id, endUserRef: "c0", amount: 50 }); // rev/visitor = 50/5 = 10
    const e = (await computeAnalytics(store, plan)).experiment!;
    expect(e.liftPct).toBe(-80); // (2 - 10) / 10 = -80%
  });

  it("degrades honestly when the control-arm callback is not wired (no false/∞ lift)", async () => {
    const { plan, store, service } = setup();
    for (let i = 0; i < 8; i++) await service.recordImpression({ planId: plan.id, endUserRef: `t${i}`, cohort: "treatment" });
    await store.createDeal(settledDeal(plan.id, plan.merchantId, "t0", 30));
    for (let i = 0; i < 8; i++) await service.recordImpression({ planId: plan.id, endUserRef: `c${i}`, cohort: "control" });
    // No recordConversion calls — merchant hasn't wired the callback.
    const e = (await computeAnalytics(store, plan)).experiment!;
    expect(e.controlReported).toBe(false);
    expect(e.control.revPerVisitor).toBeNull(); // can't tell "sold nothing" from "no callback"
    expect(e.liftPct).toBeNull(); // refuse to compute a comparison we can't trust
    expect(e.treatment.revPerVisitor).toBe(3.75); // treatment still self-measures: 30/8
  });

  it("normalizes an unknown cohort to treatment", async () => {
    const { plan, store, service } = setup();
    await service.recordImpression({ planId: plan.id, endUserRef: "v1", cohort: "garbage" });
    const e = (await computeAnalytics(store, plan)).experiment!;
    expect(e.treatment.visitors).toBe(1);
    expect(e.control.visitors).toBe(0);
  });

  it("scopes events to the plan — another plan's impressions never leak in", async () => {
    const { plan, store, service } = setup();
    await service.recordImpression({ planId: plan.id, endUserRef: "mine", cohort: "treatment" });
    // Append an impression for a different plan id directly into the log.
    await store.appendEvent("widget.impression", { planId: "other_plan", userRef: "theirs", cohort: "treatment" });
    const e = (await computeAnalytics(store, plan)).experiment!;
    expect(e.treatment.visitors).toBe(1); // only "mine"
  });

  it("recordConversion rejects a negative amount", async () => {
    const { plan, service } = setup();
    await expect(
      service.recordConversion({ planId: plan.id, endUserRef: "c0", amount: -5 }),
    ).rejects.toMatchObject({ code: "bad_request" });
  });
});
