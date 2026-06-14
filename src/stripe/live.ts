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
    // Connect direct charges (Spec settlement §3): the charge is created DIRECTLY
    // on the merchant's connected account (Stripe-Account header), so the merchant
    // is merchant-of-record; Bouncr takes only an application fee. Money never
    // lands on Bouncr's own account. The idempotency key collapses double-taps to
    // a single session.
    const options: Stripe.RequestOptions = {
      ...(params.connectedAccountId ? { stripeAccount: params.connectedAccountId } : {}),
      ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
    };
    const feePercent = connectFee(params.connectedAccountId, params.applicationFeePercent);
    const amountCents = Math.round(params.amount * 100);
    // Sessions expire so an abandoned checkout cleans up and the deal can re-mint.
    // Stripe requires expires_at to be AT LEAST 30 min out; use a buffer so the
    // boundary (and a few ms of processing) never trips "must be ≥ 30 minutes".
    const expiresUnix = Math.floor(Date.now() / 1000) + 32 * 60;

    const common = {
      success_url: params.successUrl,
      cancel_url: params.cancelUrl,
      client_reference_id: params.endUserRef,
      expires_at: expiresUnix,
      metadata: { dealId: params.dealId, planKey: params.planKey },
    } as const;

    let session: Stripe.Checkout.Session;
    if (params.interval === "one_time") {
      // One-time (day pass): a single PaymentIntent on the connected account,
      // Bouncr's cut as a fixed application_fee_amount.
      const feeAmount = feePercent ? Math.round(amountCents * (feePercent / 100)) : 0;
      session = await this.stripe.checkout.sessions.create(
        {
          ...common,
          mode: "payment",
          payment_intent_data: {
            metadata: { dealId: params.dealId },
            ...(feeAmount > 0 ? { application_fee_amount: feeAmount } : {}),
          },
          line_items: [
            {
              quantity: 1,
              price_data: {
                currency: params.currency,
                product_data: { name: `${params.productName} — ${params.planKey} (negotiated)` },
                unit_amount: amountCents,
              },
            },
          ],
        },
        options,
      );
    } else {
      // Recurring: a subscription on the connected account with a per-invoice
      // application_fee_percent.
      session = await this.stripe.checkout.sessions.create(
        {
          ...common,
          mode: "subscription",
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
                unit_amount: amountCents,
                recurring: { interval: "month" },
              },
            },
          ],
        },
        options,
      );
    }
    if (!session.url) throw new Error("Stripe did not return a Checkout URL");
    return { checkoutId: session.id, url: session.url, expiresAt: (session.expires_at ?? expiresUnix) * 1000 };
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
    // For Connect direct charges the event fires on the connected account, surfaced
    // as `event.account` — carried through for account-scoping in the service.
    const accountId = (event as unknown as { account?: string | null }).account ?? null;

    // Settlement is driven off BOTH checkout.session.completed AND
    // checkout.session.async_payment_succeeded (Stripe fulfillment docs:
    // https://docs.stripe.com/checkout/fulfillment). For instant methods (cards)
    // `completed` arrives already `paid`; for delayed methods (ACH / bank transfer)
    // `completed` arrives `unpaid` and async_payment_succeeded fires later when funds
    // land. Both carry the session with its subscription / payment_intent and a
    // payment_status the service gates on — so we never settle an `unpaid` session.
    // async_payment_failed is recognized but NOT settled (it's a no-op "ignored").
    if (
      event.type === "checkout.session.completed" ||
      event.type === "checkout.session.async_payment_succeeded"
    ) {
      const s = event.data.object as Stripe.Checkout.Session;
      const subscriptionId = typeof s.subscription === "string" ? s.subscription : (s.subscription?.id ?? null);
      const paymentIntentId = typeof s.payment_intent === "string" ? s.payment_intent : (s.payment_intent?.id ?? null);
      return {
        type: "checkout.session.completed",
        eventId: event.id,
        accountId,
        checkoutId: s.id,
        subscriptionId,
        paymentIntentId,
        paymentStatus: s.payment_status ?? null,
      };
    }
    // Everything else (async_payment_failed, invoice.*, payment_intent.*) is a
    // recognized no-op — the deal-already-settled guard makes any overlap idempotent.
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
