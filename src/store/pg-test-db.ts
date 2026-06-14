/**
 * Disposable Postgres test harness. Resets the `bouncr` schema FRESH from
 * db/schema.sql so PostgresStore tests run against real Postgres semantics
 * (isolation, atomic upserts) — the money-critical guarantees that an in-memory
 * Map can't prove.
 *
 * Gated on BOUNCR_TEST_DATABASE_URL (a DEDICATED throwaway DB — a CI service
 * container, or a local/branch scratch DB). When unset, the PostgresStore suite
 * skips, so the default `npm test` stays DB-free. CI runs it via a Postgres
 * service container (see .github/workflows/ci.yml).
 */
import postgres from "postgres";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/** The dedicated test DB URL, or undefined (→ PostgresStore suite skips). */
export const PG_TEST_URL = process.env.BOUNCR_TEST_DATABASE_URL;

/** Connection opts mirroring src/store/postgres.ts (SSL for hosted, not localhost). */
function opts(url: string) {
  const isLocal = /localhost|127\.0\.0\.1/.test(url);
  return { ...(isLocal ? {} : { ssl: "require" as const, prepare: false }), max: 1 };
}

/**
 * Drop + recreate the `bouncr` schema from db/schema.sql. Refuses to touch the
 * production database (BOUNCR_TEST_DATABASE_URL must differ from DATABASE_URL) —
 * this is destructive by design and must only ever hit a throwaway DB.
 */
export async function resetBouncrSchema(): Promise<void> {
  if (!PG_TEST_URL) throw new Error("BOUNCR_TEST_DATABASE_URL is not set");
  if (process.env.DATABASE_URL && PG_TEST_URL === process.env.DATABASE_URL) {
    throw new Error("BOUNCR_TEST_DATABASE_URL must NOT equal DATABASE_URL — refusing to reset the production DB");
  }
  const sql = postgres(PG_TEST_URL, opts(PG_TEST_URL));
  try {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const schema = readFileSync(join(root, "db", "schema.sql"), "utf8");
    await sql.unsafe("drop schema if exists bouncr cascade;");
    await sql.unsafe(schema); // recreates the schema + every table fresh
  } finally {
    await sql.end();
  }
}
