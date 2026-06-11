/**
 * Merchant auth (dashboard). Two primitives, both stateless so they work across
 * serverless instances with no session store:
 *
 *   1. Per-merchant API key — `bk_<merchantId>_<secret>`. The merchant id is
 *      embedded so login can resolve the merchant without a secondary index; the
 *      secret is high-entropy random, stored only as a SHA-256 hash. (Keys are
 *      random, not user-chosen passwords, so a fast hash is sufficient — there's
 *      no low-entropy brute-force surface.)
 *   2. Session token — an HMAC-signed `base64url(payload).sig` the dashboard
 *      carries as a bearer. Short-lived; no server-side storage.
 */
import { createHmac, createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

// --- passwords (human-chosen → slow, salted hash) --------------------------

/** Hash a password with scrypt + a random salt. Stored as `scrypt$salt$hash`. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 32).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

/** Verify a password against a stored `scrypt$salt$hash` (constant-time). */
export function verifyPassword(password: string, stored: string | null | undefined): boolean {
  if (!stored) return false;
  const [scheme, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const want = Buffer.from(hash, "hex");
  let got: Buffer;
  try {
    got = scryptSync(password, salt, want.length);
  } catch {
    return false;
  }
  return got.length === want.length && timingSafeEqual(got, want);
}

const KEY_RE = /^bk_(.+)_[0-9a-f]{48}$/;

/** Mint a fresh merchant API key embedding the merchant id. */
export function generateMerchantKey(merchantId: string): string {
  return `bk_${merchantId}_${randomBytes(24).toString("hex")}`;
}

/** Pull the merchant id out of a key, or null if it isn't well-formed. */
export function parseMerchantKey(key: string): { merchantId: string } | null {
  const m = KEY_RE.exec(key.trim());
  return m ? { merchantId: m[1]! } : null;
}

/** SHA-256 hash of a key, for at-rest storage / comparison. */
export function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** Constant-time compare of two hex strings of equal length. */
export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

/** Sign a session token binding a merchant id, expiring after ttlMs. */
export function signSession(
  merchantId: string,
  secret: string,
  ttlMs: number,
  now: number,
): { token: string; expiresAt: number } {
  const expiresAt = now + ttlMs;
  const payload = Buffer.from(JSON.stringify({ m: merchantId, exp: expiresAt })).toString("base64url");
  return { token: `${payload}.${hmac(payload, secret)}`, expiresAt };
}

/** Verify a session token: signature + expiry. Returns the merchant id or null. */
export function verifySession(token: string, secret: string, now: number): { merchantId: string } | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  if (!safeEqualHex(token.slice(dot + 1), hmac(payload, secret))) return null;
  try {
    const { m, exp } = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (typeof m !== "string" || typeof exp !== "number" || exp < now) return null;
    return { merchantId: m };
  } catch {
    return null;
  }
}

function hmac(data: string, secret: string): string {
  return createHmac("sha256", secret).update(data).digest("hex");
}
