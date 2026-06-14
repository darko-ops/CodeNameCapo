import { describe, beforeEach } from "vitest";
import { MemoryStore } from "./memory.js";
import { runStoreContract } from "./store-contract.js";

// MemoryStore runs the shared store contract on every push (no DB needed). The
// SAME contract runs against real Postgres in CI (postgres.pg.test.ts) so the two
// are proven equivalent — a divergence in a money-critical guarantee is a real bug.
describe("MemoryStore — store contract", () => {
  let store: MemoryStore;
  beforeEach(() => {
    store = new MemoryStore([], []);
  });
  runStoreContract({ store: () => store });
});
