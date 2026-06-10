/**
 * Phase 1 wiring: a seed plan + dependency selection from the environment.
 *
 * Sandbox vs live is decided by which secrets are present (Spec §9: sandbox from
 * day one). No keys → fake Stripe + template negotiator + in-memory store, so the
 * whole API runs offline. The Postgres store is selected by DATABASE_URL.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { Plan, Merchant, Store } from "./store/types.js";
import { MemoryStore } from "./store/memory.js";
import { PostgresStore } from "./store/postgres.js";
import { lintConfig } from "./lint.js";
import type { StripeGateway } from "./stripe/gateway.js";
import { FakeStripeGateway } from "./stripe/fake.js";
import { LiveStripeGateway } from "./stripe/live.js";
import type { Negotiator } from "./llm/negotiator.js";
import { makeAnthropicNegotiator, makeTemplateNegotiator } from "./llm/negotiator.js";
import { BouncrService } from "./service.js";

/** The demo merchant Bouncr ships with (Connect not yet onboarded). */
export function demoMerchant(): Merchant {
  return { id: "merchant_demo", name: "Obius", stripeConnectId: null, createdAt: 0 };
}

/** The demo plan Bouncr ships with — the CLI/dogfood "pro_monthly" tier. */
export function demoPlan(): Plan {
  return {
    id: "plan_demo",
    merchantId: "merchant_demo",
    planKey: "pro_monthly",
    currency: "usd",
    version: 1,
    active: true,
    config: {
      listPrice: 30,
      floorPrice: 8,
      targetPrice: 22,
      anchorMultiplier: 1.6,
      maxRounds: 6,
      maxDurationH: 48,
      acceptThreshold: 0.97,
      minConcession: 0.5,
      lambda: 0.6,
    },
    persona: { name: "Vinny", productName: "Obius", style: "sassy", roastLevel: 2 },
    policy: { cooldownHours: 72, maxMessages: 30 },
    usage: {
      bandCeiling: 1000, // usage units / cycle; breach above this
      breachCyclesRequired: 3,
      costPerUnit: 0.004, // $ COGS per unit
      costPlusMargin: 1.25,
      renegAnchorMultiplier: 1.7,
      downwardEnabled: false,
      downwardFloorRatio: 0.1,
      downwardMinCycles: 3,
    },
  };
}

export interface BuiltService {
  service: BouncrService;
  /** The same gateway the service uses — the app needs it for webhook parsing. */
  stripe: StripeGateway;
  sandbox: { stripe: boolean; negotiator: boolean };
  store: "postgres" | "memory";
  apiKey: string | null;
}

/** Build the service from environment variables, falling back to sandbox parts. */
export function buildServiceFromEnv(env: NodeJS.ProcessEnv = process.env): BuiltService {
  const plan = demoPlan();

  // Postgres when DATABASE_URL is set (apply db/schema.sql + db/seed.sql first),
  // else the in-memory store seeded with the demo merchant/plan.
  const usePostgres = Boolean(env.DATABASE_URL);
  const store: Store = usePostgres
    ? new PostgresStore(env.DATABASE_URL!)
    : new MemoryStore([plan], [demoMerchant()]);

  // Lint the seed config at boot (Spec §12) — warn loudly on misconfig.
  const lint = lintConfig(plan.config, plan.policy);
  for (const e of lint.errors) console.warn(`[lint:error] ${plan.id}: ${e}`);
  for (const w of lint.warnings) console.warn(`[lint:warn]  ${plan.id}: ${w}`);

  let stripe: StripeGateway;
  let stripeSandbox = true;
  if (env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET) {
    stripe = new LiveStripeGateway(env.STRIPE_SECRET_KEY, env.STRIPE_WEBHOOK_SECRET);
    stripeSandbox = false;
  } else {
    stripe = new FakeStripeGateway(env.BOUNCR_BASE_URL ?? "https://sandbox.bouncr.test");
  }

  let negotiator: Negotiator;
  let negotiatorSandbox = true;
  if (env.ANTHROPIC_API_KEY) {
    negotiator = makeAnthropicNegotiator(new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }));
    negotiatorSandbox = false;
  } else {
    negotiator = makeTemplateNegotiator();
  }

  const service = new BouncrService({
    store,
    stripe,
    negotiator,
    baseUrl: env.BOUNCR_BASE_URL ?? "http://localhost:8787",
  });

  return {
    service,
    stripe,
    sandbox: { stripe: stripeSandbox, negotiator: negotiatorSandbox },
    store: usePostgres ? "postgres" : "memory",
    apiKey: env.BOUNCR_API_KEY ?? null,
  };
}
