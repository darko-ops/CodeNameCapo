import { describe, it, expect } from "vitest";
import { BouncrService, ServiceError } from "./service.js";
import { MemoryStore } from "./store/memory.js";
import { FakeStripeGateway } from "./stripe/fake.js";
import { makeTemplateNegotiator } from "./llm/negotiator.js";
import { computeAnalytics } from "./analytics.js";
import { demoPlan, demoMerchant } from "./config.js";
import type { WebhookEvent } from "./stripe/gateway.js";

function setup(planOverrides: Partial<ReturnType<typeof demoPlan>["policy"]> = {}) {
  const plan = demoPlan();
  plan.policy = { ...plan.policy, ...planOverrides };
  const store = new MemoryStore([plan], [demoMerchant()]);
  const stripe = new FakeStripeGateway();
  const service = new BouncrService({
    store,
    stripe,
    negotiator: makeTemplateNegotiator(),
    baseUrl: "http://localhost:8787",
    now: () => Date.now(),
  });
  return { plan, store, stripe, service };
}

const completed = (checkoutId: string): WebhookEvent => ({
  type: "checkout.session.completed",
  checkoutId,
  subscriptionId: "sub_x",
});

describe("walkaway cooldown (Spec §12)", () => {
  it("blocks a new session for the same user+plan after a walk", async () => {
    const { plan, store, service } = setup({ maxMessages: 1 }); // force a quick walk
    const { sessionId } = await service.createSession({ planId: plan.id, endUserRef: "abuser" });
    // First message is within cap (0 prior); second hits the cap → walk.
    await service.postMessage(sessionId, "$1");
    const walked = await service.postMessage(sessionId, "$1 again");
    expect(walked.action.type).toBe("walk");

    const cd = await store.getCooldown(plan.id, "abuser");
    expect(cd).toBeGreaterThan(Date.now());

    await expect(service.createSession({ planId: plan.id, endUserRef: "abuser" })).rejects.toMatchObject({
      code: "conflict",
    });
    // A different user is unaffected.
    await expect(service.createSession({ planId: plan.id, endUserRef: "someone_else" })).resolves.toBeTruthy();
  });

  it("a zero-hour cooldown does not block", async () => {
    const { plan, service } = setup({ cooldownHours: 0, maxMessages: 1 });
    const { sessionId } = await service.createSession({ planId: plan.id, endUserRef: "u" });
    await service.postMessage(sessionId, "$1");
    await service.postMessage(sessionId, "$1");
    await expect(service.createSession({ planId: plan.id, endUserRef: "u" })).resolves.toBeTruthy();
  });
});

describe("message cap (Spec §12 anti-siege)", () => {
  it("ends the session as a walk once the cap is reached", async () => {
    const { plan, service } = setup({ maxMessages: 3 });
    const { sessionId } = await service.createSession({ planId: plan.id, endUserRef: "u" });
    const actions: string[] = [];
    for (let i = 0; i < 5; i++) {
      const s = await service.getSessionView(sessionId);
      if (s.status !== "open") break;
      actions.push((await service.postMessage(sessionId, "$2")).action.type);
    }
    // 3 messages allowed; the 4th attempt walks.
    expect(actions.filter((a) => a === "walk").length).toBe(1);
    expect(actions.length).toBe(4);
  });
});

describe("Stripe Connect routing (Spec §7, Phase 3)", () => {
  it("onboards a merchant and routes the next checkout to their account", async () => {
    const { plan, store, stripe, service } = setup();
    const r = await service.startConnectOnboarding("merchant_demo", "http://x/return", "http://x/refresh");
    expect(r.accountId).toMatch(/^acct_test_/);
    expect(r.url).toContain("/connect/onboard/");
    expect((await store.getMerchant("merchant_demo"))?.stripeConnectId).toBe(r.accountId);

    const status = await service.getConnectStatus("merchant_demo");
    expect(status).toMatchObject({ connected: true, chargesEnabled: true });

    // A deal now settles into the connected account.
    const { sessionId } = await service.createSession({ planId: plan.id, endUserRef: "buyer" });
    await service.acceptCurrent(sessionId);
    expect(stripe.checkouts.at(-1)?.connectedAccountId).toBe(r.accountId);
  });

  it("settles to the platform when the merchant is not connected", async () => {
    const { plan, stripe, service } = setup();
    const { sessionId } = await service.createSession({ planId: plan.id, endUserRef: "buyer" });
    await service.acceptCurrent(sessionId);
    expect(stripe.checkouts.at(-1)?.connectedAccountId).toBeNull();
  });
});

describe("WTP analytics (Spec §11)", () => {
  it("computes funnel, offer distribution, and closing stats from real negotiations", async () => {
    const { plan, store, service } = setup();

    // Session A: engages, then closes at $36 (above the $32 target) → settle.
    const a = await service.createSession({ planId: plan.id, endUserRef: "a" });
    await service.postMessage(a.sessionId, "$3"); // first offer 3, counter
    const close = await service.postMessage(a.sessionId, "$36"); // accept
    await service.handleStripeEvent(completed((await store.getDeal(close.dealId!))!.stripeCheckoutId!));

    // Session B: engages but never closes.
    const b = await service.createSession({ planId: plan.id, endUserRef: "b" });
    await service.postMessage(b.sessionId, "$5");

    // Session C: created, never engages.
    await service.createSession({ planId: plan.id, endUserRef: "c" });

    const an = await computeAnalytics(store, plan);
    expect(an.funnel.sessions).toBe(3);
    expect(an.funnel.engaged).toBe(2);
    expect(an.funnel.accepted).toBe(1);
    expect(an.funnel.settled).toBe(1);
    expect(an.offers.firstOffers.sort((x, y) => x - y)).toEqual([3, 5]);
    expect(an.offers.closingPrices).toEqual([36]);
    expect(an.closing.medianPrice).toBe(36);
    expect(an.closing.revenue).toBe(36);
    expect(an.reference).toMatchObject({ list: 30, target: 32, floor: 22 });
  });
});
