import { describe, it, expect, beforeEach } from "vitest";
import { BouncrService, ServiceError } from "./service.js";
import { MemoryStore } from "./store/memory.js";
import { FakeStripeGateway } from "./stripe/fake.js";
import { makeTemplateNegotiator } from "./llm/negotiator.js";
import { demoPlan } from "./config.js";
import { ProofSigner, mintProof } from "./proof.js";
import type { WebhookEvent } from "./stripe/gateway.js";

const PLAN = demoPlan(); // floor 8, target 22, anchor 48, maxRounds 6

function makeService() {
  const store = new MemoryStore([PLAN]);
  const stripe = new FakeStripeGateway();
  const service = new BouncrService({
    store,
    stripe,
    negotiator: makeTemplateNegotiator(),
    baseUrl: "http://localhost:8787",
  });
  return { store, stripe, service };
}

const completed = (checkoutId: string, sub = "sub_test_1"): WebhookEvent => ({
  type: "checkout.session.completed",
  checkoutId,
  subscriptionId: sub,
});

// Drive the hosted-checkout Pay step from an accept URL (creates the Stripe session).
async function pay(service: BouncrService, accepted: { checkoutUrl?: string }) {
  const u = new URL(accepted.checkoutUrl!);
  return service.startCheckout(u.pathname.split("/checkout/")[1]!, u.searchParams.get("proof")!);
}

