/**
 * Apply db/seed.sql to DATABASE_URL — the demo merchant + plan (DATA, not schema).
 * Idempotent. Schema is applied separately via `npm run migrate` (node-pg-migrate);
 * this only seeds the shipped demo so a fresh deploy has something to negotiate.
 *
 *   DATABASE_URL="postgres://…" npm run seed
 *
 * SSL is required for hosted Postgres and disabled for localhost (matches
 * src/store/postgres.ts).
 */
import postgres from "postgres";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
const isLocal = /localhost|127\.0\.0\.1/.test(url);
const sql = postgres(url, { ...(isLocal ? {} : { ssl: "require", prepare: false }), max: 1 });

try {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  console.log(`applying seed.sql${isLocal ? "" : " (ssl)"} …`);
  await sql.unsafe(readFileSync(join(root, "db", "seed.sql"), "utf8"));
  const [{ count }] = await sql`select count(*)::int as count from bouncr.plans`;
  console.log(`seed done — ${count} plan(s) in schema "bouncr".`);
} catch (err) {
  console.error("seed failed:", err.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
