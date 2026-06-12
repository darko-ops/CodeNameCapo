import { describe, it, expect } from "vitest";
import { ProofSigner, mintProof } from "./proof.js";
import type { DealRecord, Plan } from "./store/types.js";
import { demoPlan } from "./config.js";
import { MemoryStore } from "./store/memory.js";

const PLAN: Plan = demoPlan();
const NOW = 1_700_000_000_000;

function dealAt(price: number): DealRecord {
  return {
    id: "deal_x", sessionId: "sess_x", merchantId: PLAN.merchantId, planId: PLAN.id,
    endUserRef: "user_42", price, currency: "usd", status: "pending", kind: "initial",
    stripeCheckoutId: null, stripeSubscriptionId: null, renegSessionId: null, createdAt: NOW, settledAt: null,
  };
}

describe("settlement proof (EdDSA)", () => {
  const signer = ProofSigner.ephemeral("test-1");
  const verifier = signer.verifier();

  it("invariant 1: minted amount is the engine's accepted price (cents), no override", () => {
    // The engine sets deal.price ($13.47); the proof carries exactly that, in cents.
    const { claims } = mintProof(signer, { deal: dealAt(13.47), plan: PLAN, nowMs: NOW });
    expect(claims.amount).toBe(1347);
    expect(claims.currency).toBe("usd");
    expect(claims.aud).toBe(PLAN.merchantId);
    expect(claims.sub).toBe("user_42");
    expect(claims.iss).toBe("bouncr");
    expect(claims.interval).toBe("month");
    // There is no parameter to set `amount` independently — mintProof's input
    // exposes only {deal, plan, ...}; amount derives solely from deal.price.
  });

  it("happy path: a fresh proof verifies and returns the typed claims", () => {
    const { token } = mintProof(signer, { deal: dealAt(20), plan: PLAN, nowMs: NOW });
    const res = verifier.verify(token, NOW + 1000);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.claims.amount).toBe(2000);
  });

  it("invariant 2: a tampered amount/sub/aud fails verification (signature breaks)", () => {
    const { token } = mintProof(signer, { deal: dealAt(20), plan: PLAN, nowMs: NOW });
    const [h, p, s] = token.split(".");
    const payload = JSON.parse(Buffer.from(p!, "base64url").toString());
    payload.amount = 1; // try to pay 1 cent
    const forged = `${h}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${s}`;
    const res = verifier.verify(forged, NOW + 1000);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("bad_signature");
  });

  it("invariant 4: an expired proof fails", () => {
    const { token } = mintProof(signer, { deal: dealAt(20), plan: PLAN, nowMs: NOW, ttlMs: 60_000 });
    expect(verifier.verify(token, NOW + 61_000).ok).toBe(false);
    const late = verifier.verify(token, NOW + 61_000);
    if (!late.ok) expect(late.reason).toBe("expired");
  });

  it("invariant 5: amount is only available from the verified token, never the raw string", () => {
    // A proof signed by a DIFFERENT key must not verify against ours, so an
    // attacker can't fabricate a valid-looking token with an arbitrary amount.
    const other = ProofSigner.ephemeral("attacker");
    const { token } = mintProof(other, { deal: dealAt(999), plan: PLAN, nowMs: NOW });
    expect(verifier.verify(token, NOW + 1000).ok).toBe(false);
  });

  it("a token signed by the wrong issuer is rejected", () => {
    const { token } = mintProof(signer, { deal: dealAt(20), plan: PLAN, nowMs: NOW });
    const [h, p, s] = token.split(".");
    const payload = JSON.parse(Buffer.from(p!, "base64url").toString());
    payload.iss = "evil";
    // Re-sign with our key so the signature is valid but the issuer is wrong.
    const reSigned = signer.sign(payload);
    const res = verifier.verify(reSigned, NOW + 1000);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("bad_issuer");
  });

  it("invariant 3: a jti is single-use — the second redeem loses (atomic burn)", async () => {
    const store = new MemoryStore();
    const { claims } = mintProof(signer, { deal: dealAt(20), plan: PLAN, nowMs: NOW });
    expect(await store.isProofRedeemed(claims.jti)).toBe(false);
    expect(await store.redeemProof(claims.jti, claims.deal_id, NOW)).toBe(true); // this caller burns it
    expect(await store.isProofRedeemed(claims.jti)).toBe(true);
    expect(await store.redeemProof(claims.jti, claims.deal_id, NOW + 1)).toBe(false); // replay loses
  });

  it("publishes a valid OKP/Ed25519 public JWK (no private material)", () => {
    const jwk = signer.publicJwk();
    expect(jwk.kty).toBe("OKP");
    expect(jwk.crv).toBe("Ed25519");
    expect(jwk.alg).toBe("EdDSA");
    expect(jwk.kid).toBe("test-1");
    expect(jwk.x).toBeTruthy(); // public point
    expect((jwk as any).d).toBeUndefined(); // never the private scalar
  });
});
