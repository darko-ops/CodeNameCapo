/**
 * Postgres Store (Spec §8) — the deployment path. Mirrors MemoryStore exactly;
 * schema in db/schema.sql. Uses postgres.js. Smoke-tested end-to-end against
 * Postgres 16.
 *
 * All tables live in a dedicated `bouncr` schema and are explicitly schema-
 * qualified in every query — so Bouncr is isolated from anything else in the
 * same database (e.g. Dromo's `public` tables) AND it works through a
 * transaction-mode pooler, where a session-level `search_path` wouldn't stick.
 *
 * Apply the schema with `npm run migrate` (db/schema.sql + db/seed.sql).
 */
import postgres from "postgres";
import type {
  Store,
  Merchant,
  Plan,
  PlanUpdate,
  NegotiationPolicy,
  UsagePolicy,
  SessionRecord,
  TurnRecord,
  DealRecord,
  UsageCycle,
  NewSession,
  NewTurn,
  NewDeal,
  NewUsageCycle,
  SessionPatch,
  DealPatch,
  SessionStatus,
  DealStatus,
  DealKind,
} from "./types.js";
import type { Config, Action } from "../engine.js";
import type { Persona, Extraction } from "../llm/types.js";

type Sql = ReturnType<typeof postgres>;

export class PostgresStore implements Store {
  private readonly sql: Sql;

  constructor(connectionString: string) {
    // Hosted Postgres (Neon/Supabase/Vercel PG) requires SSL; localhost doesn't.
    // Small pool — friendly to serverless where many instances each hold a pool.
    // `prepare: false` for hosted connections so we're compatible with a
    // transaction-mode pooler (Supabase :6543 / Neon pooler), which rejects the
    // named prepared statements postgres.js uses by default.
    const isLocal = /localhost|127\.0\.0\.1/.test(connectionString);
    this.sql = postgres(connectionString, {
      ...(isLocal ? {} : { ssl: "require" as const, prepare: false }),
      max: isLocal ? 10 : 3,
      idle_timeout: 20,
    });
  }

  async close(): Promise<void> {
    await this.sql.end();
  }

  async getMerchant(id: string): Promise<Merchant | null> {
    const rows = await this.sql`select * from bouncr.merchants where id = ${id} limit 1`;
    return rows[0] ? mapMerchant(rows[0]) : null;
  }

  async createMerchant(m: Merchant): Promise<Merchant> {
    const rows = await this.sql`
      insert into bouncr.merchants (id, name, email, stripe_connect_id, api_key_hash, created_at)
      values (${m.id}, ${m.name}, ${m.email}, ${m.stripeConnectId}, ${m.apiKeyHash}, ${m.createdAt})
      returning *`;
    return mapMerchant(rows[0]);
  }

  async updateMerchant(
    id: string,
    patch: Partial<Pick<Merchant, "stripeConnectId" | "apiKeyHash">>,
  ): Promise<Merchant> {
    const rows = await this.sql`
      update bouncr.merchants set
        stripe_connect_id = coalesce(${patch.stripeConnectId ?? null}, stripe_connect_id),
        api_key_hash      = coalesce(${patch.apiKeyHash ?? null}, api_key_hash)
      where id = ${id} returning *`;
    if (!rows[0]) throw new Error(`merchant ${id} not found`);
    return mapMerchant(rows[0]);
  }

  async deleteMerchant(id: string): Promise<void> {
    // FK-safe cascade, in one transaction: usage → deals → turns → sessions →
    // cooldowns → plans → merchant.
    await this.sql.begin(async (sql) => {
      await sql`delete from bouncr.usage_cycles where deal_id in (select id from bouncr.deals where merchant_id = ${id})`;
      await sql`delete from bouncr.deals where merchant_id = ${id}`;
      await sql`delete from bouncr.turns where session_id in (
        select s.id from bouncr.sessions s join bouncr.plans p on s.plan_id = p.id where p.merchant_id = ${id})`;
      await sql`delete from bouncr.sessions where plan_id in (select id from bouncr.plans where merchant_id = ${id})`;
      await sql`delete from bouncr.cooldowns where plan_id in (select id from bouncr.plans where merchant_id = ${id})`;
      await sql`delete from bouncr.plans where merchant_id = ${id}`;
      await sql`delete from bouncr.merchants where id = ${id}`;
    });
  }

