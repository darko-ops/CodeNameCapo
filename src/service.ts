/**
 * BouncrService — the application core for Phase 1 (Spec §7, §8, §9).
 *
 * Wires the conversation layer, the policy engine, persistence, and Stripe into
 * the operations the HTTP API exposes: start a negotiation, take a turn, accept,
 * and settle via webhook. Server-authoritative throughout — rounds, the timer,
 * and (critically) the price all come from the engine, never the client.
 *
 * Dependencies are injected (Store, StripeGateway, Negotiator) so the whole flow
 * runs offline in tests with the in-memory store + fake Stripe + template negotiator.
 */
import { randomUUID, randomBytes } from "node:crypto";
import { openSession, round2, type Action, type Config, type SessionState } from "./engine.js";
import type { Store, Plan, Merchant, SessionRecord, TurnRecord, DealRecord } from "./store/types.js";
import type { Persona } from "./llm/types.js";
import { parseDiscoveryConfig, type DiscoveryConfig } from "./llm/discovery.js";
import {
  parseMerchantKey,
  hashKey,
  safeEqualHex,
  generateMerchantKey,
  hashPassword,
  verifyPassword,
  pwFingerprint,
} from "./auth.js";

/** Coerce to a finite number, or null. */
const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);
import type { StripeGateway } from "./stripe/gateway.js";
import type { WebhookEvent } from "./stripe/gateway.js";
import type { Negotiator } from "./llm/negotiator.js";
import type { ChatTurn } from "./llm/types.js";
import { computeAnalytics } from "./analytics.js";
import { ProofSigner, mintProof, type ProofVerifier, type ProofClaims, type ProofError, type ProofInterval } from "./proof.js";
import { NoopNotifier, type EntitlementNotifier, type EntitlementPayload } from "./notify.js";
import { lintConfig, type LintResult } from "./lint.js";
import { buildRenegConfig, type RenegDirection, type RenegPlan } from "./reneg.js";
import { messageRateExceeded } from "./ratelimit.js";

/** Default wallet-guard rate when a plan's policy omits rateLimitPerMin. */
const DEFAULT_RATE_LIMIT_PER_MIN = 12;

