/**
 * Apply db/schema.sql + db/seed.sql to DATABASE_URL. Idempotent.
 *
 *   DATABASE_URL="postgres://…" npm run migrate
 *
 * SSL is required for hosted Postgres (Neon/Supabase/Vercel PG) and disabled for
 * localhost — matching src/store/postgres.ts.
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

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const isLocal = /localhost|127\.0\.0\.1/.test(url);
const sql = postgres(url, { ...(isLocal ? {} : { ssl: "require" }), max: 1 });

try {
  console.log(`applying schema.sql${isLocal ? "" : " (ssl)"} …`);
  await sql.unsafe(readFileSync(join(root, "db", "schema.sql"), "utf8"));
  console.log("applying seed.sql …");
  await sql.unsafe(readFileSync(join(root, "db", "seed.sql"), "utf8"));
  const [{ count: plans }] = await sql`select count(*)::int as count from plans`;
  const [{ count: merchants }] = await sql`select count(*)::int as count from merchants`;
  console.log(`done — ${plans} plan(s), ${merchants} merchant(s).`);
} catch (err) {
  console.error("migration failed:", err.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
