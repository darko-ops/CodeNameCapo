import { describe, it, expect } from "vitest";
import { validate, permittedAmount, extractMentionedAmounts } from "./validator.js";
import { template } from "./renderer.js";
import type { Action } from "../engine.js";
import type { Persona } from "./types.js";

const PERSONA: Persona = { name: "Vinny", productName: "Obius", style: "sassy", roastLevel: 2 };

describe("permittedAmount", () => {
  it("returns the amount for accept/counter/hold and null for walk", () => {
    expect(permittedAmount({ type: "accept", amount: 22 })).toBe(22);
    expect(permittedAmount({ type: "counter", amount: 18.5, isFinal: false })).toBe(18.5);
    expect(permittedAmount({ type: "hold", amount: 30 })).toBe(30);
    expect(permittedAmount({ type: "walk" })).toBeNull();
  });
});

describe("extractMentionedAmounts", () => {
  it("catches $-prefixed and cadence-attached numbers, ignores plain integers", () => {
    expect(extractMentionedAmounts("I can do $18/mo.").sort()).toEqual([18]);
    expect(extractMentionedAmounts("15 a month, final.")).toEqual([15]);
    expect(extractMentionedAmounts("9 bucks or nothing")).toEqual([9]);
    expect(extractMentionedAmounts("$1,299.50 is the list")).toEqual([1299.5]);
    // "round 3" / "48 hours" are not prices — no $ and no cadence
    expect(extractMentionedAmounts("you've got 48 hours, this is round 3")).toEqual([]);
  });
});

describe("validate — number leakage (Spec §5.2a)", () => {
  it("passes when the reply states exactly the permitted amount", () => {
    const a: Action = { type: "counter", amount: 18, isFinal: false };
    expect(validate("Tell you what — $18/mo. That's me moving.", a).ok).toBe(true);
  });

  it("FAILS when the reply states a different number (a hallucinated discount)", () => {
    const a: Action = { type: "counter", amount: 18, isFinal: false };
    const v = validate("You twisted my arm — $5/mo, just for you.", a);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/\$5/);
  });

  it("FAILS when an accept omits the price entirely", () => {
    const a: Action = { type: "accept", amount: 22 };
    expect(validate("You got it, welcome aboard!", a).ok).toBe(false);
  });

  it("FAILS when a walk reply states any price", () => {
    const a: Action = { type: "walk" };
    const v = validate("Fine, $8/mo, get out of here.", a);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/no price allowed/);
  });

  it("passes a clean walk with no number", () => {
    expect(validate("We're done here. Standard pricing is that way.", { type: "walk" }).ok).toBe(true);
  });
});

describe("validate — quoting the user's offer (allowMentions)", () => {
  const counter: Action = { type: "counter", amount: 37.86, isFinal: false };

  it("allows the user's own offer to be quoted alongside the permitted price", () => {
    const v = validate("$30? cute. I can do $37.86/mo — that's me moving.", counter, { allowMentions: [30] });
    expect(v.ok).toBe(true);
  });

  it("still rejects a third, unexplained number even with the offer allowed", () => {
    const v = validate("$30? no. But for $19/mo, sure.", counter, { allowMentions: [30] });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/\$19/);
  });

  it("still requires the permitted price to appear (can't only quote the user)", () => {
    const v = validate("$30? in this economy? absolutely not.", counter, { allowMentions: [30] });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/omitted/);
  });

  it("without allowMentions, the user's number is still forbidden (default strict)", () => {
    expect(validate("$30? I can do $37.86.", counter).ok).toBe(false);
  });
});

describe("validate — acceptance language (Spec §5.2b)", () => {
  it("FAILS fabricated acceptance on a counter", () => {
    const a: Action = { type: "counter", amount: 18, isFinal: false };
    const v = validate("It's a deal — $18/mo!", a);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/acceptance language/);
  });

  it("allows acceptance language on an actual accept", () => {
    const a: Action = { type: "accept", amount: 22 };
    expect(validate("You got it — $22/mo. Welcome in.", a).ok).toBe(true);
  });

  it("does not flag NEGATED 'deal' on a counter", () => {
    const a: Action = { type: "counter", amount: 18, isFinal: false };
    expect(validate("That's no deal I can make. $18/mo is my number.", a).ok).toBe(true);
  });
});

describe("templates are always Validator-safe", () => {
  const actions: Action[] = [
    { type: "accept", amount: 22 },
    { type: "counter", amount: 18.5, isFinal: false },
    { type: "counter", amount: 9, isFinal: true },
    { type: "hold", amount: 30 },
    { type: "walk" },
  ];
  for (const a of actions) {
    it(`template for ${a.type}${"isFinal" in a && a.isFinal ? " (final)" : ""} passes validation`, () => {
      expect(validate(template(a, PERSONA), a).ok).toBe(true);
    });
  }
});
