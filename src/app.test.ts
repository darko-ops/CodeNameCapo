import { describe, it, expect } from "vitest";
import { buildApp } from "./app.js";
import { BouncrService } from "./service.js";
import { MemoryStore } from "./store/memory.js";
import { FakeStripeGateway } from "./stripe/fake.js";
import { makeTemplateNegotiator } from "./llm/negotiator.js";
import { demoPlan, demoMerchant } from "./config.js";
import { generateMerchantKey, hashKey } from "./auth.js";

const PLAN = demoPlan();
const AUTH_SECRET = "test_auth_secret";

function makeApp(apiKey: string | null = null) {
  // Seed the demo merchant with a known dashboard key so login works in tests.
  const merchant = demoMerchant();
  const merchantKey = generateMerchantKey(merchant.id);
  merchant.apiKeyHash = hashKey(merchantKey);
  const store = new MemoryStore([PLAN], [merchant]);
  const stripe = new FakeStripeGateway();
  const service = new BouncrService({
    store,
    stripe,
    negotiator: makeTemplateNegotiator(),
    baseUrl: "http://localhost:8787",
  });
  return { app: buildApp({ service, stripe, apiKey, authSecret: AUTH_SECRET }), store, stripe, merchantKey };
}

/** Log in as the demo merchant and return a Bearer auth header. */
async function login(app: any, key: string): Promise<Record<string, string>> {
  const r = await post(app, "/v1/auth/login", { key });
  const b = await r.json();
  return { authorization: "Bearer " + b.token };
}

