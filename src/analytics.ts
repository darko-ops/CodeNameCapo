/**
 * WTP analytics (Spec §11) — the retention product. Computes the dashboard's
 * numbers from persisted sessions/turns/deals:
 *   - funnel: sessions → engaged → accepted → settled (+ walk rate by round)
 *   - offer distribution: every first offer and every closing price vs list/target/floor
 *   - rounds-to-close, median negotiated price, revenue vs list-price counterfactual
 *   - tactic frequency (lowball %, competitor mentions, sob stories…)
 *
 * Pure over the store reads — no LLM, fully testable on MemoryStore.
 */
import type { Store, Plan, TurnRecord } from "./store/types.js";

export interface Analytics {
  planId: string;
  currency: string;
  reference: { list: number; target: number; floor: number; anchor: number };
  funnel: {
    sessions: number;
    engaged: number; // ≥1 user message
    accepted: number; // engine said accept (accepted or settled)
    settled: number; // money actually moved
    walkByRound: Record<number, number>;
  };
  offers: {
    firstOffers: number[]; // each session's first numeric offer
    closingPrices: number[]; // each settled/accepted deal price
  };
  closing: {
    avgRoundsToClose: number | null;
    medianPrice: number | null;
    revenue: number; // sum of settled deal prices
    listCounterfactual: number; // settled count × list price
    upliftPct: number | null; // not really uplift — list capture %, signed
  };
  /** Bouncr's cut — the effective take-rate and what it yields on settled revenue.
   *  Filled by the service (it knows the platform default behind a plan override). */
  monetization?: {
    takeRatePercent: number; // effective Connect application fee % for this plan
    bouncrFee: number; // revenue × takeRate
    merchantNet: number; // revenue − bouncrFee
  };
  tactics: Record<string, number>; // rate in [0,1] across user turns
  /** Renegotiation analytics (Spec §6.4) — repricing tolerance over time. */
  reneg: {
    opened: number;
    up: number;
    down: number;
    accepted: number; // negotiated to a new price
    grandfathered: number; // walked, moved to the fair tier instead
    avgUpliftPct: number | null; // avg (new−old)/old across reneg_up closes
  };
}

export async function computeAnalytics(store: Store, plan: Plan): Promise<Analytics> {
  const [sessions, turns, deals] = await Promise.all([
    store.listSessionsByPlan(plan.id),
    store.listTurnsByPlan(plan.id),
    store.listDealsByPlan(plan.id),
  ]);

  const anchor = round2(plan.config.listPrice * plan.config.anchorMultiplier);
  const bySession = groupBy(turns, (t) => t.sessionId);

  // --- funnel --------------------------------------------------------------
  let engaged = 0;
  const walkByRound: Record<number, number> = {};
  for (const s of sessions) {
    const ts = bySession.get(s.id) ?? [];
    if (ts.some((t) => t.role === "user")) engaged++;
    if (s.status === "walked") walkByRound[s.round] = (walkByRound[s.round] ?? 0) + 1;
  }
  const accepted = sessions.filter((s) => s.status === "accepted" || s.status === "settled").length;
  const settledDeals = deals.filter((d) => d.status === "settled");
  const settled = settledDeals.length;

  // --- offer distribution --------------------------------------------------
  const firstOffers: number[] = [];
  for (const [, ts] of bySession) {
    const first = ts
      .filter((t) => t.role === "user" && t.extracted && t.extracted.offer_amount !== null)
      .sort((a, b) => a.createdAt - b.createdAt)[0];
    if (first?.extracted?.offer_amount != null) firstOffers.push(first.extracted.offer_amount);
  }
  // Closing prices: prefer settled, else any non-canceled deal (pending counts as a close).
  const closedDeals = deals.filter((d) => d.status !== "canceled");
  const closingPrices = closedDeals.map((d) => d.price);

  // --- closing stats -------------------------------------------------------
  const acceptedSessions = sessions.filter((s) => s.status === "accepted" || s.status === "settled");
  const avgRoundsToClose = acceptedSessions.length
    ? round2(acceptedSessions.reduce((a, s) => a + s.round, 0) / acceptedSessions.length)
    : null;
  const medianPrice = median(closingPrices);
  const revenue = round2(settledDeals.reduce((a, d) => a + d.price, 0));
  const listCounterfactual = round2(settled * plan.config.listPrice);
  const upliftPct =
    listCounterfactual > 0 ? round2(((revenue - listCounterfactual) / listCounterfactual) * 100) : null;

  // --- renegotiation (§6.4) -------------------------------------------------
  const dealById = new Map(deals.map((d) => [d.id, d]));
  const settledBySession = new Map(deals.filter((d) => d.status === "settled").map((d) => [d.sessionId, d]));
  const renegSessions = sessions.filter((s) => s.kind === "reneg_up" || s.kind === "reneg_down");
  const uplifts: number[] = [];
  let renegAccepted = 0;
  let grandfathered = 0;
  for (const s of renegSessions) {
    const newDeal = settledBySession.get(s.id);
    if (s.status === "settled") renegAccepted++;
    else if (s.status === "walked" && newDeal) grandfathered++;
    const oldDeal = s.renegDealId ? dealById.get(s.renegDealId) : undefined;
    if (s.kind === "reneg_up" && newDeal && oldDeal && oldDeal.price > 0) {
      uplifts.push((newDeal.price - oldDeal.price) / oldDeal.price);
    }
  }
  const avgUpliftPct = uplifts.length
    ? round2((uplifts.reduce((a, b) => a + b, 0) / uplifts.length) * 100)
    : null;

  return {
    planId: plan.id,
    currency: plan.currency,
    reference: { list: plan.config.listPrice, target: plan.config.targetPrice, floor: plan.config.floorPrice, anchor },
    funnel: { sessions: sessions.length, engaged, accepted, settled, walkByRound },
    offers: { firstOffers, closingPrices },
    closing: { avgRoundsToClose, medianPrice, revenue, listCounterfactual, upliftPct },
    tactics: tacticRates(turns),
    reneg: {
      opened: renegSessions.length,
      up: renegSessions.filter((s) => s.kind === "reneg_up").length,
      down: renegSessions.filter((s) => s.kind === "reneg_down").length,
      accepted: renegAccepted,
      grandfathered,
      avgUpliftPct,
    },
  };
}

function tacticRates(turns: TurnRecord[]): Record<string, number> {
  const userTurns = turns.filter((t) => t.role === "user" && t.extracted);
  const total = userTurns.length || 1;
  const counts: Record<string, number> = {};
  for (const t of userTurns) {
    for (const tac of t.extracted!.tactics) counts[tac] = (counts[tac] ?? 0) + 1;
  }
  const rates: Record<string, number> = {};
  for (const [k, v] of Object.entries(counts)) rates[k] = round2(v / total);
  return rates;
}

// --- helpers ---------------------------------------------------------------

function groupBy<T, K>(xs: T[], key: (x: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const x of xs) {
    const k = key(x);
    const list = m.get(k);
    if (list) list.push(x);
    else m.set(k, [x]);
  }
  return m;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : round2((s[mid - 1]! + s[mid]!) / 2);
}

const round2 = (x: number) => Math.round((x + Number.EPSILON) * 100) / 100;
