# Bouncr — Policy Engine

[![Live demo](https://img.shields.io/badge/live%20demo-bouncr.tech-7C3AED?style=flat-square&logo=googlechrome&logoColor=white)](https://bouncr.tech)

The deterministic pricing core (Spec §4 / Appendix A). Pure functions, **zero runtime
dependencies**. The LLM and the numbers never touch: the conversation layer extracts a
user's offer into a number, this engine decides `accept` / `counter` / `hold` / `walk`,
and the only price that ever reaches Stripe is the amount in an `accept` action.

A user who jailbreaks the persona gets charm, not discounts — that property is
**architectural**, proven below, not prompt-deep.

## Guarantees (Spec §4.4)

Each is enforced in `src/engine.ts` and proven by fast-check property tests
(`src/engine.test.ts`, 2000 generated cases per property):

| | Invariant | Where |
|---|---|---|
| **I1** | An accepted (or countered) price is **always** ≥ `floorPrice`. No exception path exists; `accept()` also asserts it at runtime. | `I1: price never below floor` |
| **I2** | The engine's ask is **monotonically non-increasing** across a cold-start negotiation, conceding at least `minConcession` per round until it bottoms out at the floor. | `I2: ask is monotone non-increasing` |
| **I3** | Rounds and the expiry timer are evaluated server-side here. At/after `maxRounds` the only actions are `accept`, a final `counter`, or `walk`; past expiry it always `walk`s. | `I3: round/timer enforcement` |
| **I4** | `decide()` is a pure function of `(state, offer, config, now)` — fully deterministic and replayable. | `I4: determinism` |

## The math (Spec §4.3)

The ask at round *n* decays from the anchor toward the **target** (not the floor — the
floor is a circuit breaker, not a destination):

```
ask(n) = targetPrice + (anchor − targetPrice) · e^(−λn)        anchor = listPrice · anchorMultiplier
```

Counters split the difference biased ~70% toward our ask (softening each round, never
past the true midpoint — pure midpoint converges too fast and trains lowballing). The
engine accepts immediately if the user clears `targetPrice` (never haggle past target) or
meets the standing ask within `acceptThreshold` — in both cases only if the offer also
clears the floor.

> Note: this fixes the Appendix A sketch's concession-step direction. To guarantee
> "never concede less than `minConcession`", the next ask must drop by *at least*
> `minConcession` — `min(curve, ask − minConcession)`, not the sketch's `Math.max(...)`.

## Use

```ts
import { openSession, decide, applyAction, type Config } from "./src/engine.js";

const cfg: Config = {
  listPrice: 30, floorPrice: 8, targetPrice: 22, anchorMultiplier: 1.6,
  maxRounds: 6, maxDurationH: 48, acceptThreshold: 0.97, minConcession: 0.5, lambda: 0.6,
};

let s = openSession(cfg, Date.now());      // opens at the anchor ($48)
const action = decide(s, /*userOffer*/ 18, cfg, Date.now());
if (action.type === "counter") s = applyAction(s, 18, action);
// action.amount is the ONLY number the renderer/Stripe may use.
```

## The conversation layer (Spec §5)

The LLM and the numbers never touch. One turn flows:

```
user message
  → Extractor  (Haiku, structured output)  {intent, offer_amount?, sentiment, tactics[]}   src/llm/extractor.ts
  → Engine     (deterministic)             (state, offer) → action                          src/engine.ts
  → Renderer   (Sonnet, in character)      action → reply text                              src/llm/renderer.ts
  → Validator  (deterministic, MANDATORY)  reply states ONLY the permitted number           src/llm/validator.ts
  → send
```

- **Extractor** (`claude-haiku-4-5`) classifies the message and pulls out any offered number via **structured outputs** — we never regex a price from free text.
- **Engine** is the only thing that decides a price. `action.amount` is the sole number that may ever reach Stripe.
- **Renderer** (`claude-sonnet-4-6`) is told exactly one permitted amount and nothing about the floor or target. It cannot accept, hint at, or compute any other number.
- **Validator** deterministically proves the rendered text leaked no other number and didn't fabricate an acceptance. On failure it re-renders once, then falls back to a guaranteed-safe **template**. This is what makes "the bouncer that can't be jailbroken" architectural, not prompt-deep — a jailbroken persona gets charm, not a discount.

`runTurn()` in `src/llm/pipeline.ts` wires it together and advances the engine state. Abuse → `walk` (Spec §12); social-engineering offers never carry a number into the engine.

### Red-team it

```
ANTHROPIC_API_KEY=sk-... npm run haggle
```

A CLI chat against the full pipeline, with per-turn `[intent · offer · tactics · → action]` traces and any `[validator blocked: …]` events shown inline. Phase 0 exit criterion: you cannot talk it below the floor.

## Phase 1 — settle real money (Spec §7–§9)

Persistence + Stripe Checkout handoff + webhook settlement, behind the HTTP API. Everything runs **offline in sandbox mode** (no keys) and swaps to live by setting secrets — *which* secret is present decides each part independently (Spec §9, sandbox from day one).

```
src/
├── service.ts          # BouncrService: negotiate → persist → checkout → settle (server-authoritative)
├── app.ts              # Hono HTTP API (§9 endpoints)
├── server.ts           # node entry — `npm run serve`
├── config.ts           # demo plan + env-based dependency wiring
├── store/              # Store interface · memory.ts (tested) · postgres.ts (deploy)
├── stripe/             # gateway interface · fake.ts (sandbox) · live.ts (Stripe SDK)
└── llm/negotiator.ts   # Anthropic pipeline OR deterministic template (sandbox/tests)
db/schema.sql           # Postgres data model (§8)
```

### API (Spec §9)

```
POST /v1/sessions                {plan_id, end_user_ref, context?} → {session_id, opener_message}
POST /v1/sessions/:id/messages   {message} → {reply, state, action, checkout_url?}
POST /v1/sessions/:id/accept     → {checkout_url, deal_id, price}
GET  /v1/deals/:id
POST /v1/webhooks/stripe         (raw body + Stripe-Signature) → settles the deal
```

The widget is a dumb terminal: rounds, the timer, and the **price** are decided server-side and never trusted from the client. The only number that reaches Stripe is an engine `accept` amount.

### Run it (sandbox — no external services)

```
npm run serve     # http://localhost:8787 · stripe: sandbox · negotiator: sandbox
```

```bash
curl -sX POST localhost:8787/v1/sessions -d '{"plan_id":"plan_demo","end_user_ref":"me"}'
curl -sX POST localhost:8787/v1/sessions/<id>/messages -d '{"message":"I will give you 5 bucks"}'
curl -sX POST localhost:8787/v1/sessions/<id>/accept
# webhook (sandbox body): {"type":"checkout.session.completed","checkoutId":"cs_test_...","subscriptionId":"sub_x"}
```

### Going live

| Set | Switches | To |
|---|---|---|
| `ANTHROPIC_API_KEY` | negotiator | real Haiku/Sonnet pipeline |
| `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` | Stripe | real Checkout + signature-verified webhooks |
| `DATABASE_URL` | store | Postgres (`psql "$DATABASE_URL" -f db/schema.sql` first) |
| `BOUNCR_API_KEY` | auth | `x-api-key` required on `/v1/*` (webhook exempt) |
| `BOUNCR_BASE_URL` | redirects | Stripe success/cancel URLs |

> Stripe settles into **your own** account in Phase 1; Connect (settle into the merchant's account) is Phase 3.

### Live Postgres (validated)

The `PostgresStore` is wired in automatically when `DATABASE_URL` is set, and has been smoke-tested end-to-end against Postgres 16 — every store method (sessions, turns, deals, usage cycles, cooldowns, merchants, the reneg flows) exercised through the real HTTP API.

```bash
# 1. stand up Postgres (any instance works; throwaway container shown)
docker run -d --name bouncr-pg -e POSTGRES_PASSWORD=bouncr -e POSTGRES_DB=bouncr -p 5439:5432 postgres:16-alpine
export DATABASE_URL="postgres://postgres:bouncr@localhost:5439/bouncr"

# 2. apply schema + seed the demo merchant/plan
docker exec -i bouncr-pg psql -U postgres -d bouncr < db/schema.sql
docker exec -i bouncr-pg psql -U postgres -d bouncr < db/seed.sql
#   (or, with a local psql:  psql "$DATABASE_URL" -f db/schema.sql -f db/seed.sql)

# 3. run — the boot line reports `store: postgres`
npm run serve
```

Both `schema.sql` and `seed.sql` are idempotent (re-runnable).

## Phase 2 — embeddable widget (Spec §10)

A drop-in negotiation widget that works on any stack: **script tag → iframe**. The widget never holds the merchant key — it operates on a per-session **session token** (Spec §9), issued at creation and naturally short-lived (it dies with the session).

```
src/widget/
├── widget.html   # self-contained chat UI: streaming typing, typewriter reveal,
│                 #   offer quick-chips, screenshot-worthy deal screen w/ "negotiated via Bouncr",
│                 #   expiry countdown, accessible <noscript> fallback
├── embed.js      # script-tag loader → iframe + postMessage bridge (onDeal/onWalkaway)
├── demo.html     # public playground (Spec §15) served at GET /
└── assets.ts     # serves the above (read at runtime — no build step)
```

### Embed it

```html
<!-- one tag, auto-mount -->
<script src="https://bouncr.tech/embed.js"
        data-plan="pro_monthly" data-user="user_123"
        data-mount="#bouncr" data-fallback="https://yourapp.com/pricing"></script>
```

```js
// or programmatically
Bouncr.mount({
  el: "#bouncr", planId: "pro_monthly", userRef: user.id,
  theme: { accent: "7C3AED" },
  onDeal: (d) => { window.location = d.checkoutUrl },   // default if omitted
  onWalkaway: () => showStandardPricing(),
});
```

### Auth split (Spec §9)

| Surface | Credential | Routes |
|---|---|---|
| Merchant server | `x-api-key` (when `BOUNCR_API_KEY` set) | `POST /v1/sessions`, `GET /v1/deals/:id` |
| Widget (browser) | `x-session-token` (or `Authorization: Bearer`) | messages, stream, accept, session view |

The merchant's server creates the session with its key and hands the widget the `session_token`; a token is scoped to its one session (cross-session use → 401).

### Streaming

`POST /v1/sessions/:id/messages/stream` is **SSE**: a `typing` event fires immediately, then a single `reply` event once the full Extract→Engine→**Validate** turn completes. The reply is only sent *after* validation, so a hallucinated number can never reach the browser — the widget does a client-side typewriter reveal for the texting feel (Spec §10: "latency is tolerated, dead air is not"). The non-streaming `POST .../messages` remains for non-browser callers.

### See it

```
npm run serve     # then open http://localhost:8787  (playground)
#                   /widget is the bare iframe target; /embed.js is the loader
```

## Phase 3 — first external merchants (Spec §7, §11, §12)

Stripe Connect onboarding, a merchant dashboard, config linting, walkaway cooldowns, and message-cap abuse hardening.

```
src/
├── lint.ts             config linter (§12) — errors (floor=$0, target≤floor…) + warnings
├── analytics.ts        WTP analytics (§11) — funnel, offer distribution, closing stats, tactics
└── widget/dashboard.html   merchant dashboard (served at /dashboard)
```

### Stripe Connect (§7)
Deals settle into the **merchant's** account once onboarded (Connect Standard, direct charges via the `Stripe-Account` header — no platform fee in v1).

```
POST /v1/merchants/:id/connect/onboard   {return_url?} → {url, account_id}
GET  /v1/merchants/:id/connect           → {connected, account_id, charges_enabled}
```
`closeDeal` routes the checkout to `merchant.stripeConnectId` when present, else the platform account.

### Dashboard + analytics (§11) — merchant key
```
GET /dashboard                       funnel · offer-distribution histogram · transcript viewer · Connect status · lint
GET /v1/analytics/wtp?plan_id=        → funnel, firstOffers + closingPrices vs list/target/floor, median, revenue vs list, tactics
GET /v1/plans/:id/sessions            recent negotiations (transcript index)
GET /v1/sessions/:id/transcript       full transcript w/ per-turn extractor + engine snapshots
GET /v1/plans/:id/lint                config lint result
```
The offer-distribution histogram is the chart that shows a founder their true demand curve — every first offer and closing price against the list/target/floor lines.

### Abuse hardening (§12)
- **Config linting** runs at boot (warns loudly) and on demand; `floor = $0` is a hard error.
- **Walkaway cooldown** per `end_user_ref`+plan (`policy.cooldownHours`, default 72) — a fresh session during cooldown returns `409 {code:"conflict", retry_at}`.
- **Message cap** per session (`policy.maxMessages`, default 30) — exceeding it ends the session as a walk (and starts the cooldown).

Open the dashboard at `http://localhost:8787/dashboard` after `npm run serve`.

## Phase 4 — the moat: renegotiation (Spec §6)

Price changes as conversations — the differentiator no billing platform has. Usage ingestion → breach-streak evaluation → renegotiation, with grandfathering so access is never cut.

```
src/reneg.ts        builds the reneg engine config (§6.2) — pure, property-tested
src/service.ts      reportUsage / renegotiateDeal / settleReneg / grandfather
src/analytics.ts    + reneg metrics (repricing tolerance, §6.4)
```

### The key idea
Reneg **reuses the same `decide()` engine**. `buildRenegConfig` produces a reneg-specific config where:
- `floor = max(currentPrice, trailing-COGS × margin)` — never below what they pay now, never below cost
- `anchor = currentPrice × 1.5–2.0` — **relative** to the current price (a $9 user sees ~$15, not the cold-start $48)
- `target` scales with how badly they overused, capped at the anchor

`floor < target < anchor` holds, so every §4.4 invariant carries over and the close is provably `≥ current ≥ cost`. No mirrored math.

### Trigger (§6.1)
```
POST /v1/usage  {deal_id, cycle, value}   → {breach, breach_streak, renegotiation?}
```
Breach = usage > band ceiling. A renegotiation opens only after **consecutive** breaches (`breachCyclesRequired`, default 3) — a viral week won't reopen the deal; a sustained change will. A single good cycle resets the streak.

### Flow
- Opening fires `POST /v1/deals/:id/renegotiate` (or auto from usage) → returns a reneg **session + token**; the user haggles via the same Phase 2 widget/endpoints.
- **Acceptance reprices the existing subscription** (`subscriptions.update`, §7) — no re-checkout.
- **Walk / ghost / message-cap → grandfather** to the fair tier (the reneg target). Access is never hard-cut (§6.2) — a revenue event never becomes a churn event.
- **Downward reneg** (§6.3, `usage.downwardEnabled`, off by default): sustained under-use proactively offers a lower price.

### Analytics v2 (§6.4)
`GET /v1/analytics/wtp` now includes `reneg: {opened, up, down, accepted, grandfathered, avgUpliftPct}` — repricing tolerance over time, a dataset no billing platform has.

> Not built (GTM/infra, out of scope for this repo): the SMS/iMessage channel (needs Twilio/Sendblue), config A/B experiments, and the public launch. The "negotiated via Bouncr" viral mark already ships in the Phase 2 deal screen.

## Scripts

```
npm install
npm test         # vitest: engine + validator + service/HTTP/widget/SSE + lint/analytics/cooldown/connect + reneg/usage (no API key)
npm run typecheck
npm run haggle   # live CLI negotiation (needs ANTHROPIC_API_KEY)
npm run serve    # HTTP API + widget + dashboard (sandbox by default)
npm run build    # emits dist/
```

## Models

| Stage | Model | Why |
|---|---|---|
| Extractor | `claude-haiku-4-5` | Classification task — small/fast, structured outputs |
| Renderer | `claude-sonnet-4-6` | Persona quality is the product surface |

A 6-round negotiation is ~12 LLM calls ≈ low single-digit cents (Spec §5.5) — irrelevant against LTV.
