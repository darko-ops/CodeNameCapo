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
import { signSession, verifySession } from "./auth.js";
import { WIDGET_HTML, EMBED_JS, DEMO_HTML, DASHBOARD_HTML, LANDING_HTML } from "./widget/assets.js";

export interface AppDeps {
  service: BouncrService;
  stripe: StripeGateway;
  /** When set, server routes (session create, deals, usage) require this in `x-api-key`. */
  apiKey: string | null;
  /** HMAC secret for signing dashboard session tokens. */
  authSecret: string;
}

/** Dashboard session lifetime. */
const DASHBOARD_TTL_MS = 12 * 60 * 60 * 1000;

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

  // --- merchant dashboard auth (Spec §9) -----------------------------------
  // Each merchant has an API key; login exchanges it for a short-lived signed
  // token (stateless HMAC — no session store, works across serverless instances).
  // Dashboard reads are gated by this token AND scoped to the token's merchant.
  app.post("/v1/auth/login", async (c) => {
    if (!limiter.hitAll(clientIp(c), [{ windowMs: 60_000, max: 10 }])) {
      return c.json({ error: "too many attempts, try again shortly", code: "unauthorized" }, 429);
    }
    const key = str((await safeJson(c)).key);
    try {
      const merchant = await service.authenticateMerchantKey(key ?? undefined);
      const { token, expiresAt } = signSession(merchant.id, deps.authSecret, DASHBOARD_TTL_MS, Date.now());
      return c.json({ token, expires_at: expiresAt, merchant: { id: merchant.id, name: merchant.name } });
    } catch {
      return c.json({ error: "invalid credentials", code: "unauthorized" }, 401);
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
    return c.json({ connected: s.connected, account_id: s.accountId, charges_enabled: s.chargesEnabled });
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

  // --- settlement -----------------------------------------------------------

  app.post("/v1/webhooks/stripe", async (c) => {
    const raw = await c.req.text();
    const sig = c.req.header("stripe-signature");
    let event;
    try {
      event = stripe.parseWebhook(raw, sig);
    } catch (err) {
      return c.json({ error: `signature verification failed: ${msg(err)}` }, 400);
    }
    const r = await service.handleStripeEvent(event);
    return c.json({ received: true, settled: r.settled, ...(r.dealId ? { deal_id: r.dealId } : {}) });
  });

  // --- embeddable widget (Spec §10) ----------------------------------------

  // thebouncr.com → marketing landing; bouncr.tech (and anything else) → the
  // live playground. Same deployment, routed by Host header (Spec §15).
  app.get("/", (c) => {
    // Vercel may surface the request domain on x-forwarded-host rather than host.
    const host = `${c.req.header("x-forwarded-host") ?? ""} ${c.req.header("host") ?? ""}`.toLowerCase();
    return c.html(host.includes("thebouncr.com") ? LANDING_HTML : DEMO_HTML);
  });
  app.get("/landing", (c) => c.html(LANDING_HTML)); // always reachable for preview
  app.get("/playground", (c) => c.html(DEMO_HTML)); // explicit demo path
  app.get("/widget", (c) => c.html(WIDGET_HTML));
  app.get("/dashboard", (c) => c.html(DASHBOARD_HTML)); // merchant dashboard (Spec §11)
  app.get("/embed.js", (c) => {
    c.header("content-type", "application/javascript; charset=utf-8");
    return c.body(EMBED_JS);
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
function baseFromReq(c: Context): string {
  try {
    const u = new URL(c.req.url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "http://localhost:8787";
  }
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
