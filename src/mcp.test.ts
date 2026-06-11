import { describe, it, expect } from "vitest";
import { buildApp } from "./app.js";
import { BouncrService } from "./service.js";
import { MemoryStore } from "./store/memory.js";
import { FakeStripeGateway } from "./stripe/fake.js";
import { makeTemplateNegotiator } from "./llm/negotiator.js";
import { demoPlan, demoMerchant } from "./config.js";

const PLAN = demoPlan();

function makeApp() {
  const store = new MemoryStore([PLAN], [demoMerchant()]);
  const stripe = new FakeStripeGateway();
  const service = new BouncrService({ store, stripe, negotiator: makeTemplateNegotiator(), baseUrl: "http://x" });
  return buildApp({ service, stripe, apiKey: null, authSecret: "test_secret" });
}

const rpc = (app: any, msg: unknown) =>
  app.request("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify(msg),
  });
const call = async (app: any, msg: unknown) => (await rpc(app, msg)).json();
async function tool(app: any, name: string, args: unknown, id = 1) {
  const r = await call(app, { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
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
});