export class ServiceError extends Error {
  constructor(
    public readonly code: "not_found" | "conflict" | "bad_request" | "unauthorized",
    message: string,
    /** Extra structured fields surfaced to the client (e.g. cooldown retry_at). */
    public readonly meta?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

export interface ServiceDeps {
  store: Store;
  stripe: StripeGateway;
  negotiator: Negotiator;
  /** Public base URL for Stripe success/cancel redirects. */
  baseUrl: string;
  /** Injectable clock (defaults to Date.now). */
  now?: () => number;
  /**
   * Bouncr's platform take-rate, as a % of each settled invoice (0–100). Applied
   * as a Stripe Connect application fee on deals that settle into a merchant's
   * connected account. Defaults to 0 (merchant keeps 100%).
   */
  applicationFeePercent?: number;
  /** Signs/serves settlement proofs (hosted-checkout path). Defaults to an
   *  ephemeral key when omitted (tests/dev); production injects a stable key. */
  proofSigner?: ProofSigner;
  /** Delivers entitlement webhooks to merchants on settle. Defaults to no-op. */
  notifier?: EntitlementNotifier;
}

export interface CreateSessionInput {
  planId: string;
  endUserRef: string;
  channel?: string;
  context?: Record<string, unknown>;
}

/** The handful of essentials a merchant supplies to create a plan. */
export interface PlanInput {
  productName: string;
  listPrice: number;
  floorPrice: number;
  targetPrice?: number;
  currency?: string;
  personaStyle?: Persona["style"];
}

export interface TurnResponse {
  reply: string;
  action: Action;
  round: number;
  currentAsk: number;
  status: SessionRecord["status"];
  expiresAt: number;
  /** True on a final-round counter — drives the widget's "last call" urgency. */
  isFinal: boolean;
  /** Present when the turn closed a deal — the URL to send the user to. */
  checkoutUrl?: string;
  dealId?: string;
}

/** What the hosted checkout page should render/do for a deal (see getCheckoutView). */
export type CheckoutView =
  | { state: "pay"; dealId: string; productName: string; amountCents: number; currency: string; interval: ProofInterval; proof: string }
  | { state: "resume"; url: string }
  | { state: "remint"; url: string }
  | { state: "settled" }
  | { state: "expired" };

/** Public, token-gated session view for the widget (countdown, reconnect). */
export interface SessionView {
  status: SessionRecord["status"];
  round: number;
  currentAsk: number;
  expiresAt: number;
}

export class BouncrService {
  private readonly store: Store;
  private readonly stripe: StripeGateway;
  private readonly negotiator: Negotiator;
  private readonly baseUrl: string;
  private readonly now: () => number;
  /** Platform take-rate (% of each settled invoice), clamped to [0, 100]. */
  private readonly applicationFeePercent: number;
  private readonly proofSigner: ProofSigner;
  private readonly proofVerifier: ProofVerifier;
  private readonly notifier: EntitlementNotifier;

  constructor(deps: ServiceDeps) {
    this.store = deps.store;
    this.stripe = deps.stripe;
    this.negotiator = deps.negotiator;
    this.baseUrl = deps.baseUrl.replace(/\/$/, "");
    this.now = deps.now ?? Date.now;
    const fee = deps.applicationFeePercent ?? 0;
    this.applicationFeePercent = Number.isFinite(fee) ? Math.max(0, Math.min(100, fee)) : 0;
    this.proofSigner = deps.proofSigner ?? ProofSigner.ephemeral();
    this.proofVerifier = this.proofSigner.verifier();
    this.notifier = deps.notifier ?? new NoopNotifier();
  }

  // --- Settlement proofs (hosted-checkout path) ----------------------------

  /** The public JWKS so merchants can verify Bouncr-issued proofs independently. */
  publicJwks(): { keys: Record<string, unknown>[] } {
    return { keys: [this.proofSigner.publicJwk()] };
  }

  /**
   * Verify a settlement proof for the checkout PAGE (read-only): signature +
   * expiry + issuer (crypto), then `aud` must equal the plan's merchant, and the
   * jti must not already be spent. Does NOT burn the jti. Returns typed claims or
   * a typed reason. The amount only ever comes from the verified token.
   */
  async verifyProof(
    token: string,
  ): Promise<{ ok: true; claims: ProofClaims } | { ok: false; reason: ProofError | "aud_mismatch" | "redeemed" }> {
    const res = this.proofVerifier.verify(token, this.now());
    if (!res.ok) return res;
    const plan = await this.store.getPlanById(res.claims.plan_id);
    if (!plan || plan.merchantId !== res.claims.aud) return { ok: false, reason: "aud_mismatch" };
    if (await this.store.isProofRedeemed(res.claims.jti)) return { ok: false, reason: "redeemed" };
    return { ok: true, claims: res.claims };
  }

  /** Mint a fresh proof for a deal and return the Bouncr-hosted checkout URL. */
  private mintCheckoutUrl(deal: DealRecord, plan: Plan, interval: ProofInterval = "month"): string {
    const { token } = mintProof(this.proofSigner, { deal, plan, nowMs: this.now(), interval });
    return `${this.baseUrl}/checkout/${deal.id}?proof=${encodeURIComponent(token)}`;
  }

  /**
   * Decide what the hosted checkout page should do for a deal + (optional) proof.
   * Server-authoritative: the price only ever comes from a VERIFIED proof, and a
   * deal is never dead-ended —
   *   - settled            → "settled" (success)
   *   - open Stripe session → "resume" (redirect to the same Stripe URL; no re-charge)
   *   - valid proof         → "pay" (render the amount from the token)
   *   - invalid/expired/used proof, deal still open → "remint" (fresh proof, same
   *     engine-accepted amount, redirect back to the page)
   *   - unknown deal        → "expired"
   */
  async getCheckoutView(dealId: string, proofToken: string | undefined): Promise<CheckoutView> {
    const deal = await this.store.getDeal(dealId);
    if (!deal) return { state: "expired" };
    if (deal.status === "settled") return { state: "settled" };
    const plan = await this.store.getPlanById(deal.planId);
    if (!plan) return { state: "expired" };

    const now = this.now();
    // Resume an open, unexpired Stripe session instead of minting a new proof.
    if (deal.checkoutStatus === "pending" && deal.checkoutUrl && (deal.checkoutExpiresAt ?? Infinity) > now) {
      return { state: "resume", url: deal.checkoutUrl };
    }

    if (proofToken) {
      const res = await this.verifyProof(proofToken);
      if (res.ok && res.claims.deal_id === dealId) {
        return {
          state: "pay",
          dealId,
          productName: plan.persona.productName,
          amountCents: res.claims.amount,
          currency: res.claims.currency,
          interval: res.claims.interval,
          proof: proofToken,
        };
      }
    }
    // No/invalid/expired proof, but the deal is still open → re-mint (same amount).
    return { state: "remint", url: this.mintCheckoutUrl(deal, plan) };
  }

  /** Effective take-rate for a plan: its per-plan override if set, else the
   *  platform default. Clamped to [0, 100]. */
  private feeFor(plan: Plan): number {
    const raw = plan.applicationFeePercent ?? this.applicationFeePercent;
    return Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) : 0;
  }

  // --- Session lifecycle ----------------------------------------------------

  async createSession(
    input: CreateSessionInput,
  ): Promise<{ sessionId: string; sessionToken: string; opener: string; expiresAt: number }> {
    const plan = await this.requirePlan(input.planId);
    const now = this.now();

    // Walkaway cooldown (Spec §12): a user who got walked must wait before retrying.
    const cooldownUntil = await this.store.getCooldown(plan.id, input.endUserRef);
    if (cooldownUntil && cooldownUntil > now) {
      throw new ServiceError("conflict", "in cooldown after a recent walkaway", {
        retry_at: cooldownUntil,
      });
    }

    const seed = openSession(plan.config, now); // round 0, currentAsk = anchor
    const expiresAt = now + plan.config.maxDurationH * 3_600_000;

    const session = await this.store.createSession({
      planId: plan.id,
      sessionToken: `sst_${randomUUID().replace(/-/g, "")}`,
      endUserRef: input.endUserRef,
      channel: input.channel ?? "web",
      round: seed.round,
      currentAsk: seed.currentAsk,
      openedAt: now,
      expiresAt,
      status: "open",
      configVersion: plan.version,
      context: input.context ?? null,
      kind: "initial",
      renegDealId: null,
      configOverride: null,
    });

    const opener = await this.negotiator.opener({ cfg: plan.config, persona: plan.persona });
    await this.store.addTurn({
      sessionId: session.id,
      role: "bouncer",
      rawText: opener,
      extracted: null,
      action: null,
    });
    await this.store.appendEvent("session.opened", {
      sessionId: session.id,
      planId: plan.id,
      anchor: seed.currentAsk,
    });

    return { sessionId: session.id, sessionToken: session.sessionToken, opener, expiresAt };
  }

  /**
   * Early-access waitlist signup (landing page). Rides on the append-only event
   * log, so it's durable wherever the store is (Postgres in prod); query later
   * with `select payload->>'email' from bouncr.events where type='waitlist.signup'`.
   * Normalizes + validates the email; throws bad_request on a malformed one.
   */
  async joinWaitlist(email: string, source?: string): Promise<void> {
    const e = email.trim().toLowerCase();
    if (e.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
      throw new ServiceError("bad_request", "a valid email is required");
    }
    await this.store.appendEvent("waitlist.signup", { email: e, source: source ?? null, at: this.now() });
  }

  /**
   * Record a widget impression for the A/B lift experiment (Spec §11). Fired by
   * the embed loader for BOTH arms before anything mounts — this is the visitor
   * denominator that makes revenue-PER-VISITOR (not per-session) measurable.
   * Resolves the public plan key to the internal id so the analytics read
   * (listEventsByPlan) matches; cohort is normalized to treatment|control.
   * Dedup is done at read time (distinct user per cohort), so re-firing is safe.
   */
  async recordImpression(input: { planId: string; endUserRef: string; cohort: string }): Promise<void> {
    const plan = await this.requirePlan(input.planId);
    const cohort = input.cohort === "control" ? "control" : "treatment";
    await this.store.appendEvent("widget.impression", {
      planId: plan.id,
      userRef: input.endUserRef,
      cohort,
      at: this.now(),
    });
  }

  /**
   * Record a CONTROL-arm conversion reported by the merchant (Spec §11). Bouncr
   * sees treatment revenue natively (settled deals) but is blind to sales that
   * close on the merchant's own flat page — so the merchant calls this from its
   * existing Stripe webhook (one line) to report them. Without it, the dashboard
   * degrades honestly: treatment self-measures, the flat arm shows "needs
   * conversion callback" rather than a false comparison.
   */
  async recordConversion(input: { planId: string; endUserRef: string; amount: number }): Promise<void> {
    const plan = await this.requirePlan(input.planId);
    if (!Number.isFinite(input.amount) || input.amount < 0) {
      throw new ServiceError("bad_request", "amount must be a non-negative number");
    }
    await this.store.appendEvent("merchant.conversion", {
      planId: plan.id,
      userRef: input.endUserRef,
      amount: input.amount,
      at: this.now(),
    });
  }

  // --- Merchant signup / onboarding (Spec §9) ------------------------------

  /**
   * Create a new merchant. The merchant logs into the dashboard with their
   * email + password; an API key is also minted for programmatic / agent (MCP)
   * access and returned ONCE (only its hash is stored). Email is the unique
   * login identifier.
   */
  async signupMerchant(input: {
    name: string;
    email: string;
    password: string;
    plan?: PlanInput;
  }): Promise<{ merchant: Merchant; key: string; plan?: Plan }> {
    const name = input.name?.trim();
    if (!name) throw new ServiceError("bad_request", "a business name is required");
    const email = input.email?.trim().toLowerCase() || "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new ServiceError("bad_request", "a valid email is required");
    }
    const password = input.password ?? "";
    if (password.length < 8) {
      throw new ServiceError("bad_request", "password must be at least 8 characters");
    }
    if (await this.store.getMerchantByEmail(email)) {
      throw new ServiceError("conflict", "an account with that email already exists");
    }
    const id = `merchant_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const key = generateMerchantKey(id);
    // Lint/assemble the first plan BEFORE creating anything — an invalid plan
    // creates no account, so the merchant is only "fulfilled" once it all checks
    // out and the final step runs.
    const planToCreate = input.plan ? this.assemblePlan(id, input.plan) : null;
    const merchant = await this.store.createMerchant({
      id,
      name,
      email,
      passwordHash: hashPassword(password),
      stripeConnectId: null,
      apiKeyHash: hashKey(key),
      createdAt: this.now(),
    });
    await this.store.appendEvent("merchant.signup", { merchantId: id, name });
    const plan = planToCreate ? await this.store.createPlan(planToCreate) : undefined;
    return { merchant, key, ...(plan ? { plan } : {}) };
  }

  /**
   * Validate an email + password for dashboard login. Returns the merchant on
   * success; throws unauthorized otherwise. The same opaque error for "no such
   * email" and "wrong password" avoids leaking which emails are registered.
   */
  async authenticatePassword(email: string, password: string): Promise<Merchant> {
    const merchant = email ? await this.store.getMerchantByEmail(email.trim().toLowerCase()) : null;
    if (!merchant || !verifyPassword(password ?? "", merchant.passwordHash)) {
      throw new ServiceError("unauthorized", "invalid email or password");
    }
    return merchant;
  }

  /**
   * Change a merchant's dashboard password. Requires the current password
   * (re-auth), so a stolen session token alone can't lock the owner out. The
   * dashboard token stays valid — only the stored hash changes.
   */
  async changePassword(merchantId: string, currentPassword: string, newPassword: string): Promise<void> {
    const merchant = await this.store.getMerchant(merchantId);
    if (!merchant) throw new ServiceError("not_found", "merchant not found");
    if (!verifyPassword(currentPassword ?? "", merchant.passwordHash)) {
      throw new ServiceError("unauthorized", "current password is incorrect");
    }
    if ((newPassword ?? "").length < 8) {
      throw new ServiceError("bad_request", "new password must be at least 8 characters");
    }
    await this.store.updateMerchant(merchantId, { passwordHash: hashPassword(newPassword) });
    await this.store.appendEvent("merchant.password_changed", { merchantId });
  }

  /**
   * Forgot-password lookup. Returns the merchant id, name, and a fingerprint of
   * the current password (which binds the reset token, making it single-use)
   * WITHOUT exposing the hash. Null if no account has that email — the caller
   * must still respond identically so the endpoint can't be used to enumerate.
   */
  async lookupForReset(email: string): Promise<{ merchantId: string; name: string; fingerprint: string } | null> {
    const m = email ? await this.store.getMerchantByEmail(email.trim().toLowerCase()) : null;
    return m ? { merchantId: m.id, name: m.name, fingerprint: pwFingerprint(m.passwordHash) } : null;
  }

  /**
   * Complete a password reset. The token's fingerprint must still match the
   * stored password (single-use: a prior reset or change invalidates the link).
   */
  async resetPassword(merchantId: string, expectedFingerprint: string, newPassword: string): Promise<void> {
    const m = await this.store.getMerchant(merchantId);
    if (!m || pwFingerprint(m.passwordHash) !== expectedFingerprint) {
      throw new ServiceError("bad_request", "this reset link is invalid or has already been used");
    }
    if ((newPassword ?? "").length < 8) {
      throw new ServiceError("bad_request", "new password must be at least 8 characters");
    }
    await this.store.updateMerchant(merchantId, { passwordHash: hashPassword(newPassword) });
    await this.store.appendEvent("merchant.password_reset", { merchantId });
  }

  /** A merchant's own plans (onboarding / dashboard). */
  async listPlans(merchantId: string): Promise<Plan[]> {
    return this.store.listPlansByMerchant(merchantId);
  }

  /** Permanently delete a merchant account and everything under it (plans,
   *  sessions, deals, etc.). Irreversible — the dashboard confirms first. */
  async deleteAccount(merchantId: string): Promise<void> {
    await this.store.deleteMerchant(merchantId);
    await this.store.appendEvent("merchant.deleted", { merchantId });
  }

  /**
   * Create the merchant's first (or next) plan from a few essentials; everything
   * else gets sensible, lint-clean defaults. The config is linted before storing
   * — a misconfigured plan (e.g. floor ≥ target) is rejected with the reasons.
   */
  async createPlan(merchantId: string, input: PlanInput): Promise<Plan> {
    return this.store.createPlan(this.assemblePlan(merchantId, input));
  }

  /**
   * Build a complete, lint-clean Plan from a few essentials. Pure assembly +
   * validation — does NOT touch the store, so signup can lint a plan before
   * creating any account (an invalid plan creates nothing). Throws bad_request
   * with the reasons on a misconfigured plan (e.g. floor ≥ list).
   *
   * The bouncer opens at the merchant's list price (anchor = list) and negotiates
   * down toward a target (defaulting to the floor↔list midpoint), never below the
   * floor — so the demo reflects exactly the price the merchant set.
   */
  private assemblePlan(merchantId: string, input: PlanInput): Plan {
    const productName = input.productName?.trim();
    if (!productName) throw new ServiceError("bad_request", "a product name is required");
    const listPrice = num(input.listPrice);
    const floorPrice = num(input.floorPrice);
    if (listPrice === null || floorPrice === null) {
      throw new ServiceError("bad_request", "listPrice and floorPrice are required numbers");
    }
    const targetPrice =
      input.targetPrice != null ? num(input.targetPrice)! : round2((listPrice + floorPrice) / 2);
    const config: Config = {
      listPrice,
      floorPrice,
      targetPrice,
      anchorMultiplier: 1, // anchor = list price
      maxRounds: 6,
      maxDurationH: 48,
      acceptThreshold: 0.92,
      minConcession: Math.max(1, round2((listPrice - floorPrice) * 0.12)),
      lambda: 0.55,
    };
    const policy = { cooldownHours: 72, maxMessages: 2000, rateLimitPerMin: 12 };
    const lint = lintConfig(config, policy);
    if (!lint.ok) throw new ServiceError("bad_request", `plan config invalid: ${lint.errors.join("; ")}`);

    const id = `plan_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    return {
      id,
      merchantId,
      planKey: id, // the embed references the unique id; no cross-merchant key collisions
      currency: (input.currency ?? "usd").toLowerCase(),
      config,
      persona: { name: "Vini", productName, style: input.personaStyle ?? "sassy", roastLevel: 2 },
      policy,
      usage: {
        bandCeiling: 1000,
        breachCyclesRequired: 3,
        costPerUnit: 0.004,
        costPlusMargin: 1.25,
        renegAnchorMultiplier: 1.7,
        downwardEnabled: false,
        downwardFloorRatio: 0.1,
        downwardMinCycles: 3,
      },
      version: 1,
      active: true,
      applicationFeePercent: null, // inherits the platform take-rate
    };
  }