const post = (app: any, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function startSession(app: any) {
  const created = await post(app, "/v1/sessions", { plan_id: PLAN.id, end_user_ref: "u" });
  const body = await created.json();
  return { id: body.session_id, token: body.session_token, body };
}
const tok = (token: string) => ({ "x-session-token": token });

describe("HTTP API (Spec §9)", () => {
  it("walks the full create → message → accept → webhook → deal path", async () => {
    const { app } = makeApp();

    const created = await post(app, "/v1/sessions", { plan_id: PLAN.id, end_user_ref: "user_9" });
    expect(created.status).toBe(201);
    const { session_id, session_token, opener_message, expires_at } = await created.json();
    expect(opener_message).toContain("$48");
    expect(session_token).toMatch(/^sst_/);
    expect(expires_at).toBeGreaterThan(Date.now());

    // message — lowball, counters
    const m1 = await post(app, `/v1/sessions/${session_id}/messages`, { message: "5 bucks" }, tok(session_token));
    const b1 = await m1.json();
    expect(b1.action.type).toBe("counter");
    expect(b1.state.status).toBe("open");
    expect(b1.checkout_url).toBeUndefined();

    // accept the current ask explicitly
    const acc = await post(app, `/v1/sessions/${session_id}/accept`, undefined, tok(session_token));
    const accBody = await acc.json();
    expect(acc.status).toBe(200);
    expect(accBody.checkout_url).toContain("/checkout/");

    const dealRes = await app.request(`/v1/deals/${accBody.deal_id}`);
    expect((await dealRes.json()).status).toBe("pending");

    const checkoutId = accBody.checkout_url.split("/checkout/")[1];
    expect(checkoutId).toMatch(/^cs_test_/);

    const wh = await post(app, "/v1/webhooks/stripe", {
      type: "checkout.session.completed",
      checkoutId,
      subscriptionId: "sub_http",
    });
    expect((await wh.json())).toMatchObject({ received: true, settled: true });

    const after = await (await app.request(`/v1/deals/${accBody.deal_id}`)).json();
    expect(after.status).toBe("settled");
    expect(after.stripe_subscription_id).toBe("sub_http");
  });

  it("validates request bodies and maps service errors to status codes", async () => {
    const { app } = makeApp();
    expect((await post(app, "/v1/sessions", {})).status).toBe(400);
    // unknown session is rejected at the token guard before the handler
    const noSession = await post(app, "/v1/sessions/missing/messages", { message: "hi" }, tok("x"));
    expect(noSession.status).toBe(404);

    const { id, token } = await startSession(app);
    await post(app, `/v1/sessions/${id}/accept`, undefined, tok(token)); // -> accepted
    const conflict = await post(app, `/v1/sessions/${id}/messages`, { message: "hi" }, tok(token));
    expect(conflict.status).toBe(409);
  });
});

describe("session-token auth (Spec §9 widget tokens)", () => {
  it("rejects per-session calls without the correct token", async () => {
    const { app } = makeApp();
    const { id, token } = await startSession(app);

    expect((await post(app, `/v1/sessions/${id}/messages`, { message: "hi" })).status).toBe(401);
    expect((await post(app, `/v1/sessions/${id}/messages`, { message: "hi" }, tok("wrong"))).status).toBe(401);
    expect((await post(app, `/v1/sessions/${id}/messages`, { message: "hi" }, tok(token))).status).toBe(200);

    // Bearer form also works.
    const bearer = await post(app, `/v1/sessions/${id}/messages`, { message: "hi" }, { authorization: `Bearer ${token}` });
    expect(bearer.status).toBe(200);
  });

  it("a token is scoped to its own session", async () => {
    const { app } = makeApp();
    const a = await startSession(app);
    const b = await startSession(app);
    // a's token must not work on b's session
    expect((await post(app, `/v1/sessions/${b.id}/messages`, { message: "hi" }, tok(a.token))).status).toBe(401);
  });
});

describe("SSE streaming (Spec §10)", () => {
  it("emits a typing event then a validated reply", async () => {
    const { app } = makeApp();
    const { id, token } = await startSession(app);
    const res = await post(app, `/v1/sessions/${id}/messages/stream`, { message: "I'll do $4" }, tok(token));
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("event: typing");
    expect(text).toContain("event: reply");
    const replyLine = text.split("\n").find((l: string) => l.startsWith("data:") && l.includes("reply"));
    expect(replyLine).toBeDefined();
    const payload = JSON.parse(replyLine!.slice(5).trim());
    expect(payload.action.type).toBe("counter");
    expect(payload.state.current_ask).toBeGreaterThanOrEqual(PLAN.config.floorPrice);
  });
});

describe("embeddable widget assets (Spec §10)", () => {
  it("serves the widget HTML and the embed loader", async () => {
    const { app } = makeApp();
    const w = await app.request("/widget");
    expect(w.status).toBe(200);
    expect(w.headers.get("content-type")).toContain("text/html");
    expect(await w.text()).toContain("negotiated via");

    const e = await app.request("/embed.js");
    expect(e.status).toBe(200);
    expect(e.headers.get("content-type")).toContain("javascript");
    const js = await e.text();
    expect(js).toContain("Bouncr.mount");
    expect(js).toContain("addEventListener");
  });
});

describe("invisible rate limiting", () => {
  it("throttles a message burst with an in-character reply, never an error", async () => {
    const { app } = makeApp();
    const { id, token } = await startSession(app);
    let throttled = 0;
    let realTurns = 0;
    // Hammer past the burst rule (6 / 3s). The widget itself can never do this
    // (it blocks sending until each reply lands) — only a script can.
    for (let i = 0; i < 12; i++) {
      const r = await post(app, `/v1/sessions/${id}/messages`, { message: "$5" }, tok(token));
      expect([200, 409]).toContain(r.status); // invisible: a throttle is 200, never 429/5xx
      if (r.status === 200) {
        const b = await r.json();
        if (b.state === null) throttled++; // throttled turns carry no engine state
        else realTurns++;
      }
    }
    expect(realTurns).toBeGreaterThan(0); // the first few got through
    expect(throttled).toBeGreaterThan(0); // the burst got canned, in-character replies
  });

  it("caps session creation per IP on the keyless demo", async () => {
    const { app } = makeApp(); // apiKey null => public demo
    let blocked = 0;
    for (let i = 0; i < 20; i++) {
      const r = await post(app, "/v1/sessions", { plan_id: PLAN.id, end_user_ref: "u" });
      if (r.status === 429) blocked++;
    }
    expect(blocked).toBeGreaterThan(0); // 15 sessions / 10 min ceiling kicks in
  });

  it("does NOT IP-cap session creation when a merchant key guards the route", async () => {
    const { app } = makeApp("secret_key"); // keyed deployment = trusted server
    const h = { "x-api-key": "secret_key" };
    for (let i = 0; i < 20; i++) {
      const r = await post(app, "/v1/sessions", { plan_id: PLAN.id, end_user_ref: "u" }, h);
      expect(r.status).toBe(201); // a merchant server creating from one IP is never throttled
    }
  });
});

describe("early-access waitlist (Spec §15)", () => {
  it("accepts a valid email (keyless), rejects a malformed one, and records it", async () => {
    const { app, store } = makeApp();
    const ok = await post(app, "/v1/waitlist", { email: "Founder@Example.com", source: "thebouncr.com" });
    expect(ok.status).toBe(200);
    expect((await ok.json()).ok).toBe(true);

    const bad = await post(app, "/v1/waitlist", { email: "not-an-email" });
    expect(bad.status).toBe(400);

    const missing = await post(app, "/v1/waitlist", {});
    expect(missing.status).toBe(400);

    // Stored on the append-only event log, normalized (lowercased).
    const signups = store.allEvents().filter((e) => e.type === "waitlist.signup");
    expect(signups).toHaveLength(1);
    expect((signups[0]!.payload as any).email).toBe("founder@example.com");
  });
});

describe("landing page host routing (thebouncr.com)", () => {
  it("serves the landing on thebouncr.com and the playground elsewhere", async () => {
    const { app } = makeApp();

    const landing = await app.request("/", { headers: { host: "thebouncr.com" } });
    expect(landing.status).toBe(200);
    expect(await landing.text()).toContain("Your paywall should");

    const wwwLanding = await app.request("/", { headers: { host: "www.thebouncr.com" } });
    expect(await wwwLanding.text()).toContain("Your paywall should");

    // x-forwarded-host (what Vercel's edge sets) also routes to the landing.
    const fwd = await app.request("/", { headers: { "x-forwarded-host": "thebouncr.com", host: "bouncr.vercel.app" } });
    expect(await fwd.text()).toContain("Your paywall should");

    // bouncr.tech (and the default test host) keeps the live playground.
    const demo = await app.request("/", { headers: { host: "bouncr.tech" } });
    expect(await demo.text()).not.toContain("Your paywall should");

    // landing is always reachable explicitly for preview.
    expect((await app.request("/landing")).status).toBe(200);
    expect(await (await app.request("/landing")).text()).toContain("Your paywall should");
    expect((await app.request("/playground")).status).toBe(200);
  });
});

describe("merchant signup / onboarding (Spec §9)", () => {
  it("signs up a merchant, returns a usable key + token, and creates a first plan", async () => {
    const { app } = makeApp();

    // 1. Signup → merchant, plaintext key, auto-login token.
    const su = await post(app, "/v1/signup", { name: "Acme Co", email: "founder@acme.com" });
    expect(su.status).toBe(201);
    const s = await su.json();
    expect(s.merchant.id).toMatch(/^merchant_/);
    expect(s.key).toMatch(/^bk_merchant_/);
    expect(s.token).toBeTruthy();

    // The returned key actually logs in (independent of the auto-login token).
    expect((await post(app, "/v1/auth/login", { key: s.key })).status).toBe(200);

    const auth = { authorization: "Bearer " + s.token };
    // 2. No plans yet.
    expect((await (await app.request("/v1/plans", { headers: auth })).json()).plans).toHaveLength(0);

    // 3. Create a plan from essentials → returns the plan + an embed snippet.
    const cp = await post(app, "/v1/plans", { product_name: "Acme Pro", list_price: 40, floor_price: 25, persona_name: "Sal" }, auth);
    expect(cp.status).toBe(201);
    const { plan, embed } = await cp.json();
    expect(plan.id).toMatch(/^plan_/);
    expect(plan.list_price).toBe(40);
    expect(plan.floor_price).toBe(25);
    expect(plan.target_price).toBe(32.5); // defaults to the floor↔list midpoint
    expect(plan.persona.name).toBe("Vini"); // always Vini — persona_name is ignored
    expect(embed.snippet).toContain(`data-plan="${plan.id}"`);

    // 4. It now shows in the merchant's plans, scoped to them.
    const list = await (await app.request("/v1/plans", { headers: auth })).json();
    expect(list.plans).toHaveLength(1);
    expect(list.plans[0].id).toBe(plan.id);

    // 5. The new plan is immediately negotiable through the widget.
    const sess = await post(app, "/v1/sessions", { plan_id: plan.id, end_user_ref: "buyer" });
    expect(sess.status).toBe(201);
  });

  it("edits a plan in place — re-lints, bumps version, and stays scoped", async () => {
    const { app } = makeApp();
    const s = await (await post(app, "/v1/signup", { name: "EditCo" })).json();
    const auth = { authorization: "Bearer " + s.token };
    const created = await (await post(app, "/v1/plans", { product_name: "Edit Pro", list_price: 30, floor_price: 20 }, auth)).json();
    const id = created.plan.id;
    const patch = (body: unknown, headers: Record<string, string> = auth) => app.request(`/v1/plans/${id}`, { method: "PATCH", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

    // Valid edit: new prices + persona + a per-plan fee override.
    const ok = await patch({ list_price: 45, floor_price: 28, target_price: 40, persona_name: "Tony", application_fee_percent: 12 });
    expect(ok.status).toBe(200);
    const updated = (await ok.json()).plan;
    expect(updated.list_price).toBe(45);
    expect(updated.floor_price).toBe(28);
    expect(updated.persona.name).toBe("Vini"); // name is fixed — persona_name ignored
    expect(updated.application_fee_percent).toBe(12);
    expect(updated.version).toBe(2); // bumped from 1

    // Clearing the fee (null) reverts to the platform default.
    expect((await (await patch({ application_fee_percent: null })).json()).plan.application_fee_percent).toBeNull();

    // A breaking edit (floor ≥ target) is rejected with the reason.
    const bad = await patch({ floor_price: 100 });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/invalid|target|floor/i);

    // Auth required; another merchant can't edit it (404, not 403).
    expect((await patch({ list_price: 10 }, {})).status).toBe(401);
    const other = await (await post(app, "/v1/signup", { name: "OtherCo" })).json();
    expect((await patch({ list_price: 10 }, { authorization: "Bearer " + other.token })).status).toBe(404);
  });

  it("deactivates a plan — widget can't negotiate it, but it stays manageable and reactivates", async () => {
    const { app } = makeApp();
    const s = await (await post(app, "/v1/signup", { name: "ToggleCo" })).json();
    const auth = { authorization: "Bearer " + s.token };
    const id = (await (await post(app, "/v1/plans", { product_name: "Tog Pro", list_price: 30, floor_price: 20 }, auth)).json()).plan.id;
    const patch = (body: unknown) => app.request(`/v1/plans/${id}`, { method: "PATCH", headers: { "content-type": "application/json", ...auth }, body: JSON.stringify(body) });

    // active by default → negotiable.
    expect((await post(app, "/v1/sessions", { plan_id: id, end_user_ref: "u" })).status).toBe(201);

    // Deactivate → widget can no longer start a negotiation on it.
    expect((await (await patch({ active: false })).json()).plan.active).toBe(false);
    expect((await post(app, "/v1/sessions", { plan_id: id, end_user_ref: "u" })).status).toBe(404);

    // …but it's still listed for the merchant (so they can turn it back on) and editable.
    const plans = (await (await app.request("/v1/plans", { headers: auth })).json()).plans;
    expect(plans.find((p: any) => p.id === id)?.active).toBe(false);
    expect((await (await patch({ list_price: 35 })).json()).plan.list_price).toBe(35); // editable while inactive

    // Reactivate → negotiable again.
    expect((await (await patch({ active: true })).json()).plan.active).toBe(true);
    expect((await post(app, "/v1/sessions", { plan_id: id, end_user_ref: "u" })).status).toBe(201);
  });

  it("rejects signup with no name and a plan that breaks the floor/target invariant", async () => {
    const { app } = makeApp();
    expect((await post(app, "/v1/signup", { name: "" })).status).toBe(400);

    const s = await (await post(app, "/v1/signup", { name: "BadCo" })).json();
    const auth = { authorization: "Bearer " + s.token };
    // floor ≥ list ⇒ no room (lint rejects) → 400 with the reason.
    const bad = await post(app, "/v1/plans", { product_name: "X", list_price: 20, floor_price: 30 }, auth);
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/invalid|target|floor/i);

    // Creating a plan requires auth.
    expect((await post(app, "/v1/plans", { product_name: "X", list_price: 40, floor_price: 20 })).status).toBe(401);
  });

  it("creates the account AND first plan atomically; an invalid plan creates nothing", async () => {
    const { app } = makeApp();
    const ok = await post(app, "/v1/signup", {
      name: "Atomic Co",
      plan: { product_name: "Atomic Pro", list_price: 30, floor_price: 20 },
    });
    expect(ok.status).toBe(201);
    const d = await ok.json();
    expect(d.merchant.id).toMatch(/^merchant_/);
    expect(d.plan.list_price).toBe(30);
    expect(d.embed.snippet).toContain(`data-plan="${d.plan.id}"`);
    // Plan is live for the merchant and negotiable immediately.
    const auth = { authorization: "Bearer " + d.token };
    expect((await (await app.request("/v1/plans", { headers: auth })).json()).plans).toHaveLength(1);
    expect((await post(app, "/v1/sessions", { plan_id: d.plan.id, end_user_ref: "u" })).status).toBe(201);

    // Invalid plan (floor ≥ list) → 400, and NO account/key is returned (nothing created).
    const bad = await post(app, "/v1/signup", {
      name: "BadAtomic",
      plan: { product_name: "X", list_price: 20, floor_price: 30 },
    });
    expect(bad.status).toBe(400);
    const bd = await bad.json();
    expect(bd.key).toBeUndefined();
    expect(bd.token).toBeUndefined();
  });

  it("deletes an account and everything under it, blocking further access", async () => {
    const { app } = makeApp();
    const s = await (await post(app, "/v1/signup", {
      name: "DelCo",
      plan: { product_name: "Del Pro", list_price: 30, floor_price: 20 },
    })).json();
    const auth = { authorization: "Bearer " + s.token };
    const planId = s.plan.id;
    expect((await post(app, "/v1/sessions", { plan_id: planId, end_user_ref: "u" })).status).toBe(201);

    // Delete requires auth.
    expect((await app.request("/v1/account", { method: "DELETE" })).status).toBe(401);

    const del = await app.request("/v1/account", { method: "DELETE", headers: auth });
    expect(del.status).toBe(200);

    // The plan is gone (not negotiable) and the key no longer logs in.
    expect((await post(app, "/v1/sessions", { plan_id: planId, end_user_ref: "u" })).status).toBe(404);
    expect((await post(app, "/v1/auth/login", { key: s.key })).status).toBe(401);
  });
});

describe("merchant dashboard auth (Spec §9)", () => {
  it("logs in with a valid key, rejects a bad one, and gates reads on the token", async () => {
    const { app, merchantKey } = makeApp();

    // wrong key → 401
    expect((await post(app, "/v1/auth/login", { key: "bk_merchant_demo_" + "0".repeat(48) })).status).toBe(401);
    expect((await post(app, "/v1/auth/login", { key: "garbage" })).status).toBe(401);

    // right key → token + merchant
    const ok = await post(app, "/v1/auth/login", { key: merchantKey });
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.token).toBeTruthy();
    expect(body.merchant).toMatchObject({ id: "merchant_demo", name: "Obius" });

    const auth = { authorization: "Bearer " + body.token };
    expect((await app.request("/v1/auth/me", { headers: auth })).status).toBe(200);

    // reads require the token
    expect((await app.request(`/v1/plans/${PLAN.id}/sessions`)).status).toBe(401);
    expect((await app.request(`/v1/plans/${PLAN.id}/sessions`, { headers: auth })).status).toBe(200);

    // a tampered/garbage token is rejected
    expect((await app.request("/v1/auth/me", { headers: { authorization: "Bearer not.a.token" } })).status).toBe(401);
  });

  it("rotates the API key — new key works, old key is dead, current token survives", async () => {
    const { app, merchantKey } = makeApp();
    const auth = await login(app, merchantKey);

    const rot = await post(app, "/v1/auth/rotate-key", undefined, auth);
    expect(rot.status).toBe(200);
    const newKey = (await rot.json()).key;
    expect(newKey).toMatch(/^bk_merchant_demo_/);
    expect(newKey).not.toBe(merchantKey);

    // Old key no longer logs in; the new one does.
    expect((await post(app, "/v1/auth/login", { key: merchantKey })).status).toBe(401);
    expect((await post(app, "/v1/auth/login", { key: newKey })).status).toBe(200);

    // The session token issued before rotation still works (it's not the key).
    expect((await app.request("/v1/auth/me", { headers: auth })).status).toBe(200);

    // Rotation requires auth.
    expect((await post(app, "/v1/auth/rotate-key")).status).toBe(401);
  });

  it("scopes data to the token's merchant — no cross-merchant reads", async () => {
    // Two merchants, each with their own plan, sharing one app/store.
    const planA = { ...demoPlan(), id: "plan_a", planKey: "a", merchantId: "m_a" };
    const planB = { ...demoPlan(), id: "plan_b", planKey: "b", merchantId: "m_b" };
    const mkMerchant = (id: string) => {
      const m = demoMerchant();
      (m as any).id = id;
      const key = generateMerchantKey(id);
      m.apiKeyHash = hashKey(key);
      return { m, key };
    };
    const a = mkMerchant("m_a");
    const b = mkMerchant("m_b");
    const store = new MemoryStore([planA, planB], [a.m, b.m]);
    const app = buildApp({
      service: new BouncrService({ store, stripe: new FakeStripeGateway(), negotiator: makeTemplateNegotiator(), baseUrl: "http://x" }),
      stripe: new FakeStripeGateway(),
      apiKey: null,
      authSecret: AUTH_SECRET,
    });

    const authA = await login(app, a.key);
    // A can read its own plan…
    expect((await app.request("/v1/plans/plan_a/sessions", { headers: authA })).status).toBe(200);
    // …but NOT merchant B's plan (404, not 403 — don't confirm it exists).
    expect((await app.request("/v1/plans/plan_b/sessions", { headers: authA })).status).toBe(404);
    expect((await app.request("/v1/analytics/wtp?plan_id=plan_b", { headers: authA })).status).toBe(404);
    // …and not B's Connect account.
    expect((await app.request("/v1/merchants/m_b/connect", { headers: authA })).status).toBe(404);
  });
});

