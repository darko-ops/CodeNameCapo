/**
 * Scan bouncr.plans for ladder violations: list_price > target_price > floor_price.
 *
 *   DATABASE_URL="postgres://…" npm run scan:plans
 *
 * Exits non-zero if any plan violates the ladder — wire into CI / pre-deploy so a
 * bad row is caught HERE, not discovered mid-negotiation (a target >= list plan
 * gives the piecewise concession curve a zero-width list→target zone → nonsense).
 *
 * The API write path already rejects such writes (lintConfig in src/lint.ts, on
 * both create and update). This catches rows inserted out-of-band (direct SQL),
 * which is how the two historical bad rows got there before the guard existed.
 *
 * SSL is required for hosted Postgres and disabled for localhost — matching
 * scripts/migrate.mjs and src/store/postgres.ts.
 */
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const isLocal = /localhost|127\.0\.0\.1/.test(url);
const sql = postgres(url, { ...(isLocal ? {} : { ssl: "require", prepare: false }), max: 1 });

try {
  const bad = await sql`
    select id,
      (config_jsonb->>'listPrice')::numeric   as list,
      (config_jsonb->>'targetPrice')::numeric as target,
      (config_jsonb->>'floorPrice')::numeric  as floor
    from bouncr.plans
    where not (
      (config_jsonb->>'listPrice')::numeric  > (config_jsonb->>'targetPrice')::numeric
      and (config_jsonb->>'targetPrice')::numeric > (config_jsonb->>'floorPrice')::numeric
    )
    order by id`;

  if (bad.length) {
    console.error(`✗ ${bad.length} plan(s) violate the ladder (list > target > floor):`);
    for (const r of bad) console.error(`    ${r.id}: list ${r.list}, target ${r.target}, floor ${r.floor}`);
    process.exitCode = 1;
  } else {
    const [{ count }] = await sql`select count(*)::int as count from bouncr.plans`;
    console.log(`✓ all ${count} plan(s) satisfy list > target > floor`);
  }
} catch (err) {
  console.error("scan failed:", err.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
