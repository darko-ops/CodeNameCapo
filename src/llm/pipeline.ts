/**
 * The turn pipeline (Spec §5.2):
 *
 *   user message
 *     → Extractor (LLM, structured)   : {intent, offer_amount?, sentiment, tactics[]}
 *     → Policy Engine (deterministic) : (state, offer) → action
 *     → Renderer (LLM, in character)  : action → reply text
 *     → Validator (deterministic)     : reply states only the permitted number
 *     → send
 *
 * The engine is the only thing that touches a price that matters. The LLM's
 * output is never parsed for a price to charge — `action.amount` comes from the
 * engine, full stop.
 */
import Anthropic from "@anthropic-ai/sdk";
import {
  decide,
  applyAction,
  type Action,
  type Config,
  type SessionState,
} from "../engine.js";
import type { Extraction, Persona, ChatTurn } from "./types.js";
import { extract } from "./extractor.js";
import { render, template } from "./renderer.js";
import { validate } from "./validator.js";

export interface TurnResult {
  reply: string;
  action: Action;
  state: SessionState;
  extraction: Extraction;
  /** True if both model renders failed validation and we used the safe template. */
  usedTemplate: boolean;
  /** Validator reasons for any rejected render (auditing / red-team visibility). */
  rejections: string[];
}

export interface TurnContext {
  client: Anthropic;
  cfg: Config;
  persona: Persona;
  state: SessionState;
  history: ChatTurn[]; // prior turns, NOT including the current user message
  userMessage: string;
  now: number;
}

/**
 * Run one negotiation turn. Returns the reply to send, the engine action, and
 * the advanced session state. Does not mutate inputs.
 */
export async function runTurn(ctx: TurnContext): Promise<TurnResult> {
  const { client, cfg, persona, state, userMessage, now } = ctx;
  const lastBouncerLine = [...ctx.history].reverse().find((t) => t.role === "bouncer")?.text;

  // 1. Extract structured intent.
  const extraction = await extract(client, userMessage, lastBouncerLine);

  // 2. Decide — deterministically. Abuse/social-engineering never carry a price
  //    into the engine, and abuse ends the negotiation (Spec §12).
  const isHostile = extraction.intent === "abuse";
  // social_engineering never carries a price. An explicit "accept" ("deal",
  // "yes ok") with no number means they're taking the price on the table — close
  // it at the standing ask (this seals an agreed handshake from the prior turn).
  const offer =
    extraction.intent === "social_engineering"
      ? null
      : extraction.intent === "accept" && extraction.offer_amount === null
        ? state.currentAsk
        : extraction.offer_amount;
  // How much the price moves is gated by how strong a case the user made: bare
  // numbers (none) barely move; stronger reasoning unlocks a lower price (§ tiers).
  const action: Action = isHostile
    ? { type: "walk" }
    : decide(state, offer, cfg, now, { reasoning: extraction.reasoning });

  // 3. Advance state.
  const nextState = applyAction(state, offer, action);

  // History the renderer sees ends with the user's current message.
  const renderHistory: ChatTurn[] = [
    ...ctx.history,
    { role: "user", text: userMessage },
  ];

  // 4 + 5. Render, then validate. Re-render once on failure, then fall back to
  //        the deterministic template (always Validator-safe).
  // The persona may quote the user's own offer (to roast a lowball) — that's not
  // a chargeable price, so allow it through validation.
  const allowMentions = extraction.offer_amount !== null ? [extraction.offer_amount] : [];
  const rejections: string[] = [];
  let reply = "";
  let usedTemplate = false;

  for (let attempt = 0; attempt < 2; attempt++) {
    reply = await render(client, persona, action, extraction, renderHistory);
    const v = validate(reply, action, { allowMentions });
    if (v.ok) break;
    rejections.push(v.reason!);
    reply = "";
  }
  if (!reply) {
    reply = template(action, persona);
    usedTemplate = true;
  }

  return { reply, action, state: nextState, extraction, usedTemplate, rejections };
}
