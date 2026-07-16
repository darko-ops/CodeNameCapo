/**
 * SMS channel (Spec §10) — unit tests for the sms module (E.164 normalization,
 * Twilio signature verification, TwiML shaping) and end-to-end tests for the
 * channel through the HTTP API: the phone-input embed starts a session and the
 * opener is TEXTED; inbound webhook texts run the same engine turn; the close
 * texts a checkout link; STOP ends the thread; unknown senders get silence.
 */
import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { buildApp } from "./app.js";
import { BouncrService } from "./service.js";
import { MemoryStore } from "./store/memory.js";
import { FakeStripeGateway } from "./stripe/fake.js";
import { makeTemplateNegotiator } from "./llm/negotiator.js";
import { demoPlan, demoMerchant } from "./config.js";
import { normalizePhone, verifyTwilioSignature, twiml, type SmsSender } from "./sms.js";

const PLAN = demoPlan();

/** Test sender — records every text so assertions can read the conversation. */
class CaptureSms implements SmsSender {
  sent: { to: string; body: string }[] = [];
  failWith: Error | null = null;
  async send(to: string, body: string): Promise<void> {
    if (this.failWith) throw this.failWith;
    this.sent.push({ to, body });
  }
}

function makeApp(smsAuthToken: string | null = null) {
  const store = new MemoryStore([PLAN], [demoMerchant()]);
  const sms = new CaptureSms();
  const service = new BouncrService({
    store,
    stripe: new FakeStripeGateway(),
    negotiator: makeTemplateNegotiator(),
    baseUrl: "http://localhost:8787",
    sms,
  });
  const mailer = { send: async () => {} };
  const app = buildApp({ service, stripe: new FakeStripeGateway(), apiKey: null, authSecret: "test_secret", mailer, smsAuthToken });
  return { app, store, sms, service };
}

const start = (app: any, body: unknown, ip = "1.2.3.4") =>
  app.request("/v1/sms/start", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });

/** Simulate a Twilio inbound webhook (form-encoded From/Body). */
const inbound = (app: any, from: string, text: string, headers: Record<string, string> = {}) =>
  app.request("/v1/webhooks/sms", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams({ From: from, Body: text }).toString(),
  });

describe("normalizePhone (E.164)", () => {
  it("normalizes US formats and passes through +country numbers", () => {
    expect(normalizePhone("(555) 123-4567")).toBe("+15551234567");
    expect(normalizePhone("555.123.4567")).toBe("+15551234567");
    expect(normalizePhone("1 555 123 4567")).toBe("+15551234567");
    expect(normalizePhone("+15551234567")).toBe("+15551234567");
    expect(normalizePhone("+44 7700 900123")).toBe("+447700900123");
  });

  it("rejects what can't be a real destination (never guess a country code)", () => {
    expect(normalizePhone("12345")).toBeNull(); // too short
    expect(normalizePhone("555123456789012345")).toBeNull(); // too long
    expect(normalizePhone("call me maybe")).toBeNull();
    expect(normalizePhone("555-1234")).toBeNull(); // 7-digit local — ambiguous
    expect(normalizePhone("447700900123")).toBeNull(); // non-US without a "+"
    expect(normalizePhone("+1234567")).toBeNull(); // + but under 8 digits
  });
});

describe("verifyTwilioSignature", () => {
  const url = "https://bouncr.tech/v1/webhooks/sms";
  const params = { From: "+15551234567", Body: "20 bucks" };
  const sign = (token: string) =>
    createHmac("sha1", token)
      .update(url + Object.keys(params).sort().map((k) => k + params[k as keyof typeof params]).join(""))
      .digest("base64");

  it("accepts the genuine signature and rejects tampering / absence", () => {
    expect(verifyTwilioSignature("tok", url, params, sign("tok"))).toBe(true);
    expect(verifyTwilioSignature("tok", url, params, sign("wrong-token"))).toBe(false);
    expect(verifyTwilioSignature("tok", url, { ...params, Body: "1 buck" }, sign("tok"))).toBe(false);
    expect(verifyTwilioSignature("tok", url, params, undefined)).toBe(false);
  });
});

