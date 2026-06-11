/**
 * Negotiator — the seam between the service and the conversation layer.
 *
 * Two implementations:
 *   - makeAnthropicNegotiator(client): the real Extractor→Engine→Renderer→Validator
 *     pipeline (runTurn).
 *   - makeTemplateNegotiator(): deterministic, no API key. Runs the REAL engine
 *     but skips the LLM — crude regex intent + safe templates. Doubles as sandbox
 *     mode (no LLM cost) and as the test double for the settlement flow.
 *
 * Injecting this keeps the service's persistence + Stripe paths testable offline.
 */
import Anthropic from "@anthropic-ai/sdk";
import {
  decide,
  applyAction,
  anchor,
  type Config,
  type SessionState,
} from "../engine.js";
import type { Persona, ChatTurn, Extraction } from "./types.js";
import { runTurn, type TurnResult } from "./pipeline.js";
import { renderOpener, openerTemplate, template } from "./renderer.js";
import { validate, permittedAmount } from "./validator.js";

export interface NegotiateArgs {
  cfg: Config;
  persona: Persona;
  state: SessionState;
  history: ChatTurn[];
  userMessage: string;
  now: number;
}

export interface Negotiator {
  opener(args: { cfg: Config; persona: Persona }): Promise<string>;
  turn(args: NegotiateArgs): Promise<TurnResult>;
}

// --- Real pipeline (Anthropic) ---------------------------------------------

export function makeAnthropicNegotiator(client: Anthropic): Negotiator {
  return {
    async opener({ cfg, persona }) {
      const a = anchor(cfg);
      try {
        const text = await renderOpener(client, persona, a);
        // The opener must also state only the anchor — reuse the validator (hold).
        return validate(text, { type: "hold", amount: a }).ok ? text : openerTemplate(persona, a);
      } catch {
        return openerTemplate(persona, a);
      }
    },
    turn(args) {
      return runTurn({
        client,
        cfg: args.cfg,
        persona: args.persona,
        state: args.state,
        history: args.history,
        userMessage: args.userMessage,
        now: args.now,
      });
    },
  };
}

// --- Deterministic (sandbox / tests) ---------------------------------------

const ACCEPT_WORDS = /\b(deal|ok|okay|yes|yeah|sure|fine|sold|agreed|i'?ll take it|let'?s do it)\b/i;
const NUMBER_RE = /\$?\s*(\d+(?:\.\d{1,2})?)/;

export function makeTemplateNegotiator(): Negotiator {
  return {
    async opener({ cfg, persona }) {
      return openerTemplate(persona, anchor(cfg));
    },
    async turn(args): Promise<TurnResult> {
      const { cfg, persona, state, userMessage, now } = args;
      const numMatch = userMessage.match(NUMBER_RE);
      const named = numMatch ? Number(numMatch[1]) : null;

      let intent: Extraction["intent"];
      let offer: number | null;
      if (named !== null) {
        intent = "offer";
        offer = named;
      } else if (ACCEPT_WORDS.test(userMessage)) {
        intent = "accept";
        offer = state.currentAsk; // accepting the standing ask
      } else {
        intent = "stall";
        offer = null;
      }

      const action = decide(state, offer, cfg, now);
      const reply = template(action, persona);
      // template() is Validator-safe by construction (proven in validator.test.ts),
      // but assert in dev to catch any regression.
      const v = validate(reply, action);
      const extraction: Extraction = {
        intent,
        offer_amount: named,
        sentiment: "neutral",
        tactics: [],
        // Sandbox negotiator can't assess reasoning; it concedes via the engine
        // default (decide() with no opts → "strong"), so record "strong" to match.
        reasoning: "strong",
      };
      return {
        reply,
        action,
        state: applyAction(state, offer, action),
        extraction,
        usedTemplate: true,
        rejections: v.ok ? [] : [v.reason!],
      };
    },
  };
}

// re-export for convenience
export { permittedAmount };
