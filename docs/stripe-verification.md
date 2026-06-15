# Stripe verification runbook (Roadmap Step 2)

Prove the money path against **real test-mode Stripe** — the settlement half has only
ever run against the fake gateway. This doc records what was verified in code (no
keys needed) and the exact **confirmation checklist** for the credentialed session.

> **Mode discipline:** everything here is **test mode**. The single live charge is a
> separate, deliberate step at the bottom — and the live-mode boot guard
> (`assertLiveBootSecrets`) must pass before any live key is set.

---

## ⚠️ Settlement-event fix shipped in this pass (the headline)

The verification surfaced a real silent-failure risk in how settlement was driven —
**not** the one anticipated (the subscription id *is* reliably on the session), but a
worse one. Fixed in code + tests this pass:

**Before:** settlement was driven off `checkout.session.completed` **unconditionally**,
and `async_payment_succeeded` / `async_payment_failed` were explicitly ignored.

**Two silent failures that hides:**
1. A **delayed payment method** (ACH, bank transfer) leaves the session
   `payment_status: "unpaid"` at `completed` time — so we'd have **granted entitlement
   for money that hadn't moved** (and might still fail).
2. Those delayed payments only succeed later, via
   `checkout.session.async_payment_succeeded` — which we **ignored**, so a genuinely
   paid delayed checkout would have **never settled**.

