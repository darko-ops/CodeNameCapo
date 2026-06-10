/**
 * Server entry (Spec §9, Phase 1). Builds the service from the environment and
 * serves the Hono app on Node. Sandbox by default — runs with zero external
 * services so you can `npm run serve` and negotiate immediately.
 *
 *   npm run serve
 *   # live: set ANTHROPIC_API_KEY, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, BOUNCR_BASE_URL
 */
import { serve } from "@hono/node-server";
import { buildServiceFromEnv } from "./config.js";
import { buildApp } from "./app.js";

const built = buildServiceFromEnv();
const app = buildApp({ service: built.service, stripe: built.stripe, apiKey: built.apiKey });

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, (info) => {
  const mode = (s: boolean) => (s ? "sandbox" : "live");
  console.log(`🪩  Bouncr API on http://localhost:${info.port}`);
  console.log(
    `    store: ${built.store} · stripe: ${mode(built.sandbox.stripe)} · negotiator: ${mode(built.sandbox.negotiator)} · auth: ${
      built.apiKey ? "x-api-key required" : "open (dev)"
    }`,
  );
  console.log(`    demo plan: plan_demo (pro_monthly)`);
});
