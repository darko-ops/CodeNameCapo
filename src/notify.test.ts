import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { signEntitlement } from "./notify.js";

describe("entitlement webhook signature", () => {
  it("produces a t=,v1= HMAC-SHA256 a merchant can recompute and verify", () => {
    const secret = "whsec_abc";
    const body = JSON.stringify({ deal_id: "deal_1", amount: 1347, status: "active" });
    const header = signEntitlement(secret, body, 1_700_000_000_000);

    const m = /^t=(\d+),v1=([0-9a-f]+)$/.exec(header)!;
    expect(m).toBeTruthy();
    const t = m[1]!;
    const expected = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
    expect(m[2]).toBe(expected); // merchant verifies the same way
    expect(Number(t)).toBe(1_700_000_000); // seconds (replay window anchor)
  });

  it("a tampered body yields a different signature", () => {
    const a = signEntitlement("s", JSON.stringify({ amount: 100 }), 1000);
    const b = signEntitlement("s", JSON.stringify({ amount: 999 }), 1000);
    expect(a.split(",v1=")[1]).not.toBe(b.split(",v1=")[1]);
  });
});
