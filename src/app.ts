/**
 * HTTP API (Spec §9) + embeddable widget (Spec §10). Hono app — a thin,
 * server-authoritative shell over BouncrService. The widget is a dumb terminal:
 * rounds, timers, and prices are decided here, never trusted from the client.
 *
 *   POST /v1/sessions                      {plan_id, end_user_ref} → {session_id, session_token, opener_message, expires_at}
 *   GET  /v1/sessions/:id                   (session token) → {status, round, current_ask, expires_at}
 *   POST /v1/sessions/:id/messages          (session token) {message} → {reply, state, action, checkout_url?}
 *   POST /v1/sessions/:id/messages/stream   (session token) {message} → SSE: typing → reply
 *   POST /v1/sessions/:id/accept            (session token) → {checkout_url}
 *   GET  /v1/deals/:id                      (merchant key)
 *   POST /v1/webhooks/stripe                (raw body + Stripe-Signature)
 *   GET  /widget                            embeddable chat UI (iframe target)
 *   GET  /embed.js                          script-tag loader (creates the iframe)
 *
 * Auth split (Spec §9): the merchant's API key (server-side) gates session
 * creation and deal reads. The widget never holds that key — it operates on a
 * per-session `session_token` returned at creation.
 */
import { Hono, type Context, type Next } from "hono";
import { streamSSE } from "hono/streaming";
import type { StripeGateway } from "./stripe/gateway.js";
import { BouncrService, ServiceError } from "./service.js";
import { RateLimiter, type RateRule } from "./ratelimit.js";
import { signSession, verifySession, signReset, verifyReset } from "./auth.js";
import type { Mailer } from "./mailer.js";
import { dispatchMcp } from "./mcp.js";
import { normalizePhone, verifyTwilioSignature, twiml } from "./sms.js";
import { WIDGET_HTML, EMBED_JS, SMS_HTML, DEMO_HTML, DASHBOARD_HTML, LANDING_HTML, ONBOARD_HTML, RESET_HTML } from "./widget/assets.js";
import { FAVICON_ICO_B64, ICON_16_B64, ICON_32_B64, APPLE_TOUCH_B64, ICON_192_B64, ICON_512_B64 } from "./widget/icons.generated.js";

export interface AppDeps {
  service: BouncrService;
  stripe: StripeGateway;
  /** When set, server routes (session create, deals, usage) require this in `x-api-key`. */
  apiKey: string | null;
  /** HMAC secret for signing dashboard session tokens. */
  authSecret: string;
  /** True only when a real (live) Stripe gateway is configured. Sandbox/fake = false. */
  stripeLive?: boolean;
  /** Sends transactional email (password reset). Console logger in the sandbox. */
  mailer: Mailer;
  /** Twilio auth token — when set, inbound SMS webhooks must carry a valid
   *  X-Twilio-Signature. Null/absent (sandbox) skips verification. */
  smsAuthToken?: string | null;
}

/** Dashboard session lifetime. */
const DASHBOARD_TTL_MS = 12 * 60 * 60 * 1000;
/** Password-reset link lifetime — short, since the email arrives in seconds. */
const RESET_TTL_MS = 60 * 60 * 1000;

const STATUS: Record<ServiceError["code"], 400 | 401 | 404 | 409> = {
  bad_request: 400,
  unauthorized: 401,
  not_found: 404,
  conflict: 409,
};

// Invisible rate limits, keyed by client IP. Generous for a human haggling
// (the widget blocks sending until each reply lands, so a real user can't even
// approach these), tight for a script hammering the LLM endpoints.
const MSG_RULES: readonly RateRule[] = [
  { windowMs: 3_000, max: 6 }, // no rapid-fire (anti-bot burst)
  { windowMs: 60_000, max: 30 }, // sustained per-minute ceiling
];
const SESSION_RULE: RateRule = { windowMs: 600_000, max: 15 }; // new sessions / IP / 10 min (public demo only)
// SMS-pumping guard: outbound texts cost real money, so the keyless start
// endpoint is capped per IP AND per destination number (a flood aimed at one
// victim's phone is throttled even when it rotates IPs).
const SMS_START_RULES: readonly RateRule[] = [
  { windowMs: 60_000, max: 3 },
  { windowMs: 3_600_000, max: 10 },
];
const SMS_PHONE_RULES: readonly RateRule[] = [{ windowMs: 3_600_000, max: 4 }];

// In-character throttle lines — shown instead of a 429 so it reads as the
// bouncer talking, not an error. No LLM call is made, so a throttled turn is free.
const THROTTLE_LINES = [
  "ok ok slow down, im only one guy here 😤 gimme a sec",
  "easy speed racer — one at a time",
  "yo chill, i cant keep up if u spam me like that",
  "one message at a time champ, im not a vending machine",
];

