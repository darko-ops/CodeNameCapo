import { describe, it, expect } from "vitest";
import { BouncrService } from "./service.js";
import { MemoryStore } from "./store/memory.js";
import { FakeStripeGateway } from "./stripe/fake.js";
import { makeTemplateNegotiator } from "./llm/negotiator.js";
import { computeAnalytics } from "./analytics.js";
import { demoPlan, demoMerchant } from "./config.js";
import type { Plan } from "./store/types.js";
import type { WebhookEvent } from "./stripe/gateway.js";

function setup(mutate: (p: Plan) => void = () => {}) {
  const plan = demoPlan();
  mutate(plan);
  const store = new MemoryStore([plan], [demoMerchant()]);
  const stripe = new FakeStripeGateway();
  const service = new BouncrService({ store, stripe, negotiator: makeTemplateNegotiator(), baseUrl: "http://x" });
  return { plan, store, stripe, service };
}

const completed = (checkoutId: string): WebhookEvent => ({
  type: "checkout.session.completed",
  checkoutId,
  subscriptionId: "sub_1",
});

/** Negotiate a fresh cold-start deal to settled, returning the deal id. */
async function settleInitialDeal(service: BouncrService, store: MemoryStore, plan: Plan, user = "u") {
  const { sessionId } = await service.createSession({ planId: plan.id, endUserRef: user });
  const acc = await service.acceptCurrent(sessionId);
  await service.handleStripeEvent(completed((await store.getDeal(acc.dealId))!.stripeCheckoutId!));
  return acc.dealId;
}

describe("breach-streak trigger (Spec §6.1)", () => {
  it("opens a renegotiation only after consecutive breaches", async () => {
    const { plan, store, service } = setup(); // bandCeiling 1000, breachCyclesRequired 3
    const dealId = await settleInitialDeal(service, store, plan);

    const r1 = await service.reportUsage(dealId, 1, 5000); // breach 1
    const r2 = await service.reportUsage(dealId, 2, 6000); // breach 2
    expect(r1.breachStreak).toBe(1);
    expect(r2.renegotiation).toBeUndefined();
    const r3 = await service.reportUsage(dealId, 3, 5500); // breach 3 → open
    expect(r3.breachStreak).toBe(3);
    expect(r3.renegotiation?.direction).toBe("up");

    // the deal now has an open reneg session linked
    expect((await store.getDeal(dealId))?.renegSessionId).toBe(r3.renegotiation!.sessionId);
  });

  it("a single good cycle resets the streak (a blip won't reopen the deal)", async () => {
    const { plan, store, service } = setup();
    const dealId = await settleInitialDeal(service, store, plan);
    await service.reportUsage(dealId, 1, 5000); // breach
    await service.reportUsage(dealId, 2, 5000); // breach
    const reset = await service.reportUsage(dealId, 3, 100); // under band → reset
    expect(reset.breachStreak).toBe(0);
    const after = await service.reportUsage(dealId, 4, 5000); // breach 1 again
    expect(after.breachStreak).toBe(1);
    expect(after.renegotiation).toBeUndefined();
  });
});

