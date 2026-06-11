import { describe, it, expect } from "vitest";
import { buildApp } from "./app.js";
import { BouncrService } from "./service.js";
import { MemoryStore } from "./store/memory.js";
import { FakeStripeGateway } from "./stripe/fake.js";
import { makeTemplateNegotiator } from "./llm/negotiator.js";
import { demoPlan, demoMerchant } from "./config.js";

const PLAN = demoPlan();

function makeApp(apiKey: string | null = null) {
  const store = new MemoryStore([PLAN], [demoMerchant()]);
  const stripe = new FakeStripeGateway();
  const service = new BouncrService({
    store,
    stripe,
    negotiator: makeTemplateNegotiator(),
    baseUrl: "http://localhost:8787",
  });
  return { app: buildApp({ service, stripe, apiKey }), store, stripe };
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

describe("dashboard + analytics + Connect endpoints (Spec §7, §11, §12)", () => {
  it("serves analytics, lint, transcript, connect, and the dashboard page", async () => {
    const { app } = makeApp();
    // one full negotiation so analytics has data
    const s = await startSession(app);
    const r1 = await post(app, `/v1/sessions/${s.id}/messages`, { message: "$3" }, tok(s.token));
    const ask = (await r1.json()).state.current_ask;
    const close = await post(app, `/v1/sessions/${s.id}/messages`, { message: `ok ${ask}` }, tok(s.token));
    expect((await close.json()).action.type).toBe("accept");

    const an = await (await app.request(`/v1/analytics/wtp?plan_id=${PLAN.id}`)).json();
    expect(an.funnel.sessions).toBe(1);
    expect(an.offers.closingPrices).toEqual([ask]);

    const lint = await (await app.request(`/v1/plans/${PLAN.id}/lint`)).json();
    expect(lint.ok).toBe(true);

    const list = await (await app.request(`/v1/plans/${PLAN.id}/sessions`)).json();
    expect(list.sessions.length).toBe(1);

    const tr = await (await app.request(`/v1/sessions/${s.id}/transcript`)).json();
    expect(tr.turns.length).toBeGreaterThan(0);
    expect(tr.turns.some((t: any) => t.role === "user")).toBe(true);

    const conn = await (await app.request(`/v1/merchants/merchant_demo/connect`)).json();
    expect(conn.connected).toBe(false);
    const onboard = await post(app, "/v1/merchants/merchant_demo/connect/onboard", { return_url: "http://x" });
    expect((await onboard.json()).url).toContain("/connect/onboard/");
    // after onboarding the merchant is connected
    expect((await (await app.request(`/v1/merchants/merchant_demo/connect`)).json()).connected).toBe(true);

    expect((await app.request("/dashboard")).status).toBe(200);
  });

  it("returns 409 with retry_at when a user is in cooldown", async () => {
    // build an app whose plan walks fast (maxMessages 1)
    const store = new MemoryStore([{ ...PLAN, policy: { cooldownHours: 72, maxMessages: 1 } }], []);
    // demo merchant needed for closeDeal lookups, but no deal here
    const stripe = new FakeStripeGateway();
    const service = new BouncrService({ store, stripe, negotiator: makeTemplateNegotiator(), baseUrl: "http://x" });
    const app = buildApp({ service, stripe, apiKey: null });

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
