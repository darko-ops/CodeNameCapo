/**
 * Persistence layer (Spec §8). Records + the Store interface. Two implementations:
 *   - memory.ts   — in-memory; the sandbox default and what the tests exercise
 *   - postgres.ts — postgres.js; the deployment path (schema in db/schema.sql)
 *
 * The records mirror the §8 tables but only what Phase 1 needs to settle money:
 * merchants, plans, sessions, turns, deals, events. usage_cycles (renegotiation)
 * is Phase 4.
 */
import type { Config } from "../engine.js";
import type { Persona, Extraction } from "../llm/types.js";
import type { Action } from "../engine.js";

export type SessionStatus = "open" | "accepted" | "walked" | "expired" | "settled";
export type DealStatus = "pending" | "settled" | "canceled";
export type DealKind = "initial" | "reneg_up" | "reneg_down";

/** A merchant. Deals settle into their Stripe account once Connect-onboarded (§7). */
export interface Merchant {
  id: string;
  name: string;
  /** Email — the login identifier for the dashboard (unique). */
  email: string | null;
  /** scrypt hash of the dashboard password (`scrypt$salt$hash`), or null. */
  passwordHash: string | null;
  /** Connected Stripe account id (acct_...), or null until onboarding completes. */
  stripeConnectId: string | null;
  /** SHA-256 of the merchant's programmatic API key (agents / MCP), or null. */
  apiKeyHash: string | null;
  createdAt: number;
}

/** Abuse-resistance / lifecycle policy (Spec §12), separate from pricing. */
export interface NegotiationPolicy {
  /** Hours a walked-away user must wait before a fresh session on this plan. */
  cooldownHours: number;
  /** Hard cap on user messages per session (anti-siege; default ~30). */
  maxMessages: number;
}

/** Usage-band / renegotiation policy (Spec §4.1, §6). */
export interface UsagePolicy {
  /** Per-cycle usage ceiling — the deal's tripwire (not a cap). */
  bandCeiling: number;
  /** Consecutive breaches required before reopening the deal (default 3). */
  breachCyclesRequired: number;
  /** $ COGS per usage unit — feeds the recalculated cost floor at reneg time. */
  costPerUnit: number;
  /** Cost-plus margin: reneg floor = trailing COGS × this. */
  costPlusMargin: number;
  /** Opening reneg ask = current price × this (1.5–2.0). */
  renegAnchorMultiplier: number;
  /** Downward renegotiation (proactively offer a lower price) — off by default (§6.3). */
  downwardEnabled: boolean;
  /** Usage below ratio × ceiling for `downwardMinCycles` triggers a downward offer. */
  downwardFloorRatio: number;
  downwardMinCycles: number;
}

/** A merchant plan: the engine config + persona a negotiation runs under. */
export interface Plan {
  id: string;
  merchantId: string;
  /** Public key the widget references, e.g. "pro_monthly". */
  planKey: string;
  currency: string;
  config: Config;
  persona: Persona;
  policy: NegotiationPolicy;
  usage: UsagePolicy;
  /** Versioned (Spec §8): a deal records the config version it closed under. */
  version: number;
  active: boolean;
  /**
   * Per-plan Bouncr take-rate (% of each settled invoice, 0–100). Overrides the
   * platform default when set; null/undefined falls back to it. Lets pricing
   * tiers carry different rates (e.g. Self-serve 20% vs Growth 15%).
   */
  applicationFeePercent?: number | null;
}

/** The mutable subset of a Plan, replaced wholesale on edit (Spec §8 versioning). */
export interface PlanUpdate {
  config: Config;
  persona: Persona;
  currency: string;
  applicationFeePercent: number | null;
  active: boolean;
  version: number;
}

export interface SessionRecord {
  id: string;
  planId: string;
  /**
   * Widget-facing bearer token (Spec §9). Scoped to this one session and
   * naturally short-lived (it dies with the session), so it can be handed to a
   * browser without exposing the merchant's API key.
   */
  sessionToken: string;
  /** The merchant's opaque user id — Bouncr holds minimal PII (Spec §8). */
  endUserRef: string;
  channel: string;
  // Engine state is reconstructable from these three (history isn't needed to decide):
  round: number;
  currentAsk: number;
  openedAt: number; // epoch ms
  expiresAt: number; // epoch ms
  status: SessionStatus;
  configVersion: number;
  context: Record<string, unknown> | null;
  /** initial cold-start, or a renegotiation (Spec §6). */
  kind: DealKind;
  /** For reneg sessions: the original settled deal being renegotiated. */
  renegDealId: string | null;
  /** Reneg pricing config (anchor/target/floor recomputed); null → use plan.config. */
  configOverride: Config | null;
  createdAt: number;
}

