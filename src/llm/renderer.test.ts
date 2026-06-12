import { describe, it, expect } from "vitest";
import { stripFormatting, template, ordinaryCounterLine } from "./renderer.js";
import { validate } from "./validator.js";
import type { Action } from "../engine.js";
import type { Extraction } from "./types.js";

const extr = (over: Partial<Extraction> = {}): Extraction => ({
  intent: "offer",
  offer_amount: 20,
  sentiment: "neutral",
  tactics: [],
  reasoning: "none",
  ...over,
});

const PERSONA = { name: "Vini", productName: "Obius", style: "deadpan", roastLevel: 2 } as any;

describe("stripFormatting — plain-text texting style", () => {
  it("removes bold/italics but keeps the dollar amount intact", () => {
    const out = stripFormatting("$30? cute. I can do **$37.86**/mo. thats me moving.");
    expect(out).toBe("$30? cute. I can do $37.86/mo. thats me moving.");
    expect(out).not.toContain("*");
  });

  it("strips roleplay asterisks and collapses paragraph breaks", () => {
    const out = stripFormatting("*adjusts earpiece*\n\nOh sweetie, $30?\n\n$37.86, take it.");
    expect(out).not.toContain("*");
    expect(out).not.toMatch(/\n\n/); // collapsed to single newlines
    expect(out).toContain("$37.86");
  });

  it("removes headings, bullets, and code ticks", () => {
    expect(stripFormatting("# Nope\n- $37.86\n`final`")).toBe("Nope\n$37.86\nfinal");
  });

  it("a stripped reply still passes validation (amounts preserved)", () => {
    const action: Action = { type: "counter", amount: 37.86, isFinal: false };
    const stripped = stripFormatting("$30?? lol. **$37.86**/mo, ur move 😏");
    expect(validate(stripped, action, { allowMentions: [30] }).ok).toBe(true);
  });
});

describe("no em dashes (a dead AI tell)", () => {
  it("stripFormatting turns em/en dashes into commas", () => {
    expect(stripFormatting("ok $40 works — say the word")).toBe("ok $40 works, say the word");
    expect(stripFormatting("talked to my boss—best i can do is $30")).not.toMatch(/[—–]/);
    expect(stripFormatting("nah – thats below cost")).not.toMatch(/[—–]/);
  });

  it("no fallback template uses an em or en dash", () => {
    const actions: Action[] = [
      { type: "accept", amount: 22 },
      { type: "counter", amount: 30, isFinal: false },
      { type: "counter", amount: 30, isFinal: true },
      { type: "counter", amount: 40, isFinal: false, agreed: true },
      { type: "hold", amount: 46 },
      { type: "walk" },
    ];
    for (const a of actions) expect(template(a, PERSONA)).not.toMatch(/[—–]/);
  });
});

describe("ordinaryCounterLine — tone by what the user brought", () => {
  it("states the engine's amount and never a different dollar figure", () => {
    for (const tier of ["none", "weak", "moderate", "strong"] as const) {
      const line = ordinaryCounterLine(31, extr({ reasoning: tier, tactics: tier === "weak" ? ["exposure_offer"] : [] }));
      const dollars = [...line.matchAll(/\$(\d+(?:\.\d+)?)/g)].map((m) => m[1]);
      expect(dollars.length, tier).toBeGreaterThan(0);
      expect(dollars.every((d) => d === "31"), `${tier}: ${dollars.join(",")}`).toBe(true);
    }
  });

  it("deflects a VAGUE/small exposure offer (weak) instead of granting a discount", () => {
    const line = ordinaryCounterLine(31, extr({ tactics: ["exposure_offer"], reasoning: "weak" })).toLowerCase();
    expect(line).toMatch(/shoutout|follow|clout|bank/);
    expect(line).toMatch(/do not give|don't give|wave it off/); // no special discount for vague clout
  });

  it("ACKNOWLEDGES a big-reach exposure offer (strong) — real marketing value, not deflected", () => {
    const line = ordinaryCounterLine(31, extr({ tactics: ["exposure_offer"], reasoning: "strong" })).toLowerCase();
    expect(line).toMatch(/reach|audience|referral|marketing value/);
    expect(line).not.toMatch(/wave it off|do not give|don't give/); // a big audience is real value
  });

  it("on a no-case push, gives a token bit and asks for a real case", () => {
    const line = ordinaryCounterLine(40, extr({ reasoning: "none" })).toLowerCase();
    expect(line).toMatch(/token|hustle|pushing/);
    expect(line).toMatch(/budget|competitor|commitment/); // tell them what would actually move you
  });

  it("on a real case, lets the drop feel earned", () => {
    const line = ordinaryCounterLine(28, extr({ reasoning: "strong" })).toLowerCase();
    expect(line).toMatch(/earned|fair case|moved you/);
  });
});

describe("agreed-counter template (conversational handshake)", () => {
  it("states the price, seeks confirmation, and stays Validator-safe (no premature close)", () => {
    const action: Action = { type: "counter", amount: 40, isFinal: false, agreed: true };
    const reply = template(action, PERSONA);
    expect(reply).toContain("$40");
    // It's a handshake, not the close — must NOT use closing language, so the
    // validator (which forbids acceptance language on a non-accept) passes it.
    expect(validate(reply, action).ok).toBe(true);
    expect(reply.toLowerCase()).not.toMatch(/welcome in|sold|done deal/);
  });
});