  async getPlan(ref: string): Promise<Plan | null> {
    // Resolve by internal id OR public plan_key (widgets use the friendly key). Active only.
    const rows = await this.sql`
      select * from bouncr.plans where (id = ${ref} or plan_key = ${ref}) and active = true limit 1`;
    return rows[0] ? mapPlan(rows[0]) : null;
  }

  async getPlanById(id: string): Promise<Plan | null> {
    const rows = await this.sql`select * from bouncr.plans where id = ${id} limit 1`;
    return rows[0] ? mapPlan(rows[0]) : null;
  }

  async createPlan(p: Plan): Promise<Plan> {
    const rows = await this.sql`
      insert into bouncr.plans
        (id, merchant_id, plan_key, currency, config_jsonb, persona_jsonb, policy_jsonb, usage_jsonb,
         version, active, application_fee_percent)
      values
        (${p.id}, ${p.merchantId}, ${p.planKey}, ${p.currency},
         ${this.sql.json(p.config as any)}, ${this.sql.json(p.persona as any)},
         ${this.sql.json(p.policy as any)}, ${this.sql.json(p.usage as any)},
         ${p.version}, ${p.active}, ${p.applicationFeePercent ?? null})
      returning *`;
    return mapPlan(rows[0]);
  }

  async updatePlan(id: string, f: PlanUpdate): Promise<Plan> {
    const rows = await this.sql`
      update bouncr.plans set
        config_jsonb            = ${this.sql.json(f.config as any)},
        persona_jsonb           = ${this.sql.json(f.persona as any)},
        currency                = ${f.currency},
        application_fee_percent = ${f.applicationFeePercent},
        active                  = ${f.active},
        version                 = ${f.version}
      where id = ${id} returning *`;
    if (!rows[0]) throw new Error(`plan ${id} not found`);
    return mapPlan(rows[0]);
  }

  async listPlansByMerchant(merchantId: string): Promise<Plan[]> {
    const rows = await this.sql`
      select * from bouncr.plans where merchant_id = ${merchantId} order by active desc, id`;
    return rows.map(mapPlan);
  }

  async createSession(rec: NewSession): Promise<SessionRecord> {
    const now = Date.now();
    const rows = await this.sql`
      insert into bouncr.sessions
        (plan_id, session_token, end_user_ref, channel, round, current_ask, opened_at, expires_at,
         status, config_version, context, kind, reneg_deal_id, config_override, created_at)
      values
        (${rec.planId}, ${rec.sessionToken}, ${rec.endUserRef}, ${rec.channel}, ${rec.round},
         ${rec.currentAsk}, ${rec.openedAt}, ${rec.expiresAt}, ${rec.status}, ${rec.configVersion},
         ${rec.context ? this.sql.json(rec.context as any) : null}, ${rec.kind}, ${rec.renegDealId},
         ${rec.configOverride ? this.sql.json(rec.configOverride as any) : null}, ${now})
      returning *`;
    return this.toSession(rows[0]!);
  }

  async getSession(id: string): Promise<SessionRecord | null> {
    const rows = await this.sql`select * from bouncr.sessions where id = ${id} limit 1`;
    return rows[0] ? this.toSession(rows[0]) : null;
  }

  async updateSession(id: string, patch: SessionPatch): Promise<SessionRecord> {
    const rows = await this.sql`
      update bouncr.sessions set
        round = coalesce(${patch.round ?? null}, round),
        current_ask = coalesce(${patch.currentAsk ?? null}, current_ask),
        status = coalesce(${patch.status ?? null}, status)
      where id = ${id}
      returning *`;
    if (!rows[0]) throw new Error(`session ${id} not found`);
    return this.toSession(rows[0]);
  }

  async addTurn(rec: NewTurn): Promise<TurnRecord> {
    const now = Date.now();
    const rows = await this.sql`
      insert into bouncr.turns (session_id, role, raw_text, extracted, action, created_at)
      values (${rec.sessionId}, ${rec.role}, ${rec.rawText},
              ${rec.extracted ? this.sql.json(rec.extracted) : null},
              ${rec.action ? this.sql.json(rec.action) : null}, ${now})
      returning *`;
    return this.toTurn(rows[0]!);
  }