export interface TurnRecord {
  id: string;
  sessionId: string;
  role: "user" | "bouncer";
  rawText: string;
  /** Extractor output (user turns) — the WTP analytics raw material. */
  extracted: Extraction | null;
  /** Full policy-engine action snapshot (bouncer turns) — replay/audit (Spec §4.4.5). */
  action: Action | null;
  createdAt: number;
}

export interface DealRecord {
  id: string;
  sessionId: string;
  merchantId: string;
  planId: string;
  endUserRef: string;
  price: number;
  currency: string;
  status: DealStatus;
  kind: DealKind;
  stripeCheckoutId: string | null;
  stripeSubscriptionId: string | null;
  /** An open renegotiation session for this deal, if any (prevents duplicates). */
  renegSessionId: string | null;
  createdAt: number;
  settledAt: number | null;
}

/** One billing cycle's usage reading for a deal (Spec §6.1, §8 usage_cycles). */
export interface UsageCycle {
  id: string;
  dealId: string;
  cycleIndex: number;
  usageValue: number;
  bandCeiling: number;
  breach: boolean;
  breachStreak: number;
  createdAt: number;
}

export interface EventRecord {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: number;
}

/** Patch shapes (only the mutable fields). */
export type SessionPatch = Partial<
  Pick<SessionRecord, "round" | "currentAsk" | "status">
>;
export type DealPatch = Partial<
  Pick<DealRecord, "status" | "stripeCheckoutId" | "stripeSubscriptionId" | "settledAt" | "price" | "renegSessionId">
>;

/** New-record inputs (the store assigns id + createdAt). */
export type NewSession = Omit<SessionRecord, "id" | "createdAt">;
export type NewTurn = Omit<TurnRecord, "id" | "createdAt">;
export type NewDeal = Omit<DealRecord, "id" | "createdAt">;
export type NewUsageCycle = Omit<UsageCycle, "id" | "createdAt">;

export interface Store {
  getMerchant(id: string): Promise<Merchant | null>;
  /** Resolve a merchant by email (login lookup), case-insensitive. */
  getMerchantByEmail(email: string): Promise<Merchant | null>;
  createMerchant(merchant: Merchant): Promise<Merchant>;
  updateMerchant(id: string, patch: Partial<Pick<Merchant, "stripeConnectId" | "apiKeyHash" | "passwordHash">>): Promise<Merchant>;
  /** Permanently delete a merchant and everything under it (cascade). */
  deleteMerchant(id: string): Promise<void>;

  /** Resolve a plan for negotiation: by id OR public plan_key, ACTIVE only. */
  getPlan(planId: string): Promise<Plan | null>;
  /** Resolve a plan by id for owner/admin ops, regardless of active state. */
  getPlanById(id: string): Promise<Plan | null>;
  createPlan(plan: Plan): Promise<Plan>;
  /** Replace a plan's mutable fields (config, persona, fee, currency, active, version). */
  updatePlan(id: string, fields: PlanUpdate): Promise<Plan>;
  /** All plans owned by a merchant — active AND inactive (dashboard manages both). */
  listPlansByMerchant(merchantId: string): Promise<Plan[]>;

  createSession(rec: NewSession): Promise<SessionRecord>;
  getSession(id: string): Promise<SessionRecord | null>;
  updateSession(id: string, patch: SessionPatch): Promise<SessionRecord>;
  /** All sessions for a plan, newest first — analytics (§11). */
  listSessionsByPlan(planId: string): Promise<SessionRecord[]>;

  addTurn(rec: NewTurn): Promise<TurnRecord>;
  listTurns(sessionId: string): Promise<TurnRecord[]>;
  /** All turns across a plan's sessions — tactic frequency / offer distribution. */
  listTurnsByPlan(planId: string): Promise<TurnRecord[]>;

  createDeal(rec: NewDeal): Promise<DealRecord>;
  getDeal(id: string): Promise<DealRecord | null>;
  getDealByCheckoutId(checkoutId: string): Promise<DealRecord | null>;
  updateDeal(id: string, patch: DealPatch): Promise<DealRecord>;
  listDealsByPlan(planId: string): Promise<DealRecord[]>;

  addUsageCycle(rec: NewUsageCycle): Promise<UsageCycle>;
  listUsageCycles(dealId: string): Promise<UsageCycle[]>;

  appendEvent(type: string, payload: Record<string, unknown>): Promise<void>;

  /** Per-(plan, end_user_ref) walkaway cooldown (Spec §12). Stores the expiry ms. */
  setCooldown(planId: string, endUserRef: string, until: number): Promise<void>;
  /** The cooldown expiry ms for this user+plan, or null if none. */
  getCooldown(planId: string, endUserRef: string): Promise<number | null>;
}
