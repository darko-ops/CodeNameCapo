/**
 * Discovery Phase Data Policy — the guardrail tests.
 *
 * The single load-bearing guarantee (Rule 1): discovery data reaches the
 * persona/renderer and NEVER the policy engine, so it can personalize the
 * *argument* for the price but can never move the *number*. This file proves
 * that three ways:
 *   1. Compile-time: decide() takes no discovery param (@ts-expect-error, under tsc).
 *   2. Runtime data-flow: the same turn yields an identical engine action whether
 *      or not discovery is present, and the discovery view reaches render().
 *   3. The NEVER-list of forbidden fields is rejected at config-parse time.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  parseDiscoveryConfig,
  discoveryPromptFragment,
  emptyDiscovery,
  FORBIDDEN_DISCOVERY_KEYS,
  type DiscoveryView,
} from "./discovery.js";
import { decide, openSession, type Config } from "../engine.js";

const CFG: Config = {
  listPrice: 30,
  floorPrice: 22,
  targetPrice: 32,
  anchorMultiplier: 1.6,
  maxRounds: 6,
  maxDurationH: 48,
  acceptThreshold: 0.92,
  minConcession: 1,
  lambda: 0.55,
};

// --- Mocks for the data-flow test (real engine, faked LLM seams) ------------

const hoisted = vi.hoisted(() => ({ renderArgs: [] as (DiscoveryView | undefined)[] }));

vi.mock("./extractor.js", () => ({
  extract: vi.fn(async () => ({
    intent: "offer" as const,
    offer_amount: 25,
    sentiment: "neutral" as const,
    tactics: [],
    reasoning: "weak" as const,
  })),
}));

vi.mock("./renderer.js", () => ({
  // Capture the discovery view the renderer is handed; return a Validator-safe line.
  render: vi.fn(async (_c, _p, _a, _e, _h, discovery) => {
    hoisted.renderArgs.push(discovery);
    return "talked to my boss, $X is the best i can do";
  }),
  template: vi.fn(() => "template reply"),
}));

vi.mock("./validator.js", () => ({ validate: () => ({ ok: true }) }));

import { runTurn } from "./pipeline.js";

describe("discovery → renderer is a one-way seam (Rule 1)", () => {
  beforeEach(() => {
    hoisted.renderArgs.length = 0;
  });

  const ctx = (discovery?: DiscoveryView) => ({
    client: {} as never,
    cfg: CFG,
    persona: { name: "Vini", productName: "Obius", style: "sassy" as const, roastLevel: 2 },
    state: openSession(CFG, 0),
    history: [],
    userMessage: "i'll give you $25",
    now: 1000,
    ...(discovery ? { discovery } : {}),
  });

  it("yields an IDENTICAL engine action regardless of discovery content", async () => {
    const none = await runTurn(ctx(undefined));
    const rich = await runTurn(
      ctx({ ctx: { answers: { first_name: "Sam", work_or_student: "student", currently_pays: "$999/mo" } } }),
    );
    // The number the engine decided did not budge — discovery touched only the pitch.
    expect(rich.action).toEqual(none.action);
    expect(rich.state).toEqual(none.state);
  });

  it("routes the discovery view to the renderer", async () => {
    const view: DiscoveryView = { ctx: { answers: { first_name: "Sam" } } };
    await runTurn(ctx(view));
    expect(hoisted.renderArgs.at(-1)).toBe(view);
  });
});

describe("parseDiscoveryConfig — NEVER-list enforcement", () => {
  it("rejects a forbidden field with a policy-grounded error", () => {
    const r = parseDiscoveryConfig({ enabled: true, questions: [{ field: "income", prompt: "what do you make?" }] });
    expect(r.config).toBeNull();
    expect(r.errors.join(" ")).toMatch(/NEVER list/i);
  });

  it("rejects EVERY field on the forbidden deny-list", () => {
    for (const k of FORBIDDEN_DISCOVERY_KEYS) {
      const r = parseDiscoveryConfig({ questions: [{ field: k, prompt: "x" }] });
      expect(r.config, `expected "${k}" to be rejected`).toBeNull();
    }
  });

  it("accepts a valid core config and applies the enabled default", () => {
    const r = parseDiscoveryConfig({ enabled: true, questions: [{ field: "first_name", prompt: "ur name?" }] });
    expect(r.errors).toEqual([]);
    expect(r.config?.questions[0]?.enabled).toBe(true);
  });

  it("warns when more than 3 questions are enabled (kills haggle momentum)", () => {
    const r = parseDiscoveryConfig({
      enabled: true,
      questions: [
        { field: "first_name", prompt: "a" },
        { field: "work_or_student", prompt: "b" },
        { field: "use_case", prompt: "c" },
        { field: "currently_pays", prompt: "d" },
      ],
    });
    expect(r.config).not.toBeNull();
    expect(r.warnings.join(" ")).toMatch(/momentum/);
  });
});

describe("discoveryPromptFragment — persona view (Rule 2 + the SF trap)", () => {
  it("says nothing when there is nothing to say", () => {
    expect(discoveryPromptFragment(undefined)).toBe("");
    expect(discoveryPromptFragment({})).toBe("");
    expect(discoveryPromptFragment({ ctx: emptyDiscovery() })).toBe("");
  });

  it("says nothing when discovery is disabled, even with answers on hand", () => {
    const view: DiscoveryView = {
      cfg: { enabled: false, questions: [] },
      ctx: { answers: { first_name: "Sam" } },
    };
    expect(discoveryPromptFragment(view)).toBe("");
  });

  it("surfaces volunteered answers as levers and ALWAYS restates the price rule", () => {
    const f = discoveryPromptFragment({ ctx: { answers: { first_name: "Sam", work_or_student: "student" } } });
    expect(f).toContain("Sam");
    expect(f).toMatch(/identical for everyone|never WHAT you charge/i);
  });

  it("NEVER surfaces region to the persona — it's a currency/config field, not a wealth signal", () => {
    expect(discoveryPromptFragment({ ctx: { answers: { region: "San Francisco" } } })).toBe("");
    const f = discoveryPromptFragment({ ctx: { answers: { first_name: "Sam", region: "San Francisco" } } });
    expect(f).toContain("Sam");
    expect(f).not.toContain("San Francisco");
  });

  it("weaves in at most two unanswered questions (a chat, not a survey)", () => {
    const view: DiscoveryView = {
      cfg: {
        enabled: true,
        questions: [
          { field: "first_name", prompt: "ASK_NAME", enabled: true },
          { field: "work_or_student", prompt: "ASK_WORK", enabled: true },
          { field: "use_case", prompt: "ASK_USE", enabled: true },
        ],
      },
      ctx: { answers: {} },
    };
    const f = discoveryPromptFragment(view);
    const asked = ["ASK_NAME", "ASK_WORK", "ASK_USE"].filter((p) => f.includes(p));
    expect(asked.length).toBe(2);
  });

  it("stops asking a question once it's been answered", () => {
    const view: DiscoveryView = {
      cfg: { enabled: true, questions: [{ field: "first_name", prompt: "ASK_NAME", enabled: true }] },
      ctx: { answers: { first_name: "Sam" } },
    };
    const f = discoveryPromptFragment(view);
    expect(f).not.toContain("ASK_NAME");
    expect(f).toContain("Sam");
  });
});

describe("decide() is structurally closed to discovery (Rule 1, enforced by tsc)", () => {
  it("only the reasoning opt is assignable; discovery fields are not", () => {
    const s = openSession(CFG, 0);
    // Legal — the engine's ONLY knob is the reasoning tier.
    decide(s, 25, CFG, 1000, { reasoning: "weak" });
    // @ts-expect-error — a discovery field cannot be smuggled into the engine's opts.
    decide(s, 25, CFG, 1000, { reasoning: "weak", first_name: "Sam" });
    // @ts-expect-error — a DiscoveryContext is not assignable to the engine's opts.
    decide(s, 25, CFG, 1000, { answers: { first_name: "Sam" } });
    expect(true).toBe(true);
  });
});
