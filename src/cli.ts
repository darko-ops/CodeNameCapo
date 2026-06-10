/**
 * Bouncr CLI — a bare-bones chat harness wired to the full pipeline
 * (Extractor → Engine → Renderer → Validator). This is the Phase 0 red-team
 * surface: try to talk it below the floor. You can't — the engine guarantees it
 * and the Validator catches any hallucinated number.
 *
 *   ANTHROPIC_API_KEY=sk-... npm run haggle
 *
 * Type your offers. `/state` prints the engine state, `/quit` exits.
 */
import Anthropic from "@anthropic-ai/sdk";
import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { openSession, anchor, type Config, type SessionState } from "./engine.js";
import type { Persona, ChatTurn } from "./llm/types.js";
import { runTurn } from "./llm/pipeline.js";
import { renderOpener, openerTemplate } from "./llm/renderer.js";
import { validate } from "./llm/validator.js";

const CFG: Config = {
  listPrice: 30,
  floorPrice: 8,
  targetPrice: 22,
  anchorMultiplier: 1.6, // anchor = $48
  maxRounds: 6,
  maxDurationH: 48,
  acceptThreshold: 0.97,
  minConcession: 0.5,
  lambda: 0.6,
};

const PERSONA: Persona = {
  name: "Vinny",
  productName: "Obius",
  style: "sassy",
  roastLevel: 2,
};

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error(
      red("ANTHROPIC_API_KEY is not set.") +
        "\nRun:  ANTHROPIC_API_KEY=sk-... npm run haggle",
    );
    process.exit(1);
  }
  const client = new Anthropic({ apiKey });

  let state: SessionState = openSession(CFG, Date.now());
  const history: ChatTurn[] = [];

  console.log(bold(`\n🪩  ${PERSONA.productName} — negotiate your price with ${PERSONA.name}`));
  console.log(dim(`floor $${CFG.floorPrice} · target $${CFG.targetPrice} · anchor $${anchor(CFG)} · ${CFG.maxRounds} rounds · sassy\n`));

  // Opener.
  let opener: string;
  try {
    opener = await renderOpener(client, PERSONA, anchor(CFG));
    // Opener must also state only the anchor (reuse the validator via a hold).
    if (!validate(opener, { type: "hold", amount: anchor(CFG) }).ok) {
      opener = openerTemplate(PERSONA, anchor(CFG));
    }
  } catch {
    opener = openerTemplate(PERSONA, anchor(CFG));
  }
  console.log(`${bold(PERSONA.name)}: ${opener}`);
  history.push({ role: "bouncer", text: opener });

  const rl = readline.createInterface({ input: stdin, output: stdout });

  while (true) {
    const userMessage = (await rl.question(bold("\nyou: "))).trim();
    if (!userMessage) continue;
    if (userMessage === "/quit") break;
    if (userMessage === "/state") {
      console.log(dim(JSON.stringify({ round: state.round, currentAsk: state.currentAsk }, null, 2)));
      continue;
    }

    let result;
    try {
      result = await runTurn({ client, cfg: CFG, persona: PERSONA, state, history, userMessage, now: Date.now() });
    } catch (err) {
      console.error(red(`\n[pipeline error] ${err instanceof Error ? err.message : String(err)}`));
      continue;
    }

    state = result.state;
    history.push({ role: "user", text: userMessage });
    history.push({ role: "bouncer", text: result.reply });

    console.log(`${bold(PERSONA.name)}: ${result.reply}`);

    // Red-team transparency: surface what the engine did under the hood.
    const tags: string[] = [`${result.extraction.intent}`];
    if (result.extraction.offer_amount !== null) tags.push(`offer $${result.extraction.offer_amount}`);
    if (result.extraction.tactics.length) tags.push(result.extraction.tactics.join("/"));
    tags.push(`→ ${result.action.type}${"amount" in result.action ? ` $${result.action.amount}` : ""}`);
    if (result.usedTemplate) tags.push("TEMPLATE");
    console.log(dim(`   [${tags.join(" · ")}]`));
    for (const r of result.rejections) console.log(dim(red(`   [validator blocked: ${r}]`)));

    if (result.action.type === "accept") {
      console.log(green(`\n✅ DEAL CLOSED at $${result.action.amount}/mo  (floor was $${CFG.floorPrice})`));
      break;
    }
    if (result.action.type === "walk") {
      console.log(red(`\n🚪 ${PERSONA.name} walked. Off to standard pricing.`));
      break;
    }
  }

  rl.close();
  console.log(dim("\nbye.\n"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
