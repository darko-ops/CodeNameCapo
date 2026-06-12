/**
 * Outbound entitlement notification (Spec settlement §4b). When a deal settles,
 * Bouncr tells the MERCHANT to grant access — it never grants access itself. The
 * POST is signed with the merchant's per-merchant outbound secret (HMAC-SHA256,
 * distinct from their inbound API key) so the merchant can verify authenticity
 * and reject replays via the timestamp.
 *
 * Delivery is best-effort: settlement is already complete (money moved) before
 * this runs, so a failure here NEVER rolls back the deal. Every entitlement is
 * persisted durably first (in the service), making durable retries a later
 * bolt-on over the recorded events rather than new plumbing.
 */
import { createHmac } from "node:crypto";

export interface EntitlementPayload {
  deal_id: string;
  end_user_ref: string;
  plan_id: string;
  amount: number; // minor units (cents)
  currency: string;
  status: "active";
  expires_at?: number | null;
}

/** `Bouncr-Signature: t=<unix>,v1=<hex hmac of `${t}.${body}`>`. */
export function signEntitlement(secret: string, body: string, nowMs: number): string {
  const t = Math.floor(nowMs / 1000);
  const v1 = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

export interface EntitlementNotifier {
  /** Deliver the entitlement. Throws on any non-2xx / network failure. */
  notify(url: string, secret: string, payload: EntitlementPayload, nowMs: number): Promise<void>;
}

/** Real notifier — a signed POST to the merchant's webhook URL. */
export class FetchNotifier implements EntitlementNotifier {
  async notify(url: string, secret: string, payload: EntitlementPayload, nowMs: number): Promise<void> {
    const body = JSON.stringify(payload);
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "bouncr-signature": signEntitlement(secret, body, nowMs) },
      body,
    });
    if (!res.ok) throw new Error(`entitlement webhook ${res.status}`);
  }
}

/** Sandbox/no-op notifier — records nothing, fails nothing (dev/offline). */
export class NoopNotifier implements EntitlementNotifier {
  async notify(): Promise<void> {}
}
