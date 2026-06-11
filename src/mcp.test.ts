import { describe, it, expect } from "vitest";
import { buildApp } from "./app.js";
import { BouncrService } from "./service.js";
import { MemoryStore } from "./store/memory.js";
import { FakeStripeGateway } from "./stripe/fake.js";
import { makeTemplateNegotiator } from "./llm/negotiator.js";
import { demoPlan, demoMerchant } from "./config.js";
import { generateMerchantKey, hashKey } from "./auth.js";
import { ConsoleMailer } from "./mailer.js";

const PLAN = demoPlan();

function makeApp() {
  const store = new MemoryStore([PLAN], [demoMerchant()]);
  const stripe = new FakeStripeGateway();
  const service = new BouncrService({ store, stripe, negotiator: makeTemplateNegotiator(), baseUrl: "http://x" });
  return buildApp({ service, stripe, apiKey: null, authSecret: "test_secret", mailer: new ConsoleMailer() });
}

// Two merchants, each with a key + plans (one of A's is inactive), one app/store.
function makeMerchant(id: string) {
  const m = demoMerchant();
  (m as any).id = id;
  const key = generateMerchantKey(id);
  m.apiKeyHash = hashKey(key);
  return { m, key };
}
function scopedApp() {
  const a = makeMerchant("m_a");
  const b = makeMerchant("m_b");
  const store = new MemoryStore(
    [
      { ...demoPlan(), id: "plan_a", planKey: "pa", merchantId: "m_a" },
      { ...demoPlan(), id: "plan_a_off", planKey: "pao", merchantId: "m_a", active: false },
      { ...demoPlan(), id: "plan_b", planKey: "pb", merchantId: "m_b" },
    ],
    [a.m, b.m],
  );
  const stripe = new FakeStripeGateway();
  const service = new BouncrService({ store, stripe, negotiator: makeTemplateNegotiator(), baseUrl: "http://x" });
  return { app: buildApp({ service, stripe, apiKey: null, authSecret: "s", mailer: new ConsoleMailer() }), keyA: a.key, keyB: b.key };
}

const rpc = (app: any, msg: unknown, key?: string) =>
  app.request("/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(key ? { authorization: "Bearer " + key } : {}),
    },
    body: JSON.stringify(msg),
  });
const call = async (app: any, msg: unknown, key?: string) => (await rpc(app, msg, key)).json();
async function tool(app: any, name: string, args: unknown, id = 1, key?: string) {
  const r = await call(app, { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }, key);
  return r.result as { content: any[]; structuredContent?: any; isError?: boolean };
}

