import { describe, it, expect } from "vitest";
import { assertLiveBootSecrets, buildServiceFromEnv } from "./config.js";

/** A live env (real Stripe configured) with every required secret set properly. */
const liveEnvOk = (): NodeJS.ProcessEnv => ({
  STRIPE_SECRET_KEY: "sk_live_realish_key",
  STRIPE_WEBHOOK_SECRET: "whsec_realish_secret",
  BOUNCR_AUTH_SECRET: "a".repeat(64),
  BOUNCR_PROOF_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nMOCKPEM\n-----END PRIVATE KEY-----",
  BOUNCR_DEMO_MERCHANT_PASSWORD: "a-strong-real-password",
});

describe("assertLiveBootSecrets — live-mode secret guard", () => {
  it("sandbox mode (no Stripe keys) allows all defaults / unset secrets", () => {
    expect(() => assertLiveBootSecrets({})).not.toThrow();
    expect(() => assertLiveBootSecrets({ ANTHROPIC_API_KEY: "x" })).not.toThrow();
  });

  it("live mode boots when every required secret is set properly", () => {
    expect(() => assertLiveBootSecrets(liveEnvOk())).not.toThrow();
  });

  it("live mode refuses the 'bouncrdemo' default password", () => {
    const env = { ...liveEnvOk(), BOUNCR_DEMO_MERCHANT_PASSWORD: "bouncrdemo" };
    expect(() => assertLiveBootSecrets(env)).toThrow(/LIVE mode/);
    expect(() => assertLiveBootSecrets(env)).toThrow(/BOUNCR_DEMO_MERCHANT_PASSWORD/);
  });

  it("live mode with Postgres (DATABASE_URL set) does NOT require the demo password — it's SQL-seeded", () => {
    const env = { ...liveEnvOk(), DATABASE_URL: "postgres://u:p@h:5432/db" };
    delete env.BOUNCR_DEMO_MERCHANT_PASSWORD;
    expect(() => assertLiveBootSecrets(env)).not.toThrow();
    // even the 'bouncrdemo' default is moot with Postgres (demoM is discarded there):
    expect(() => assertLiveBootSecrets({ ...env, BOUNCR_DEMO_MERCHANT_PASSWORD: "bouncrdemo" })).not.toThrow();
    // ...but the real secrets are still enforced regardless of the store:
    const missing = { ...env };
    delete missing.BOUNCR_AUTH_SECRET;
    expect(() => assertLiveBootSecrets(missing)).toThrow(/BOUNCR_AUTH_SECRET/);
  });

  it("live mode refuses missing auth/proof secrets (would fall back to ephemeral)", () => {
    const env = { ...liveEnvOk() };
    delete env.BOUNCR_AUTH_SECRET;
    delete env.BOUNCR_PROOF_PRIVATE_KEY;
    expect(() => assertLiveBootSecrets(env)).toThrow(/BOUNCR_AUTH_SECRET/);
    expect(() => assertLiveBootSecrets(env)).toThrow(/BOUNCR_PROOF_PRIVATE_KEY/);
  });

  it("live mode refuses unreplaced placeholders copied from .env.example", () => {
    const env = { ...liveEnvOk(), BOUNCR_AUTH_SECRET: "REPLACE_ME" };
    expect(() => assertLiveBootSecrets(env)).toThrow(/placeholder/i);
  });

  it("lists EVERY problem at once, not just the first", () => {
    const env = { STRIPE_SECRET_KEY: "sk_live_x", STRIPE_WEBHOOK_SECRET: "whsec_x" };
    try {
      assertLiveBootSecrets(env);
      throw new Error("expected it to throw");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toMatch(/BOUNCR_DEMO_MERCHANT_PASSWORD/);
      expect(msg).toMatch(/BOUNCR_AUTH_SECRET/);
      expect(msg).toMatch(/BOUNCR_PROOF_PRIVATE_KEY/);
    }
  });
});

describe("buildServiceFromEnv — guard is wired into boot", () => {
  it("a live env missing secrets throws on boot (before constructing anything)", () => {
    expect(() => buildServiceFromEnv({ STRIPE_SECRET_KEY: "sk_live_x", STRIPE_WEBHOOK_SECRET: "whsec_x" })).toThrow(
      /LIVE mode/,
    );
  });

  it("a sandbox env (defaults) boots fine", () => {
    const built = buildServiceFromEnv({}); // no Stripe keys → sandbox everything
    expect(built.sandbox.stripe).toBe(true);
    expect(built.store).toBe("memory");
    expect(built.service).toBeTruthy();
  });
});
