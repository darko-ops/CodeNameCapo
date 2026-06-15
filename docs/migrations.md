# Database migrations

Versioned, forward-only schema migrations via **[node-pg-migrate](https://github.com/salsita/node-pg-migrate)** — chosen because the stack is raw `postgres.js` (no ORM), and node-pg-migrate is the idiomatic, battle-tested runner for raw-pg stacks: ordered, forward-only, with applied state tracked in the DB (a `pgmigrations` table).

This replaced the ad-hoc `scripts/migrate.mjs` + `db/migrate-passwords.sql` (the latter, a one-off password-column migration, is folded into the baseline).

## Commands

```
DATABASE_URL="postgres://…?sslmode=require" npm run migrate          # apply pending migrations (up)
npm run migrate:create add_something                                  # scaffold migrations/<ts>_add_something.cjs
DATABASE_URL="postgres://…" npm run seed                              # apply db/seed.sql (demo data — NOT schema)
```

- **SSL:** hosted Postgres (Supabase/Neon) needs `?sslmode=require` in `DATABASE_URL` (Supabase connection strings include it). Localhost needs no SSL.
- Migration state lives in the `pgmigrations` table; `npm run migrate` is idempotent — already-applied migrations are skipped.

## Baseline

`migrations/0001_baseline.cjs` is the baseline: it applies `db/schema.sql`, the **canonical, frozen** schema. Because schema.sql is idempotent (`create … if not exists`), the first `migrate up`:
- on an **existing** production DB → no-op, just records the baseline as applied;
- on a **fresh** DB → creates the full `bouncr` schema.

## Rules going forward

- **Never edit `db/schema.sql` or the baseline.** Schema changes are NEW migration files (`migrations/0002_*.cjs`, …) created with `npm run migrate:create`.
- Forward-only. `down` exists only for local resets, not production rollback.
- `db/schema.sql` stays the canonical DDL and is also what the **Postgres test harness** (`src/store/pg-test-db.ts`) applies. ⚠️ When migrations beyond the baseline exist, switch that harness to run `node-pg-migrate up` so tests exercise the same migration path as prod (currently it applies schema.sql directly, which equals the baseline).
