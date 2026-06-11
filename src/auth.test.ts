import { describe, it, expect } from "vitest";
import {
  generateMerchantKey,
  parseMerchantKey,
  hashKey,
  safeEqualHex,
  signSession,
  verifySession,
} from "./auth.js";

describe("merchant keys", () => {
  it("round-trips the merchant id through a generated key", () => {
    const key = generateMerchantKey("merchant_demo");
    expect(key).toMatch(/^bk_merchant_demo_[0-9a-f]{48}$/);
    expect(parseMerchantKey(key)).toEqual({ merchantId: "merchant_demo" });
  });

  it("rejects malformed keys", () => {
    expect(parseMerchantKey("garbage")).toBeNull();
    expect(parseMerchantKey("bk_m_short")).toBeNull();
  });

  it("hashes deterministically and compares in constant time", () => {
    const key = generateMerchantKey("m_x");
    expect(hashKey(key)).toBe(hashKey(key));
    expect(hashKey(key)).not.toBe(hashKey(generateMerchantKey("m_x")));
    expect(safeEqualHex(hashKey(key), hashKey(key))).toBe(true);
    expect(safeEqualHex(hashKey(key), hashKey("other"))).toBe(false);
  });
});

describe("session tokens", () => {
  const SECRET = "s3cr3t";

  it("signs and verifies a fresh token", () => {
    const { token, expiresAt } = signSession("m_1", SECRET, 1000, 1000);
    expect(expiresAt).toBe(2000);
    expect(verifySession(token, SECRET, 1500)).toEqual({ merchantId: "m_1" });
  });

  it("rejects an expired token", () => {
    const { token } = signSession("m_1", SECRET, 1000, 1000);
    expect(verifySession(token, SECRET, 2001)).toBeNull();
  });

  it("rejects a wrong secret or tampered payload", () => {
    const { token } = signSession("m_1", SECRET, 10_000, 0);
    expect(verifySession(token, "wrong", 1)).toBeNull();
    const [payload, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ m: "m_evil", exp: 9_999_999 })).toString("base64url") + "." + sig;
    expect(verifySession(forged, SECRET, 1)).toBeNull();
    expect(verifySession("nodot", SECRET, 1)).toBeNull();
  });
});
