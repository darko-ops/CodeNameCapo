import { describe, it, expect } from "vitest";
import { parseExtraction } from "./extractor.js";

describe("parseExtraction", () => {
  it("parses a clean JSON object", () => {
    const e = parseExtraction(
      '{"intent":"offer","offer_amount":12,"sentiment":"neutral","tactics":["lowball"],"justified":false}',
    );
    expect(e).toEqual({ intent: "offer", offer_amount: 12, sentiment: "neutral", tactics: ["lowball"], justified: false });
  });

  it("defaults justified to false when the model omits it", () => {
    const e = parseExtraction('{"intent":"offer","offer_amount":12,"sentiment":"neutral","tactics":[]}');
    expect(e.justified).toBe(false);
  });

  it("strips code fences", () => {
    const e = parseExtraction('```json\n{"intent":"accept","offer_amount":null,"sentiment":"positive","tactics":[]}\n```');
    expect(e.intent).toBe("accept");
    expect(e.offer_amount).toBeNull();
  });

  it("recovers a JSON object embedded in prose", () => {
    const e = parseExtraction('Here you go: {"intent":"stall","offer_amount":null,"sentiment":"neutral","tactics":[]} hope that helps');
    expect(e.intent).toBe("stall");
  });

  it("falls back to a no-number stall on garbage or invalid enums", () => {
    const fallback = { intent: "stall", offer_amount: null, sentiment: "neutral", tactics: [], justified: false };
    expect(parseExtraction("not json at all")).toEqual(fallback);
    expect(parseExtraction('{"intent":"banana","offer_amount":5}')).toEqual(fallback); // bad enum
    expect(parseExtraction("")).toEqual(fallback);
  });
});
