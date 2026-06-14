/**
 * Fake Stripe gateway — sandbox mode (`test_` keys) and tests. No network, no
 * money. Produces deterministic-shaped fake checkout URLs and trusts a
 * plain-JSON webhook body so the full settlement flow can be exercised offline.
 */
import { randomUUID } from "node:crypto";
import type {
  StripeGateway,
  CheckoutParams,
  CheckoutResult,
  WebhookEvent,
  OnboardingParams,
  OnboardingResult,
  AccountStatus,
  SubscriptionUpdateParams,
} from "./gateway.js";

export class FakeStripeGateway implements StripeGateway {
  /** Records what was asked of Stripe — useful for assertions in tests. */
  public readonly checkouts: CheckoutParams[] = [];
  public readonly subscriptionUpdates: SubscriptionUpdateParams[] = [];

  constructor(private readonly baseUrl = "https://sandbox.bouncr.test") {}

  async updateSubscription(params: SubscriptionUpdateParams): Promise<{ ok: true }> {
    this.subscriptionUpdates.push(params);
    return { ok: true };
  }

  async createCheckout(params: CheckoutParams): Promise<CheckoutResult> {
    this.checkouts.push(params);
    const checkoutId = `cs_test_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    // A fake Stripe-hosted URL (distinct from Bouncr's /checkout page) + a 30-min
    // expiry so the resume/re-mint paths can be exercised offline.
    return {
      checkoutId,
      url: `${this.baseUrl}/stripe-checkout/${checkoutId}`,
      expiresAt: Date.now() + 30 * 60 * 1000,
    };
  }

  parseWebhook(rawBody: string): WebhookEvent {
    // Sandbox trusts the body — no signature verification.
    let body: {
      type?: string;
      eventId?: string;
      accountId?: string | null;
      checkoutId?: string;
      subscriptionId?: string | null;
      paymentIntentId?: string | null;
      paymentStatus?: string | null;
    };
    try {
      body = JSON.parse(rawBody);
    } catch {
      return { type: "ignored" };
    }
    // Mirror live: both completed and async_payment_succeeded are settlement
    // triggers; payment_status defaults to "paid" (the offline/card path).
    if (
      (body.type === "checkout.session.completed" || body.type === "checkout.session.async_payment_succeeded") &&
      body.checkoutId
    ) {
      return {
        type: "checkout.session.completed",
        eventId: body.eventId ?? `evt_test_${randomUUID().slice(0, 8)}`,
        accountId: body.accountId ?? null,
        checkoutId: body.checkoutId,
        subscriptionId: body.subscriptionId ?? `sub_test_${randomUUID().slice(0, 8)}`,
        paymentIntentId: body.paymentIntentId ?? null,
        paymentStatus: body.paymentStatus ?? "paid",
      };
    }
    return { type: "ignored" };
  }

  async startConnectOnboarding(params: OnboardingParams): Promise<OnboardingResult> {
    const accountId = params.existingAccountId ?? `acct_test_${randomUUID().slice(0, 12)}`;
    return { accountId, url: `${this.baseUrl}/connect/onboard/${accountId}` };
  }

  async getAccountStatus(): Promise<AccountStatus> {
    // Sandbox accounts are always ready.
    return { chargesEnabled: true, detailsSubmitted: true };
  }

  /** Test helper: synthesize the webhook body Stripe would POST on completion. */
  static completedWebhookBody(
    checkoutId: string,
    subscriptionId?: string,
    opts: { eventId?: string; accountId?: string | null } = {},
  ): string {
    return JSON.stringify({
      type: "checkout.session.completed",
      eventId: opts.eventId ?? null,
      accountId: opts.accountId ?? null,
      checkoutId,
      subscriptionId: subscriptionId ?? null,
    });
  }
}
