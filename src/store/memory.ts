/**
 * In-memory Store (Spec §8) — the sandbox default and the test double.
 * Deterministic, dependency-free, deep-copies on the boundary so callers can't
 * mutate stored records by reference.
 */
import { randomUUID } from "node:crypto";
import type {
  Store,
  Merchant,
  Plan,
  PlanUpdate,
  SessionRecord,
  TurnRecord,
  DealRecord,
  EventRecord,
  UsageCycle,
  NewSession,
  NewTurn,
  NewDeal,
  NewUsageCycle,
  SessionPatch,
  DealPatch,
} from "./types.js";

const clone = <T>(x: T): T => structuredClone(x);

export class MemoryStore implements Store {
  private merchants = new Map<string, Merchant>();
  private plans = new Map<string, Plan>();
  private sessions = new Map<string, SessionRecord>();
  private turns = new Map<string, TurnRecord[]>();
  private deals = new Map<string, DealRecord>();
  private usage = new Map<string, UsageCycle[]>(); // dealId -> cycles
  private events: EventRecord[] = [];
  private cooldowns = new Map<string, number>(); // `${planId}:${endUserRef}` -> until ms

  constructor(plans: Plan[] = [], merchants: Merchant[] = []) {
    for (const p of plans) this.plans.set(p.id, clone(p));
    for (const m of merchants) this.merchants.set(m.id, clone(m));
  }

  /** Test/inspection helper — not part of the Store interface. */
  allEvents(): EventRecord[] {
    return this.events.map(clone);
  }

  async getMerchant(id: string): Promise<Merchant | null> {
    const m = this.merchants.get(id);
    return m ? clone(m) : null;
  }

  async createMerchant(merchant: Merchant): Promise<Merchant> {
    if (this.merchants.has(merchant.id)) throw new Error(`merchant ${merchant.id} already exists`);
    this.merchants.set(merchant.id, clone(merchant));
    return clone(merchant);
  }

  async updateMerchant(id: string, patch: Partial<Pick<Merchant, "stripeConnectId" | "apiKeyHash">>): Promise<Merchant> {
    const m = this.merchants.get(id);
    if (!m) throw new Error(`merchant ${id} not found`);
    Object.assign(m, patch);
    return clone(m);
  }

  async getPlan(ref: string): Promise<Plan | null> {
    // Resolve by internal id OR public plan_key — the widget references the
    // friendly key (e.g. "pro_monthly"), internal callers pass the id. Active only.
    const p = this.plans.get(ref) ?? [...this.plans.values()].find((x) => x.planKey === ref);
    return p && p.active ? clone(p) : null;
  }

  async getPlanById(id: string): Promise<Plan | null> {
    const p = this.plans.get(id);
    return p ? clone(p) : null; // any active state — owner ops
  }

  async createPlan(plan: Plan): Promise<Plan> {
    if (this.plans.has(plan.id)) throw new Error(`plan ${plan.id} already exists`);
    this.plans.set(plan.id, clone(plan));
    return clone(plan);
  }

  async updatePlan(id: string, fields: PlanUpdate): Promise<Plan> {
    const p = this.plans.get(id);
    if (!p) throw new Error(`plan ${id} not found`);
    Object.assign(p, {
      config: clone(fields.config),
      persona: clone(fields.persona),
      currency: fields.currency,
      applicationFeePercent: fields.applicationFeePercent,
      active: fields.active,
      version: fields.version,
    });
    return clone(p);
  }

  async listPlansByMerchant(merchantId: string): Promise<Plan[]> {
    return [...this.plans.values()]
      .filter((p) => p.merchantId === merchantId)
      .sort((a, b) => Number(b.active) - Number(a.active) || a.id.localeCompare(b.id))
      .map(clone);
  }

  async createSession(rec: NewSession): Promise<SessionRecord> {
    const full: SessionRecord = { ...clone(rec), id: randomUUID(), createdAt: Date.now() };
    this.sessions.set(full.id, full);
    this.turns.set(full.id, []);
    return clone(full);
  }

  async getSession(id: string): Promise<SessionRecord | null> {
    const s = this.sessions.get(id);
    return s ? clone(s) : null;
  }

  async updateSession(id: string, patch: SessionPatch): Promise<SessionRecord> {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`session ${id} not found`);
    Object.assign(s, patch);
    return clone(s);
  }

  async addTurn(rec: NewTurn): Promise<TurnRecord> {
    const full: TurnRecord = { ...clone(rec), id: randomUUID(), createdAt: Date.now() };
    const list = this.turns.get(rec.sessionId) ?? [];
    list.push(full);
    this.turns.set(rec.sessionId, list);
    return clone(full);
  }

  async listTurns(sessionId: string): Promise<TurnRecord[]> {
    return (this.turns.get(sessionId) ?? []).map(clone);
  }

  async listSessionsByPlan(planId: string): Promise<SessionRecord[]> {
    return [...this.sessions.values()]
      .filter((s) => s.planId === planId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(clone);
  }

  async listTurnsByPlan(planId: string): Promise<TurnRecord[]> {
    const sessionIds = new Set(
      [...this.sessions.values()].filter((s) => s.planId === planId).map((s) => s.id),
    );
    const out: TurnRecord[] = [];
    for (const [sid, list] of this.turns) {
      if (sessionIds.has(sid)) out.push(...list.map(clone));
    }
    return out;
  }

  async listDealsByPlan(planId: string): Promise<DealRecord[]> {
    return [...this.deals.values()]
      .filter((d) => d.planId === planId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(clone);
  }

  async createDeal(rec: NewDeal): Promise<DealRecord> {
    const full: DealRecord = { ...clone(rec), id: randomUUID(), createdAt: Date.now() };
    this.deals.set(full.id, full);
    return clone(full);
  }

  async getDeal(id: string): Promise<DealRecord | null> {
    const d = this.deals.get(id);
    return d ? clone(d) : null;
  }

  async getDealByCheckoutId(checkoutId: string): Promise<DealRecord | null> {
    for (const d of this.deals.values()) {
      if (d.stripeCheckoutId === checkoutId) return clone(d);
    }
    return null;
  }

  async updateDeal(id: string, patch: DealPatch): Promise<DealRecord> {
    const d = this.deals.get(id);
    if (!d) throw new Error(`deal ${id} not found`);
    Object.assign(d, patch);
    return clone(d);
  }

  async addUsageCycle(rec: NewUsageCycle): Promise<UsageCycle> {
    const full: UsageCycle = { ...clone(rec), id: randomUUID(), createdAt: Date.now() };
    const list = this.usage.get(rec.dealId) ?? [];
    list.push(full);
    this.usage.set(rec.dealId, list);
    return clone(full);
  }

  async listUsageCycles(dealId: string): Promise<UsageCycle[]> {
    return (this.usage.get(dealId) ?? []).map(clone);
  }

  async appendEvent(type: string, payload: Record<string, unknown>): Promise<void> {
    this.events.push({ id: randomUUID(), type, payload: clone(payload), createdAt: Date.now() });
  }

  async setCooldown(planId: string, endUserRef: string, until: number): Promise<void> {
    this.cooldowns.set(`${planId}:${endUserRef}`, until);
  }

  async getCooldown(planId: string, endUserRef: string): Promise<number | null> {
    return this.cooldowns.get(`${planId}:${endUserRef}`) ?? null;
  }
}