describe("twiml", () => {
  it("wraps a reply in <Message> with XML escaping; no reply → empty <Response/>", () => {
    expect(twiml("deal <3 & \"done\"")).toContain("<Message>deal &lt;3 &amp; &quot;done&quot;</Message>");
    expect(twiml()).toBe(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`);
    expect(twiml(null)).not.toContain("<Message>");
  });
});

describe("SMS channel end-to-end (Spec §10)", () => {
  it("start texts the opener (with the opt-out notice) to the normalized number", async () => {
    const { app, sms, store } = makeApp();
    const res = await start(app, { plan_id: PLAN.id, phone: "(555) 123-4567" });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true });
    expect(sms.sent).toHaveLength(1);
    expect(sms.sent[0]!.to).toBe("+15551234567");
    expect(sms.sent[0]!.body).toContain("$48"); // the anchor opener
    expect(sms.sent[0]!.body).toContain("STOP");
    const sessions = await store.listSessionsByPlan(PLAN.id);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.channel).toBe("sms");
    expect(sessions[0]!.endUserRef).toBe("+15551234567");
  });

  it("re-starting the same number reuses the open thread (nudge, not a second opener)", async () => {
    const { app, sms, store } = makeApp();
    await start(app, { plan_id: PLAN.id, phone: "+15551234567" });
    const res = await start(app, { plan_id: PLAN.id, phone: "555 123 4567" }); // same number, other format
    expect(res.status).toBe(201);
    expect(await store.listSessionsByPlan(PLAN.id)).toHaveLength(1); // no fork
    expect(sms.sent).toHaveLength(2);
    expect(sms.sent[1]!.body).toContain("$48"); // nudges with the standing ask
    expect(sms.sent[1]!.body).toContain("still on");
  });

  it("rejects a bad number / unknown plan before any text is sent", async () => {
    const { app, sms } = makeApp();
    expect((await start(app, { plan_id: PLAN.id, phone: "nope" })).status).toBe(400);
    expect((await start(app, { plan_id: "plan_ghost", phone: "+15551234567" })).status).toBe(404);
    expect(sms.sent).toHaveLength(0);
  });

  it("surfaces a send failure as bad_request, not a 500", async () => {
    const { app, sms } = makeApp();
    sms.failWith = new Error("twilio 400: unreachable");
    const res = await start(app, { plan_id: PLAN.id, phone: "+15551234567" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("couldn't text");
  });

  it("rate-limits per IP and per destination number (SMS-pumping guard)", async () => {
    const { app } = makeApp();
    // Per IP: 3/min from one address, the 4th is refused.
    for (let i = 0; i < 3; i++) {
      expect((await start(app, { plan_id: PLAN.id, phone: `+1555123456${i}` }, "9.9.9.9")).status).toBe(201);
    }
    expect((await start(app, { plan_id: PLAN.id, phone: "+15551234563" }, "9.9.9.9")).status).toBe(429);
    // Per number: 4/hour to one phone even from rotating IPs, the 5th is refused.
    for (let i = 0; i < 4; i++) {
      expect((await start(app, { plan_id: PLAN.id, phone: "+15550009999" }, `10.0.0.${i}`)).status).toBe(201);
    }
    expect((await start(app, { plan_id: PLAN.id, phone: "+15550009999" }, "10.0.0.99")).status).toBe(429);
  });

  it("inbound texts run the engine turn; the close texts back a checkout link", async () => {
    const { app } = makeApp();
    await start(app, { plan_id: PLAN.id, phone: "+15551234567" });

    // Low offer → counter, delivered as TwiML.
    const r1 = await inbound(app, "+15551234567", "25 bucks");
    expect(r1.status).toBe(200);
    expect(r1.headers.get("content-type")).toContain("text/xml");
    const t1 = await r1.text();
    expect(t1).toContain("<Message>");
    expect(t1).not.toContain("checkout"); // no deal yet

    // Taking the standing ask → engine accepts; reply carries the pay link.
    const r2 = await inbound(app, "(555) 123-4567", "deal"); // any From format routes home
    const t2 = await r2.text();
    expect(t2).toContain("lock it in");
    expect(t2).toContain("/checkout/");
  });

  it("STOP ends the thread silently; unknown senders get an empty <Response/>", async () => {
    const { app, store } = makeApp();
    await start(app, { plan_id: PLAN.id, phone: "+15551234567" });

    const stop = await inbound(app, "+15551234567", "STOP");
    expect(await stop.text()).not.toContain("<Message>"); // carrier sends the confirmation
    const session = (await store.listSessionsByPlan(PLAN.id))[0]!;
    expect(session.status).toBe("walked");

    // After opting out (and for strangers) the webhook yields silence, so it
    // can't be used to make Bouncr talk to arbitrary numbers.
    expect(await (await inbound(app, "+15551234567", "hello?")).text()).not.toContain("<Message>");
    expect(await (await inbound(app, "+19998887777", "who dis")).text()).not.toContain("<Message>");
  });

  it("with a Twilio auth token configured, unsigned webhooks are refused", async () => {
    const { app } = makeApp("twilio_auth_token");
    await start(app, { plan_id: PLAN.id, phone: "+15551234567" });

    expect((await inbound(app, "+15551234567", "20 bucks")).status).toBe(403);
    expect((await inbound(app, "+15551234567", "20 bucks", { "x-twilio-signature": "forged" })).status).toBe(403);

    // Signed over the exact URL + sorted params, as Twilio does.
    const params = { Body: "20 bucks", From: "+15551234567" };
    const sig = createHmac("sha1", "twilio_auth_token")
      .update("http://localhost/v1/webhooks/sms" + Object.keys(params).sort().map((k) => k + params[k as keyof typeof params]).join(""))
      .digest("base64");
    const ok = await inbound(app, "+15551234567", "20 bucks", { "x-twilio-signature": sig });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain("<Message>");
  });

  it("serves the phone-input embed page and the loader knows the sms channel", async () => {
    const { app } = makeApp();
    const page = await app.request("/widget/sms?plan=pro_monthly");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("/v1/sms/start");
    const loader = await (await app.request("/embed.js")).text();
    expect(loader).toContain("/widget/sms");
    expect(loader).toContain("channel");
  });
});
