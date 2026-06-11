/**
 * Bouncr MCP server (v1) — exposes negotiation as tools any AI agent can call,
 * over the Model Context Protocol's Streamable HTTP transport. A buyer's agent
 * (or a merchant's own agent) negotiates programmatically and STILL cannot breach
 * the floor: every tool call runs the same Extractor → Engine → Validator pipeline
 * as the widget, so the price guarantees hold no matter who — or what — is on the
 * other side. Agents try prompt injection harder than humans; the LLM and the
 * numbers never touch, so it doesn't matter.
 *
 * Stateless: the MCP layer keeps no transport session of its own. The Bouncr
 * negotiation session is application state, threaded via session_id/session_token
 * in the tool args and persisted in the store, so each tool call is an independent
 * HTTP request — which is exactly why this needs the durable (Postgres) store.
 *
 * The JSON-RPC transport is implemented directly (no SDK) to compose cleanly with
 * the existing fetch-based Hono app on a serverless host.
 */
import { BouncrService, ServiceError } from "./service.js";

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "bouncr", title: "Bouncr — negotiated pricing", version: "1.0.0" };
const INSTRUCTIONS =
  "Bouncr lets you negotiate the price of a subscription on a user's behalf. " +
  "Call bouncr_start_negotiation with the merchant's plan id to open a session, then bouncr_offer to haggle — " +
  "cite a real reason (a budget, a commitment like annual billing, a competitor's price, word of mouth) to unlock a " +
  "better price. Call bouncr_accept to close and get a checkout URL. The merchant guarantees a price floor you cannot go below.";

export const MCP_TOOLS = [
  {
    name: "bouncr_start_negotiation",
    description:
      "Open a price negotiation for a plan and get the bouncer's opening offer. Returns a session_id and session_token to pass to the other tools.",
    inputSchema: {
      type: "object",
      properties: {
        plan: { type: "string", description: "The merchant's plan id (e.g. plan_… or a public plan key)." },
        user_ref: { type: "string", description: "Optional stable id for the end user you're negotiating for." },
      },
      required: ["plan"],
    },
  },
  {
    name: "bouncr_offer",
    description:
      "Send a message or price offer to the bouncer and get its reply. Make your case — better reasoning unlocks a lower price, but never below the merchant's floor.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        session_token: { type: "string" },
        message: { type: "string", description: "Your offer or message, e.g. \"I'll do $40 if I commit to annual billing\"." },
      },
      required: ["session_id", "session_token", "message"],
    },
  },
  {
    name: "bouncr_accept",
    description: "Accept the bouncer's current asking price and get a checkout URL to complete the purchase.",
    inputSchema: {
      type: "object",
      properties: { session_id: { type: "string" }, session_token: { type: "string" } },
      required: ["session_id", "session_token"],
    },
  },
  {
    name: "bouncr_status",
    description: "Check the current state of a negotiation (status, current ask, expiry).",
    inputSchema: {
      type: "object",
      properties: { session_id: { type: "string" }, session_token: { type: "string" } },
      required: ["session_id", "session_token"],
    },
  },
] as const;

type Json = Record<string, any>;

/**
 * Handle one JSON-RPC message. Returns a response object, or null for a
 * notification (the caller replies 202 with no body).
 */
export async function dispatchMcp(service: BouncrService, msg: Json): Promise<Json | null> {
  const id = msg?.id;
  const method = msg?.method;
  const params = msg?.params ?? {};
  const isNotification = id === undefined || id === null;
  const ok = (result: Json) => ({ jsonrpc: "2.0", id, result });
  const err = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

  try {
    switch (method) {
      case "initialize":
        return ok({
          protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        });
      case "notifications/initialized":
      case "notifications/cancelled":
        return null;
      case "ping":
        return ok({});
      case "tools/list":
        return ok({ tools: MCP_TOOLS });
      case "tools/call":
        return ok(await callTool(service, params.name, params.arguments ?? {}));
      default:
        return isNotification ? null : err(-32601, `method not found: ${method}`);
    }
  } catch (e) {
    return isNotification ? null : err(-32603, e instanceof Error ? e.message : "internal error");
  }
}

/** Execute a tool. Tool-level failures come back as isError content (the agent reads it), not JSON-RPC errors. */
async function callTool(service: BouncrService, name: string, args: Json): Promise<Json> {
  const toolErr = (message: string) => ({ content: [{ type: "text", text: message }], isError: true });
  const result = (data: Json) => ({ content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data });

  try {
    switch (name) {
      case "bouncr_start_negotiation": {
        const plan = str(args.plan);
        if (!plan) return toolErr("plan is required");
        const s = await service.createSession({ planId: plan, endUserRef: str(args.user_ref) ?? `agent_${rand()}` });
        const view = await service.getSessionView(s.sessionId);
        return result({
          session_id: s.sessionId,
          session_token: s.sessionToken,
          opener: s.opener,
          current_ask: view.currentAsk,
          status: view.status,
          expires_at: s.expiresAt,
        });
      }
      case "bouncr_offer": {
        const auth = await authArgs(service, args);
        if (auth.e) return toolErr(auth.e);
        const message = str(args.message);
        if (!message) return toolErr("message is required");
        const r = await service.postMessage(auth.sid!, message);
        return result({
          reply: r.reply,
          action: r.action,
          current_ask: r.currentAsk,
          status: r.status,
          is_final: r.isFinal,
          ...(r.checkoutUrl ? { checkout_url: r.checkoutUrl, deal_id: r.dealId } : {}),
        });
      }
      case "bouncr_accept": {
        const auth = await authArgs(service, args);
        if (auth.e) return toolErr(auth.e);
        const r = await service.acceptCurrent(auth.sid!);
        return result({ price: r.price, deal_id: r.dealId, ...(r.checkoutUrl ? { checkout_url: r.checkoutUrl } : {}) });
      }
      case "bouncr_status": {
        const auth = await authArgs(service, args);
        if (auth.e) return toolErr(auth.e);
        const v = await service.getSessionView(auth.sid!);
        return result({ status: v.status, current_ask: v.currentAsk, expires_at: v.expiresAt });
      }
      default:
        return toolErr(`unknown tool: ${name}`);
    }
  } catch (e) {
    // Service errors (cooldown, unknown plan, closed session) are negotiation
    // outcomes the agent should see — surface them as tool errors, not crashes.
    if (e instanceof ServiceError) return toolErr(e.message);
    throw e;
  }
}

async function authArgs(service: BouncrService, args: Json): Promise<{ sid?: string; e?: string }> {
  const sid = str(args.session_id);
  const tok = str(args.session_token);
  if (!sid || !tok) return { e: "session_id and session_token are required" };
  try {
    await service.verifySessionToken(sid, tok);
  } catch {
    return { e: "invalid session_id or session_token" };
  }
  return { sid };
}

const str = (x: unknown): string | null => (typeof x === "string" && x.trim() ? x.trim() : null);
const rand = () => Math.random().toString(36).slice(2, 10);