  async listTurns(sessionId: string): Promise<TurnRecord[]> {
    const rows = await this.sql`
      select * from bouncr.turns where session_id = ${sessionId} order by created_at asc`;
    return rows.map((r) => this.toTurn(r));
  }

  async listSessionsByPlan(planId: string): Promise<SessionRecord[]> {
    const rows = await this.sql`
      select * from bouncr.sessions where plan_id = ${planId} order by created_at desc`;
    return rows.map((r) => this.toSession(r));
  }

  async listTurnsByPlan(planId: string): Promise<TurnRecord[]> {
    const rows = await this.sql`
      select t.* from bouncr.turns t join bouncr.sessions s on s.id = t.session_id
      where s.plan_id = ${planId} order by t.created_at asc`;
    return rows.map((r) => this.toTurn(r));
  }

  async listDealsByPlan(planId: string): Promise<DealRecord[]> {
    const rows = await this.sql`
      select * from bouncr.deals where plan_id = ${planId} order by created_at desc`;
    return rows.map((r) => this.toDeal(r));
  }

  async createDeal(rec: NewDeal): Promise<DealRecord> {
    const now = Date.now();
    const rows = await this.sql`
      insert into bouncr.deals
        (session_id, merchant_id, plan_id, end_user_ref, price, currency, status, kind,
         stripe_checkout_id, stripe_subscription_id, reneg_session_id, created_at, settled_at)
      values
        (${rec.sessionId}, ${rec.merchantId}, ${rec.planId}, ${rec.endUserRef}, ${rec.price},
         ${rec.currency}, ${rec.status}, ${rec.kind}, ${rec.stripeCheckoutId},
         ${rec.stripeSubscriptionId}, ${rec.renegSessionId}, ${now}, ${rec.settledAt})
      returning *`;
    return this.toDeal(rows[0]!);
  }

  async getDeal(id: string): Promise<DealRecord | null> {
    const rows = await this.sql`select * from bouncr.deals where id = ${id} limit 1`;
    return rows[0] ? this.toDeal(rows[0]) : null;
  }

  async getDealByCheckoutId(checkoutId: string): Promise<DealRecord | null> {
    const rows = await this.sql`select * from bouncr.deals where stripe_checkout_id = ${checkoutId} limit 1`;
    return rows[0] ? this.toDeal(rows[0]) : null;
  }

  async updateDeal(id: string, patch: DealPatch): Promise<DealRecord> {
    // reneg_session_id is nullable-on-purpose (cleared after settle), so use a
    // sentinel to distinguish "set to null" from "leave unchanged".
    const clearReneg = patch.renegSessionId === null;
    const rows = await this.sql`
      update bouncr.deals set
        status = coalesce(${patch.status ?? null}, status),
        price = coalesce(${patch.price ?? null}, price),
        stripe_checkout_id = coalesce(${patch.stripeCheckoutId ?? null}, stripe_checkout_id),
        stripe_subscription_id = coalesce(${patch.stripeSubscriptionId ?? null}, stripe_subscription_id),
        reneg_session_id = ${clearReneg ? null : this.sql`coalesce(${patch.renegSessionId ?? null}, reneg_session_id)`},
        settled_at = coalesce(${patch.settledAt ?? null}, settled_at)
      where id = ${id}
      returning *`;
    if (!rows[0]) throw new Error(`deal ${id} not found`);
    return this.toDeal(rows[0]);
  }

  async addUsageCycle(rec: NewUsageCycle): Promise<UsageCycle> {
    const now = Date.now();
    const rows = await this.sql`
      insert into bouncr.usage_cycles (deal_id, cycle_index, usage_value, band_ceiling, breach, breach_streak, created_at)
      values (${rec.dealId}, ${rec.cycleIndex}, ${rec.usageValue}, ${rec.bandCeiling}, ${rec.breach}, ${rec.breachStreak}, ${now})
      returning *`;
    return this.toUsage(rows[0]!);
  }

