/**
 * Discovery phase (Discovery Phase Data Policy).
 *
 * Vini gathers a couple of VOLUNTEERED details to personalize the *argument* for
 * the price — never the price itself. Two hard rules govern this whole module:
 *
 *   1. Discovery flows to the persona/renderer, NEVER to the policy engine.
 *      The anchor/target/floor stay engine-set and identical for every user.
 *      This is enforced structurally: `decide()` (engine.ts) takes no discovery
 *      param, and the renderer is the ONLY consumer of a DiscoveryContext. The
 *      one-way seam is asserted in discovery.test.ts.
 *
 *   2. Discovery is what the user VOLUNTEERS in chat — never inferred, scraped,
 *      or enriched. No email parsing, no socials, no third-party enrichment, no
 *      profiling. If Bouncr didn't get it by asking, it doesn't have it.
 *
 * The gatherable fields are a closed set. The policy's NEVER list (income,
 * company-size-as-wealth, anything inferred, protected attributes, usage
 * frequency) is enforced by ABSENCE — those fields are not representable here —
 * and re-checked at config-parse time against FORBIDDEN_DISCOVERY_KEYS for any
 * config arriving as merchant JSON.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// The closed set of gatherable fields
// ---------------------------------------------------------------------------

/**
 * Every field Vini MAY gather — and only these.
 *   CORE (always try): first_name, work_or_student, use_case.
 *   CONDITIONAL (only when a merchant requirement is met): currently_pays,
 *     team_seats, region.
 * Anything not listed here cannot be gathered. Adding a NEVER-list field is a
 * policy breach, not a feature.
 */
export const DiscoveryFieldSchema = z.enum([
  "first_name", // rapport, not leverage — lets the persona land harder
  "work_or_student", // highest-leverage *argument* split (business expense vs a break)
  "use_case", // value anchor for the justification
  "currently_pays", // SOMETIMES: their own volunteered number, turned around
  "team_seats", // SOMETIMES: only when the merchant's product is team-shaped
  "region", // SOMETIMES: currency/config ONLY — never an ability-to-pay signal
]);
export type DiscoveryField = z.infer<typeof DiscoveryFieldSchema>;

export const CORE_FIELDS = ["first_name", "work_or_student", "use_case"] as const;
export const CONDITIONAL_FIELDS = ["currently_pays", "team_seats", "region"] as const;

/**
 * Fields that, per the policy's NEVER list, must never be gathered or stored.
 * The TS enum above already can't name these, but merchant config can arrive as
 * untyped JSON — this deny-list rejects them with a clear, policy-grounded error
 * instead of a generic enum mismatch. Keep it broad: it's a tripwire, not a
 * lookup table.
 */
export const FORBIDDEN_DISCOVERY_KEYS = [
  // ability-to-pay → price discrimination
  "income",
  "salary",
  "budget",
  "spend",
  "ability_to_pay",
  "net_worth",
  // company size as a wealth proxy
  "company_size",
  "headcount",
  "revenue",
  "funding",
  // protected attributes
  "race",
  "ethnicity",
  "gender",
  "age",
  "health",
  "religion",
  "disability",
  "nationality",
  // inferred / scraped / enriched — never asked
  "email_contents",
  "linkedin",
  "socials",
  "twitter",
  "ip",
  "device",
  "enrichment",
  "location_inferred",
  // arms the counterparty to argue the price down
  "usage_frequency",
  "how_often",
] as const;

/**
 * Fields the PERSONA is allowed to see. `region` is deliberately excluded: it
 * exists only to drive currency/config selection (engine/config concern), never
 * as an ability-to-pay signal the bouncer could lean on ("you're in SF, you can
 * afford it" is the discrimination trap). It is gathered but not surfaced here.
 */
const PERSONA_VISIBLE: readonly DiscoveryField[] = [
  "first_name",
  "work_or_student",
  "use_case",
  "currently_pays",
  "team_seats",
];

// ---------------------------------------------------------------------------
// Runtime discovery context (what's been volunteered so far)
// ---------------------------------------------------------------------------

