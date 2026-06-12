/**
 * Settlement proof (Spec §settlement). A short-lived, single-use signed token
 * that authorizes charging EXACTLY ONE negotiated amount. It is the keystone of
 * the hosted-checkout path: the only price that can ever be charged is the one
 * the policy engine accepted, carried here and cryptographically sealed.
 *
 *   - EdDSA (Ed25519) JWT, signed with Bouncr's private key (env, never logged).
 *   - The matching public key is published at /.well-known/bouncr-jwks.json so a
 *     merchant can verify a charge was authorized by Bouncr, independently.
 *   - `amount` is in minor units (cents) and originates ONLY from the deal's
 *     accepted price (engine origin) — there is no API to set it from anywhere
 *     else (see mintProof; the LLM/client/URL can't influence it).
 *
 * Implemented on node:crypto (Ed25519 is native in Node 18+), so there's no
 * extra dependency and it runs offline in the sandbox.
 */
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify,
  randomUUID,
  type KeyObject,
} from "node:crypto";
import type { Plan, DealRecord } from "./store/types.js";

export type ProofKind = "initial" | "reneg_up" | "reneg_down" | "day_pass" | "trial";
export type ProofInterval = "month" | "one_time";

/** The signed claims. Mirrors the spec exactly; times are epoch SECONDS (JWT). */
export interface ProofClaims {
  iss: "bouncr";
  sub: string; // end_user_ref (merchant's opaque user id)
  aud: string; // merchant_id
  deal_id: string;
  plan_id: string;
  amount: number; // integer minor units (cents)
  currency: string;
  interval: ProofInterval;
  kind: ProofKind;
  jti: string; // single-use nonce
  iat: number;
  exp: number;
}

export type ProofError = "bad_format" | "bad_signature" | "bad_issuer" | "bad_shape" | "expired";

const DEFAULT_TTL_MS = 15 * 60 * 1000;
const b64uJson = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

/** Holds the Ed25519 private key and mints/serves the public JWK. */
export class ProofSigner {
  readonly kid: string;
  private readonly priv: KeyObject;
  private readonly pub: KeyObject;

  constructor(privateKey: KeyObject, kid: string) {
    this.priv = privateKey;
    this.pub = createPublicKey(privateKey);
    this.kid = kid;
  }

  /** From a PKCS8 PEM private key (production: env secret). */
  static fromPem(pem: string, kid: string): ProofSigner {
    return new ProofSigner(createPrivateKey(pem), kid);
  }

  /** Ephemeral keypair for the sandbox/dev — proofs verify within one process. */
  static ephemeral(kid = "bouncr-dev"): ProofSigner {
    const { privateKey } = generateKeyPairSync("ed25519");
    return new ProofSigner(privateKey, kid);
  }

  sign(claims: ProofClaims): string {
    const header = { alg: "EdDSA", typ: "JWT", kid: this.kid };
    const input = `${b64uJson(header)}.${b64uJson(claims)}`;
    const sig = edSign(null, Buffer.from(input), this.priv).toString("base64url");
    return `${input}.${sig}`;
  }

  /** Public JWK (OKP/Ed25519) for the JWKS endpoint. No private material. */
  publicJwk(): Record<string, unknown> {
    const jwk = this.pub.export({ format: "jwk" }) as Record<string, unknown>;
    return { ...jwk, use: "sig", alg: "EdDSA", kid: this.kid };
  }

  /** A verifier bound to this signer's public key (single-key deployment). */
  verifier(): ProofVerifier {
    return new ProofVerifier([{ kid: this.kid, key: this.pub }]);
  }
}

/** Verifies the signature + structural claims of a proof. NO store access — the
 *  single-use (jti) and aud↔merchant checks are layered on by the service. */
export class ProofVerifier {
  constructor(private readonly keys: { kid: string; key: KeyObject }[]) {}

  verify(token: string, nowMs: number): { ok: true; claims: ProofClaims } | { ok: false; reason: ProofError } {
    const parts = token.split(".");
    if (parts.length !== 3) return { ok: false, reason: "bad_format" };
    let header: Record<string, unknown>;
    let claims: Record<string, unknown>;
    try {
      header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString());
      claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString());
    } catch {
      return { ok: false, reason: "bad_format" };
    }
    if (header.alg !== "EdDSA") return { ok: false, reason: "bad_signature" };
    const key = (this.keys.find((k) => k.kid === header.kid) ?? this.keys[0])?.key;
    if (!key) return { ok: false, reason: "bad_signature" };
    let valid = false;
    try {
      valid = edVerify(null, Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2]!, "base64url"));
    } catch {
      valid = false;
    }
    if (!valid) return { ok: false, reason: "bad_signature" };
    if (claims.iss !== "bouncr") return { ok: false, reason: "bad_issuer" };
    if (!isWellFormed(claims)) return { ok: false, reason: "bad_shape" };
    if ((claims.exp as number) * 1000 < nowMs) return { ok: false, reason: "expired" };
    return { ok: true, claims: claims as unknown as ProofClaims };
  }
}

/**
 * Mint a proof for a deal. `amount` is taken ONLY from the deal's accepted price
 * (the engine is the sole origin of `deal.price`); there is deliberately no
 * parameter to override it. `interval` defaults to "month" (subscriptions); the
 * one-time rail passes "one_time" explicitly (only ever via a hand-minted proof,
 * never a negotiator path — see the scope boundary in the spec).
 */
export function mintProof(
  signer: ProofSigner,
  input: { deal: DealRecord; plan: Plan; nowMs: number; ttlMs?: number; interval?: ProofInterval; kind?: ProofKind },
): { token: string; claims: ProofClaims } {
  const claims: ProofClaims = {
    iss: "bouncr",
    sub: input.deal.endUserRef,
    aud: input.plan.merchantId,
    deal_id: input.deal.id,
    plan_id: input.plan.id,
    amount: Math.round(input.deal.price * 100), // minor units, engine-origin only
    currency: input.deal.currency,
    interval: input.interval ?? "month",
    kind: input.kind ?? (input.deal.kind as ProofKind),
    jti: randomUUID(),
    iat: Math.floor(input.nowMs / 1000),
    exp: Math.floor((input.nowMs + (input.ttlMs ?? DEFAULT_TTL_MS)) / 1000),
  };
  return { token: signer.sign(claims), claims };
}

function isWellFormed(c: Record<string, unknown>): boolean {
  return (
    typeof c.sub === "string" &&
    typeof c.aud === "string" &&
    typeof c.deal_id === "string" &&
    typeof c.plan_id === "string" &&
    typeof c.amount === "number" &&
    Number.isInteger(c.amount) &&
    c.amount > 0 &&
    typeof c.currency === "string" &&
    (c.interval === "month" || c.interval === "one_time") &&
    typeof c.kind === "string" &&
    typeof c.jti === "string" &&
    typeof c.iat === "number" &&
    typeof c.exp === "number"
  );
}