  async listUsageCycles(dealId: string): Promise<UsageCycle[]> {
    const rows = await this.sql`select * from bouncr.usage_cycles where deal_id = ${dealId} order by cycle_index asc`;
    return rows.map((r) => this.toUsage(r));
  }

  async appendEvent(type: string, payload: Record<string, unknown>): Promise<void> {
    await this.sql`
      insert into bouncr.events (type, payload, created_at)
      values (${type}, ${this.sql.json(payload as any)}, ${Date.now()})`;
  }

  async setCooldown(planId: string, endUserRef: string, until: number): Promise<void> {
    await this.sql`
      insert into bouncr.cooldowns (plan_id, end_user_ref, until_ms)
      values (${planId}, ${endUserRef}, ${until})
      on conflict (plan_id, end_user_ref) do update set until_ms = excluded.until_ms`;
  }

  async getCooldown(planId: string, endUserRef: string): Promise<number | null> {
    const rows = await this.sql`
      select until_ms from bouncr.cooldowns where plan_id = ${planId} and end_user_ref = ${endUserRef} limit 1`;
    return rows[0] ? Number(rows[0].until_ms) : null;
  }

  // --- row mappers (numeric comes back as string in postgres.js) ------------

  private toSession(r: any): SessionRecord {
    return {
      id: r.id,
      planId: r.plan_id,
      sessionToken: r.session_token,
      endUserRef: r.end_user_ref,
      channel: r.channel,
      round: Number(r.round),
      currentAsk: Number(r.current_ask),
      openedAt: Number(r.opened_at),
      expiresAt: Number(r.expires_at),
      status: r.status as SessionStatus,
      configVersion: Number(r.config_version),
      context: r.context ?? null,
      kind: (r.kind ?? "initial") as DealKind,
      renegDealId: r.reneg_deal_id ?? null,
      configOverride: (r.config_override ?? null) as Config | null,
      createdAt: Number(r.created_at),
    };
  }

  private toTurn(r: any): TurnRecord {
    return {
      id: r.id,
      sessionId: r.session_id,
      role: r.role,
      rawText: r.raw_text,
      extracted: (r.extracted ?? null) as Extraction | null,
      action: (r.action ?? null) as Action | null,
      createdAt: Number(r.created_at),
    };
  }

  private toDeal(r: any): DealRecord {
    return {
      id: r.id,
      sessionId: r.session_id,
      merchantId: r.merchant_id,
      planId: r.plan_id,
      endUserRef: r.end_user_ref,
      price: Number(r.price),
      currency: r.currency,
      status: r.status as DealStatus,
      kind: r.kind as DealKind,
      stripeCheckoutId: r.stripe_checkout_id ?? null,
      stripeSubscriptionId: r.stripe_subscription_id ?? null,
      renegSessionId: r.reneg_session_id ?? null,
      createdAt: Number(r.created_at),
      settledAt: r.settled_at === null ? null : Number(r.settled_at),
    };
  }

  private toUsage(r: any): UsageCycle {
    return {
      id: r.id,
      dealId: r.deal_id,
      cycleIndex: Number(r.cycle_index),
      usageValue: Number(r.usage_value),
      bandCeiling: Number(r.band_ceiling),
      breach: r.breach,
      breachStreak: Number(r.breach_streak),
      createdAt: Number(r.created_at),
    };
  }
}

// --- row mappers -----------------------------------------------------------

function mapMerchant(r: any): Merchant {
  return {
    id: r.id,
    name: r.name,
    email: r.email ?? null,
    stripeConnectId: r.stripe_connect_id ?? null,
    apiKeyHash: r.api_key_hash ?? null,
    createdAt: Number(r.created_at),
  };
}

function mapPlan(r: any): Plan {
  return {
    id: r.id,
    merchantId: r.merchant_id,
    planKey: r.plan_key,
    currency: r.currency,
    config: r.config_jsonb as Config,
    persona: r.persona_jsonb as Persona,
    policy: r.policy_jsonb as NegotiationPolicy,
    usage: r.usage_jsonb as UsagePolicy,
    version: r.version,
    active: r.active,
    applicationFeePercent: r.application_fee_percent == null ? null : Number(r.application_fee_percent),
  };
}