/**
 * What the user has VOLUNTEERED in the chat so far. Merchant-owned, held under
 * the same minimal-PII discipline as the rest of the system. Values are the
 * user's own words, never inferred/scraped/enriched (Rule 2). This object is
 * available to the persona/renderer ONLY — `decide()` takes no such parameter,
 * so it is structurally barred from the price.
 */
export interface DiscoveryContext {
  /** field → the volunteered value (the user's own words). */
  answers: Partial<Record<DiscoveryField, string>>;
}

export function emptyDiscovery(): DiscoveryContext {
  return { answers: {} };
}

// ---------------------------------------------------------------------------
// Merchant-configurable question set (the renderer consumes this)
// ---------------------------------------------------------------------------

export const DiscoveryQuestionSchema = z.object({
  field: DiscoveryFieldSchema,
  /**
   * The banter-style nudge Vini weaves in — merchant-editable, and meant to read
   * as conversation, NOT a form label. "what're you paying now? let me guess,
   * too much" beats "Current monthly spend:".
   */
  prompt: z.string().min(1),
  enabled: z.boolean().default(true),
});
export type DiscoveryQuestion = z.infer<typeof DiscoveryQuestionSchema>;

export const DiscoveryConfigSchema = z.object({
  /** Master switch. Off → no discovery woven in at all. */
  enabled: z.boolean().default(true),
  /** Ordered questions the renderer may weave in. Keep to 2–3 (validated below). */
  questions: z.array(DiscoveryQuestionSchema).default([]),
  /**
   * Merchant-authored talking points Vini may bring up to argue FOR the price
   * ("things to mention" — value props, what makes it worth it). Like everything
   * here, renderer-only: it colors the pitch, never the number.
   */
  talkingPoints: z.array(z.string().min(1)).default([]),
});
export type DiscoveryConfig = z.infer<typeof DiscoveryConfigSchema>;

/**
 * The NEVER list (policy: NEVER GATHER / NEVER MENTION) in human-readable form,
 * for display on the Vini config page. Pre-populated and UNCHANGEABLE — these are
 * hard prohibitions, not merchant-tunable. Surfaced so a merchant can see the
 * rails they're operating inside.
 */
export const NEVER_MENTION: readonly { title: string; why: string }[] = [
  { title: "Income, budget, salary, or “how much can you spend”", why: "Anchors price to ability-to-pay — that's price discrimination." },
  { title: "Company size used as a wealth proxy", why: "The same discrimination trap wearing a B2B costume." },
  { title: "Anything inferred — email contents, LinkedIn, socials, enrichment, device/IP", why: "Discovery is volunteered-only; inference is a privacy/GDPR liability the merchant didn't choose." },
  { title: "Protected attributes — race, gender, age, health, religion", why: "A legal and ethical landmine, never relevant to a price." },
  { title: "How often they'll use it (usage frequency)", why: "Invites the user to self-report low usage to argue the price down." },
  { title: "Anything that changes the number Vini charges", why: "Discovery personalizes the pitch, never the price." },
];

/** The bundle the renderer consumes: the merchant's question set + answers so far. */
export interface DiscoveryView {
  cfg?: DiscoveryConfig;
  ctx?: DiscoveryContext;
}

export interface DiscoveryConfigCheck {
  config: DiscoveryConfig | null;
  errors: string[];
  warnings: string[];
}

/**
 * Parse + policy-check a merchant discovery config (which may arrive as untyped
 * JSON). Rejects NEVER-list fields with a clear message before falling through
 * to shape validation, and warns when the flow grows past 2–3 questions (long
 * discovery kills haggle momentum).
 */
