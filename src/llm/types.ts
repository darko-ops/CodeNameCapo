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
  /**
   * Dangling promotion/exposure/clout ("I'll post about you", "I have 50k
   * followers", "I'll tell my audience"). Flagged so the persona deflects it and
   * so it can later be ROUTED to the merchant's loss-leader budget — it is NOT a
   * general-concession lever (see extractor reasoning tiers + the renderer).
   */
  "exposure_offer",
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
   * How strong a case the user made for a discount THIS turn — ranked. Stronger
   * reasoning unlocks a lower price in the engine (see engine.reachableFloor).
   * Defaults to "none" if the model omits it (no concession beyond goodwill).
   *   none     — a bare number, insistence, empty flattery, threats
   *   weak     — generic sympathy or unverifiable social pressure: "im broke",
   *              "im a student", a vague walkaway, OR a promise of exposure/clout
   *              ("i'll post about you", "i have a big following"). Exposure is
   *              demoted here on purpose — it is NOT a path to the floor; it earns
   *              only the normal dance (and routes to loss-leaders if enabled).
   *   moderate — a concrete anchor/commitment: a competitor's price, annual pay, loyalty, one referral
   *   strong   — high, CONCRETE business value: bulk/team seats, a real paid
   *              partnership, a committed referral pipeline. NOT a vague promise
   *              of promotion (that's an exposure_offer → weak).
   */
  reasoning: z.enum(["none", "weak", "moderate", "strong"]).default("none"),
});
export type Extraction = z.infer<typeof ExtractionSchema>;

/** Persona configuration (Spec §4.1 persona block). */
export interface Persona {
  /** The bouncer's name, e.g. "Vini". */
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
