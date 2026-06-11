/**
 * Stripe gateway (Spec §7). Principle: Bouncr never touches money — it produces
 * a number and hands off to Stripe Checkout. This kills ~80% of compliance scope.
 *
 * Two implementations:
 *   - fake.ts — sandbox / `test_` keys / tests. Generates fake checkout URLs and
 *     trusts a plain-JSON webhook body (no signature).
 *   - live.ts — the real Stripe SDK: per-deal Price + Checkout Session, and
 *     signature-verified webhook parsing.
 */

export interface CheckoutParams {
  planKey: string;
  productName: string;
  amount: number; // dollars
  currency: string;
  endUserRef: string;
  dealId: string;
  successUrl: string;
  cancelUrl: string;
  /** Connected Stripe account (acct_...) to settle into — Connect (Spec §7, Phase 3). */
  connectedAccountId?: string | null;
  /**
   * Bouncr's take-rate as a % of each recurring invoice (Stripe Connect
   * `application_fee_percent`, 0–100). Only applied on a direct charge to a
   * connected account; ignored when settling to the platform's own account.
   */
  applicationFeePercent?: number | null;
}

export interface OnboardingParams {
  merchantId: string;
  /** Reuse an in-progress connected account, or create a fresh one when absent. */
  existingAccountId?: string | null;
  returnUrl: string;
  refreshUrl: string;
}

export interface OnboardingResult {
  accountId: string;
  url: string;
}

export interface AccountStatus {
  chargesEnabled: boolean;
  detailsSubmitted: boolean;
}

export interface CheckoutResult {
  checkoutId: string;
  url: string;
}

/** Normalized webhook event — only what Phase 1 settlement cares about. */
export type WebhookEvent =
  | { type: "checkout.session.completed"; checkoutId: string; subscriptionId: string | null }
  | { type: "ignored" };

export interface SubscriptionUpdateParams {
  subscriptionId: string;
  productName: string;
  amount: number; // dollars
  currency: string;
  connectedAccountId?: string | null;
  /** Take-rate to keep applied after a reprice (Connect application fee, 0–100). */
  applicationFeePercent?: number | null;
}

export interface StripeGateway {
  /** Create a subscription Checkout Session at the negotiated price. */
  createCheckout(params: CheckoutParams): Promise<CheckoutResult>;

  /** Reprice an existing subscription (renegotiation acceptance, Spec §6/§7). */
  updateSubscription(params: SubscriptionUpdateParams): Promise<{ ok: true }>;
  /**
   * Verify (live) + parse a raw webhook body into a normalized event.
   * Throws on signature failure (live only).
   */
  parseWebhook(rawBody: string, signature: string | undefined): WebhookEvent;

  // --- Connect onboarding (Spec §7 Connect Standard, Phase 3) --------------
  /** Create (or reuse) a connected account and return an onboarding link. */
  startConnectOnboarding(params: OnboardingParams): Promise<OnboardingResult>;
  /** Whether a connected account can accept charges yet. */
  getAccountStatus(accountId: string): Promise<AccountStatus>;
}