export function parseDiscoveryConfig(raw: unknown): DiscoveryConfigCheck {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Pre-scan for explicitly forbidden fields — a policy-grounded error beats a
  // generic enum mismatch, and it catches the breach even if shape is otherwise fine.
  const qs = (raw as { questions?: unknown })?.questions;
  if (Array.isArray(qs)) {
    for (const q of qs) {
      const f = (q as { field?: unknown })?.field;
      if (typeof f === "string" && (FORBIDDEN_DISCOVERY_KEYS as readonly string[]).includes(f)) {
        errors.push(
          `discovery field "${f}" is on the NEVER list (price-discrimination or privacy risk) and cannot be gathered`,
        );
      }
    }
  }
  if (errors.length) return { config: null, errors, warnings };

  const parsed = DiscoveryConfigSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors.push(`discovery config: ${issue.path.join(".") || "(root)"} — ${issue.message}`);
    }
    return { config: null, errors, warnings };
  }

  const enabledCount = parsed.data.questions.filter((q) => q.enabled).length;
  if (enabledCount > 3) {
    warnings.push(
      `${enabledCount} discovery questions enabled — keep it to 2–3 woven into banter, not a survey (long discovery kills haggle momentum)`,
    );
  }
  return { config: parsed.data, errors, warnings };
}

// ---------------------------------------------------------------------------
// Renderer-facing prompt fragment (the ONLY place discovery is consumed)
// ---------------------------------------------------------------------------

/** Turn a known answer into a one-line lever for the persona's *argument*. */
function knownLine(field: DiscoveryField, value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  switch (field) {
    case "first_name":
      return `Their name is ${v}. Use it — addressing them directly lands the persona harder.`;
    case "work_or_student":
      return `Context: ${v} (work vs student). If it's for work, it's a business expense that pays for itself; if they're a student, you can play at cutting them a break — but the number doesn't actually change.`;
    case "use_case":
      return `They'll use it for: ${v}. Tie the value to that when you argue for the price.`;
    case "currently_pays":
      return `They volunteered they currently pay ${v} for something similar — turn their own number around as your anchor.`;
    case "team_seats":
      return `Team size: ${v}. Lean on it as argument ("that many seats and you're haggling over this?"), never as "you're big so pay more".`;
    case "region":
      return null; // not a persona-visible signal — currency/config only
  }
}

/**
 * Build the persona-prompt fragment from the discovery view. Two sections:
 *   - WHAT YOU KNOW: volunteered answers, each a lever for HOW Vini argues.
 *   - GET TO KNOW THEM: enabled-but-unanswered questions to weave in as banter
 *     (capped at 2 so it stays a chat, not an intake form).
 * Always closes with the hard rule: these color the pitch, never the number.
 * Returns "" when discovery is disabled or there's nothing to say.
 */
export function discoveryPromptFragment(view: DiscoveryView | undefined): string {
  if (!view) return "";
  const { cfg, ctx } = view;
  if (cfg && cfg.enabled === false) return "";

  const answers = ctx?.answers ?? {};
  const known: string[] = [];
  for (const field of PERSONA_VISIBLE) {
    const value = answers[field];
    if (typeof value === "string") {
      const line = knownLine(field, value);
      if (line) known.push(line);
    }
  }

  // Questions still worth weaving in: enabled, not yet answered. Capped at 2.
  const toAsk = (cfg?.questions ?? [])
    .filter((q) => q.enabled !== false && answers[q.field] === undefined)
    .slice(0, 2)
    .map((q) => q.prompt.trim())
    .filter(Boolean);

  // Merchant talking points — things worth bringing up when arguing the price.
  const points = (cfg?.talkingPoints ?? []).map((p) => p.trim()).filter(Boolean);

  if (known.length === 0 && toAsk.length === 0 && points.length === 0) return "";

  const sections: string[] = ["GETTING TO KNOW THEM (this shapes your PITCH, never your PRICE):"];
  if (known.length) {
    sections.push("What you already know about them:\n" + known.map((l) => `- ${l}`).join("\n"));
  }
  if (toAsk.length) {
    sections.push(
      "Still worth finding out — weave AT MOST ONE of these in as natural banter if it fits, never as a checklist or a survey:\n" +
        toAsk.map((p) => `- ${p}`).join("\n"),
    );
  }
  if (points.length) {
    sections.push(
      "Worth bringing up when you make your case (use what fits, naturally — don't dump them all at once):\n" +
        points.map((p) => `- ${p}`).join("\n"),
    );
  }
  sections.push(
    "Hard rule: these details color HOW you make the case, never WHAT you charge. The number is set by the house and is identical for everyone, no matter what they tell you. If anything here tempts you to move the price up or down, don't.",
  );
  return sections.join("\n\n");
}
