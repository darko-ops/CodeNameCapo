/**
 * Baseline migration — the current `bouncr` schema, under version control.
 *
 * It applies db/schema.sql (the canonical, FROZEN baseline DDL — also used by the
 * Postgres test harness). schema.sql is idempotent (`create ... if not exists`), so
 * the first `migrate up` is safe on an EXISTING production DB (no-op, just records
 * the baseline as applied) and creates everything fresh on a new DB.
 *
 * Going forward: schema changes are NEW migration files (migrations/0002_*.cjs, …),
 * never edits to schema.sql or to this file. See docs/migrations.md.
 */
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

exports.up = (pgm) => {
  pgm.sql(readFileSync(join(__dirname, "..", "db", "schema.sql"), "utf8"));
};

exports.down = (pgm) => {
  // Forward-only in practice; a down is provided only for completeness/local resets.
  pgm.sql("drop schema if exists bouncr cascade;");
};
