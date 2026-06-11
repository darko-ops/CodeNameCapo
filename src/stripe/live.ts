/**
 * Live Stripe gateway (Spec §7). Per-deal Price via inline `price_data` (cheap
 * and fine at this scale — start here, revisit with coupons/metered later) and a
 * subscription Checkout Session. Webhooks are signature-verified.
 *
 * Phase 1 settles into your OWN Stripe account; Connect (settle into the
 * merchant's account) is Phase 3.
 */
import Stripe from "stripe";
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

export class LiveStripeGateway implements StripeGateway {
  private readonly stripe: Stripe;

  constructor(
    apiKey: string,
    private readonly webhookSecret: string,
  ) {
    this.stripe = new Stripe(apiKey);
  }

  async createCheckout(params: CheckoutParams): Promise<CheckoutResult> {
    // Connect Standard (Spec §7): when the merchant has a connected account, the
    // subscription is created directly on it (Stripe-Account header), and Bouncr
    // takes its cut as a Connect application fee on each invoice. The fee only
    // makes sense on a direct charge to a connected account — settling to the
    // platform's own account (demo / no Connect) carries no fee.
    const options = params.connectedAccountId
      ? { stripeAccount: params.connectedAccountId }
      : undefined;
    const feePercent = connectFee(params.connectedAccountId, params.applicationFeePercent);

    const session = await this.stripe.checkout.sessions.create(
      {
        mode: "subscription",
        success_url: params.successUrl,
        cancel_url: params.cancelUrl,
        client_reference_id: params.endUserRef,
        metadata: { dealId: params.dealId, planKey: params.planKey },
        subscription_data: {
          metadata: { dealId: params.dealId },
          ...(feePercent ? { application_fee_percent: feePercent } : {}),
        },
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: params.currency,
              product_data: { name: `${params.productName} — ${params.planKey} (negotiated)` },
              // Stripe amounts are in the currency's minor unit (cents).
              unit_amount: Math.round(params.amount * 100),
              recurring: { interval: "month" },
            },
          },
        ],
      },
      options,
    );
    if (!session.url) throw new Error("Stripe did not return a Checkout URL");
    return { checkoutId: session.id, url: session.url };
  }

  async updateSubscription(params: SubscriptionUpdateParams): Promise<{ ok: true }> {
    const opts = params.connectedAccountId ? { stripeAccount: params.connectedAccountId } : undefined;
    const sub = await this.stripe.subscriptions.retrieve(params.subscriptionId, undefined, opts);
    const item = sub.items.data[0];
    if (!item) throw new Error(`subscription ${params.subscriptionId} has no items`);
    const price = await this.stripe.prices.create(
      {
        currency: params.currency,
        unit_amount: Math.round(params.amount * 100),
        recurring: { interval: "month" },
        product_data: { name: `${params.productName} (renegotiated)` },
      },
      opts,
    );
    const feePercent = connectFee(params.connectedAccountId, params.applicationFeePercent);
    await this.stripe.subscriptions.update(
      params.subscriptionId,
      {
        items: [{ id: item.id, price: price.id }],
        proration_behavior: "create_prorations",
        ...(feePercent ? { application_fee_percent: feePercent } : {}),
      },
      opts,
    );
    return { ok: true };
  }

  async startConnectOnboarding(params: OnboardingParams): Promise<OnboardingResult> {
    const accountId =
      params.existingAccountId ??
      (await this.stripe.accounts.create({ type: "standard", metadata: { merchantId: params.merchantId } })).id;
    const link = await this.stripe.accountLinks.create({
      account: accountId,
      type: "account_onboarding",
      return_url: params.returnUrl,
      refresh_url: params.refreshUrl,
    });
    return { accountId, url: link.url };
  }

  async getAccountStatus(accountId: string): Promise<AccountStatus> {
    const acct = await this.stripe.accounts.retrieve(accountId);
    return { chargesEnabled: acct.charges_enabled ?? false, detailsSubmitted: acct.details_submitted ?? false };
  }

  parseWebhook(rawBody: string, signature: string | undefined): WebhookEvent {
    if (!signature) throw new Error("missing Stripe-Signature header");
    // Throws on signature mismatch — the caller returns 400 (Spec §12: verified webhooks only).
    const event = this.stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret);

    if (event.type === "checkout.session.completed") {
      const s = event.data.object as Stripe.Checkout.Session;
      const subscriptionId =
        typeof s.subscription === "string" ? s.subscription : (s.subscription?.id ?? null);
      return { type: "checkout.session.completed", checkoutId: s.id, subscriptionId };
    }
    return { type: "ignored" };
  }
}

/**
 * The Connect application fee to apply, or null. A fee only exists on a direct
 * charge to a connected account; clamped to a sane (0, 100] band.
 */
function connectFee(connectedAccountId: string | null | undefined, pct: number | null | undefined): number | null {
  if (!connectedAccountId || !pct || !Number.isFinite(pct) || pct <= 0) return null;
  return Math.min(100, pct);
}
