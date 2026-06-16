/**
 * Phase 1 wiring: a seed plan + dependency selection from the environment.
 *
 * Sandbox vs live is decided by which secrets are present (Spec §9: sandbox from
 * day one). No keys → fake Stripe + template negotiator + in-memory store, so the
 * whole API runs offline. The Postgres store is selected by DATABASE_URL.
 */
import { randomBytes } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { generateMerchantKey, hashKey, hashPassword } from "./auth.js";
import type { Plan, Merchant, Store } from "./store/types.js";
import { MemoryStore } from "./store/memory.js";
import { PostgresStore } from "./store/postgres.js";
import { lintConfig } from "./lint.js";
import type { StripeGateway } from "./stripe/gateway.js";
import { FakeStripeGateway } from "./stripe/fake.js";
import { LiveStripeGateway } from "./stripe/live.js";
import type { Negotiator } from "./llm/negotiator.js";
import { makeAnthropicNegotiator, makeTemplateNegotiator } from "./llm/negotiator.js";
import type { Mailer } from "./mailer.js";
import { ConsoleMailer, ResendMailer } from "./mailer.js";
import { ProofSigner } from "./proof.js";
import { FetchNotifier } from "./notify.js";
import { BouncrService } from "./service.js";

/** The demo merchant Bouncr ships with (Connect not yet onboarded). */
export function demoMerchant(): Merchant {
  return {
    id: "merchant_demo",
    name: "Obius",
    email: "demo@thebouncr.com",
    passwordHash: null,
    stripeConnectId: null,
    apiKeyHash: null,
    createdAt: 0,
  };
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
      // Tuned for a fun, hagglable demo. The price ladder is list > target > floor
      // (an enforced invariant — see lintConfig): sticker $30, Vini aims to land
      // around the $24 target, and won't be talked below the $22 floor. Opens high
      // at the anchor ($48) and concedes gently down to target, then grinds.
      listPrice: 30,
      floorPrice: 22,
      targetPrice: 24,
      anchorMultiplier: 1.6, // anchor = $48
      maxRounds: 6,
      maxDurationH: 48,
      acceptThreshold: 0.92,
      minConcession: 1.0,
      lambda: 0.55,
    },
    persona: { name: "Vini", productName: "Obius", style: "sassy", roastLevel: 2 },
    // Discovery (renderer-only): the three CORE questions, woven in as banter to
    // personalize the pitch — never the price. Merchant-editable; see discovery.ts.
    discovery: {
      enabled: true,
      questions: [
        { field: "first_name", prompt: "clock who's at the door, get their first name, casual", enabled: true },
        { field: "work_or_student", prompt: "feel out if this is for work or theyre a student, no pressure either way", enabled: true },
        { field: "use_case", prompt: "find out what theyre actually gonna use it for", enabled: true },
      ],
      talkingPoints: [],
    },
    policy: { cooldownHours: 72, maxMessages: 2000, rateLimitPerMin: 12 },
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
  /** Outbound email (Resend live, console in sandbox). */
  mailer: Mailer;
  sandbox: { stripe: boolean; negotiator: boolean; email: boolean };
  store: "postgres" | "memory";
  apiKey: string | null;
  /** HMAC secret for signing dashboard session tokens. */
  authSecret: string;
}

/**
 * LIVE-mode boot guard. When real Stripe is configured (STRIPE_SECRET_KEY +
 * STRIPE_WEBHOOK_SECRET — the same signal that selects the live gateway), every
 * security-critical secret MUST be present and not a default/placeholder, or we
 * refuse to boot with a clear list of what's wrong. In SANDBOX (no Stripe keys)
 * the defaults are fine, so local dev and the fake-gateway demo need zero setup.
 *
 * Throws a single Error naming exactly which vars are missing/defaulted — never a
 * silent live-mode fallback to "bouncrdemo" / an ephemeral signing key.
 */
const PLACEHOLDER_RE = /replace|changeme|your[-_]|placeholder|example|x{4,}/i;
export function assertLiveBootSecrets(env: NodeJS.ProcessEnv = process.env): void {
  const liveMode = Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET);
  if (!liveMode) return; // sandbox / tests — defaults allowed

  const flag = (name: string, val: string | undefined, def?: string): string | null => {
    if (!val) return `${name} is unset`;
    if (def && val === def) return `${name} is still the default ("${def}")`;
    if (PLACEHOLDER_RE.test(val)) return `${name} looks like an unreplaced placeholder`;
    return null;
  };

  const problems = [
    // The demo-merchant password only matters when the in-memory demo merchant is
    // seeded from env (no DATABASE_URL). With Postgres the demo merchant is seeded
    // via SQL (db/seed.sql) and this var is unused — so don't force it in real,
    // DB-backed production; real merchants set their own passwords at signup.
    ...(env.DATABASE_URL ? [] : [flag("BOUNCR_DEMO_MERCHANT_PASSWORD", env.BOUNCR_DEMO_MERCHANT_PASSWORD, "bouncrdemo")]),
    flag("BOUNCR_AUTH_SECRET", env.BOUNCR_AUTH_SECRET), // unset ⇒ ephemeral; sessions die + insecure
    flag("BOUNCR_PROOF_PRIVATE_KEY", env.BOUNCR_PROOF_PRIVATE_KEY), // unset ⇒ ephemeral signing key
    flag("STRIPE_SECRET_KEY", env.STRIPE_SECRET_KEY),
    flag("STRIPE_WEBHOOK_SECRET", env.STRIPE_WEBHOOK_SECRET),
  ].filter((p): p is string => p !== null);

  if (problems.length) {
    throw new Error(
      "Refusing to boot in LIVE mode (real Stripe is configured) with insecure or missing secrets:\n" +
        problems.map((p) => `  - ${p}`).join("\n") +
        "\nSet these (see .env.example), or run in sandbox by omitting STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET.",
    );
  }
}