describe("dashboard + analytics + Connect endpoints (Spec §7, §11, §12)", () => {
  it("serves analytics, lint, transcript, connect, and the dashboard page", async () => {
    const { app, merchantKey } = makeApp();
    const auth = await login(app, merchantKey); // dashboard reads require a logged-in merchant
    const get = (path: string) => app.request(path, { headers: auth });
    // one full negotiation so analytics has data
    const s = await startSession(app);
    const r1 = await post(app, `/v1/sessions/${s.id}/messages`, { message: "$3" }, tok(s.token));
    const ask = (await r1.json()).state.current_ask;
    const close = await post(app, `/v1/sessions/${s.id}/messages`, { message: `ok ${ask}` }, tok(s.token));
    expect((await close.json()).action.type).toBe("accept");

    const an = await (await get(`/v1/analytics/wtp?plan_id=${PLAN.id}`)).json();
    expect(an.funnel.sessions).toBe(1);
    expect(an.offers.closingPrices).toEqual([ask]);

    const lint = await (await get(`/v1/plans/${PLAN.id}/lint`)).json();
    expect(lint.ok).toBe(true);

    const list = await (await get(`/v1/plans/${PLAN.id}/sessions`)).json();
    expect(list.sessions.length).toBe(1);

    const tr = await (await get(`/v1/sessions/${s.id}/transcript`)).json();
    expect(tr.turns.length).toBeGreaterThan(0);
    expect(tr.turns.some((t: any) => t.role === "user")).toBe(true);

    const conn = await (await get(`/v1/merchants/merchant_demo/connect`)).json();
    expect(conn.connected).toBe(false);
    const onboard = await post(app, "/v1/merchants/merchant_demo/connect/onboard", { return_url: "http://x" }, auth);
    expect((await onboard.json()).url).toContain("/connect/onboard/");
    // after onboarding the merchant is connected
    expect((await (await get(`/v1/merchants/merchant_demo/connect`)).json()).connected).toBe(true);

    // unauthenticated dashboard reads are rejected
    expect((await app.request(`/v1/analytics/wtp?plan_id=${PLAN.id}`)).status).toBe(401);

    expect((await app.request("/dashboard")).status).toBe(200);
  });

  it("returns 409 with retry_at when a user is in cooldown", async () => {
    // build an app whose plan walks fast (maxMessages 1)
    const store = new MemoryStore([{ ...PLAN, policy: { cooldownHours: 72, maxMessages: 1 } }], []);
    // demo merchant needed for closeDeal lookups, but no deal here
    const stripe = new FakeStripeGateway();
    const service = new BouncrService({ store, stripe, negotiator: makeTemplateNegotiator(), baseUrl: "http://x" });
    const app = buildApp({ service, stripe, apiKey: null, authSecret: AUTH_SECRET });

    const s = await startSession(app);
    await post(app, `/v1/sessions/${s.id}/messages`, { message: "$1" }, tok(s.token));
    await post(app, `/v1/sessions/${s.id}/messages`, { message: "$1" }, tok(s.token)); // walks
    const blocked = await post(app, "/v1/sessions", { plan_id: PLAN.id, end_user_ref: "u" });
    expect(blocked.status).toBe(409);
    const body = await blocked.json();
    expect(body.code).toBe("conflict");
    expect(body.retry_at).toBeGreaterThan(Date.now());
  });
});

describe("merchant API key (Spec §9)", () => {
  it("guards session creation and deal reads, exempts the webhook and widget", async () => {
    const { app } = makeApp("secret_key");
    expect((await post(app, "/v1/sessions", { plan_id: PLAN.id, end_user_ref: "u" })).status).toBe(401);
    const ok = await post(app, "/v1/sessions", { plan_id: PLAN.id, end_user_ref: "u" }, { "x-api-key": "secret_key" });
    expect(ok.status).toBe(201);
    // webhook + widget are not key-gated
    expect((await post(app, "/v1/webhooks/stripe", { type: "noise" })).status).toBe(200);
    expect((await app.request("/widget")).status).toBe(200);
  });
});
