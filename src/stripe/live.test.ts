/**
 * LiveStripeGateway.parseWebhook — settlement-event normalization.
 *
 * The headline of the Stripe verification pass (Step 2): settlement is driven off
 * BOTH checkout.session.completed AND checkout.session.async_payment_succeeded, and
 * the session's payment_status is carried through so the service refuses to settle
 * an `unpaid` (delayed-method) session. These tests stub Stripe's verified-event
 * output to pin the normalization; the live signature/delivery path is a credentialed
 * TODO (see docs/stripe-verification.md).
 */
import { describe, it, expect } from "vitest";
import { LiveStripeGateway } from "./live.js";

/** A gateway whose Stripe SDK returns `event` from constructEvent (no network). */
function gatewayReturning(event: unknown): LiveStripeGateway {
  const gw = new LiveStripeGateway("sk_test_x", "whsec_x");
  (gw as unknown as { stripe: { webhooks: { constructEvent: () => unknown } } }).stripe = {
    webhooks: { constructEvent: () => event },
  };
  return gw;
}

const session = (over: Record<string, unknown>) => ({
  id: "cs_1",
  subscription: null,
  payment_intent: null,
  payment_status: "paid",
  ...over,
});

describe("LiveStripeGateway.parseWebhook", () => {
  it("throws without a Stripe-Signature header (verified webhooks only)", () => {
    expect(() => gatewayReturning({}).parseWebhook("{}", undefined)).toThrow(/signature/i);
  });

  it("completed + paid (card): normalizes subscription, account scope, payment_status", () => {
    const e = gatewayReturning({
      id: "evt_1",
      type: "checkout.session.completed",
      account: "acct_merchantA", // Connect direct charge → connected account on event.account
      data: { object: session({ subscription: "sub_1" }) },
    }).parseWebhook("{}", "sig");
    expect(e).toMatchObject({
      type: "checkout.session.completed",
      eventId: "evt_1",
      accountId: "acct_merchantA",
      checkoutId: "cs_1",
      subscriptionId: "sub_1",
      paymentStatus: "paid",
    });
  });

  it("completed but UNPAID (delayed method): carries payment_status 'unpaid' (service must not settle)", () => {
    const e = gatewayReturning({
      id: "evt_2",
      type: "checkout.session.completed",
      account: null,
      data: { object: session({ subscription: "sub_2", payment_status: "unpaid" }) },
    }).parseWebhook("{}", "sig");
    expect(e).toMatchObject({ type: "checkout.session.completed", paymentStatus: "unpaid", subscriptionId: "sub_2" });
  });

  it("async_payment_succeeded is ALSO a settlement trigger (delayed method paid later)", () => {
    const e = gatewayReturning({
      id: "evt_3",
      type: "checkout.session.async_payment_succeeded",
      account: "acct_A",
      data: { object: session({ subscription: "sub_3", payment_status: "paid" }) },
    }).parseWebhook("{}", "sig");
    expect(e).toMatchObject({ type: "checkout.session.completed", checkoutId: "cs_1", subscriptionId: "sub_3", paymentStatus: "paid" });
  });

  it("async_payment_failed is a recognized no-op (never settles)", () => {
    const e = gatewayReturning({ id: "evt_4", type: "checkout.session.async_payment_failed", data: { object: session({}) } }).parseWebhook("{}", "sig");
    expect(e).toEqual({ type: "ignored" });
  });

  it("one-time (payment_intent) session normalizes the PI id", () => {
    const e = gatewayReturning({
      id: "evt_5",
      type: "checkout.session.completed",
      account: null,
      data: { object: session({ payment_intent: "pi_5" }) },
    }).parseWebhook("{}", "sig");
    expect(e).toMatchObject({ paymentIntentId: "pi_5", subscriptionId: null, paymentStatus: "paid" });
  });
});