  /**
   * Edit an existing plan (scoped to its owner). Applies a partial change over
   * the current config/persona, re-lints (a breaking edit is rejected with the
   * reasons), and bumps the version so new deals close under the new terms.
   */
  async updatePlan(
    merchantId: string,
    planId: string,
    input: {
      productName?: string;
      listPrice?: number;
      floorPrice?: number;
      targetPrice?: number;
      currency?: string;
      personaStyle?: Persona["style"];
      applicationFeePercent?: number | null;
      active?: boolean;
      /** Raw Vini/discovery config (renderer-only); validated here, null clears it. */
      discovery?: unknown;
    },
  ): Promise<Plan> {
    const plan = await this.requireOwnedPlan(planId, merchantId);

    const config: Config = { ...plan.config };
    for (const [k, v] of [
      ["listPrice", input.listPrice],
      ["floorPrice", input.floorPrice],
      ["targetPrice", input.targetPrice],
    ] as const) {
      if (v !== undefined) {
        const n = num(v);
        if (n === null) throw new ServiceError("bad_request", `${k} must be a number`);
        config[k] = n;
      }
    }
    const lint = lintConfig(config, plan.policy);
    if (!lint.ok) throw new ServiceError("bad_request", `plan config invalid: ${lint.errors.join("; ")}`);

    const persona: Persona = { ...plan.persona, name: "Vini" }; // always Vini
    if (input.productName?.trim()) persona.productName = input.productName.trim();
    if (input.personaStyle) persona.style = input.personaStyle;

    const fee =
      input.applicationFeePercent === undefined
        ? (plan.applicationFeePercent ?? null)
        : input.applicationFeePercent === null
          ? null
          : Math.max(0, Math.min(100, input.applicationFeePercent));

    // Discovery: validate against the policy (NEVER-list, shape) before storing.
    // Absent → keep what's there; explicit null → clear it.
    let discovery: DiscoveryConfig | null;
    if (input.discovery === undefined) {
      discovery = plan.discovery ?? null;
    } else if (input.discovery === null) {
      discovery = null;
    } else {
      const checked = parseDiscoveryConfig(input.discovery);
      if (!checked.config) throw new ServiceError("bad_request", checked.errors.join("; "));
      discovery = checked.config;
    }

    return this.store.updatePlan(planId, {
      config,
      persona,
      currency: (input.currency ?? plan.currency).toLowerCase(),
      applicationFeePercent: fee,
      active: input.active ?? plan.active,
      version: plan.version + 1,
      discovery,
    });
  }

