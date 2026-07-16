/**
 * A/B lift analytics (§11) read the event log by plan: planId lives in the JSONB
 * payload, so index the expression, composite with type for the common
 * (plan, type) filter (widget.impression / merchant.conversion per plan).
 *
 * Note: this index was (incorrectly) added to db/schema.sql in the same commit
 * that shipped the feature — an edit the migration rules forbid (the baseline is
 * frozen). schema.sql is left as-is so fresh DBs / the test harness stay
 * equivalent to baseline+0002; this migration is what brings EXISTING databases
 * (which recorded the baseline before that edit) up to match. `if not exists`
 * makes the two paths converge either way.
 */
exports.up = (pgm) => {
  pgm.sql("create index if not exists events_plan_idx on bouncr.events ((payload->>'planId'), type);");
};

exports.down = (pgm) => {
  pgm.sql("drop index if exists bouncr.events_plan_idx;");
};
