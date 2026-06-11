import { describe, it, expect } from "vitest";
import { stripFormatting, template } from "./renderer.js";
import { validate } from "./validator.js";
import type { Action } from "../engine.js";

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
