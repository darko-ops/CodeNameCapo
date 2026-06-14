/**
 * Store contract — behavioral tests run against BOTH MemoryStore and (in CI)
 * PostgresStore, so the two are proven equivalent on the contracts that matter.
 * PostgresStore is the production datastore and source of truth on any divergence.
 *
 * Covers the full Store surface, with extra weight on the money-critical and
 * historically-tricky bits: proof single-use (incl. concurrency), the updateDeal
 * reneg-session-id clear sentinel, the listTurnsByPlan join, JSONB config
 * round-trips, and active-only plan resolution.
 */
import { it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import type { Store, Plan, Merchant, NewSession, NewDeal } from "./types.js";
import { demoPlan, demoMerchant } from "../config.js";

export interface StoreCtx {
  /** A live store for the current test (MemoryStore: fresh per test; Postgres: shared, isolated by unique ids). */
  store: () => Store;
}

export function runStoreContract(ctx: StoreCtx): void {
  const uniq = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;

  async function seed(store: Store): Promise<{ merchant: Merchant; plan: Plan }> {
    const merchant: Merchant = { ...demoMerchant(), id: uniq("m"), email: `${uniq("e")}@t.co` };
    await store.createMerchant(merchant);
    const plan: Plan = { ...demoPlan(), id: uniq("p"), merchantId: merchant.id, planKey: uniq("k") };
    await store.createPlan(plan);
    return { merchant, plan };
  }
  const newSession = (planId: string, over: Partial<NewSession> = {}): NewSession => ({
    planId,
    sessionToken: uniq("sst"),
    endUserRef: uniq("u"),
    channel: "web",
    round: 0,
    currentAsk: 48,
    openedAt: Date.now(),
    expiresAt: Date.now() + 3_600_000,
    status: "open",
    configVersion: 1,
    context: null,
    kind: "initial",
    renegDealId: null,
    configOverride: null,
    ...over,
  });
  const newDeal = (sessionId: string, merchantId: string, planId: string, over: Partial<NewDeal> = {}): NewDeal => ({
    sessionId,
    merchantId,
    planId,
    endUserRef: uniq("u"),
    price: 30,
    currency: "usd",
    status: "pending",
    kind: "initial",
    stripeCheckoutId: null,
    stripeSubscriptionId: null,
    renegSessionId: null,
    settledAt: null,
    ...over,
  });

  it("merchants: create, get by id, get by email (case-insensitive), coalesce-update + null-clear", async () => {
    const s = ctx.store();
    const m: Merchant = { ...demoMerchant(), id: uniq("m"), email: "Mixed@Case.CO" };
    await s.createMerchant(m);
    expect((await s.getMerchant(m.id))?.id).toBe(m.id);
    expect((await s.getMerchantByEmail("mixed@case.co"))?.id).toBe(m.id);
    const up = await s.updateMerchant(m.id, { stripeConnectId: "acct_x", webhookUrl: "https://w" });
    expect(up.stripeConnectId).toBe("acct_x");
    expect(up.webhookUrl).toBe("https://w");
    const cleared = await s.updateMerchant(m.id, { webhookUrl: null }); // null sentinel clears
    expect(cleared.webhookUrl ?? null).toBeNull();
    expect(cleared.stripeConnectId).toBe("acct_x"); // omitted → unchanged
  });

  it("plans: JSONB config/persona/policy/usage/discovery round-trip exactly; getPlan is active-only", async () => {
    const s = ctx.store();
    const { plan } = await seed(s);
    const got = await s.getPlanById(plan.id);
    expect(got!.config).toEqual(plan.config); // numbers survive JSONB
    expect(got!.persona).toEqual(plan.persona);
    expect(got!.policy).toEqual(plan.policy);
    expect(got!.usage).toEqual(plan.usage);
    expect(got!.discovery).toEqual(plan.discovery);
    expect((await s.getPlan(plan.planKey))?.id).toBe(plan.id); // resolves by public key
    await s.updatePlan(plan.id, {
      config: plan.config,
      persona: plan.persona,
      currency: plan.currency,
      applicationFeePercent: plan.applicationFeePercent ?? null,
      active: false,
      version: plan.version + 1,
      discovery: plan.discovery ?? null,
    });
    expect(await s.getPlan(plan.planKey)).toBeNull(); // inactive → not resolvable by getPlan
    expect((await s.getPlanById(plan.id))?.active).toBe(false); // ...but still by id (owner view)
  });

  it("sessions: create/get; updateSession patches ONLY provided fields", async () => {
    const s = ctx.store();
    const { plan } = await seed(s);
    const sess = await s.createSession(newSession(plan.id));
    expect((await s.getSession(sess.id))?.status).toBe("open");
    const up = await s.updateSession(sess.id, { round: 2, currentAsk: 40 });
    expect([up.round, up.currentAsk, up.status]).toEqual([2, 40, "open"]); // status untouched
    const up2 = await s.updateSession(sess.id, { status: "accepted" });
    expect([up2.status, up2.currentAsk]).toEqual(["accepted", 40]); // prior currentAsk preserved
  });

  it("turns: ordered listTurns; listTurnsByPlan JOINs across the plan's sessions; extracted JSONB round-trips", async () => {
    const s = ctx.store();
    const { plan } = await seed(s);
    const a = await s.createSession(newSession(plan.id));
    const b = await s.createSession(newSession(plan.id));
    await s.addTurn({ sessionId: a.id, role: "bouncer", rawText: "hi", extracted: null, action: null });
    await s.addTurn({
      sessionId: a.id,
      role: "user",
      rawText: "$20",
      extracted: { intent: "offer", offer_amount: 20, sentiment: "neutral", tactics: [], reasoning: "none" },
      action: null,
    });
    await s.addTurn({ sessionId: b.id, role: "user", rawText: "yo", extracted: null, action: null });
    const turnsA = await s.listTurns(a.id);
    expect(turnsA.length).toBe(2);
    expect(turnsA[0]!.rawText).toBe("hi"); // created_at order
    const all = await s.listTurnsByPlan(plan.id);
    expect(all.length).toBe(3); // joined across both sessions
    expect(all.find((t) => t.rawText === "$20")?.extracted?.offer_amount).toBe(20);
  });

  it("deals: create/get/getByCheckoutId; updateDeal reneg sentinel (null clears, omit leaves)", async () => {
    const s = ctx.store();
    const { merchant, plan } = await seed(s);
    const sess = await s.createSession(newSession(plan.id));
    const reneg = await s.createSession(newSession(plan.id));
    const deal = await s.createDeal(newDeal(sess.id, merchant.id, plan.id, { stripeCheckoutId: "cs_1", renegSessionId: reneg.id }));
    expect((await s.getDeal(deal.id))?.price).toBe(30);
    expect((await s.getDealByCheckoutId("cs_1"))?.id).toBe(deal.id);
    const u1 = await s.updateDeal(deal.id, { status: "settled", settledAt: Date.now() }); // omit renegSessionId
    expect(u1.status).toBe("settled");
    expect(u1.renegSessionId).toBe(reneg.id); // left unchanged
    const u2 = await s.updateDeal(deal.id, { renegSessionId: null }); // explicit null clears
    expect(u2.renegSessionId ?? null).toBeNull();
    expect(u2.status).toBe("settled"); // unchanged
    expect((await s.listDealsByPlan(plan.id)).some((d) => d.id === deal.id)).toBe(true);
  });

  it("usage cycles + events: ordered list, durable append", async () => {
    const s = ctx.store();
    const { merchant, plan } = await seed(s);
    const sess = await s.createSession(newSession(plan.id));
    const deal = await s.createDeal(newDeal(sess.id, merchant.id, plan.id));
    await s.addUsageCycle({ dealId: deal.id, cycleIndex: 1, usageValue: 100, bandCeiling: 1000, breach: false, breachStreak: 0 });
    await s.addUsageCycle({ dealId: deal.id, cycleIndex: 2, usageValue: 1200, bandCeiling: 1000, breach: true, breachStreak: 1 });
    const cycles = await s.listUsageCycles(deal.id);
    expect(cycles.map((c) => c.cycleIndex)).toEqual([1, 2]); // cycle_index order
    expect(cycles[1]!.breach).toBe(true);
    await s.appendEvent("test.event", { a: 1 }); // smoke: durable append doesn't throw
  });

  it("cooldown: upsert sets then overwrites; getCooldown reads back; unknown → null", async () => {
    const s = ctx.store();
    const { plan } = await seed(s);
    await s.setCooldown(plan.id, "abuser", 1000);
    expect(await s.getCooldown(plan.id, "abuser")).toBe(1000);
    await s.setCooldown(plan.id, "abuser", 2000); // on-conflict update
    expect(await s.getCooldown(plan.id, "abuser")).toBe(2000);
    expect(await s.getCooldown(plan.id, "nobody")).toBeNull();
  });

  it("proof redemption is SINGLE-USE: first burns it, second is refused", async () => {
    const s = ctx.store();
    const jti = uniq("jti");
    expect(await s.isProofRedeemed(jti)).toBe(false);
    expect(await s.redeemProof(jti, "deal_1", Date.now())).toBe(true);
    expect(await s.redeemProof(jti, "deal_2", Date.now())).toBe(false); // already spent
    expect(await s.isProofRedeemed(jti)).toBe(true);
  });

  it("proof redemption under CONCURRENCY: exactly ONE of N simultaneous redemptions wins", async () => {
    const s = ctx.store();
    const jti = uniq("jti");
    const results = await Promise.all(Array.from({ length: 20 }, () => s.redeemProof(jti, "d", Date.now())));
    expect(results.filter(Boolean).length).toBe(1); // the money-critical atomic guarantee
  });
}
