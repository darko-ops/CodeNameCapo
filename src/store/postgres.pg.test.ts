/**
 * PostgresStore against REAL Postgres. Gated on BOUNCR_TEST_DATABASE_URL — skips
 * when unset (so `npm test` stays DB-free) and runs in CI via a Postgres service
 * container. Proves the production datastore satisfies the SAME store contract as
 * MemoryStore, plus the money-critical guarantees that only real Postgres can show
 * (atomic single-use under genuine concurrency).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { PostgresStore } from "./postgres.js";
import { runStoreContract } from "./store-contract.js";
import { PG_TEST_URL, resetBouncrSchema } from "./pg-test-db.js";

(PG_TEST_URL ? describe : describe.skip)("PostgresStore — store contract + concurrency (real Postgres)", () => {
  let store: PostgresStore;

  beforeAll(async () => {
    await resetBouncrSchema(); // fresh schema from db/schema.sql
    store = new PostgresStore(PG_TEST_URL!);
  });
  afterAll(async () => {
    await store?.close();
  });

  // Equivalence with MemoryStore on the full contract (incl. proof single-use,
  // reneg sentinel, listTurnsByPlan join, JSONB round-trips, active-only getPlan).
  runStoreContract({ store: () => store });

  // --- Postgres-only money-critical guarantees (real isolation/concurrency) --

  it("redeemProof: 50-way concurrent burst on the same jti yields exactly one winner", async () => {
    const jti = `jti_${randomUUID()}`;
    const wins = (await Promise.all(Array.from({ length: 50 }, () => store.redeemProof(jti, "d", Date.now())))).filter(
      Boolean,
    ).length;
    expect(wins).toBe(1);
    expect(await store.isProofRedeemed(jti)).toBe(true);
  });

  it("redeemProof: distinct jtis under concurrency all succeed (no false contention)", async () => {
    const jtis = Array.from({ length: 10 }, () => `jti_${randomUUID()}`);
    const wins = (await Promise.all(jtis.map((j) => store.redeemProof(j, "d", Date.now())))).filter(Boolean).length;
    expect(wins).toBe(10);
  });
});