export function buildApp(deps: AppDeps): Hono<{ Variables: { merchantId: string } }> {
  const app = new Hono<{ Variables: { merchantId: string } }>();
  const { service, stripe } = deps;
  const limiter = new RateLimiter();
  let throttleIdx = 0;
  const throttleReply = () => THROTTLE_LINES[throttleIdx++ % THROTTLE_LINES.length]!;

  app.get("/healthz", (c) => c.json({ ok: true }));

  // Public JWKS for settlement proofs — merchants verify Bouncr-issued tokens.
  app.get("/.well-known/bouncr-jwks.json", (c) => {
    c.header("cache-control", "public, max-age=3600");
    return c.json(service.publicJwks());
  });

  // --- merchant dashboard auth (Spec §9) -----------------------------------
  // Merchants log in with email + password; login exchanges them for a
  // short-lived signed token (stateless HMAC — no session store, works across
  // serverless instances). Dashboard reads are gated by this token AND scoped to
  // the token's merchant.
  app.post("/v1/auth/login", async (c) => {
    if (!limiter.hitAll(clientIp(c), [{ windowMs: 60_000, max: 10 }])) {
      return c.json({ error: "too many attempts, try again shortly", code: "unauthorized" }, 429);
    }
    const body = await safeJson(c);
    const email = str(body.email);
    const password = str(body.password);
    try {
      const merchant = await service.authenticatePassword(email ?? "", password ?? "");
      const { token, expiresAt } = signSession(merchant.id, deps.authSecret, DASHBOARD_TTL_MS, Date.now());
      return c.json({ token, expires_at: expiresAt, merchant: { id: merchant.id, name: merchant.name } });
    } catch {
      return c.json({ error: "invalid email or password", code: "unauthorized" }, 401);
    }
  });

  const dashboardAuth = async (c: Context<{ Variables: { merchantId: string } }>, next: Next) => {
    const token = bearer(c.req.header("authorization")) ?? c.req.header("x-dashboard-token");
    const v = token ? verifySession(token, deps.authSecret, Date.now()) : null;
    if (!v) return c.json({ error: "login required", code: "unauthorized" }, 401);
    c.set("merchantId", v.merchantId);
    await next();
  };

  app.get("/v1/auth/me", dashboardAuth, async (c) => {
    const info = await service.getMerchantInfo(c.get("merchantId"));
    if (!info) return c.json({ error: "merchant not found", code: "not_found" }, 404);
    return c.json({ merchant: info });
  });

  // Rotate the merchant's API key: mints a new one (returned ONCE) and invalidates
  // the old immediately. The current dashboard token stays valid until it expires.
  app.post("/v1/auth/rotate-key", dashboardAuth, async (c) => {
    if (!limiter.hitAll(clientIp(c), [{ windowMs: 60_000, max: 5 }])) {
      return c.json({ error: "too many attempts, slow down", code: "conflict" }, 429);
    }
    const key = await service.provisionMerchantKey(c.get("merchantId"));
    return c.json({ key });
  });

  // Change the dashboard password — requires the current password (re-auth).
  app.post("/v1/auth/change-password", dashboardAuth, async (c) => {
    if (!limiter.hitAll(clientIp(c), [{ windowMs: 60_000, max: 5 }])) {
      return c.json({ error: "too many attempts, slow down", code: "conflict" }, 429);
    }
    const b = await safeJson(c);
    await service.changePassword(c.get("merchantId"), str(b.current_password) ?? "", str(b.new_password) ?? "");
    return c.json({ ok: true });
  });

  // Forgot password: email a single-use reset link. ALWAYS returns 200 — never
  // reveals whether an account exists (no enumeration). Keyless + rate-limited.
  app.post("/v1/auth/forgot-password", async (c) => {
    if (!limiter.hitAll(clientIp(c), [{ windowMs: 60_000, max: 5 }, { windowMs: 3_600_000, max: 20 }])) {
      return c.json({ ok: true }); // silently drop — same shape as success
    }
    const email = str((await safeJson(c)).email);
    if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      const ctx = await service.lookupForReset(email);
      if (ctx) {
        const { token } = signReset(ctx.merchantId, ctx.fingerprint, deps.authSecret, RESET_TTL_MS, Date.now());
        const link = `${baseFromReq(c)}/reset?token=${encodeURIComponent(token)}`;
        try {
          await deps.mailer.send({
            to: email.trim(),
            subject: "Reset your Bouncr password",
            html: resetEmailHtml(ctx.name, link),
            text: `Reset your Bouncr password (link expires in 1 hour):\n\n${link}\n\nIf you didn't request this, ignore this email.`,
          });
        } catch (err) {
          console.error("[forgot-password] mail send failed:", msg(err));
        }
      }
    }
    return c.json({ ok: true });
  });

  // Complete a reset: verify the emailed token, set the new password.
  app.post("/v1/auth/reset-password", async (c) => {
    if (!limiter.hitAll(clientIp(c), [{ windowMs: 60_000, max: 10 }])) {
      return c.json({ error: "too many attempts, slow down", code: "conflict" }, 429);
    }
    const b = await safeJson(c);
    const v = verifyReset(str(b.token) ?? "", deps.authSecret, Date.now());
    if (!v) return c.json({ error: "this reset link is invalid or has expired", code: "bad_request" }, 400);
    await service.resetPassword(v.merchantId, v.fingerprint, str(b.new_password) ?? "");
    return c.json({ ok: true });
  });

  // --- merchant signup / onboarding (Spec §9) ------------------------------
  // Public + rate-limited. Creates a merchant, mints its dashboard key (returned
  // ONCE), and signs them straight in so onboarding can continue.
  app.post("/v1/signup", async (c) => {
    if (!limiter.hitAll(clientIp(c), [{ windowMs: 60_000, max: 5 }, { windowMs: 86_400_000, max: 60 }])) {
      return c.json({ error: "too many signups, try again later", code: "conflict" }, 429);
    }
    const body = await safeJson(c);
    // Optionally create the first plan in the SAME call so nothing is persisted
    // until the user finishes onboarding (account isn't "fulfilled" until the end).
    const pb = isRecord(body.plan) ? body.plan : null;
    const planInput = pb
      ? {
          productName: str(pb.product_name) ?? "",
          listPrice: num(pb.list_price) ?? NaN,
          floorPrice: num(pb.floor_price) ?? NaN,
          ...(num(pb.target_price) !== null ? { targetPrice: num(pb.target_price)! } : {}),
          ...(str(pb.currency) ? { currency: str(pb.currency)! } : {}),
          ...(personaStyle(pb.persona_style) ? { personaStyle: personaStyle(pb.persona_style)! } : {}),
        }
      : undefined;
    const { merchant, key, plan } = await service.signupMerchant({
      name: str(body.name) ?? "",
      email: str(body.email) ?? "",
      password: str(body.password) ?? "",
      ...(planInput ? { plan: planInput } : {}),
    });
    const { token, expiresAt } = signSession(merchant.id, deps.authSecret, DASHBOARD_TTL_MS, Date.now());
    return c.json(
      {
        merchant: { id: merchant.id, name: merchant.name },
        key,
        token,
        expires_at: expiresAt,
        ...(plan ? { plan: planJson(plan), embed: embedInfo(baseFromReq(c), plan.id) } : {}),
      },
      201,
    );
  });

  // Permanently delete the authenticated merchant account (and everything under it).
  app.delete("/v1/account", dashboardAuth, async (c) => {
    await service.deleteAccount(c.get("merchantId"));
    return c.json({ ok: true });
  });

  // Plans: create / list — dashboard token, scoped to the merchant.
  app.post("/v1/plans", dashboardAuth, async (c) => {
    const b = await safeJson(c);
    const plan = await service.createPlan(c.get("merchantId"), {
      productName: str(b.product_name) ?? "",
      listPrice: num(b.list_price) ?? NaN,
      floorPrice: num(b.floor_price) ?? NaN,
      ...(num(b.target_price) !== null ? { targetPrice: num(b.target_price)! } : {}),
      ...(str(b.currency) ? { currency: str(b.currency)! } : {}),
      ...(personaStyle(b.persona_style) ? { personaStyle: personaStyle(b.persona_style)! } : {}),
    });
    return c.json({ plan: planJson(plan), embed: embedInfo(baseFromReq(c), plan.id) }, 201);
  });

  app.get("/v1/plans", dashboardAuth, async (c) => {
    const plans = await service.listPlans(c.get("merchantId"));
    return c.json({ plans: plans.map(planJson) });
  });

  app.patch("/v1/plans/:id", dashboardAuth, async (c) => {
    const b = await safeJson(c);
    const plan = await service.updatePlan(c.get("merchantId"), c.req.param("id")!, {
      ...(str(b.product_name) ? { productName: str(b.product_name)! } : {}),
      ...(num(b.list_price) !== null ? { listPrice: num(b.list_price)! } : {}),
      ...(num(b.floor_price) !== null ? { floorPrice: num(b.floor_price)! } : {}),
      ...(num(b.target_price) !== null ? { targetPrice: num(b.target_price)! } : {}),
      ...(personaStyle(b.persona_style) ? { personaStyle: personaStyle(b.persona_style)! } : {}),
      // application_fee_percent: number sets an override, null clears it (use platform default)
      ...("application_fee_percent" in b
        ? { applicationFeePercent: num(b.application_fee_percent) }
        : {}),
      // discovery: the Vini config (renderer-only). Validated in the service.
      ...("discovery" in b ? { discovery: b.discovery } : {}),
      ...(typeof b.active === "boolean" ? { active: b.active } : {}),
    });
    return c.json({ plan: planJson(plan), embed: embedInfo(baseFromReq(c), plan.id) });
  });

  // --- merchant routes (API key) -------------------------------------------

  const merchantKey = apiKeyGuard(deps.apiKey);

  app.post("/v1/sessions", merchantKey, async (c) => {
    const body = await safeJson(c);
    const planId = str(body.plan_id);
    const endUserRef = str(body.end_user_ref);
    if (!planId || !endUserRef) return c.json({ error: "plan_id and end_user_ref are required" }, 400);
    // Cap session spin-up per IP on the public (keyless) demo. A merchant server
    // creates sessions with its API key from one IP — never IP-limit that, so we
    // only throttle when no merchant key is configured.
    if (deps.apiKey === null && !limiter.hitAll(clientIp(c), [SESSION_RULE])) {
      return c.json({ error: "too many sessions, try again shortly", code: "conflict", retry_at: Date.now() + 60_000 }, 429);
    }
    const r = await service.createSession({
      planId,
      endUserRef,
      ...(isRecord(body.context) ? { context: body.context } : {}),
    });
    return c.json(
      {
        session_id: r.sessionId,
        session_token: r.sessionToken,
        opener_message: r.opener,
        expires_at: r.expiresAt,
      },
      201,
    );
  });

  app.get("/v1/deals/:id", merchantKey, async (c) => {
    const d = await service.getDeal(c.req.param("id")!);
    return c.json({
      id: d.id,
      status: d.status,
      price: d.price,
      currency: d.currency,
      kind: d.kind,
      stripe_subscription_id: d.stripeSubscriptionId,
      settled_at: d.settledAt,
    });
  });

  // WTP analytics + dashboard reads (Spec §11) — merchant dashboard token,
  // scoped: a merchant only ever sees its OWN plans/sessions.
  app.get("/v1/analytics/wtp", dashboardAuth, async (c) => {
    const planId = c.req.query("plan_id");
    if (!planId) return c.json({ error: "plan_id query param is required" }, 400);
    await service.requireOwnedPlan(planId, c.get("merchantId"));
    return c.json(await service.getAnalytics(planId));
  });

  app.get("/v1/plans/:id/sessions", dashboardAuth, async (c) => {
    await service.requireOwnedPlan(c.req.param("id")!, c.get("merchantId"));
    const sessions = await service.listSessions(c.req.param("id")!);
    return c.json({
      sessions: sessions.map((s) => ({
        id: s.id,
        status: s.status,
        round: s.round,
        current_ask: s.currentAsk,
        end_user_ref: s.endUserRef,
        created_at: s.createdAt,
      })),
    });
  });

  app.get("/v1/plans/:id/lint", dashboardAuth, async (c) => {
    await service.requireOwnedPlan(c.req.param("id")!, c.get("merchantId"));
    return c.json(await service.lintPlan(c.req.param("id")!));
  });

  app.get("/v1/sessions/:id/transcript", dashboardAuth, async (c) => {
    await service.requireOwnedSession(c.req.param("id")!, c.get("merchantId"));
    const { session, turns } = await service.getTranscript(c.req.param("id")!);
    return c.json({
      session: { id: session.id, status: session.status, round: session.round, end_user_ref: session.endUserRef },
      turns: turns.map((t) => ({ role: t.role, text: t.rawText, extracted: t.extracted, action: t.action, at: t.createdAt })),
    });
  });

  // Usage ingestion + renegotiation (Spec §6, §9, Phase 4) — merchant key.
  app.post("/v1/usage", merchantKey, async (c) => {
    const body = await safeJson(c);
    const dealId = str(body.deal_id);
    const cycle = num(body.cycle);
    const value = num(body.value);
    if (!dealId || cycle === null || value === null) {
      return c.json({ error: "deal_id, cycle, and value are required" }, 400);
    }
    const r = await service.reportUsage(dealId, cycle, value);
    return c.json({
      breach: r.breach,
      breach_streak: r.breachStreak,
      ...(r.renegotiation
        ? {
            renegotiation: {
              session_id: r.renegotiation.sessionId,
              session_token: r.renegotiation.sessionToken,
              direction: r.renegotiation.direction,
            },
          }
        : {}),
    });
  });

  app.post("/v1/deals/:id/renegotiate", merchantKey, async (c) => {
    const dir = str((await safeJson(c)).direction);
    const direction = dir === "down" ? "down" : "up";
    const r = await service.renegotiateDeal(c.req.param("id")!, direction);
    return c.json({ session_id: r.sessionId, session_token: r.sessionToken, opener: r.opener, summary: r.summary });
  });

  // Stripe Connect (Spec §7) — dashboard token, scoped to the merchant's OWN id.
  app.post("/v1/merchants/:id/connect/onboard", dashboardAuth, async (c) => {
    if (c.req.param("id") !== c.get("merchantId")) return c.json({ error: "not found", code: "not_found" }, 404);
    const body = await safeJson(c);
    const returnUrl = str(body.return_url) ?? `${baseFromReq(c)}/dashboard`;
    const refreshUrl = str(body.refresh_url) ?? returnUrl;
    const r = await service.startConnectOnboarding(c.get("merchantId"), returnUrl, refreshUrl);
    return c.json({ url: r.url, account_id: r.accountId });
  });

  app.get("/v1/merchants/:id/connect", dashboardAuth, async (c) => {
    if (c.req.param("id") !== c.get("merchantId")) return c.json({ error: "not found", code: "not_found" }, 404);
    const s = await service.getConnectStatus(c.get("merchantId"));
    return c.json({ connected: s.connected, account_id: s.accountId, charges_enabled: s.chargesEnabled, live: Boolean(deps.stripeLive) });
  });

  // Set/clear the entitlement webhook URL; returns the outbound signing secret
  // (shown so the merchant can verify our HMAC). Owner-scoped.
  app.put("/v1/merchants/:id/webhook", dashboardAuth, async (c) => {
    if (c.req.param("id") !== c.get("merchantId")) return c.json({ error: "not found", code: "not_found" }, 404);
    const url = str((await safeJson(c)).url);
    const r = await service.setWebhookUrl(c.get("merchantId"), url ?? null);
    return c.json({ webhook_url: r.webhookUrl, webhook_secret: r.webhookSecret });
  });

  // Live-mode gate: refuses unless a webhook_url is configured (settlement §5).
  app.post("/v1/merchants/:id/go-live", dashboardAuth, async (c) => {
    if (c.req.param("id") !== c.get("merchantId")) return c.json({ error: "not found", code: "not_found" }, 404);
    const r = await service.goLive(c.get("merchantId"));
    return c.json({ live_mode: r.liveMode });
  });

  // --- widget routes (session token) ---------------------------------------

  const sessionAuth = sessionTokenGuard(service);

  app.get("/v1/sessions/:id", sessionAuth, async (c) => {
    const v = await service.getSessionView(c.req.param("id")!);
    return c.json({ status: v.status, round: v.round, current_ask: v.currentAsk, expires_at: v.expiresAt });
  });

  app.post("/v1/sessions/:id/messages", sessionAuth, async (c) => {
    const message = str((await safeJson(c)).message);
    if (!message) return c.json({ error: "message is required" }, 400);
    // Invisible throttle: short-circuit BEFORE the (paid) LLM turn with a canned
    // in-character reply. Looks like the bouncer talking, costs nothing.
    if (!limiter.hitAll(clientIp(c), MSG_RULES)) return c.json(cannedTurn(throttleReply()));
    const r = await service.postMessage(c.req.param("id")!, message);
    return c.json(turnJson(r));
  });

  app.post("/v1/sessions/:id/messages/stream", sessionAuth, async (c) => {
    const message = str((await safeJson(c)).message);
    const id = c.req.param("id")!;
    const ip = clientIp(c);
    return streamSSE(c, async (stream) => {
      if (!message) {
        await stream.writeSSE({ event: "error", data: JSON.stringify({ error: "message is required" }) });
        return;
      }
      // Invisible throttle: emit a canned in-character reply over SSE, before the
      // (paid) LLM turn. The widget renders it like any other bouncer message.
      if (!limiter.hitAll(ip, MSG_RULES)) {
        await stream.writeSSE({ event: "typing", data: "1" });
        await stream.writeSSE({ event: "reply", data: JSON.stringify(cannedTurn(throttleReply())) });
        return;
      }
      // Typing indicator first — the haggle should feel like texting; dead air is
      // the enemy, latency is tolerated (Spec §10). The reply is only sent after
      // the full Extract→Engine→Render→Validate turn completes (number is safe).
      await stream.writeSSE({ event: "typing", data: "1" });
      try {
        const r = await service.postMessage(id, message);
        await stream.writeSSE({ event: "reply", data: JSON.stringify(turnJson(r)) });
      } catch (err) {
        const code = err instanceof ServiceError ? err.code : "bad_request";
        await stream.writeSSE({ event: "error", data: JSON.stringify({ error: msg(err), code }) });
      }
    });
  });

  app.post("/v1/sessions/:id/accept", sessionAuth, async (c) => {
    const r = await service.acceptCurrent(c.req.param("id")!);
    return c.json({ ...(r.checkoutUrl ? { checkout_url: r.checkoutUrl } : {}), deal_id: r.dealId, price: r.price });
  });

  // --- early-access waitlist (landing page) --------------------------------
  // Public + keyless (the landing page posts directly). IP-rate-limited so it
  // can't be scripted. Logged as well as stored, so signups are recoverable from
  // the platform logs even before a durable DATABASE_URL is configured.
  app.post("/v1/waitlist", async (c) => {
    if (!limiter.hitAll(clientIp(c), [{ windowMs: 60_000, max: 10 }])) {
      return c.json({ ok: true }); // silently absorb floods — never reveal a limit
    }
    const body = await safeJson(c);
    const email = str(body.email);
    if (!email) return c.json({ error: "email is required" }, 400);
    await service.joinWaitlist(email, str(body.source) ?? "landing");
    console.log(`[waitlist] ${email.trim().toLowerCase()} (${str(body.source) ?? "landing"})`);
    return c.json({ ok: true });
  });

  // --- A/B lift experiment (Spec §11) --------------------------------------
  // Public + keyless: the embed loader beacons one impression per visitor (both
  // arms) before anything mounts. This is the visitor denominator behind
  // revenue-per-visitor. IP-rate-limited and best-effort — a flood is absorbed
  // silently (analytics, never money; the floor is unaffected regardless).
  app.post("/v1/impressions", async (c) => {
    if (!limiter.hitAll(clientIp(c), [{ windowMs: 3_000, max: 20 }, { windowMs: 60_000, max: 120 }])) {
      return c.json({ ok: true }); // absorb floods; never reveal a limit
    }
    const body = await safeJson(c);
    const planId = str(body.plan);
    const userRef = str(body.user);
    if (!planId || !userRef) return c.json({ error: "plan and user are required" }, 400);
    try {
      await service.recordImpression({ planId, endUserRef: userRef, cohort: str(body.cohort) ?? "treatment" });
    } catch {
      // Unknown/inactive plan: swallow — an impression beacon must never error the page.
    }
    return c.json({ ok: true });
  });

  // Control-arm conversion callback (Spec §11). Merchant-key'd (server-to-server,
  // from the merchant's own Stripe webhook), unlike the keyless browser beacon.
  // Reports a flat-page sale Bouncr can't otherwise see, completing the
  // control-arm numerator for the lift comparison.
  app.post("/v1/conversions", merchantKey, async (c) => {
    const body = await safeJson(c);
    const planId = str(body.plan_id);
    const userRef = str(body.user_ref);
    const amount = num(body.amount);
    if (!planId || !userRef || amount === null) {
      return c.json({ error: "plan_id, user_ref, and amount are required" }, 400);
    }
    await service.recordConversion({ planId, endUserRef: userRef, amount });
    return c.json({ ok: true });
  });

  // --- SMS channel (Spec §10) -----------------------------------------------
  // The phone-input embed posts here — keyless (it runs in the visitor's
  // browser, like the impression beacon) but double rate-limited: per IP and per
  // destination number, since every start costs an outbound text.
  app.post("/v1/sms/start", async (c) => {
    const body = await safeJson(c);
    const planId = str(body.plan_id) ?? str(body.plan);
    const phone = str(body.phone) ? normalizePhone(str(body.phone)!) : null;
    if (!planId || !phone) {
      return c.json({ error: "plan_id and a valid phone number are required", code: "bad_request" }, 400);
    }
    if (!limiter.hitAll(clientIp(c), SMS_START_RULES) || !limiter.hitAll(`sms:${phone}`, SMS_PHONE_RULES)) {
      return c.json({ error: "too many requests, try again shortly", code: "conflict" }, 429);
    }
    await service.startSmsSession({ planId, phone });
    return c.json({ ok: true }, 201);
  });

  // Inbound texts (Twilio webhook, form-encoded From/Body). With a Twilio auth
  // token configured the X-Twilio-Signature is mandatory — verified over the
  // exact public URL + sorted params, per Twilio's scheme. The response is
  // TwiML; silence (empty <Response/>) for unknown senders, floods, or errors,
  // so this endpoint can never be used to make Bouncr text on command.
  app.post("/v1/webhooks/sms", async (c) => {
    const xml = (doc: string) => {
      c.header("content-type", "text/xml; charset=utf-8");
      return c.body(doc);
    };
    const raw = await c.req.text(); // raw body (parseBody hangs under the serverless adapter)
    const params: Record<string, string> = {};
    for (const [k, v] of new URLSearchParams(raw)) params[k] = v;
    if (deps.smsAuthToken) {
      const url = `${baseFromReq(c)}/v1/webhooks/sms`;
      if (!verifyTwilioSignature(deps.smsAuthToken, url, params, c.req.header("x-twilio-signature"))) {
        return c.text("invalid signature", 403);
      }
    }
    // Key the flood guard on the SENDER, not the caller IP — legit inbound all
    // arrives from Twilio's IPs, so an IP limit would throttle users together.
    if (!limiter.hitAll(`sms:in:${params.From ?? "unknown"}`, MSG_RULES)) return xml(twiml());
    try {
      const r = await service.handleInboundSms(params.From ?? "", params.Body ?? "");
      return xml(twiml(r.reply));
    } catch (err) {
      console.error("[sms] inbound turn failed:", msg(err));
      return xml(twiml()); // never bounce an error back through the carrier
    }
  });

  // --- MCP server (Streamable HTTP) ----------------------------------------
  // Any AI agent can negotiate via tools — same engine + validator as the widget,
  // so the floor holds. Keyless = public buyer mode (plan id only). A valid
  // `Authorization: Bearer <merchant API key>` switches to merchant-scoped mode:
  // the caller's own plans are exposed and every plan/session is scoped to them.
  const mcpHttp = async (c: Context) => {
    if (!limiter.hitAll(clientIp(c), [{ windowMs: 3_000, max: 12 }, { windowMs: 60_000, max: 40 }])) {
      return c.json({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "rate limited" } }, 429);
    }
    // Resolve a merchant from the Bearer key via the SAME path the REST API uses.
    // The key is never logged or echoed; an invalid one is rejected opaquely.
    let merchant: Awaited<ReturnType<typeof service.authenticateMerchantKey>> | null = null;
    const key = bearer(c.req.header("authorization"));
    if (key) {
      try {
        merchant = await service.authenticateMerchantKey(key);
      } catch {
        return c.json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "invalid credentials" } }, 401);
      }
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, 400);
    }
    if (Array.isArray(body)) {
      return c.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "JSON-RPC batching is not supported" } }, 400);
    }
    const res = await dispatchMcp(service, (body ?? {}) as Record<string, unknown>, { merchant });
    return res === null ? c.body(null, 202) : c.json(res);
  };
  app.post("/mcp", mcpHttp);
  // We don't open server-initiated streams; per the MCP spec a 405 is valid.
  app.get("/mcp", (c) => c.json({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "GET not supported — POST JSON-RPC" } }, 405));

  // --- settlement -----------------------------------------------------------

  app.post("/v1/webhooks/stripe", async (c) => {
    // Correlation id for this webhook → threaded through settlement + entitlement
    // durable events; returned as request_id so a response can be traced to them.
    const correlationId = c.req.header("x-request-id") || crypto.randomUUID();
    const raw = await c.req.text();
    const sig = c.req.header("stripe-signature");
    let event;
    try {
      event = stripe.parseWebhook(raw, sig);
    } catch (err) {
      return c.json({ error: `signature verification failed: ${msg(err)}`, request_id: correlationId }, 400);
    }
    const r = await service.handleStripeEvent(event, { correlationId });
    return c.json({ received: true, settled: r.settled, ...(r.dealId ? { deal_id: r.dealId } : {}), request_id: correlationId });
  });

  // --- embeddable widget (Spec §10) ----------------------------------------

  // thebouncr.com → marketing landing; bouncr.tech (and anything else) → the
  // live playground. Same deployment, routed by Host header (Spec §15).
  app.get("/", (c) => {
    const host = hostOf(c);
    // mcp.thebouncr.com is an alias for the MCP server — bare root is an info doc.
    if (host.includes("mcp.thebouncr.com")) {
      return c.json({ name: "bouncr", description: "Bouncr MCP server (Streamable HTTP). POST JSON-RPC here or to /mcp.", transport: "streamable-http" });
    }
    return c.html(host.includes("thebouncr.com") ? LANDING_HTML : DEMO_HTML);
  });
  // On the mcp alias, a bare-root POST is the MCP endpoint too (so the URL can be
  // just https://mcp.thebouncr.com). Elsewhere root POST isn't a thing.
  app.post("/", (c) => (hostOf(c).includes("mcp.thebouncr.com") ? mcpHttp(c) : c.json({ error: "not found", code: "not_found" }, 404)));
  app.get("/landing", (c) => c.html(LANDING_HTML)); // always reachable for preview
  app.get("/playground", (c) => c.html(DEMO_HTML)); // explicit demo path
  app.get("/widget", (c) => c.html(WIDGET_HTML));
  app.get("/widget/sms", (c) => c.html(SMS_HTML)); // compact phone-input embed (SMS channel)
  app.get("/dashboard", (c) => c.html(DASHBOARD_HTML)); // merchant dashboard (Spec §11)
  app.get("/signup", (c) => c.html(ONBOARD_HTML)); // merchant onboarding wizard (Spec §9)
  app.get("/start", (c) => c.html(ONBOARD_HTML));
  // One page for the whole reset flow: with ?token it sets a new password,
  // without it asks for the email to send a link to.
  app.get("/reset", (c) => c.html(RESET_HTML));
  app.get("/forgot", (c) => c.html(RESET_HTML));

  // Bouncr-hosted checkout (Spec settlement §2): verify the proof server-side,
  // render the negotiated price, then hand off to Stripe. Resume/re-mint keep an
  // abandoned checkout from dead-ending the deal.
  app.get("/checkout/:deal_id", async (c) => {
    const view = await service.getCheckoutView(c.req.param("deal_id")!, c.req.query("proof"));
    if (view.state === "resume" || view.state === "remint") return c.redirect(view.url, 302);
    return c.html(checkoutHtml(view));
  });

  // Pay button → verify proof, burn jti, create the Stripe session on the
  // connected account, redirect to Stripe. Accepts form-encoded or JSON proof.
  app.post("/checkout/:deal_id/pay", async (c) => {
    if (!limiter.hitAll(clientIp(c), [{ windowMs: 60_000, max: 20 }])) {
      return c.redirect(`/checkout/${c.req.param("deal_id")}`, 303);
    }
    const dealId = c.req.param("deal_id")!;
    let proof: string | undefined;
    const ctype = c.req.header("content-type") ?? "";
    if (ctype.includes("application/json")) {
      proof = str((await safeJson(c)).proof) ?? undefined;
    } else {
      // Read the raw body and parse it ourselves — Hono's parseBody() can hang
      // under the Node serverless adapter, but text() is reliable (the webhook
      // uses it too). The hosted page posts a urlencoded <form>.
      const raw = await c.req.text();
      proof = new URLSearchParams(raw).get("proof") ?? undefined;
    }
    const r = await service.startCheckout(dealId, proof);
    // redirect → Stripe; settled/invalid → back to the page (settled or re-mint).
    return c.redirect(r.state === "redirect" ? r.url : `/checkout/${dealId}`, 303);
  });
  app.get("/embed.js", (c) => {
    c.header("content-type", "application/javascript; charset=utf-8");
    return c.body(EMBED_JS);
  });

  // --- brand icons ----------------------------------------------------------
  // The logo pack (assets/bouncr_logo_pack/) is bundled to base64 at build time
  // (icons.generated.ts) and served here so favicon/app-icon URLs resolve in both
  // local dev and Vercel (where everything is rewritten to this function).
  const icon = (b64: string, type: string) => (c: Context) => {
    c.header("content-type", type);
    c.header("cache-control", "public, max-age=31536000, immutable");
    return c.body(Buffer.from(b64, "base64"));
  };
  app.get("/favicon.ico", icon(FAVICON_ICO_B64, "image/x-icon"));
  app.get("/icon-16.png", icon(ICON_16_B64, "image/png"));
  app.get("/icon-32.png", icon(ICON_32_B64, "image/png"));
  app.get("/apple-touch-icon.png", icon(APPLE_TOUCH_B64, "image/png"));
  app.get("/apple-touch-icon-precomposed.png", icon(APPLE_TOUCH_B64, "image/png"));
  app.get("/icon-192.png", icon(ICON_192_B64, "image/png"));
  app.get("/icon-512.png", icon(ICON_512_B64, "image/png"));
  app.get("/site.webmanifest", (c) => {
    c.header("content-type", "application/manifest+json");
    return c.body(JSON.stringify({
      name: "Bouncr",
      short_name: "Bouncr",
      icons: [
        { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
        { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      ],
      theme_color: "#0B0B12",
      background_color: "#0B0B12",
      display: "standalone",
    }));
  });

  app.onError((err, c) => {
    if (err instanceof ServiceError) {
      return c.json({ error: err.message, code: err.code, ...(err.meta ?? {}) }, STATUS[err.code]);
    }
    console.error("[unhandled]", err);
    return c.json({ error: "internal error" }, 500);
  });

  return app;
}

/** Best-effort public base URL from the request (for Connect return links). */
/** Lowercased request host (Vercel may put the real domain on x-forwarded-host). */
function hostOf(c: Context): string {
  return `${c.req.header("x-forwarded-host") ?? ""} ${c.req.header("host") ?? ""}`.toLowerCase();
}

function baseFromReq(c: Context): string {
  try {
    const u = new URL(c.req.url);
    // Behind Vercel's edge the internal request is http; trust x-forwarded-proto
    // and the real host so embed snippets / return URLs come out https.
    const proto = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim() || u.protocol.replace(":", "");
    const host = c.req.header("x-forwarded-host")?.split(",")[0]?.trim() || c.req.header("host") || u.host;
    return `${proto}://${host}`;
  } catch {
    return "http://localhost:8787";
  }
}

/** The Bouncr-hosted checkout page. Amount is server-verified (from the proof),
 *  never the query string. "pay" shows the price + a button that POSTs the proof
 *  to create the Stripe session; settled/expired are friendly end states. */
function checkoutHtml(view: import("./service.js").CheckoutView): string {
  const shell = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/><title>${title} · Bouncr</title>
<link rel="icon" href="/favicon.ico"/>
<style>:root{--bg:#0B0B12;--panel:#13131c;--line:#23232f;--text:#E5E7EB;--muted:#9CA3AF;--accent:#7C3AED;--mint:#34D399;--err:#F87171}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.wrap{max-width:420px;margin:12vh auto;padding:0 18px}.card{background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:32px 28px;text-align:center}
.logo{font-size:20px;font-weight:800;letter-spacing:-.4px;color:#fff;margin-bottom:22px;display:flex;align-items:center;justify-content:center;gap:9px}.logo img{width:30px;height:30px}
.amt{font-size:40px;font-weight:800;letter-spacing:-1px;margin:10px 0 2px}.per{color:var(--muted);font-size:14px;margin-bottom:4px}
h1{font-size:19px;margin:0 0 6px}.sub{color:var(--muted);font-size:13.5px;line-height:1.55;margin:0 0 22px}
button{width:100%;background:var(--accent);color:#fff;border:0;border-radius:10px;padding:13px;font:inherit;font-weight:700;cursor:pointer}button:hover{background:#6d28d9}
.note{margin-top:16px;font-size:12px;color:var(--muted)}.big{font-size:34px;margin-bottom:10px}</style></head>
<body><div class="wrap"><div class="card"><div class="logo"><img src="/icon-192.png" alt=""/>Bouncr</div>${body}</div></div></body></html>`;

  if (view.state === "pay") {
    const dollars = (view.amountCents / 100).toFixed(2);
    const per = view.interval === "month" ? "/month" : "one-time";
    return shell(
      "Checkout",
      `<h1>${esc(view.productName)}</h1>
       <div class="amt">$${dollars}</div><div class="per">${per} · you negotiated this</div>
       <form method="POST" action="/checkout/${esc(view.dealId)}/pay">
         <input type="hidden" name="proof" value="${esc(view.proof)}"/>
         <button type="submit">Pay $${dollars} →</button>
       </form>
       <div class="note">Secure payment by Stripe. ${view.interval === "month" ? "Cancel anytime." : ""}</div>`,
    );
  }
  if (view.state === "settled") {
    return shell("All set", `<div class="big">✓</div><h1>You're all set</h1><p class="sub">This deal is already paid. You can close this tab.</p>`);
  }
  // expired / unknown
  return shell(
    "Link expired",
    `<div class="big">⌛</div><h1>This checkout link expired</h1><p class="sub">Negotiated prices are time-limited. Head back and start a fresh negotiation to lock in your price.</p>`,
  );
}

/** HTML-escape for safe interpolation into the reset email. */
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

/** Branded password-reset email body. The link is the only secret; expires in 1h. */
function resetEmailHtml(name: string, link: string): string {
  return `<!doctype html><html><body style="margin:0;background:#0B0B12;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#E5E7EB">
  <div style="max-width:460px;margin:0 auto;padding:40px 28px">
    <div style="font-size:20px;font-weight:800;color:#fff;margin-bottom:24px">Bouncr</div>
    <h1 style="font-size:20px;margin:0 0 12px;color:#fff">Reset your password</h1>
    <p style="font-size:14px;line-height:1.6;color:#9CA3AF;margin:0 0 24px">Hi ${esc(name)}, click below to choose a new password. This link expires in 1 hour. If you didn't request it, you can ignore this email.</p>
    <a href="${esc(link)}" style="display:inline-block;background:#7C3AED;color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:12px 22px;border-radius:10px">Reset password</a>
    <p style="font-size:12px;line-height:1.6;color:#6B7280;margin:28px 0 0;word-break:break-all">Or paste this link into your browser:<br><a href="${esc(link)}" style="color:#7C3AED">${esc(link)}</a></p>
  </div></body></html>`;
}

// --- shared response shaping ----------------------------------------------

function turnJson(r: import("./service.js").TurnResponse) {
  return {
    reply: r.reply,
    state: { round: r.round, current_ask: r.currentAsk, status: r.status, expires_at: r.expiresAt },
    action: r.action,
    is_final: r.isFinal,
    ...(r.checkoutUrl ? { checkout_url: r.checkoutUrl, deal_id: r.dealId } : {}),
  };
}

/**
 * A throttled turn, shaped like a normal reply so the widget renders it as a
 * bouncer message. `state: null` means the engine never ran (no round advanced,
 * no chips, no close) — it's purely a "slow down" line, never a real concession.
 */
function cannedTurn(reply: string) {
  return { reply, state: null, action: null, is_final: false };
}

const PERSONA_STYLES = ["sassy", "professional", "playful", "deadpan"] as const;
function personaStyle(x: unknown): (typeof PERSONA_STYLES)[number] | null {
  return typeof x === "string" && (PERSONA_STYLES as readonly string[]).includes(x)
    ? (x as (typeof PERSONA_STYLES)[number])
    : null;
}

/** Public shape of a plan for the dashboard / onboarding. */
function planJson(p: import("./store/types.js").Plan) {
  return {
    id: p.id,
    plan_key: p.planKey,
    currency: p.currency,
    list_price: p.config.listPrice,
    floor_price: p.config.floorPrice,
    target_price: p.config.targetPrice,
    persona: { name: p.persona.name, product_name: p.persona.productName, style: p.persona.style },
    application_fee_percent: p.applicationFeePercent ?? null,
    discovery: p.discovery ?? null,
    version: p.version,
    active: p.active,
  };
}

/** The one-line embed snippet a merchant drops on their pricing page. */
function embedInfo(base: string, planId: string) {
  return {
    plan_id: planId,
    snippet: `<script src="${base}/embed.js" data-plan="${planId}" data-mount="#bouncr"></script>`,
  };
}

/** Best-effort client IP for rate limiting (Vercel sets x-forwarded-for). */
function clientIp(c: Context): string {
  const xff = c.req.header("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return c.req.header("x-real-ip") ?? c.req.header("cf-connecting-ip") ?? "local";
}

// --- guards & helpers ------------------------------------------------------

function apiKeyGuard(apiKey: string | null) {
  return async (c: Context, next: Next) => {
    if (apiKey && c.req.header("x-api-key") !== apiKey) {
      return c.json({ error: "invalid or missing x-api-key" }, 401);
    }
    await next();
  };
}

function sessionTokenGuard(service: BouncrService) {
  return async (c: Context, next: Next) => {
    const token = c.req.header("x-session-token") ?? bearer(c.req.header("authorization"));
    try {
      await service.verifySessionToken(c.req.param("id")!, token);
    } catch (err) {
      if (err instanceof ServiceError) return c.json({ error: err.message, code: err.code }, STATUS[err.code]);
      throw err;
    }
    await next();
  };
}

const bearer = (h: string | undefined): string | undefined =>
  h?.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : undefined;

async function safeJson(c: Context): Promise<Record<string, unknown>> {
  try {
    const b = await c.req.json();
    return isRecord(b) ? b : {};
  } catch {
    return {};
  }
}

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);
const str = (x: unknown): string | null => (typeof x === "string" && x.trim() ? x.trim() : null);
const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
