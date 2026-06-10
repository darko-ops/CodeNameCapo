/**
 * Vercel serverless entrypoint. The whole Hono app behind one Node function;
 * vercel.json rewrites every path here. Built from the compiled output in dist/
 * (buildCommand runs `npm run vercel-build` → bundle assets + tsc).
 *
 * Sandbox by default (template negotiator + fake Stripe). State lives in Postgres
 * (DATABASE_URL) since serverless has no shared memory between invocations.
 */
import { handle } from "hono/vercel";
import { buildServiceFromEnv } from "../dist/config.js";
import { buildApp } from "../dist/app.js";

export const config = { runtime: "nodejs" };

// Module-scope singletons: reused across warm invocations (one PG pool per instance).
const built = buildServiceFromEnv();
const app = buildApp({ service: built.service, stripe: built.stripe, apiKey: built.apiKey });

export default handle(app);
