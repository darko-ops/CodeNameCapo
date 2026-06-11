-- Bouncr data model (Spec §8). Postgres / Supabase.
--
-- Everything lives in a dedicated `bouncr` schema so it's fully isolated from
-- anything else in the same Supabase project (e.g. Dromo's `public` email-
-- collection tables) and trivially migratable later: `pg_dump --schema=bouncr`.
--
-- Timestamps that the engine reasons about (opened_at, expires_at) are stored as
-- epoch-millisecond bigints to match the engine's clock exactly; bookkeeping
-- timestamps (created_at, settled_at) are likewise epoch ms for record parity.

create schema if not exists bouncr;

create table if not exists bouncr.merchants (
  id                 text primary key,
  name               text not null,
  stripe_connect_id  text,
  created_at         bigint not null
);

create table if not exists bouncr.plans (
  id            text primary key,
  merchant_id   text not null references bouncr.merchants(id),
  plan_key      text not null,
  currency      text not null default 'usd',
  config_jsonb  jsonb not null,          -- engine Config
  persona_jsonb jsonb not null,          -- Persona
  policy_jsonb  jsonb not null default '{"cooldownHours":72,"maxMessages":30}',  -- NegotiationPolicy (§12)
  usage_jsonb   jsonb not null default '{"bandCeiling":1000,"breachCyclesRequired":3,"costPerUnit":0.004,"costPlusMargin":1.25,"renegAnchorMultiplier":1.7,"downwardEnabled":false,"downwardFloorRatio":0.1,"downwardMinCycles":3}',  -- UsagePolicy (§6)
  version       integer not null default 1,
  active        boolean not null default true,
  application_fee_percent numeric  -- per-plan Bouncr take-rate (null => platform default)
);
-- Idempotent add for existing deployments (the column is new).
alter table bouncr.plans add column if not exists application_fee_percent numeric;
create index if not exists plans_merchant_idx on bouncr.plans(merchant_id);

-- Per-(plan, end_user_ref) walkaway cooldown (Spec §12).
create table if not exists bouncr.cooldowns (
  plan_id      text not null references bouncr.plans(id),
  end_user_ref text not null,
  until_ms     bigint not null,
  primary key (plan_id, end_user_ref)
);

create table if not exists bouncr.sessions (
  id             uuid primary key default gen_random_uuid(),
  plan_id        text not null references bouncr.plans(id),
  session_token  text not null,          -- widget-facing bearer token (§9)
  end_user_ref   text not null,          -- merchant's opaque user id (minimal PII)
  channel        text not null default 'web',
  round          integer not null,
  current_ask    numeric(12,2) not null,
  opened_at      bigint not null,        -- epoch ms
  expires_at     bigint not null,        -- epoch ms
  status         text not null default 'open',  -- open|accepted|walked|expired|settled
  config_version integer not null,
  context        jsonb,
  kind           text not null default 'initial',  -- initial|reneg_up|reneg_down (§6)
  reneg_deal_id  uuid,                              -- the deal being renegotiated
  config_override jsonb,                            -- reneg pricing config
  created_at     bigint not null
);
create index if not exists sessions_plan_idx on bouncr.sessions(plan_id);
create index if not exists sessions_user_idx on bouncr.sessions(end_user_ref);

create table if not exists bouncr.turns (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid not null references bouncr.sessions(id),
  role        text not null,             -- user|bouncer
  raw_text    text not null,
  extracted   jsonb,                     -- Extractor output (user turns)
  action      jsonb,                     -- full policy-engine action snapshot (bouncer turns)
  created_at  bigint not null
);
create index if not exists turns_session_idx on bouncr.turns(session_id, created_at);

create table if not exists bouncr.deals (
  id                     uuid primary key default gen_random_uuid(),
  session_id             uuid not null references bouncr.sessions(id),
  merchant_id            text not null references bouncr.merchants(id),
  plan_id                text not null references bouncr.plans(id),
  end_user_ref           text not null,
  price                  numeric(12,2) not null,
  currency               text not null default 'usd',
  status                 text not null default 'pending',  -- pending|settled|canceled
  kind                   text not null default 'initial',  -- initial|reneg_up|reneg_down
  stripe_checkout_id     text unique,
  stripe_subscription_id text,
  reneg_session_id       uuid,                       -- open renegotiation, if any (§6)
  created_at             bigint not null,
  settled_at             bigint
);
create index if not exists deals_session_idx on bouncr.deals(session_id);
create index if not exists deals_checkout_idx on bouncr.deals(stripe_checkout_id);

-- Usage readings per billing cycle (Spec §6.1, §8 usage_cycles).
create table if not exists bouncr.usage_cycles (
  id            uuid primary key default gen_random_uuid(),
  deal_id       uuid not null references bouncr.deals(id),
  cycle_index   integer not null,
  usage_value   numeric not null,
  band_ceiling  numeric not null,
  breach        boolean not null,
  breach_streak integer not null,
  created_at    bigint not null
);
create index if not exists usage_deal_idx on bouncr.usage_cycles(deal_id, cycle_index);

-- Append-only event log (analytics raw material, Spec §8).
create table if not exists bouncr.events (
  id         uuid primary key default gen_random_uuid(),
  type       text not null,
  payload    jsonb not null,
  created_at bigint not null
);
create index if not exists events_type_idx on bouncr.events(type, created_at);
