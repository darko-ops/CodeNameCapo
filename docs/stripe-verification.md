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

## TODO — confirm in the credentialed (test-keys) session

These need real test-mode keys + a connected test account; they're a **confirmation
checklist**, not an investigation. Set keys per `.env.example`.

- [ ] **Connect webhook scope.** The Stripe webhook endpoint that feeds
      `/v1/webhooks/stripe` is scoped to **Connected accounts** (`connect: true`), NOT
      "Your account". *(If wrong, direct-charge events never arrive → deals charge but
      never settle. This is the #1 silent failure to rule out.)*
- [ ] **`STRIPE_WEBHOOK_SECRET` = the Connect endpoint's secret** (not an account
      endpoint's, not the CLI's unless using `stripe listen`).
- [ ] **4242 subscription end-to-end** on the connected test account: negotiate → pay
      `4242` → confirm `checkout.session.completed` arrives with `event.account` = the
      connected acct, `payment_status: "paid"`, `subscription` set → deal `settled`.
- [ ] **Entitlement delivered.** The signed POST fires and `scripts/example-merchant-webhook.mjs`
      verifies the signature and "grants" at the negotiated price.
- [ ] **Idempotency on real events.** `stripe events resend <id>` (or a natural
      re-delivery) → no double-settle, entitlement is an idempotent no-op.
- [ ] **Account-scoping.** A `checkout.session.completed` whose `account` ≠ the deal's
      merchant is rejected (`webhook.account_mismatch`).
- [ ] **One-time / day-pass path** (`mode: payment`): `payment_intent` set, settles.
- [ ] **Renegotiation reprice** (`updateSubscription` on the connected account) applies
      the new price + keeps the application fee.
- [ ] **Postgres money-guarantees.** Run the suite with `DATABASE_URL` set; confirm the
      single-use proof (`redeemProof` atomic burn) and settlement idempotency hold on
      Postgres, not just MemoryStore.
- [ ] **Delayed-method gate (optional).** If feasible, drive a test ACH/delayed method:
      `completed` arrives `unpaid` → NOT settled; `async_payment_succeeded` → settles.

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