  // --- Merchant auth (dashboard) -------------------------------------------

  /**
   * Validate a merchant API key against the stored hash. Returns the merchant on
   * success; throws unauthorized otherwise. The same opaque error for "no such
   * merchant" and "wrong secret" avoids leaking which merchant ids exist.
   */
  async authenticateMerchantKey(key: string | undefined): Promise<Merchant> {
    const parsed = key ? parseMerchantKey(key) : null;
    const merchant = parsed ? await this.store.getMerchant(parsed.merchantId) : null;
    if (!merchant || !merchant.apiKeyHash || !safeEqualHex(hashKey(key!), merchant.apiKeyHash)) {
      throw new ServiceError("unauthorized", "invalid credentials");
    }
    return merchant;
  }

  /** Public merchant info for a logged-in dashboard (id + name + email + settlement config). */
  async getMerchantInfo(
    merchantId: string,
  ): Promise<{ id: string; name: string; email: string | null; webhookUrl: string | null; liveMode: boolean } | null> {
    const m = await this.store.getMerchant(merchantId);
    return m
      ? { id: m.id, name: m.name, email: m.email, webhookUrl: m.webhookUrl ?? null, liveMode: Boolean(m.liveMode) }
      : null;
  }

  /** Mint (or rotate) a merchant's API key; stores only the hash, returns the
   *  plaintext once. */
  async provisionMerchantKey(merchantId: string): Promise<string> {
    const key = generateMerchantKey(merchantId);
    await this.store.updateMerchant(merchantId, { apiKeyHash: hashKey(key) });
    return key;
  }

  /** Load a plan, but only if it belongs to `merchantId`. 404 (not 403) on a
   *  mismatch so a merchant can't probe for other merchants' plan ids. */
  async requireOwnedPlan(planId: string, merchantId: string): Promise<Plan> {
    const plan = await this.store.getPlanById(planId); // owner sees inactive plans too
    if (!plan || plan.merchantId !== merchantId) throw new ServiceError("not_found", `plan ${planId} not found`);
    return plan;
  }

  /** Assert a session belongs to `merchantId` (via its plan). */
  async requireOwnedSession(sessionId: string, merchantId: string): Promise<void> {
    const session = await this.store.getSession(sessionId);
    const plan = session ? await this.store.getPlanById(session.planId) : null;
    if (!session || !plan || plan.merchantId !== merchantId) {
      throw new ServiceError("not_found", `session ${sessionId} not found`);
    }
  }

  /** Verify a widget session token. Throws unauthorized on mismatch (Spec §9, §12). */
  async verifySessionToken(sessionId: string, token: string | undefined): Promise<void> {
    const session = await this.store.getSession(sessionId);
    if (!session) throw new ServiceError("not_found", `session ${sessionId} not found`);
    if (!token || token !== session.sessionToken) {
      throw new ServiceError("unauthorized", "invalid or missing session token");
    }
  }

  /** Token-gated public view (countdown / reconnect). */
  async getSessionView(sessionId: string): Promise<SessionView> {
    const session = await this.store.getSession(sessionId);
    if (!session) throw new ServiceError("not_found", `session ${sessionId} not found`);
    return {
      status: session.status,
      round: session.round,
      currentAsk: session.currentAsk,
      expiresAt: session.expiresAt,
    };
  }

  async postMessage(sessionId: string, text: string): Promise<TurnResponse> {
    const { session, plan } = await this.requireOpenSession(sessionId);
    const now = this.now();

    const turns = await this.store.listTurns(sessionId);
    const history: ChatTurn[] = turns.map((t) => ({ role: t.role, text: t.rawText }));
    const userMsgTimestamps = turns.filter((t) => t.role === "user").map((t) => t.createdAt);

    // Wallet guard keys off RATE (velocity), not lifetime volume (Spec §12). A
    // days-long human haggle is slow and never punished; a bot firing fast hits a
    // free canned wall instantly. Throttle is a PAUSE — it never touches the price,
    // and full Vini resumes automatically once they slow to a human pace.
    const perMin = plan.policy.rateLimitPerMin ?? DEFAULT_RATE_LIMIT_PER_MIN;
    if (messageRateExceeded(userMsgTimestamps, now, perMin)) {
      return this.throttle(session, text);
    }

    // Absolute backstop, far above any human haggle. On a cold-start session this
    // LOCKS IN the lowest ask (price never lost); reneg grandfathers.
    if (userMsgTimestamps.length >= plan.policy.maxMessages) {
      if (session.kind === "initial") return this.lockInAtCap(session, text);
      return this.endWithWalk(session, plan, text, "message cap reached", now);
    }

    // A renegotiation session prices off its own (anchor/target/floor) config.
    const cfg = session.configOverride ?? plan.config;
    const result = await this.negotiator.turn({
      cfg,
      persona: plan.persona,
      state: this.engineState(session),
      history,
      userMessage: text,
      now,
      // Vini/discovery config → renderer only (never reaches the engine via cfg).
      ...(plan.discovery ? { discovery: { cfg: plan.discovery } } : {}),
      // Cold-start never walks on rounds (hold + keep rapport); a reneg that can't
      // reach agreement terminates into a grandfather settlement (§6.2).
      ...(session.kind !== "initial" ? { endOnRoundsExhausted: true } : {}),
    });

    // Persist both sides of the turn (full extractor/action snapshots — Spec §4.4.5).
    await this.store.addTurn({
      sessionId,
      role: "user",
      rawText: text,
      extracted: result.extraction,
      action: null,
    });
    await this.store.addTurn({
      sessionId,
      role: "bouncer",
      rawText: result.reply,
      extracted: null,
      action: result.action,
    });

    const status = this.statusForAction(result.action);
    await this.store.updateSession(sessionId, {
      round: result.state.round,
      currentAsk: result.state.currentAsk,
      status,
    });
    await this.store.appendEvent("turn", {
      sessionId,
      intent: result.extraction.intent,
      offer: result.extraction.offer_amount,
      action: result.action.type,
      amount: "amount" in result.action ? result.action.amount : null,
    });

    const out: TurnResponse = {
      reply: result.reply,
      action: result.action,
      round: result.state.round,
      currentAsk: result.state.currentAsk,
      status,
      expiresAt: session.expiresAt,
      isFinal: result.action.type === "counter" && result.action.isFinal,
    };

    if (result.action.type === "accept") {
      const settle = await this.settle(session, plan, result.action.amount);
      if (settle.checkoutUrl) out.checkoutUrl = settle.checkoutUrl;
      out.dealId = settle.dealId;
    } else if (result.action.type === "walk") {
      if (session.kind === "initial") {
        // Cold-start walk → cooldown (Spec §12).
        await this.startCooldown(plan, session.endUserRef, now);
      } else {
        // Reneg walk → grandfather to the fair tier; never hard-cut (Spec §6.2).
        await this.grandfather(session, plan);
      }
    }
    return out;
  }