**After (per [Stripe fulfillment docs](https://docs.stripe.com/checkout/fulfillment)):**
- Settlement is driven off **both** `checkout.session.completed` **and**
  `checkout.session.async_payment_succeeded` (`live.ts` / `fake.ts` `parseWebhook`).
- The normalized event carries `paymentStatus`, and the service **refuses to settle an
  `unpaid` session** (`handleStripeEvent` → records `webhook.unpaid`, returns
  `settled: false`); it settles when the paid event arrives.
- `async_payment_failed` is a recognized no-op.
- Cards (`4242`) arrive `completed` + `paid`, so the demo/common path is unchanged.

Covered by `src/stripe/live.test.ts` (normalization) and `src/service.test.ts`
("settlement gates on payment_status").

---

## What was verified against the docs (no keys needed)

| Question | Finding (with source) |
|---|---|
| Which events settle a Checkout? | `completed` **+** `async_payment_succeeded` (+ `async_payment_failed`). [fulfillment](https://docs.stripe.com/checkout/fulfillment) |
| Gate on `payment_status`? | Yes — fulfill only when `payment_status != "unpaid"` (delayed methods complete `unpaid`). [fulfillment](https://docs.stripe.com/checkout/fulfillment) |
| Subscription id on the session? | Yes — after success the session references "the successful PaymentIntent or an active Subscription". So the anticipated "id missing" worry is **not** a bug. |
| Where do direct-charge events fire? | On the **connected account**; the platform receives them via a webhook scoped to **Connected accounts** (`connect: true`). A "Your account"-scoped endpoint will **not** receive them. [Connect webhooks](https://docs.stripe.com/connect/webhooks) |
| Is the connected account on the event? | Yes — top-level `account` property (the code reads `event.account` → `accountId`, and `handleStripeEvent` rejects an account mismatch). [Connect webhooks](https://docs.stripe.com/connect/webhooks) |
| Which signing secret? | The **Connect endpoint's** signing secret → that's what `STRIPE_WEBHOOK_SECRET` must be in live. |

---

## The money path (recap)

negotiate → engine `accept` → hosted checkout (`/checkout/:id?proof=`, single-use proof)
→ `LiveStripeGateway.createCheckout` (Connect **direct charge** on the merchant's
account, `application_fee_percent`) → Stripe → webhook `checkout.session.completed`
(scoped by `event.account`) → `handleStripeEvent` (idempotent, account-scoped,
**payment_status-gated**) → deal `settled` → signed entitlement POST to the merchant
(`Bouncr-Signature`).

---

## VERIFIED LIVE — 2026-06-15, test mode

Run against **real test-mode Stripe** via the Stripe CLI (`stripe listen
--forward-connect-to`), local app on `:8787` booted with the live gateway
(`stripe: live`), MemoryStore. The merchant under test had no connected account, so
charges ran on the **platform** test account (`event.account = null`); the connected
direct-charge + fee path is the one item held for live cutover (see below). No
code/Stripe divergence found — the settlement-event fix behaves exactly as designed.

- [x] **Connect webhook scope.** Satisfied locally via `stripe listen
      --forward-connect-to …` (the CLI equivalent of a `connect: true` endpoint).
      `checkout.session.completed` reached `/v1/webhooks/stripe` with `[200]`.
- [x] **`STRIPE_WEBHOOK_SECRET` matches the listener's secret** — every forwarded event
      verified (`200`); a tampered signature returned **`400`** (rejected pre-processing).
- [x] **4242 subscription end-to-end.** Real browser checkout (`4242`) → paid
      `checkout.session.completed` → deal `pending → settled` with a real
      `stripe_subscription_id` (`sub_…`) and `customer.subscription.created` processed.
- [x] **Entitlement delivered.** `scripts/example-merchant-webhook.mjs` received the
      signed POST, **verified `Bouncr-Signature`**, and granted: `✓ GRANT … at $48.00
      USD/mo`.
- [x] **`payment_status` gate (the #1 silent failure).** A validly-signed `unpaid`
      `completed` for a real deal's session → **not** settled (stayed `pending`,
      `webhook.unpaid`); the same session `paid` → `settled`.
- [x] **Idempotency.** Re-firing the paid event → `settled: true`, no double-settle.
- [x] **Account-scoping.** A `paid` event stamped with a foreign `account`
      (`acct_FOREIGN999`) → `settled: false`, deal stayed `pending`
      (`webhook.account_mismatch`).
- [x] **Delayed-method (ACH) path.** `completed`/`unpaid` → stayed `pending`; later
      `checkout.session.async_payment_succeeded`/`paid` → `settled`.
- [x] **Postgres money-guarantees.** Green in CI (`postgres` job: `redeemProof` atomic
      single-use under concurrency + the dual-store contract on real Postgres).

### Held for live cutover (not exercised this pass)

- [ ] **Connected-account direct charge + application fee.** This pass used the platform
      account; onboard a test connected account and confirm `event.account = acct_…`
      matches the deal's merchant and the `application_fee_percent` is applied. *(Logic
      is account-scope-tested above with a synthetic acct; the real direct charge is the
      remaining live item.)*
- [ ] **Deployed endpoint scope = `connect: true`.** The local CLI proved the path; the
      production Stripe **Dashboard** webhook endpoint feeding the deployed
      `/v1/webhooks/stripe` must be **Connected-accounts**-scoped, and
      `STRIPE_WEBHOOK_SECRET` set to *that* endpoint's secret.
- [ ] **One-time / day-pass path** (`mode: payment`, `payment_intent` set). Demo plan is
      monthly; covered by `src/service.test.ts`, not exercised live here.
- [ ] **Renegotiation reprice** (`updateSubscription` on the connected account) — covered
      by tests; live with a real connected account at cutover.
- [ ] **Rotate the test secret key** (`sk_test_…` was pasted in chat) — Dashboard →
      Developers → API keys → roll.

## One small LIVE charge (separate, deliberate step — do last)

ONLY after the test-mode checklist is fully clean:
- [ ] Live keys set; `assertLiveBootSecrets` passes (no default/placeholder secrets).
- [ ] A single small **real** charge at a low negotiated price, end to end.
- [ ] Entitlement granted; then **refund** it. This is the milestone.

---

## Reference merchant consumer

`scripts/example-merchant-webhook.mjs` — a minimal, copy-pasteable consumer of the
signed entitlement webhook (verifies `Bouncr-Signature`, rejects replays, idempotent on
`deal_id`, "grants" at `$amount`). Use it as the merchant side for the test-mode run:

```
BOUNCR_MERCHANT_SECRET="<merchant outbound secret>" node scripts/example-merchant-webhook.mjs
# then set the merchant's webhook URL to http://localhost:4000 (e.g. via a tunnel)
```
