-- Demo merchant + plan, mirroring src/config.ts (demoMerchant / demoPlan).
-- Idempotent: safe to re-run. Apply after db/schema.sql. Lives in the `bouncr`
-- schema, isolated from anything else in the project.

insert into bouncr.merchants (id, name, stripe_connect_id, created_at)
values ('merchant_demo', 'Obius', null, 0)
on conflict (id) do nothing;

insert into bouncr.plans (id, merchant_id, plan_key, currency, config_jsonb, persona_jsonb, policy_jsonb, usage_jsonb, version, active)
values (
  'plan_demo',
  'merchant_demo',
  'pro_monthly',
  'usd',
  '{"listPrice":30,"floorPrice":22,"targetPrice":32,"anchorMultiplier":1.6,"maxRounds":6,"maxDurationH":48,"acceptThreshold":0.92,"minConcession":1.0,"lambda":0.55}',
  '{"name":"Vini","productName":"Obius","style":"sassy","roastLevel":2}',
  '{"cooldownHours":72,"maxMessages":30}',
  '{"bandCeiling":1000,"breachCyclesRequired":3,"costPerUnit":0.004,"costPlusMargin":1.25,"renegAnchorMultiplier":1.7,"downwardEnabled":false,"downwardFloorRatio":0.1,"downwardMinCycles":3}',
  1,
  true
)
on conflict (id) do nothing;