  /** Explicit accept of the current standing ask (Spec §9 POST /accept). */
  async acceptCurrent(
    sessionId: string,
  ): Promise<{ checkoutUrl?: string; dealId: string; price: number }> {
    const { session, plan } = await this.requireOpenSession(sessionId);
    const amount = session.currentAsk;

    await this.store.addTurn({
      sessionId,
      role: "bouncer",
      rawText: `Deal — $${amount}/mo.`,
      extracted: null,
      action: { type: "accept", amount },
    });
    await this.store.updateSession(sessionId, { status: "accepted" });
    await this.store.appendEvent("turn", { sessionId, action: "accept", amount, explicit: true });

    const settle = await this.settle(session, plan, amount);
    return { ...(settle.checkoutUrl ? { checkoutUrl: settle.checkoutUrl } : {}), dealId: settle.dealId, price: amount };
  }

  async getDeal(dealId: string) {
    const deal = await this.store.getDeal(dealId);
    if (!deal) throw new ServiceError("not_found", `deal ${dealId} not found`);
    return deal;
  }

  // --- Usage ingestion + renegotiation (Spec §6, Phase 4) -------------------

  /**
   * Report one billing cycle's usage for a settled deal (Spec §6.1). Maintains
   * the breach streak; opens a renegotiation when usage breaches the band for
   * `breachCyclesRequired` CONSECUTIVE cycles (a blip won't reopen the deal).
   */
  async reportUsage(
    dealId: string,
    cycleIndex: number,
    value: number,
  ): Promise<{
    breach: boolean;
    breachStreak: number;
    renegotiation?: { sessionId: string; sessionToken: string; direction: RenegDirection };
  }> {
    const deal = await this.store.getDeal(dealId);
    if (!deal) throw new ServiceError("not_found", `deal ${dealId} not found`);
    if (deal.status !== "settled") {
      throw new ServiceError("conflict", `deal ${dealId} is ${deal.status}, not settled`);
    }
    const plan = await this.requirePlan(deal.planId);
    const u = plan.usage;
    const cycles = (await this.store.listUsageCycles(dealId)).sort((a, b) => a.cycleIndex - b.cycleIndex);

    const breach = value > u.bandCeiling;
    const prevStreak = cycles.length ? cycles[cycles.length - 1]!.breachStreak : 0;
    const breachStreak = breach ? prevStreak + 1 : 0;

    await this.store.addUsageCycle({
      dealId,
      cycleIndex,
      usageValue: value,
      bandCeiling: u.bandCeiling,
      breach,
      breachStreak,
    });
    await this.store.appendEvent("usage.reported", { dealId, cycleIndex, value, breach, breachStreak });

    const result: {
      breach: boolean;
      breachStreak: number;
      renegotiation?: { sessionId: string; sessionToken: string; direction: RenegDirection };
    } = { breach, breachStreak };

    if (deal.renegSessionId) return result; // a reneg is already open

    const allCycles = [...cycles, { usageValue: value } as { usageValue: number }];

    // Upward trigger (Spec §6.1): consecutive breaches.
    if (breach && breachStreak >= u.breachCyclesRequired) {
      const r = await this.openRenegotiation(deal, plan, "up", allCycles.map((c) => c.usageValue));
      result.renegotiation = { sessionId: r.sessionId, sessionToken: r.sessionToken, direction: "up" };
      return result;
    }

    // Downward trigger (Spec §6.3, opt-in): sustained under-use.
    if (u.downwardEnabled && allCycles.length >= u.downwardMinCycles) {
      const recent = allCycles.slice(-u.downwardMinCycles);
      const lowCeiling = u.downwardFloorRatio * u.bandCeiling;
      if (recent.every((c) => c.usageValue < lowCeiling)) {
        const r = await this.openRenegotiation(deal, plan, "down", allCycles.map((c) => c.usageValue));
        result.renegotiation = { sessionId: r.sessionId, sessionToken: r.sessionToken, direction: "down" };
      }
    }
    return result;
  }

  /** Manually trigger a renegotiation for a deal (Spec §9 POST /deals/:id/renegotiate). */
  async renegotiateDeal(
    dealId: string,
    direction: RenegDirection = "up",
  ): Promise<{ sessionId: string; sessionToken: string; opener: string; summary: RenegPlan["summary"] }> {
    const deal = await this.store.getDeal(dealId);
    if (!deal) throw new ServiceError("not_found", `deal ${dealId} not found`);
    if (deal.status !== "settled") throw new ServiceError("conflict", `deal ${dealId} is not settled`);
    if (deal.renegSessionId) throw new ServiceError("conflict", "a renegotiation is already open for this deal");
    const plan = await this.requirePlan(deal.planId);
    const cycles = (await this.store.listUsageCycles(dealId)).sort((a, b) => a.cycleIndex - b.cycleIndex);
    // No usage data → assume at-band usage (ratio 1) so the engine still has room.
    const usages = cycles.length ? cycles.map((c) => c.usageValue) : [plan.usage.bandCeiling];
    return this.openRenegotiation(deal, plan, direction, usages);
  }

  // --- Connect onboarding (Spec §7, Phase 3) --------------------------------

  /** Begin (or resume) Stripe Connect onboarding for a merchant. */
  async startConnectOnboarding(
    merchantId: string,
    returnUrl: string,
    refreshUrl: string,
  ): Promise<{ url: string; accountId: string }> {
    const merchant = await this.store.getMerchant(merchantId);
    if (!merchant) throw new ServiceError("not_found", `merchant ${merchantId} not found`);
    const r = await this.stripe.startConnectOnboarding({
      merchantId,
      existingAccountId: merchant.stripeConnectId,
      returnUrl,
      refreshUrl,
    });
    const patch: Parameters<typeof this.store.updateMerchant>[1] = {};
    if (r.accountId !== merchant.stripeConnectId) patch.stripeConnectId = r.accountId;
    // Generate the per-merchant OUTBOUND signing secret at onboarding (distinct
    // from the inbound API key) so entitlement webhooks can be signed.
    if (!merchant.webhookSecret) patch.webhookSecret = `whsec_${randomBytes(24).toString("hex")}`;
    if (Object.keys(patch).length) await this.store.updateMerchant(merchantId, patch);
    await this.store.appendEvent("connect.onboarding_started", { merchantId, accountId: r.accountId });
    return { url: r.url, accountId: r.accountId };
  }

  /**
   * Set (or clear) the merchant's entitlement webhook URL, generating the
   * outbound signing secret if needed. Returns the secret so the merchant can
   * configure verification on their side.
   */
  async setWebhookUrl(merchantId: string, url: string | null): Promise<{ webhookUrl: string | null; webhookSecret: string | null }> {
    const merchant = await this.store.getMerchant(merchantId);
    if (!merchant) throw new ServiceError("not_found", `merchant ${merchantId} not found`);
    const trimmed = url?.trim() || null;
    if (trimmed && !/^https?:\/\/.+/i.test(trimmed)) {
      throw new ServiceError("bad_request", "webhook_url must be an http(s) URL");
    }
    const webhookSecret = merchant.webhookSecret ?? `whsec_${randomBytes(24).toString("hex")}`;
    await this.store.updateMerchant(merchantId, { webhookUrl: trimmed, webhookSecret });
    return { webhookUrl: trimmed, webhookSecret };
  }

