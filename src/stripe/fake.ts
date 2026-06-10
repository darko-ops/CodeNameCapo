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
    return { checkoutId, url: `${this.baseUrl}/checkout/${checkoutId}` };
  }

  parseWebhook(rawBody: string): WebhookEvent {
    // Sandbox trusts the body — no signature verification.
    let body: { type?: string; checkoutId?: string; subscriptionId?: string | null };
    try {
      body = JSON.parse(rawBody);
    } catch {
      return { type: "ignored" };
    }
    if (body.type === "checkout.session.completed" && body.checkoutId) {
      return {
        type: "checkout.session.completed",
        checkoutId: body.checkoutId,
        subscriptionId: body.subscriptionId ?? `sub_test_${randomUUID().slice(0, 8)}`,
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
  static completedWebhookBody(checkoutId: string, subscriptionId?: string): string {
    return JSON.stringify({
      type: "checkout.session.completed",
      checkoutId,
      subscriptionId: subscriptionId ?? null,
    });
  }
}