/** Build the service from environment variables, falling back to sandbox parts. */
export function buildServiceFromEnv(env: NodeJS.ProcessEnv = process.env): BuiltService {
  assertLiveBootSecrets(env); // fail fast in live mode before constructing anything
  const plan = demoPlan();

  // Dashboard-token signing secret. A stable env value keeps sessions valid
  // across restarts/instances; without it, tokens die on redeploy (dev only).
  const authSecret = env.BOUNCR_AUTH_SECRET ?? randomBytes(32).toString("hex");
  if (!env.BOUNCR_AUTH_SECRET) {
    console.warn("[auth] BOUNCR_AUTH_SECRET unset — dashboard sessions won't survive a restart");
  }

  // Seed the in-memory demo merchant so the demo dashboard is loginable:
  //  - email + password (BOUNCR_DEMO_MERCHANT_PASSWORD, default "bouncrdemo") for
  //    the dashboard login,
  //  - an API key (BOUNCR_DEMO_MERCHANT_KEY) for programmatic / MCP access.
  // Postgres deployments seed these via SQL.
  const demoM = demoMerchant();
  const demoKey = env.BOUNCR_DEMO_MERCHANT_KEY ?? generateMerchantKey(demoM.id);
  demoM.apiKeyHash = hashKey(demoKey);
  const demoPassword = env.BOUNCR_DEMO_MERCHANT_PASSWORD ?? "bouncrdemo";
  demoM.passwordHash = hashPassword(demoPassword);
  if (!env.BOUNCR_DEMO_MERCHANT_KEY) console.log(`[auth] demo merchant api key: ${demoKey}`);
  if (!env.BOUNCR_DEMO_MERCHANT_PASSWORD)
    console.log(`[auth] demo login: ${demoM.email} / ${demoPassword}`);

  // Postgres when DATABASE_URL is set (apply db/schema.sql + db/seed.sql first),
  // else the in-memory store seeded with the demo merchant/plan.
  const usePostgres = Boolean(env.DATABASE_URL);
  const store: Store = usePostgres
    ? new PostgresStore(env.DATABASE_URL!)
    : new MemoryStore([plan], [demoM]);

  // Note: with Postgres, the demo merchant's dashboard key hash is set once in
  // the DB (the seed has none); production merchants get theirs at signup.

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

  // Email: Resend when RESEND_API_KEY is set, else a console logger (sandbox).
  let mailer: Mailer;
  let emailSandbox = true;
  if (env.RESEND_API_KEY) {
    mailer = new ResendMailer(env.RESEND_API_KEY, env.BOUNCR_EMAIL_FROM ?? "Bouncr <noreply@thebouncr.com>");
    emailSandbox = false;
  } else {
    mailer = new ConsoleMailer();
  }

  // Platform take-rate (Connect application fee), e.g. BOUNCR_APPLICATION_FEE_PERCENT=20.
  const applicationFeePercent = Number(env.BOUNCR_APPLICATION_FEE_PERCENT ?? "") || 0;

  // Settlement-proof signing key (Ed25519). A stable PKCS8 PEM from env keeps
  // proofs verifiable across restarts/instances and publishes a stable JWKS;
  // without it we mint an ephemeral keypair (dev only — proofs die on redeploy).
  const proofKid = env.BOUNCR_PROOF_KID ?? "bouncr-1";
  let proofSigner: ProofSigner;
  if (env.BOUNCR_PROOF_PRIVATE_KEY) {
    proofSigner = ProofSigner.fromPem(env.BOUNCR_PROOF_PRIVATE_KEY, proofKid);
  } else {
    proofSigner = ProofSigner.ephemeral("bouncr-dev");
    console.warn("[proof] BOUNCR_PROOF_PRIVATE_KEY unset — using an ephemeral key (proofs won't survive a restart)");
  }

  const service = new BouncrService({
    store,
    stripe,
    negotiator,
    baseUrl: env.BOUNCR_BASE_URL ?? "http://localhost:8787",
    applicationFeePercent,
    proofSigner,
    notifier: new FetchNotifier(), // real signed POST to merchants' webhook URLs
  });

  return {
    service,
    stripe,
    mailer,
    sandbox: { stripe: stripeSandbox, negotiator: negotiatorSandbox, email: emailSandbox },
    store: usePostgres ? "postgres" : "memory",
    apiKey: env.BOUNCR_API_KEY ?? null,
    authSecret,
  };
}
