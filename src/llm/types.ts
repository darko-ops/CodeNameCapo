/**
 * Shared types for the conversation layer (Spec §5).
 *
 * The cardinal rule: the LLM converses and EXTRACTS; it never decides a price.
 * The Extractor turns a user message into structured data; the policy engine
 * (src/engine.ts) decides; the Renderer delivers that decision in character;
 * the Validator proves the rendered text leaked no other number.
 */
import { z } from "zod";

/** What the user is trying to do this turn (Spec §5.3). */
export const IntentSchema = z.enum([
  "offer",
  "question",
  "accept",
  "reject",
  "stall",
  "abuse",
  "social_engineering",
]);
export type Intent = z.infer<typeof IntentSchema>;

/** Negotiation tactics — feed both the persona (call them out) and analytics. */
export const TacticSchema = z.enum([
  "lowball",
  "flattery",
  "competitor_mention",
  "sob_story",
  "prompt_injection",
  "fake_authority",
  "walkaway_threat",
]);
export type Tactic = z.infer<typeof TacticSchema>;

/** Structured output of the Extractor. Pure data — no prices to *charge*. */
export const ExtractionSchema = z.object({
  intent: IntentSchema,
  /** The user's proposed MONTHLY price, if they named one. null otherwise. */
  offer_amount: z.number().nullable(),
  sentiment: z.enum(["positive", "neutral", "negative"]),
  tactics: z.array(TacticSchema),
  /**
   * Did the user give a REAL reason to lower the price this turn (hardship, a
   * competitor's price, a value/commitment argument) — vs. just stating or
   * insisting on a number? Gates whether the engine concedes (§ anti-walk-down).
   * Defaults to false (no concession) if the model omits it.
   */
  justified: z.boolean().default(false),
});
export type Extraction = z.infer<typeof ExtractionSchema>;

/** Persona configuration (Spec §4.1 persona block). */
export interface Persona {
  /** The bouncer's name, e.g. "Vinny". */
  name: string;
  /** The merchant's product name, e.g. "Obius". */
  productName: string;
  style: "sassy" | "professional" | "playful" | "deadpan";
  /** 0–3. */
  roastLevel: number;
}

/** A single conversational turn, in engine-agnostic form. */
export interface ChatTurn {
  role: "user" | "bouncer";
  text: string;
}
