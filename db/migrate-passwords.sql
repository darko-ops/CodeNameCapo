-- One-time migration: switch dashboard login from API key → email + password.
-- Idempotent and safe to re-run. Apply to the live DATABASE_URL once, BEFORE
-- deploying the password-auth code (otherwise signup/login will error on the
-- missing column).
--
--   psql "$DATABASE_URL" -f db/migrate-passwords.sql
--   -- or paste into the Supabase SQL editor
--
-- Everything lives in the isolated `bouncr` schema.

-- 1. New columns + unique email index (the login identifier).
alter table bouncr.merchants add column if not exists password_hash text;
alter table bouncr.merchants add column if not exists email text;
create unique index if not exists merchants_email_unique
  on bouncr.merchants (lower(email)) where email is not null;

-- 2. Make the shipped demo account loginable with email + password.
--    Login:  demo@thebouncr.com  /  bouncrdemo2026
update bouncr.merchants
   set email = 'demo@thebouncr.com',
       password_hash = 'scrypt$dd93be92bbac979de0529d1f57b0f9b6$3680669232db2118a1e825966c3c7c365e0d08243e0798a8a46e60b2a47e0b9b'
 where id = 'merchant_demo';