describe("MCP server (Streamable HTTP)", () => {
  it("initializes and lists the negotiation tools", async () => {
    const app = makeApp();
    const init = await call(app, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    expect(init.result.serverInfo.name).toBe("bouncr");
    expect(init.result.capabilities.tools).toBeDefined();
    expect(init.result.protocolVersion).toBe("2025-06-18");

    const list = await call(app, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    const names = list.result.tools.map((t: any) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(["bouncr_start_negotiation", "bouncr_offer", "bouncr_accept", "bouncr_status"]),
    );
  });

  it("answers 202 to a notification and {} to ping", async () => {
    const app = makeApp();
    expect((await rpc(app, { jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
    const pong = await call(app, { jsonrpc: "2.0", id: 9, method: "ping" });
    expect(pong.result).toEqual({});
  });

  it("runs a full negotiation through the tools and closes a deal", async () => {
    const app = makeApp();
    const start = await tool(app, "bouncr_start_negotiation", { plan: "pro_monthly", user_ref: "agent_1" });
    expect(start.isError).toBeUndefined();
    const s = start.structuredContent;
    expect(s.session_id).toBeTruthy();
    expect(s.session_token).toMatch(/^sst_/);
    expect(s.current_ask).toBeGreaterThan(0);

    const offer = await tool(app, "bouncr_offer", { session_id: s.session_id, session_token: s.session_token, message: "$5" }, 2);
    expect(offer.structuredContent.action.type).toBe("counter");

    // Meet the standing ask → the engine accepts and hands back a checkout URL.
    const ask = offer.structuredContent.current_ask;
    const close = await tool(app, "bouncr_offer", { session_id: s.session_id, session_token: s.session_token, message: `ok ${ask}` }, 3);
    expect(close.structuredContent.action.type).toBe("accept");
    expect(close.structuredContent.checkout_url).toContain("/checkout/");
  });

  it("rejects a wrong session token, surfaces unknown plans, all as tool errors not crashes", async () => {
    const app = makeApp();
    const start = (await tool(app, "bouncr_start_negotiation", { plan: "pro_monthly" })).structuredContent;
    const bad = await tool(app, "bouncr_offer", { session_id: start.session_id, session_token: "wrong", message: "hi" }, 2);
    expect(bad.isError).toBe(true);

    const noPlan = await tool(app, "bouncr_start_negotiation", { plan: "does_not_exist" }, 3);
    expect(noPlan.isError).toBe(true);

    const unknown = await tool(app, "bouncr_nope", {}, 4);
    expect(unknown.isError).toBe(true);
  });

  it("returns a JSON-RPC error for an unknown method and 405 on GET", async () => {
    const app = makeApp();
    const r = await call(app, { jsonrpc: "2.0", id: 7, method: "bogus/method" });
    expect(r.error.code).toBe(-32601);
    expect((await app.request("/mcp")).status).toBe(405);
  });

  it("serves MCP at the bare root on the mcp.thebouncr.com alias", async () => {
    const app = makeApp();
    const post = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json", host: "mcp.thebouncr.com" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(post.status).toBe(200);
    expect((await post.json()).result).toEqual({});
    // GET on the alias root is an info doc, not the landing page.
    const info = await app.request("/", { headers: { host: "mcp.thebouncr.com" } });
    expect((await info.json()).transport).toBe("streamable-http");
    // The main domain root is unaffected.
    expect((await app.request("/", { headers: { host: "thebouncr.com" } })).headers.get("content-type")).toContain("text/html");
  });
});

describe("MCP merchant-scoped mode", () => {
  const names = (m: any) => m.result.tools.map((t: any) => t.name);

  it("a valid key resolves the merchant and advertises bouncr_list_plans; keyless does not", async () => {
    const { app, keyA } = scopedApp();
    const keyless = await call(app, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(names(keyless)).not.toContain("bouncr_list_plans");
    const scoped = await call(app, { jsonrpc: "2.0", id: 1, method: "tools/list" }, keyA);
    expect(names(scoped)).toContain("bouncr_list_plans");
  });

  it("rejects an invalid key (401) while keyless mode keeps working", async () => {
    const { app } = scopedApp();
    expect((await rpc(app, { jsonrpc: "2.0", id: 1, method: "tools/list" }, "bk_m_a_" + "0".repeat(48))).status).toBe(401);
    expect((await rpc(app, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(200);
  });

  it("bouncr_list_plans returns only the caller's ACTIVE plans, stripped of policy internals", async () => {
    const { app, keyA } = scopedApp();
    const r = await tool(app, "bouncr_list_plans", {}, 1, keyA);
    const plans = r.structuredContent.plans;
    expect(plans.map((p: any) => p.plan_id)).toEqual(["plan_a"]); // not the inactive one, not merchant B's
    expect(plans[0]).toHaveProperty("display_price");
    expect(plans[0]).toHaveProperty("currency");
    // policy internals must never cross the MCP boundary
    expect(JSON.stringify(plans)).not.toMatch(/floor|target|anchor|lambda|concession|threshold/i);
  });

  it("refuses bouncr_list_plans without a key", async () => {
    const { app } = scopedApp();
    expect((await tool(app, "bouncr_list_plans", {}, 1)).isError).toBe(true);
  });

  it("scopes plans and sessions to the merchant — cross-merchant access is not-found", async () => {
    const { app, keyA, keyB } = scopedApp();

    // A negotiates its own plan.
    const startA = await tool(app, "bouncr_start_negotiation", { plan: "plan_a" }, 1, keyA);
    expect(startA.isError).toBeUndefined();
    const sA = startA.structuredContent;

    // A cannot start on B's plan — not-found, no existence leak.
    const cross = await tool(app, "bouncr_start_negotiation", { plan: "plan_b" }, 2, keyA);
    expect(cross.isError).toBe(true);
    expect(JSON.stringify(cross)).toMatch(/not found/i);

    // B (a different valid merchant) can't act on A's session even with its token.
    const hijack = await tool(app, "bouncr_status", { session_id: sA.session_id, session_token: sA.session_token }, 3, keyB);
    expect(hijack.isError).toBe(true);

    // A can act on its own session.
    expect((await tool(app, "bouncr_status", { session_id: sA.session_id, session_token: sA.session_token }, 4, keyA)).isError).toBeUndefined();
  });
});