  /**
   * Live-mode gate (Spec settlement §5): a merchant cannot switch to live mode
   * until they've configured a webhook_url. This is WHERE the "merchant must hear
   * about entitlements" guarantee lives — enforced at go-live (failing is safe),
   * never at settlement (failing there would strand a completed charge).
   */
  async goLive(merchantId: string): Promise<{ liveMode: boolean }> {
    const merchant = await this.store.getMerchant(merchantId);
    if (!merchant) throw new ServiceError("not_found", `merchant ${merchantId} not found`);
    if (!merchant.webhookUrl) {
      throw new ServiceError(
        "bad_request",
        "configure a webhook_url before going live — Bouncr must be able to notify you to grant entitlements",
      );
    }
    await this.store.updateMerchant(merchantId, { liveMode: true });
    await this.store.appendEvent("merchant.went_live", { merchantId });
    return { liveMode: true };
  }

  /** Connect status for a merchant — drives the dashboard's "ready to settle" badge. */
  async getConnectStatus(
    merchantId: string,
  ): Promise<{ connected: boolean; accountId: string | null; chargesEnabled: boolean }> {
    const merchant = await this.store.getMerchant(merchantId);
    if (!merchant) throw new ServiceError("not_found", `merchant ${merchantId} not found`);
    if (!merchant.stripeConnectId) return { connected: false, accountId: null, chargesEnabled: false };
    const status = await this.stripe.getAccountStatus(merchant.stripeConnectId);
    return { connected: true, accountId: merchant.stripeConnectId, chargesEnabled: status.chargesEnabled };
  }

  // --- Dashboard reads (Spec §11) -------------------------------------------

  async getAnalytics(planId: string) {
    const plan = await this.requirePlan(planId);
    const a = await computeAnalytics(this.store, plan);
    // Attach Bouncr's cut (the service knows the platform default behind any
    // per-plan override) so the dashboard can show take-rate + net to merchant.
    const round2 = (x: number) => Math.round((x + Number.EPSILON) * 100) / 100;
    const takeRatePercent = this.feeFor(plan);
    const bouncrFee = round2(a.closing.revenue * (takeRatePercent / 100));
    return {
      ...a,
      monetization: { takeRatePercent, bouncrFee, merchantNet: round2(a.closing.revenue - bouncrFee) },
    };
  }

  /** Lint a plan's config (Spec §12). */
  async lintPlan(planId: string): Promise<LintResult> {
    const plan = await this.requirePlan(planId);
    return lintConfig(plan.config, plan.policy);
  }

  /** Full transcript for the transcript viewer (Spec §11). */
  async getTranscript(sessionId: string): Promise<{ session: SessionRecord; turns: TurnRecord[] }> {
    const session = await this.store.getSession(sessionId);
    if (!session) throw new ServiceError("not_found", `session ${sessionId} not found`);
    const turns = await this.store.listTurns(sessionId);
    return { session, turns };
  }

  /** Recent sessions for a plan (transcript viewer index). */
  async listSessions(planId: string): Promise<SessionRecord[]> {
    await this.requirePlan(planId);
    return this.store.listSessionsByPlan(planId);
  }

  // --- Settlement -----------------------------------------------------------

  /**
   * Handle a normalized Stripe webhook event (Spec settlement §4). Idempotent on
   * re-delivery (the deal-settled guard), account-scoped (a webhook carrying a
   * connected account must match the deal's merchant — A can't settle B's deal),
   * and on first settle it durably records the entitlement then best-effort
   * notifies the merchant. The outbound notify NEVER fails settlement.
   */
  async handleStripeEvent(
    event: WebhookEvent,
    opts: { correlationId?: string } = {},
  ): Promise<{ settled: boolean; dealId?: string }> {
    // Correlation id threaded through every durable event on this settlement, so a
    // single webhook can be traced end to end (route → settle → entitlement) — the
    // request_id in the HTTP response matches these records. (Settlement+webhook
    // path only; broader structured logging/metrics are a later observability pass.)
    const correlationId = opts.correlationId ?? randomUUID();
    if (event.type !== "checkout.session.completed") return { settled: false };

    const deal = await this.store.getDealByCheckoutId(event.checkoutId);
    if (!deal) {
      await this.store.appendEvent("webhook.unmatched", { checkoutId: event.checkoutId, correlationId });
      return { settled: false };
    }
    if (deal.status === "settled") return { settled: true, dealId: deal.id }; // idempotent

    // Account-scoping: when the event carries a connected account, it MUST be the
    // deal's merchant's account. (A null account = platform-level event.)
    const merchant = await this.store.getMerchant(deal.merchantId);
    if (event.accountId && event.accountId !== (merchant?.stripeConnectId ?? null)) {
      await this.store.appendEvent("webhook.account_mismatch", {
        dealId: deal.id,
        eventAccount: event.accountId,
        eventId: event.eventId,
        correlationId,
      });
      return { settled: false };
    }

    // Do NOT settle an `unpaid` session — a delayed payment method (ACH / bank
    // transfer) completes the Checkout before funds land. We wait for the later
    // checkout.session.async_payment_succeeded (which arrives `paid`). Settling here
    // would grant entitlement for money that hasn't moved (and might fail).
    // (undefined = the fake gateway / legacy events that don't carry it → treat as
    // paid, preserving the offline/test path.)
    if (event.paymentStatus === "unpaid") {
      await this.store.appendEvent("webhook.unpaid", {
        dealId: deal.id,
        checkoutId: event.checkoutId,
        eventId: event.eventId,
        correlationId,
      });
      return { settled: false };
    }

    await this.store.updateDeal(deal.id, {
      status: "settled",
      stripeSubscriptionId: event.subscriptionId,
      ...(event.paymentIntentId ? { paymentIntentId: event.paymentIntentId } : {}),
      checkoutStatus: "completed",
      settledAt: this.now(),
    });
    await this.store.updateSession(deal.sessionId, { status: "settled" });
    await this.store.appendEvent("deal.settled", {
      dealId: deal.id,
      subscriptionId: event.subscriptionId,
      price: deal.price,
      eventId: event.eventId,
      correlationId,
    });

    // Durably record the entitlement BEFORE any outbound POST, then best-effort
    // notify the merchant to grant access (skip-if-unset; failures don't roll back).
    await this.notifyEntitlement(deal, merchant ?? null, event.eventId, correlationId);
    return { settled: true, dealId: deal.id };
  }

