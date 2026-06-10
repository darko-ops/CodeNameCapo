-- Demo merchant + plan, mirroring src/config.ts (demoMerchant / demoPlan).
-- Idempotent: safe to re-run. Apply after db/schema.sql.

insert into merchants (id, name, stripe_connect_id, created_at)
values ('merchant_demo', 'Obius', null, 0)
on conflict (id) do nothing;

insert into plans (id, merchant_id, plan_key, currency, config_jsonb, persona_jsonb, policy_jsonb, usage_jsonb, version, active)
values (
  'plan_demo',
  'merchant_demo',
  'pro_monthly',
  'usd',
  '{"listPrice":30,"floorPrice":8,"targetPrice":22,"anchorMultiplier":1.6,"maxRounds":6,"maxDurationH":48,"acceptThreshold":0.97,"minConcession":0.5,"lambda":0.6}',
  '{"name":"Vinny","productName":"Obius","style":"sassy","roastLevel":2}',
  '{"cooldownHours":72,"maxMessages":30}',
  '{"bandCeiling":1000,"breachCyclesRequired":3,"costPerUnit":0.004,"costPlusMargin":1.25,"renegAnchorMultiplier":1.7,"downwardEnabled":false,"downwardFloorRatio":0.1,"downwardMinCycles":3}',
  1,
  true
)
on conflict (id) do nothing;