describe("createSession", () => {
  it("opens a session at the anchor and records the opener turn", async () => {
    const { store, service } = makeService();
    const { sessionId, opener } = await service.createSession({
      planId: PLAN.id,
      endUserRef: "user_42",
    });
    expect(opener).toContain("$48"); // anchor
    const s = await store.getSession(sessionId);
    expect(s?.status).toBe("open");
    expect(s?.currentAsk).toBe(48);
    const turns = await store.listTurns(sessionId);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.role).toBe("bouncer");
  });

  it("resolves a plan by its public plan_key (what the widget sends), not just id", async () => {
    const { service } = makeService();
    // PLAN.id is "plan_demo"; PLAN.planKey is "pro_monthly" — both must work.
    await expect(service.createSession({ planId: "pro_monthly", endUserRef: "u" })).resolves.toMatchObject({
      sessionId: expect.any(String),
    });
    await expect(service.createSession({ planId: PLAN.id, endUserRef: "u" })).resolves.toBeTruthy();
  });

  it("rejects an unknown plan", async () => {
    const { service } = makeService();
    await expect(service.createSession({ planId: "nope", endUserRef: "u" })).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

describe("full negotiate → accept → settle flow", () => {
  it("counters a lowball, closes on a target offer, then settles via webhook", async () => {
    const { store, stripe, service } = makeService();
    const { sessionId } = await service.createSession({ planId: PLAN.id, endUserRef: "user_1" });

    // Lowball — engine counters, no deal yet.
    const t1 = await service.postMessage(sessionId, "I'll give you 3 bucks");
    expect(t1.action.type).toBe("counter");
    expect(t1.checkoutUrl).toBeUndefined();
    expect(t1.status).toBe("open");

    // Meet the standing ask — engine accepts at it, a checkout is created.
    const ask = t1.currentAsk;
    const t2 = await service.postMessage(sessionId, `ok deal, ${ask}`);
    expect(t2.action.type).toBe("accept");
    expect(t2.checkoutUrl).toBeDefined();
    expect(t2.dealId).toBeDefined();
    expect(t2.status).toBe("accepted");

    // Buyer hits Pay on the hosted page → the Stripe session is created.
    await pay(service, t2);

    // Deal is pending; Stripe was asked for the negotiated amount.
    const deal = await store.getDeal(t2.dealId!);
    expect(deal?.status).toBe("pending");
    expect(deal?.price).toBe(ask);
    expect(deal?.currency).toBe("usd");
    expect(stripe.checkouts.at(-1)).toMatchObject({ amount: ask, currency: "usd", dealId: t2.dealId });

    // Webhook settles it.
    const r = await service.handleStripeEvent(completed(deal!.stripeCheckoutId!));
    expect(r).toEqual({ settled: true, dealId: t2.dealId });
    const settled = await store.getDeal(t2.dealId!);
    expect(settled?.status).toBe("settled");
    expect(settled?.stripeSubscriptionId).toBe("sub_test_1");
    const s = await store.getSession(sessionId);
    expect(s?.status).toBe("settled");
  });

  it("is idempotent on webhook re-delivery", async () => {
    const { store, service } = makeService();
    const { sessionId } = await service.createSession({ planId: PLAN.id, endUserRef: "u" });
    const t = await service.postMessage(sessionId, "$46");
    const deal = await store.getDeal(t.dealId!);
    const first = await service.handleStripeEvent(completed(deal!.stripeCheckoutId!, "sub_A"));
    const second = await service.handleStripeEvent(completed(deal!.stripeCheckoutId!, "sub_B"));
    expect(first.settled).toBe(true);
    expect(second).toEqual({ settled: true, dealId: t.dealId });
    // Subscription id is not overwritten on the idempotent replay.
    expect((await store.getDeal(t.dealId!))?.stripeSubscriptionId).toBe("sub_A");
  });

  it("ignores a webhook for an unknown checkout id", async () => {
    const { store, service } = makeService();
    const r = await service.handleStripeEvent(completed("cs_test_unknown"));
    expect(r).toEqual({ settled: false });
    expect(store.allEvents().some((e) => e.type === "webhook.unmatched")).toBe(true);
  });
});

describe("explicit accept of the current ask", () => {
  it("closes a deal at currentAsk and returns a checkout url", async () => {
    const { store, service } = makeService();
    const { sessionId } = await service.createSession({ planId: PLAN.id, endUserRef: "u" });
    const r = await service.acceptCurrent(sessionId);
    expect(r.price).toBe(48); // anchor, round 0
    expect(r.checkoutUrl).toContain("/checkout/");
    const deal = await store.getDeal(r.dealId);
    expect(deal?.price).toBe(48);
    expect(deal?.status).toBe("pending");
    expect((await store.getSession(sessionId))?.status).toBe("accepted");
  });
});

describe("guardrails through the service", () => {
  it("never settles or checks out below the floor, even under relentless lowballing", async () => {
    const { store, service } = makeService();
    const { sessionId } = await service.createSession({ planId: PLAN.id, endUserRef: "u" });
    let lastAction = "";
    for (let i = 0; i < 12; i++) {
      const s = await store.getSession(sessionId);
      if (s?.status !== "open") break;
      const t = await service.postMessage(sessionId, "$1, take it or leave it");
      lastAction = t.action.type;
      if (t.checkoutUrl) {
        const deal = await store.getDeal(t.dealId!);
        expect(deal!.price).toBeGreaterThanOrEqual(PLAN.config.floorPrice);
      }
      expect(t.currentAsk).toBeGreaterThanOrEqual(PLAN.config.floorPrice);
    }
    // A $1 offer never closes a deal — it ends in a final counter or a walk.
    expect(["counter", "walk"]).toContain(lastAction);
    // No deal was ever created (no accept happened).
    expect(store.allEvents().some((e) => e.type === "deal.created")).toBe(false);
  });

  it("rejects messages on a closed session and unknown sessions", async () => {
    const { service } = makeService();
    const { sessionId } = await service.createSession({ planId: PLAN.id, endUserRef: "u" });
    await service.acceptCurrent(sessionId); // -> accepted
    await expect(service.postMessage(sessionId, "hi")).rejects.toMatchObject({ code: "conflict" });
    await expect(service.postMessage("missing", "hi")).rejects.toMatchObject({ code: "not_found" });
    await expect(service.getDeal("missing")).rejects.toBeInstanceOf(ServiceError);
  });
});

describe("hosted checkout settlement (proof → Connect)", () => {
  it("Pay creates the Stripe session on the deal; returning resumes it (no second session)", async () => {
    const { store, stripe, service } = makeService();
    const { sessionId } = await service.createSession({ planId: PLAN.id, endUserRef: "u" });
    const acc = await service.acceptCurrent(sessionId);

    const first = await pay(service, acc);
    expect(first.state).toBe("redirect");
    expect(stripe.checkouts.length).toBe(1);
    const deal = await store.getDeal(acc.dealId);
    expect(deal?.checkoutStatus).toBe("pending");
    expect(deal?.stripeCheckoutId).toMatch(/^cs_test_/);

    // Returning to the page resumes the OPEN session — no new proof, no new session.
    const view = await service.getCheckoutView(acc.dealId, undefined);
    expect(view).toMatchObject({ state: "resume", url: deal!.checkoutUrl });
  });

  it("single-use: replaying the same proof never creates a second session (resumes instead)", async () => {
    const { stripe, service } = makeService();
    const { sessionId } = await service.createSession({ planId: PLAN.id, endUserRef: "u" });
    const acc = await service.acceptCurrent(sessionId);
    await pay(service, acc);
    await pay(service, acc); // same proof again
    expect(stripe.checkouts.length).toBe(1); // no double-burn, no parallel session
  });

  it("re-mints a fresh proof (same amount) when the proof is invalid but the deal is open", async () => {
    const { stripe, service } = makeService();
    const { sessionId } = await service.createSession({ planId: PLAN.id, endUserRef: "u" });
    const acc = await service.acceptCurrent(sessionId);
    const view = await service.getCheckoutView(acc.dealId, "garbage");
    expect(view.state).toBe("remint");
    if (view.state === "remint") {
      expect(view.url).toContain(`/checkout/${acc.dealId}?proof=`);
      const r = await pay(service, { checkoutUrl: view.url }); // the re-minted proof pays
      expect(r.state).toBe("redirect");
      expect(stripe.checkouts.at(-1)!.amount).toBe(acc.price); // same engine amount
    }
  });

  it("the negotiator only ever produces MONTHLY subscriptions (never one_time)", async () => {
    const { stripe, service } = makeService();
    const { sessionId } = await service.createSession({ planId: PLAN.id, endUserRef: "u" });
    await pay(service, await service.acceptCurrent(sessionId));
    expect(stripe.checkouts.at(-1)!.interval).toBe("month");
  });

  it("one-time rail: a hand-minted one_time proof settles via the PaymentIntent branch", async () => {
    const signer = ProofSigner.ephemeral("t");
    const store = new MemoryStore([PLAN]);
    const stripe = new FakeStripeGateway();
    const service = new BouncrService({
      store, stripe, negotiator: makeTemplateNegotiator(), baseUrl: "http://x", proofSigner: signer,
    });
    const deal = await store.createDeal({
      sessionId: "s", merchantId: PLAN.merchantId, planId: PLAN.id, endUserRef: "u",
      price: 9, currency: "usd", status: "pending", kind: "initial",
      stripeCheckoutId: null, stripeSubscriptionId: null, checkoutStatus: "none",
      renegSessionId: null, settledAt: null,
    });
    const { token } = mintProof(signer, { deal, plan: PLAN, nowMs: Date.now(), interval: "one_time" });
    const r = await service.startCheckout(deal.id, token);
    expect(r.state).toBe("redirect");
    expect(stripe.checkouts.at(-1)!.interval).toBe("one_time");
    expect(stripe.checkouts.at(-1)!.amount).toBe(9);
  });
});
