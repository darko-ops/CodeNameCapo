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
import { randomUUID } from "node:crypto";
import { openSession, type Action, type SessionState } from "./engine.js";
import type { Store, Plan, SessionRecord, TurnRecord, DealRecord } from "./store/types.js";
import type { StripeGateway } from "./stripe/gateway.js";
import type { WebhookEvent } from "./stripe/gateway.js";
import type { Negotiator } from "./llm/negotiator.js";
import type { ChatTurn } from "./llm/types.js";
import { computeAnalytics } from "./analytics.js";
import { lintConfig, type LintResult } from "./lint.js";
import { buildRenegConfig, type RenegDirection, type RenegPlan } from "./reneg.js";

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
}

export interface CreateSessionInput {
  planId: string;
  endUserRef: string;
  channel?: string;
  context?: Record<string, unknown>;
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

  constructor(deps: ServiceDeps) {
    this.store = deps.store;
    this.stripe = deps.stripe;
    this.negotiator = deps.negotiator;
    this.baseUrl = deps.baseUrl.replace(/\/$/, "");
    this.now = deps.now ?? Date.now;
    const fee = deps.applicationFeePercent ?? 0;
    this.applicationFeePercent = Number.isFinite(fee) ? Math.max(0, Math.min(100, fee)) : 0;
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

    const history = await this.loadHistory(sessionId);

    // Anti-siege message cap (Spec §12): too many turns ends the session.
    const userTurns = history.filter((t) => t.role === "user").length;
    if (userTurns >= plan.policy.maxMessages) {
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
    if (r.accountId !== merchant.stripeConnectId) {
      await this.store.updateMerchant(merchantId, { stripeConnectId: r.accountId });
    }
    await this.store.appendEvent("connect.onboarding_started", { merchantId, accountId: r.accountId });
    return { url: r.url, accountId: r.accountId };
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

  /** Handle a normalized Stripe webhook event. Idempotent on re-delivery. */
  async handleStripeEvent(event: WebhookEvent): Promise<{ settled: boolean; dealId?: string }> {
    if (event.type !== "checkout.session.completed") return { settled: false };

    const deal = await this.store.getDealByCheckoutId(event.checkoutId);
    if (!deal) {
      await this.store.appendEvent("webhook.unmatched", { checkoutId: event.checkoutId });
      return { settled: false };
    }
    if (deal.status === "settled") return { settled: true, dealId: deal.id }; // idempotent

    await this.store.updateDeal(deal.id, {
      status: "settled",
      stripeSubscriptionId: event.subscriptionId,
      settledAt: this.now(),
    });
    await this.store.updateSession(deal.sessionId, { status: "settled" });
    await this.store.appendEvent("deal.settled", {
      dealId: deal.id,
      subscriptionId: event.subscriptionId,
      price: deal.price,
    });
    return { settled: true, dealId: deal.id };
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
      renegSessionId: null,
      settledAt: null,
    });

    // Connect (Spec §7): settle into the merchant's account when onboarded, and
    // take Bouncr's cut as an application fee on that direct charge (§ business
    // model). No connected account => settles to the platform, no fee.
    const merchant = await this.store.getMerchant(plan.merchantId);
    const connectedAccountId = merchant?.stripeConnectId ?? null;
    const checkout = await this.stripe.createCheckout({
      planKey: plan.planKey,
      productName: plan.persona.productName,
      amount,
      currency: plan.currency,
      endUserRef: session.endUserRef,
      dealId: deal.id,
      connectedAccountId,
      applicationFeePercent: connectedAccountId && this.feeFor(plan) > 0 ? this.feeFor(plan) : null,
      successUrl: `${this.baseUrl}/return?status=success&deal=${deal.id}`,
      cancelUrl: `${this.baseUrl}/return?status=cancel&deal=${deal.id}`,
    });

    await this.store.updateDeal(deal.id, { stripeCheckoutId: checkout.checkoutId });
    await this.store.appendEvent("deal.created", {
      dealId: deal.id,
      price: amount,
      checkoutId: checkout.checkoutId,
    });
    return { checkoutUrl: checkout.url, dealId: deal.id };
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

  private engineState(s: SessionRecord): SessionState {
    // history is not consulted by decide(); reconstruct the decision-relevant fields.
    return { round: s.round, currentAsk: s.currentAsk, openedAt: s.openedAt, history: [] };
  }

  private async loadHistory(sessionId: string): Promise<ChatTurn[]> {
    const turns = await this.store.listTurns(sessionId);
    return turns.map((t) => ({ role: t.role, text: t.rawText }));
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