describe("renegotiation settlement (Spec §6.2, §7)", () => {
  it("negotiates UP and reprices the existing subscription (no new checkout)", async () => {
    const { plan, store, stripe, service } = setup();
    const dealId = await settleInitialDeal(service, store, plan); // price $48 (anchor, round 0 accept)
    const orig = await store.getDeal(dealId);

    const r = await service.reportUsage(dealId, 1, 5000);
    for (let i = 2; i <= 3; i++) await service.reportUsage(dealId, i, 5000);
    // The 3rd report opened the reneg; fetch its session.
    const fresh = await service.reportUsage(dealId, 4, 5000); // already open → no new reneg
    expect(fresh.renegotiation).toBeUndefined();

    const reneg = (await store.getDeal(dealId))!.renegSessionId!;
    const view = await service.getSessionView(reneg);
    expect(view.status).toBe("open");

    // Accept the reneg's standing ask → subscription repriced, new reneg_up deal.
    const acc = await service.acceptCurrent(reneg);
    expect(acc.checkoutUrl).toBeUndefined(); // reneg has no checkout
    expect(stripe.subscriptionUpdates.length).toBe(1);
    expect(stripe.subscriptionUpdates[0]!.subscriptionId).toBe(orig!.stripeSubscriptionId);

    const newDeal = await store.getDeal(acc.dealId);
    expect(newDeal?.kind).toBe("reneg_up");
    expect(newDeal?.status).toBe("settled");
    expect(newDeal!.price).toBeGreaterThanOrEqual(orig!.price); // never below current
    // the reneg session settled, and the original deal's reneg link is cleared
    expect((await service.getSessionView(reneg)).status).toBe("settled");
    expect((await store.getDeal(dealId))?.renegSessionId).toBeNull();
  });

  it("grandfathers a walked renegotiation to the fair tier (never hard-cuts)", async () => {
    const { plan, store, stripe, service } = setup((p) => {
      p.config.maxRounds = 2; // reach the final round fast
    });
    const dealId = await settleInitialDeal(service, store, plan);
    for (let i = 1; i <= 3; i++) await service.reportUsage(dealId, i, 5000);
    const reneg = (await store.getDeal(dealId))!.renegSessionId!;

    // Hold out with a credible-but-unmet offer so the reneg exhausts its rounds
    // and walks. The reneg floor is the CURRENT price ($48, never reprices below
    // it), so the offer must clear $48 to be credible — a lower one is refused.
    let walked = false;
    for (let i = 0; i < 8; i++) {
      const v = await service.getSessionView(reneg);
      if (v.status !== "open") break;
      const t = await service.postMessage(reneg, "$50");
      if (t.action.type === "walk") walked = true;
    }
    expect(walked).toBe(true);
    // Grandfathered: subscription was still updated (to the fair tier), a settled
    // reneg deal exists — access was never cut.
    expect(stripe.subscriptionUpdates.length).toBe(1);
    const deals = await store.listDealsByPlan(plan.id);
    const gf = deals.find((d) => d.kind === "reneg_up" && d.status === "settled");
    expect(gf).toBeTruthy();
  });
});

describe("downward renegotiation (Spec §6.3, opt-in)", () => {
  it("does nothing when disabled, fires a down reneg when enabled", async () => {
    const off = setup();
    const offDeal = await settleInitialDeal(off.service, off.store, off.plan);
    for (let i = 1; i <= 4; i++) await off.service.reportUsage(offDeal, i, 1); // way under band
    expect((await off.store.getDeal(offDeal))?.renegSessionId).toBeNull();

    const on = setup((p) => {
      p.usage.downwardEnabled = true;
      p.usage.downwardMinCycles = 3;
      p.usage.downwardFloorRatio = 0.1; // under 100 units
    });
    const onDeal = await settleInitialDeal(on.service, on.store, on.plan);
    await on.service.reportUsage(onDeal, 1, 5);
    await on.service.reportUsage(onDeal, 2, 5);
    const fired = await on.service.reportUsage(onDeal, 3, 5);
    expect(fired.renegotiation?.direction).toBe("down");
  });
});

describe("reneg analytics v2 (Spec §6.4)", () => {
  it("reports reneg opened/accepted and average uplift", async () => {
    const { plan, store, service } = setup();
    const dealId = await settleInitialDeal(service, store, plan);
    const origPrice = (await store.getDeal(dealId))!.price;
    for (let i = 1; i <= 3; i++) await service.reportUsage(dealId, i, 5000);
    const reneg = (await store.getDeal(dealId))!.renegSessionId!;
    const acc = await service.acceptCurrent(reneg);
    const newPrice = (await store.getDeal(acc.dealId))!.price;

    const an = await computeAnalytics(store, plan);
    expect(an.reneg.opened).toBe(1);
    expect(an.reneg.up).toBe(1);
    expect(an.reneg.accepted).toBe(1);
    expect(an.reneg.avgUpliftPct).toBeCloseTo(((newPrice - origPrice) / origPrice) * 100, 1);
  });
});

describe("usage guards", () => {
  it("rejects usage on a non-settled deal", async () => {
    const { plan, store, service } = setup();
    const { sessionId } = await service.createSession({ planId: plan.id, endUserRef: "u" });
    const acc = await service.acceptCurrent(sessionId); // pending, not settled
    await expect(service.reportUsage(acc.dealId, 1, 5000)).rejects.toMatchObject({ code: "conflict" });
    void store;
  });
});
