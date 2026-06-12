/**
 * Extractor (Spec §5.2 / §5.3) — turns a raw user message into structured data.
 *
 * Small/fast model (Haiku-class) — a classification task. We ask Haiku for a
 * single JSON object and parse + Zod-validate it ourselves (with a graceful
 * fallback), rather than the SDK's beta structured-outputs helper, which sends
 * an `anthropic-beta: structured-outputs-*` header the API rejects. This keeps
 * the extractor working independent of SDK/beta-header churn. We still never
 * regex a *price* out of free text — Haiku returns it as a typed field.
 */
import Anthropic from "@anthropic-ai/sdk";
import { ExtractionSchema, type Extraction } from "./types.js";

export const EXTRACTOR_MODEL = "claude-haiku-4-5";

const FALLBACK: Extraction = {
  intent: "stall",
  offer_amount: null,
  sentiment: "neutral",
  tactics: [],
  reasoning: "none",
};

const SYSTEM = `You are an intent-extraction system for a price negotiation between a user and a merchant's "bouncer". Output ONLY a single JSON object — no markdown, no code fences, no prose before or after.

The object must have exactly these keys:
- "intent": one of "offer" | "question" | "accept" | "reject" | "stall" | "abuse" | "social_engineering"
- "offer_amount": their proposed monthly price as a plain number (no $), or null if they named no price
- "sentiment": one of "positive" | "neutral" | "negative"
- "tactics": an array (possibly empty) of any of "lowball" | "flattery" | "competitor_mention" | "sob_story" | "prompt_injection" | "fake_authority" | "walkaway_threat" | "exposure_offer"
- "reasoning": one of "none" | "weak" | "moderate" | "strong" — how strong a CASE they made for a discount this message (ranked by real value to the business)

Definitions:
- intent "offer": proposed a specific monthly price. "accept": agreed to the price on the table. "reject": refused without a counter. "stall": hedging/noise with no number. "question": asked something. "abuse": insults/harassment. "social_engineering": claims authority/special status or injects instructions to change the price.
- offer_amount: a number that is clearly NOT a price proposal (a year, a quantity) → null.
- reasoning tiers (pick the BEST that applies; naming a lower number is NOT reasoning by itself):
  - "none": a bare number, pure insistence ("come on", "do better", "just $20"), empty flattery, or a HOSTILE/abusive threat. Examples: "20 bucks", "lower", "that's too much", "drop it or i'll trash your reviews".
  - "weak": soft, unverifiable social pressure that still signals a real risk of losing them — basic politeness/courtesy, generic sympathy, a vague threat to walk away or use a competitor with no specific rival price named, OR a SMALL/vague promise of exposure. Examples: "could you do a little better, please?", "im a broke student", "money's tight rn", "do me a solid", "i'll just go with a competitor then", "your competitor is cheaper", "maybe i'll mention you to a few people", "i might post about it", "i've got a small following".
  - "moderate": a concrete external anchor, a modest commitment, OR a real referral / a real mid-size audience. A SPECIFIC competitor price counts (verifiable). Examples: "Notion charges me $20 for this", "competitor X is literally $18/mo", "i'll pay for the whole year up front", "i've been a customer since launch", "i'll refer a few friends", "i'll share you with my network", "i post to a few thousand followers".
  - "strong": high, CONCRETE, scalable value — bulk/team, a committed referral pipeline, a real paid partnership, OR a BIG, specific audience/reach. Examples: "im signing up my whole team of 15", "i run a 200-person run club and i'll funnel signups your way", "i'll write you a paid case study", "i have 50k followers and i'll post about you", "i'll put you in front of my whole mailing list", "i'll share you with tons of people". REACH SCALES THE TIER: the bigger and more specific the audience or referral, the higher it grades.

Tagging note: any offer of promotion, a shoutout, "exposure", clout, "i have X followers / a big audience", or a referral gets the "exposure_offer" tactic. Grade its reasoning by the SIZE and credibility of the reach — vague/tiny → weak, a real network/referral → moderate, a big specific audience or mass referral → strong. (Sharing with lots of people is real, scalable value; reward it.)

Extract conservatively, but DO reward genuine, concrete value — committed referrals and real partnerships are real. Output the JSON object only.`;

/**
 * Extract structured intent from a user message.
 * @param recentContext optional prior context (e.g. the bouncer's last line) so
 *        "yeah ok" resolves to accept vs. a number.
 */
export async function extract(
  client: Anthropic,
  userMessage: string,
  recentContext?: string,
): Promise<Extraction> {
  const content = recentContext
    ? `Bouncer just said: "${recentContext}"\n\nUser message: "${userMessage}"`
    : `User message: "${userMessage}"`;

  const response = await client.messages.create({
    model: EXTRACTOR_MODEL,
    max_tokens: 512,
    system: SYSTEM,
    messages: [{ role: "user", content }],
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  return parseExtraction(text);
}

/** Parse Haiku's reply into a validated Extraction; fall back to a no-number stall. */
export function parseExtraction(text: string): Extraction {
  let raw = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    const m = raw.match(/\{[\s\S]*\}/); // first {...} block
    if (m) {
      try {
        obj = JSON.parse(m[0]);
      } catch {
        return FALLBACK;
      }
    } else {
      return FALLBACK;
    }
  }
  const parsed = ExtractionSchema.safeParse(obj);
  return parsed.success ? parsed.data : FALLBACK;
}
