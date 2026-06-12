import { describe, it, expect, beforeEach } from "vitest";
import { BouncrService, ServiceError } from "./service.js";
import { MemoryStore } from "./store/memory.js";
import { FakeStripeGateway } from "./stripe/fake.js";
import { makeTemplateNegotiator } from "./llm/negotiator.js";
import { demoPlan, demoMerchant } from "./config.js";
import { ProofSigner, mintProof } from "./proof.js";
import type { WebhookEvent } from "./stripe/gateway.js";

const PLAN = demoPlan(); // list 30 > target 24 > floor 22, anchor 48, maxRounds 6

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

const completed = (checkoutId: string, sub = "sub_test_1", accountId: string | null = null): WebhookEvent => ({
  type: "checkout.session.completed",
  eventId: "evt_x",
  accountId,
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

    // Credible low offer — engine counters TOWARD it, no deal yet. (A $3 insult
    // would be refused/held; $25 is a real number on the $48 ask.)
    const t1 = await service.postMessage(sessionId, "I'll give you 25");
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
    // A $1 offer never closes a deal — Vini stands on his number (final counter,
    // then holds) and never walks on a stubborn cold-start haggler.
    expect(["counter", "hold"]).toContain(lastAction);
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

describe("webhook account-scoping + entitlement notification (settlement §4)", () => {
  // A capturing notifier so we can assert the signed POST (and simulate failure).
  class CaptureNotifier {
    calls: { url: string; secret: string; payload: any; nowMs: number }[] = [];
    fail = false;
    async notify(url: string, secret: string, payload: any, nowMs: number) {
      this.calls.push({ url, secret, payload, nowMs });
      if (this.fail) throw new Error("merchant endpoint down");
    }
  }

  function setup(opts: { connectId?: string | null; webhookUrl?: string | null; notifier?: any } = {}) {
    const plan = demoPlan();
    const merchant = { ...demoMerchant(), stripeConnectId: opts.connectId ?? null, webhookUrl: opts.webhookUrl ?? null, webhookSecret: opts.webhookUrl ? "whsec_test" : null };
    const store = new MemoryStore([plan], [merchant]);
    const stripe = new FakeStripeGateway();
    const service = new BouncrService({ store, stripe, negotiator: makeTemplateNegotiator(), baseUrl: "http://x", ...(opts.notifier ? { notifier: opts.notifier } : {}) });
    return { plan, store, stripe, service };
  }

  async function settle(service: BouncrService, store: MemoryStore, planId: string, accountId: string | null) {
    const { sessionId } = await service.createSession({ planId, endUserRef: "buyer" });
    const acc = await service.acceptCurrent(sessionId);
    await pay(service, acc);
    const deal = await store.getDeal(acc.dealId);
    return { acc, checkoutId: deal!.stripeCheckoutId!, accountId };
  }

  it("rejects a webhook whose connected account isn't the deal's merchant (cross-account)", async () => {
    const notifier = new CaptureNotifier();
    const { store, service, plan } = setup({ connectId: "acct_A", webhookUrl: "https://m.test/hook", notifier });
    const { acc, checkoutId } = await settle(service, store, plan.id, "acct_A");

    // Event from a DIFFERENT connected account → not settled, no notify.
    const wrong = await service.handleStripeEvent(completed(checkoutId, "sub_1", "acct_B"));
    expect(wrong).toEqual({ settled: false });
    expect((await store.getDeal(acc.dealId))?.status).toBe("pending");
    expect(notifier.calls).toHaveLength(0);

    // The right account settles it (once).
    const ok = await service.handleStripeEvent(completed(checkoutId, "sub_1", "acct_A"));
    expect(ok).toMatchObject({ settled: true });
    expect((await store.getDeal(acc.dealId))?.status).toBe("settled");
  });

  it("on settle: records the entitlement durably AND sends a signed webhook to the merchant", async () => {
    const notifier = new CaptureNotifier();
    const { store, service, plan } = setup({ connectId: null, webhookUrl: "https://m.test/hook", notifier });
    const { acc, checkoutId } = await settle(service, store, plan.id, null);
    await service.handleStripeEvent(completed(checkoutId, "sub_1"));

    // Durable entitlement event recorded.
    const events = store.allEvents();
    expect(events.some((e) => e.type === "entitlement.recorded")).toBe(true);
    expect(events.some((e) => e.type === "entitlement.delivered")).toBe(true);
    // Signed POST with the right payload.
    expect(notifier.calls).toHaveLength(1);
    expect(notifier.calls[0]!.payload).toMatchObject({
      deal_id: acc.dealId, end_user_ref: "buyer", plan_id: plan.id, status: "active", currency: "usd",
    });
    expect(notifier.calls[0]!.payload.amount).toBe(Math.round(acc.price * 100));
  });

  it("a missing/failing webhook_url does NOT fail settlement (deal stays settled)", async () => {
    // No webhook_url → skip-if-unset; deal still settles.
    const skip = setup({ webhookUrl: null });
    const a = await settle(skip.service, skip.store, skip.plan.id, null);
    expect((await skip.service.handleStripeEvent(completed(a.checkoutId, "sub_1"))).settled).toBe(true);
    expect((await skip.store.getDeal(a.acc.dealId))?.status).toBe("settled");
    expect(skip.store.allEvents().some((e) => e.type === "entitlement.skipped")).toBe(true);

    // Failing POST → still settled, failure recorded (durable event already written).
    const notifier = new CaptureNotifier();
    notifier.fail = true;
    const fail = setup({ webhookUrl: "https://m.test/hook", notifier });
    const b = await settle(fail.service, fail.store, fail.plan.id, null);
    expect((await fail.service.handleStripeEvent(completed(b.checkoutId, "sub_1"))).settled).toBe(true);
    expect((await fail.store.getDeal(b.acc.dealId))?.status).toBe("settled");
    expect(fail.store.allEvents().some((e) => e.type === "entitlement.recorded")).toBe(true);
    expect(fail.store.allEvents().some((e) => e.type === "entitlement.delivery_failed")).toBe(true);
  });

  it("a redelivered Stripe event does not double-notify", async () => {
    const notifier = new CaptureNotifier();
    const { store, service, plan } = setup({ webhookUrl: "https://m.test/hook", notifier });
    const { checkoutId } = await settle(service, store, plan.id, null);
    await service.handleStripeEvent(completed(checkoutId, "sub_1"));
    await service.handleStripeEvent(completed(checkoutId, "sub_1")); // redelivery
    expect(notifier.calls).toHaveLength(1); // settled-guard → no second notify
  });
});

describe("updatePlan — Vini/discovery config (renderer-only)", () => {
  const M = PLAN.merchantId;

  it("persists a valid discovery config and bumps the version", async () => {
    const { service } = makeService();
    const updated = await service.updatePlan(M, PLAN.id, {
      discovery: {
        enabled: true,
        questions: [{ field: "first_name", prompt: "whats ur name", enabled: true }],
        talkingPoints: ["cancel anytime", "priority support"],
      },
    });
    expect(updated.discovery?.questions[0]).toMatchObject({ field: "first_name", enabled: true });
    expect(updated.discovery?.talkingPoints).toEqual(["cancel anytime", "priority support"]);
    expect(updated.version).toBe(PLAN.version + 1);
  });

  it("rejects a NEVER-list field with a policy-grounded error", async () => {
    const { service } = makeService();
    await expect(
      service.updatePlan(M, PLAN.id, {
        discovery: { enabled: true, questions: [{ field: "income", prompt: "what do you earn" }] },
      }),
    ).rejects.toMatchObject({ code: "bad_request" });
  });

  it("an explicit null clears discovery", async () => {
    const { service } = makeService();
    await service.updatePlan(M, PLAN.id, {
      discovery: { enabled: true, questions: [], talkingPoints: ["x"] },
    });
    const cleared = await service.updatePlan(M, PLAN.id, { discovery: null });
    expect(cleared.discovery == null).toBe(true);
  });

  it("leaves discovery untouched when not part of the patch", async () => {
    const { service } = makeService();
    await service.updatePlan(M, PLAN.id, {
      discovery: { enabled: true, questions: [{ field: "use_case", prompt: "what for" }], talkingPoints: [] },
    });
    const after = await service.updatePlan(M, PLAN.id, { productName: "Renamed" });
    expect(after.persona.productName).toBe("Renamed");
    expect(after.discovery?.questions[0]?.field).toBe("use_case"); // preserved
  });
});
