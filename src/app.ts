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
import { WIDGET_HTML, EMBED_JS, DEMO_HTML, DASHBOARD_HTML, LANDING_HTML } from "./widget/assets.js";

export interface AppDeps {
  service: BouncrService;
  stripe: StripeGateway;
  /** When set, merchant routes (create, deals) require this in `x-api-key`. */
  apiKey: string | null;
}

const STATUS: Record<ServiceError["code"], 400 | 401 | 404 | 409> = {
  bad_request: 400,
  unauthorized: 401,
  not_found: 404,
  conflict: 409,
};

export function buildApp(deps: AppDeps): Hono {
  const app = new Hono();
  const { service, stripe } = deps;

  app.get("/healthz", (c) => c.json({ ok: true }));

  // --- merchant routes (API key) -------------------------------------------

  const merchantKey = apiKeyGuard(deps.apiKey);

  app.post("/v1/sessions", merchantKey, async (c) => {
    const body = await safeJson(c);
    const planId = str(body.plan_id);
    const endUserRef = str(body.end_user_ref);
    if (!planId || !endUserRef) return c.json({ error: "plan_id and end_user_ref are required" }, 400);
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

  // WTP analytics + dashboard reads (Spec §11) — merchant key.
  app.get("/v1/analytics/wtp", merchantKey, async (c) => {
    const planId = c.req.query("plan_id");
    if (!planId) return c.json({ error: "plan_id query param is required" }, 400);
    return c.json(await service.getAnalytics(planId));
  });

  app.get("/v1/plans/:id/sessions", merchantKey, async (c) => {
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

  app.get("/v1/plans/:id/lint", merchantKey, async (c) => c.json(await service.lintPlan(c.req.param("id")!)));

  app.get("/v1/sessions/:id/transcript", merchantKey, async (c) => {
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

  // Stripe Connect onboarding (Spec §7, Phase 3) — merchant key.
  app.post("/v1/merchants/:id/connect/onboard", merchantKey, async (c) => {
    const body = await safeJson(c);
    const returnUrl = str(body.return_url) ?? `${baseFromReq(c)}/dashboard`;
    const refreshUrl = str(body.refresh_url) ?? returnUrl;
    const r = await service.startConnectOnboarding(c.req.param("id")!, returnUrl, refreshUrl);
    return c.json({ url: r.url, account_id: r.accountId });
  });

  app.get("/v1/merchants/:id/connect", merchantKey, async (c) => {
    const s = await service.getConnectStatus(c.req.param("id")!);
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
    const r = await service.postMessage(c.req.param("id")!, message);
    return c.json(turnJson(r));
  });

  app.post("/v1/sessions/:id/messages/stream", sessionAuth, async (c) => {
    const message = str((await safeJson(c)).message);
    const id = c.req.param("id")!;
    return streamSSE(c, async (stream) => {
      if (!message) {
        await stream.writeSSE({ event: "error", data: JSON.stringify({ error: "message is required" }) });
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