  /**
   * Record the entitlement durably, then best-effort POST it to the merchant. The
   * durable event is the load-bearing part: a settlement that happened is always
   * recorded (so retries are a later bolt-on over recorded events). A missing
   * webhook_url or a failed POST is logged, never thrown — money already moved.
   */
  private async notifyEntitlement(
    deal: DealRecord,
    merchant: Merchant | null,
    eventId: string,
    correlationId: string,
  ): Promise<void> {
    const payload: EntitlementPayload = {
      deal_id: deal.id,
      end_user_ref: deal.endUserRef,
      plan_id: deal.planId,
      amount: Math.round(deal.price * 100),
      currency: deal.currency,
      status: "active",
    };
    // Durable record of the entitlement — written BEFORE any outbound attempt.
    await this.store.appendEvent("entitlement.recorded", { ...payload, eventId, correlationId });

    if (!merchant?.webhookUrl || !merchant.webhookSecret) {
      await this.store.appendEvent("entitlement.skipped", { dealId: deal.id, reason: "no webhook_url", correlationId });
      return;
    }
    try {
      await this.notifier.notify(merchant.webhookUrl, merchant.webhookSecret, payload, this.now());
      await this.store.appendEvent("entitlement.delivered", { dealId: deal.id, eventId, correlationId });
    } catch (err) {
      // Stub for the durable-retry bolt-on: the event above is already recorded,
      // so a future replayer can re-POST without any new plumbing.
      await this.store.appendEvent("entitlement.delivery_failed", {
        dealId: deal.id,
        eventId,
        correlationId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // --- Internals ------------------------------------------------------------

  /** Dispatch settlement: cold-start → Checkout; reneg → subscription update. */
  private async settle(
    session: SessionRecord,
    plan: Plan,
    amount: number,
  ): Promise<{ checkoutUrl?: string; dealId: string }> {
    if (session.kind === "initial") return this.closeDeal(session, plan, amount);
    const dealId = await this.settleReneg(session, plan, amount, false);
    await this.store.updateSession(session.id, { status: "settled" });
    return { dealId };
  }

  /** Open a renegotiation: build the reneg config, seed a session, link the deal. */
  private async openRenegotiation(
    deal: DealRecord,
    plan: Plan,
    direction: RenegDirection,
    usages: number[],
  ): Promise<{ sessionId: string; sessionToken: string; opener: string; summary: RenegPlan["summary"] }> {
    const now = this.now();
    const trailing = usages.slice(-3);
    const trailingAvgUsage = trailing.reduce((a, b) => a + b, 0) / Math.max(1, trailing.length);

    const reneg = buildRenegConfig({
      direction,
      currentPrice: deal.price,
      trailingAvgUsage,
      bandCeiling: plan.usage.bandCeiling,
      costPerUnit: plan.usage.costPerUnit,
      costPlusMargin: plan.usage.costPlusMargin,
      renegAnchorMultiplier: plan.usage.renegAnchorMultiplier,
      base: plan.config,
    });

    const seed = openSession(reneg.config, now);
    const session = await this.store.createSession({
      planId: plan.id,
      sessionToken: `sst_${randomUUID().replace(/-/g, "")}`,
      endUserRef: deal.endUserRef,
      channel: "web",
      round: seed.round,
      currentAsk: seed.currentAsk,
      openedAt: now,
      expiresAt: now + reneg.config.maxDurationH * 3_600_000,
      status: "open",
      configVersion: plan.version,
      context: { renegOf: deal.id },
      kind: direction === "up" ? "reneg_up" : "reneg_down",
      renegDealId: deal.id,
      configOverride: reneg.config,
    });

    const opener = await this.negotiator.opener({ cfg: reneg.config, persona: plan.persona });
    await this.store.addTurn({ sessionId: session.id, role: "bouncer", rawText: opener, extracted: null, action: null });
    await this.store.updateDeal(deal.id, { renegSessionId: session.id });
    await this.store.appendEvent("reneg.opened", { dealId: deal.id, sessionId: session.id, direction, summary: reneg.summary });

    return { sessionId: session.id, sessionToken: session.sessionToken, opener, summary: reneg.summary };
  }

  /** Settle a renegotiation by repricing the existing subscription (Spec §6/§7). */
  private async settleReneg(
    session: SessionRecord,
    plan: Plan,
    amount: number,
    viaGrandfather: boolean,
  ): Promise<string> {
    const original = session.renegDealId ? await this.store.getDeal(session.renegDealId) : null;
    const subscriptionId = original?.stripeSubscriptionId ?? null;
    const merchant = await this.store.getMerchant(plan.merchantId);

    if (subscriptionId) {
      const connectedAccountId = merchant?.stripeConnectId ?? null;
      await this.stripe.updateSubscription({
        subscriptionId,
        productName: plan.persona.productName,
        amount,
        currency: plan.currency,
        connectedAccountId,
        applicationFeePercent: connectedAccountId && this.feeFor(plan) > 0 ? this.feeFor(plan) : null,
      });
    }

    const deal = await this.store.createDeal({
      sessionId: session.id,
      merchantId: plan.merchantId,
      planId: plan.id,
      endUserRef: session.endUserRef,
      price: amount,
      currency: plan.currency,
      status: "settled",
      kind: session.kind,
      stripeCheckoutId: null,
      stripeSubscriptionId: subscriptionId,
      renegSessionId: null,
      settledAt: this.now(),
    });

    if (original) await this.store.updateDeal(original.id, { renegSessionId: null });
    await this.store.appendEvent("reneg.settled", {
      dealId: deal.id,
      originalDealId: original?.id ?? null,
      price: amount,
      viaGrandfather,
    });
    return deal.id;
  }

  /** Grandfather a walked/expired reneg to the fair tier — never hard-cut (Spec §6.2). */
  private async grandfather(session: SessionRecord, plan: Plan): Promise<void> {
    const price = session.configOverride?.targetPrice ?? session.currentAsk;
    await this.settleReneg(session, plan, price, true);
    await this.store.appendEvent("reneg.grandfathered", { sessionId: session.id, price });
  }

  private async closeDeal(
    session: SessionRecord,
    plan: Plan,
    amount: number,
  ): Promise<{ checkoutUrl: string; dealId: string }> {
    // Create the pending deal, then hand back the Bouncr-HOSTED checkout URL
    // (carrying a fresh proof). NO Stripe object is created here — that happens
    // when the buyer clicks Pay on the hosted page (startCheckout), so the jti is
    // burned at session creation and Apple/Google Pay come free via Stripe Checkout.
    const deal = await this.store.createDeal({
      sessionId: session.id,
      merchantId: plan.merchantId,
      planId: plan.id,
      endUserRef: session.endUserRef,
      price: amount,
      currency: plan.currency,
      status: "pending",
      kind: "initial",
      stripeCheckoutId: null,
      stripeSubscriptionId: null,
      checkoutStatus: "none",
      renegSessionId: null,
      settledAt: null,
    });
    await this.store.appendEvent("deal.created", { dealId: deal.id, price: amount });
    return { checkoutUrl: this.mintCheckoutUrl(deal, plan), dealId: deal.id };
  }

  /**
   * The hosted page's Pay button (Spec settlement §3): verify the proof, BURN the
   * jti atomically (single-use), then create a Stripe Checkout Session DIRECTLY on
   * the merchant's connected account (subscription for "month", one-time
   * PaymentIntent for "one_time") and redirect there. Resume/idempotency keep an
   * abandoned or double-tapped checkout from charging twice or stranding the deal.
   * Settlement itself happens ONLY via the webhook (§4), never the redirect.
   */
  async startCheckout(
    dealId: string,
    proofToken: string | undefined,
  ): Promise<{ state: "redirect"; url: string } | { state: "settled" } | { state: "invalid" }> {
    const deal = await this.store.getDeal(dealId);
    if (!deal) return { state: "invalid" };
    if (deal.status === "settled") return { state: "settled" };
    const plan = await this.store.getPlanById(deal.planId);
    if (!plan) return { state: "invalid" };
    const now = this.now();

    // Resume an open, unexpired session (handles double-tap and return-to-tab).
    if (deal.checkoutStatus === "pending" && deal.checkoutUrl && (deal.checkoutExpiresAt ?? Infinity) > now) {
      return { state: "redirect", url: deal.checkoutUrl };
    }

    const res = proofToken ? await this.verifyProof(proofToken) : ({ ok: false } as const);
    if (!res.ok || res.claims.deal_id !== dealId) return { state: "invalid" }; // page re-mints

    // Single-use: burn the jti BEFORE creating the session. If we lose the race,
    // resume whatever session the winner created (never mint a second proof).
    const won = await this.store.redeemProof(res.claims.jti, dealId, now);
    if (!won) {
      const fresh = await this.store.getDeal(dealId);
      if (fresh?.checkoutUrl && fresh.checkoutStatus === "pending") return { state: "redirect", url: fresh.checkoutUrl };
      return { state: "invalid" };
    }

    const merchant = await this.store.getMerchant(plan.merchantId);
    const connectedAccountId = merchant?.stripeConnectId ?? null;
    const checkout = await this.stripe.createCheckout({
      planKey: plan.planKey,
      productName: plan.persona.productName,
      amount: res.claims.amount / 100, // proof carries cents; gateway takes dollars
      currency: res.claims.currency,
      endUserRef: deal.endUserRef,
      dealId: deal.id,
      interval: res.claims.interval,
      idempotencyKey: `bouncr_checkout_${dealId}_${res.claims.jti}`,
      connectedAccountId,
      applicationFeePercent: connectedAccountId && this.feeFor(plan) > 0 ? this.feeFor(plan) : null,
      successUrl: `${this.baseUrl}/checkout/${deal.id}`,
      cancelUrl: `${this.baseUrl}/checkout/${deal.id}`,
    });

    await this.store.updateDeal(deal.id, {
      stripeCheckoutId: checkout.checkoutId,
      checkoutUrl: checkout.url,
      checkoutStatus: "pending",
      checkoutExpiresAt: checkout.expiresAt ?? now + 30 * 60 * 1000,
    });
    await this.store.appendEvent("checkout.started", { dealId: deal.id, checkoutId: checkout.checkoutId });
    return { state: "redirect", url: checkout.url };
  }

  /** End a session as a walk (message cap / abuse) and start the cooldown. */
  private async endWithWalk(
    session: SessionRecord,
    plan: Plan,
    userText: string,
    reason: string,
    now: number,
  ): Promise<TurnResponse> {
    const reply = "We're done here, friend. Standard pricing's right this way.";
    await this.store.addTurn({ sessionId: session.id, role: "user", rawText: userText, extracted: null, action: null });
    await this.store.addTurn({ sessionId: session.id, role: "bouncer", rawText: reply, extracted: null, action: { type: "walk" } });
    await this.store.updateSession(session.id, { status: "walked" });
    await this.store.appendEvent("turn", { sessionId: session.id, action: "walk", reason });
    if (session.kind === "initial") await this.startCooldown(plan, session.endUserRef, now);
    else await this.grandfather(session, plan); // reneg cap → grandfather, never hard-cut
    return {
      reply,
      action: { type: "walk" },
      round: session.round,
      currentAsk: session.currentAsk,
      status: "walked",
      expiresAt: session.expiresAt,
      isFinal: false,
    };
  }

  private async startCooldown(plan: Plan, endUserRef: string, now: number): Promise<void> {
    if (plan.policy.cooldownHours > 0) {
      await this.store.setCooldown(plan.id, endUserRef, now + plan.policy.cooldownHours * 3_600_000);
    }
  }

  /**
   * Wallet-guard THROTTLE (rate exceeded). A cheap canned hold — NO extractor, NO
   * renderer, NO LLM call — just a DB write and an in-character "slow down". The
   * negotiation state is untouched: price, round, status all unchanged. It's a
   * pause, not a concession or a close; full Vini resumes automatically the moment
   * the sender drops back under the rate (this turn just doesn't get a real reply).
   */
  private async throttle(session: SessionRecord, userText: string): Promise<TurnResponse> {
    const f = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));
    await this.store.addTurn({ sessionId: session.id, role: "user", rawText: userText, extracted: null, action: null });
    const reply = `whoa, easy. one at a time, im not a vending machine. the number's still $${f(session.currentAsk)}/mo, slow down and talk to me.`;
    const action: Action = { type: "hold", amount: session.currentAsk };
    await this.store.addTurn({ sessionId: session.id, role: "bouncer", rawText: reply, extracted: null, action });
    await this.store.appendEvent("turn", { sessionId: session.id, action: "throttle" });
    return {
      reply,
      action,
      round: session.round,
      currentAsk: session.currentAsk,
      status: "open",
      expiresAt: session.expiresAt,
      isFinal: false,
    };
  }

  /**
   * Cold-start message cap: LOCK IN the lowest standing ask instead of walking.
   * The buyer keeps the price they worked down to — takeable any time via the
   * "Take $X" button or by saying yes — and Vini stops budging (and stops spending
   * LLM turns). The session stays OPEN, no cooldown, no hard close.
   */
  private async lockInAtCap(session: SessionRecord, userText: string): Promise<TurnResponse> {
    const price = session.currentAsk;
    const f = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));
    await this.store.addTurn({ sessionId: session.id, role: "user", rawText: userText, extracted: null, action: null });

    // Saying yes at the cap seals the deal at the standing ask (their lowest).
    if (/\b(deal|yes|yeah|yep|sure|fine|sold|agreed|ok|okay|lock it in|take it|i'?ll take it|let'?s do it)\b/i.test(userText)) {
      const settle = await this.acceptCurrent(session.id);
      return {
        reply: `locked in, $${f(price)}/mo. you earned it.`,
        action: { type: "accept", amount: price },
        round: session.round,
        currentAsk: price,
        status: "accepted",
        expiresAt: session.expiresAt,
        isFinal: false,
        ...(settle.checkoutUrl ? { checkoutUrl: settle.checkoutUrl } : {}),
        dealId: settle.dealId,
      };
    }

    // Otherwise hold AT the lock-in — session stays open (no walk, no cooldown),
    // and the widget keeps showing "Take $X" + "Keep haggling".
    const reply = `ok you've genuinely haggled me to the bone. $${f(price)}/mo is the lowest i can do and it's locked in for you, grab it whenever. im not budging off $${f(price)} though, so it's that or keep me company.`;
    const action: Action = { type: "counter", amount: price, isFinal: false };
    await this.store.addTurn({ sessionId: session.id, role: "bouncer", rawText: reply, extracted: null, action });
    await this.store.appendEvent("turn", { sessionId: session.id, action: "lock_in", price });
    return {
      reply,
      action,
      round: session.round,
      currentAsk: price,
      status: "open",
      expiresAt: session.expiresAt,
      isFinal: false,
    };
  }

  private engineState(s: SessionRecord): SessionState {
    // history is not consulted by decide(); reconstruct the decision-relevant fields.
    return { round: s.round, currentAsk: s.currentAsk, openedAt: s.openedAt, history: [] };
  }


  private statusForAction(action: Action): SessionRecord["status"] {
    if (action.type === "accept") return "accepted";
    if (action.type === "walk") return "walked";
    return "open";
  }

  private async requirePlan(planId: string): Promise<Plan> {
    const plan = await this.store.getPlan(planId);
    if (!plan || !plan.active) throw new ServiceError("not_found", `plan ${planId} not found`);
    return plan;
  }

  private async requireOpenSession(sessionId: string): Promise<{ session: SessionRecord; plan: Plan }> {
    const session = await this.store.getSession(sessionId);
    if (!session) throw new ServiceError("not_found", `session ${sessionId} not found`);
    if (session.status !== "open") {
      throw new ServiceError("conflict", `session is ${session.status}, not open`);
    }
    const plan = await this.requirePlan(session.planId);
    return { session, plan };
  }
}
