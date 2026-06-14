/**
 * Reference merchant entitlement-webhook consumer.
 *
 * When a deal settles, Bouncr POSTs a SIGNED entitlement to the merchant's webhook
 * URL — Bouncr never grants access itself, the merchant does. This is a minimal,
 * copy-pasteable reference of that consumer: verify the signature, reject replays,
 * be idempotent on deal_id, and "flip the user to subscribed at $amount". Use it to
 * test the settlement → entitlement path end to end (test mode) without the real
 * merchant app.
 *
 *   Header:  Bouncr-Signature: t=<unix>,v1=<hex hmac-sha256 of `${t}.${rawBody}`>
 *   Body:    { deal_id, end_user_ref, plan_id, amount (MINOR units), currency,
 *              status: "active", expires_at? }
 *
 *   BOUNCR_MERCHANT_SECRET="whsec_..." node scripts/example-merchant-webhook.mjs
 *   (the secret is the merchant's OUTBOUND webhook secret — Dashboard → webhook, or
 *    the value returned when you set the webhook URL.)
 */
import { createServer } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";

const SECRET = process.env.BOUNCR_MERCHANT_SECRET;
if (!SECRET) {
  console.error("BOUNCR_MERCHANT_SECRET is not set (the merchant's outbound webhook secret).");
  process.exit(1);
}
const PORT = Number(process.env.PORT ?? 4000);
const TOLERANCE_S = 5 * 60; // reject signatures older than 5 min (replay guard)

const granted = new Set(); // idempotency: deal_id we've already processed

/** Returns null if the signature is valid, else a reason string. */
function verify(sigHeader, rawBody) {
  if (!sigHeader) return "missing Bouncr-Signature header";
  const parts = Object.fromEntries(String(sigHeader).split(",").map((kv) => kv.split("=")));
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!t || !v1) return "malformed signature";
  if (Math.abs(Math.floor(Date.now() / 1000) - t) > TOLERANCE_S) return "stale signature (possible replay)";
  const expected = createHmac("sha256", SECRET).update(`${t}.${rawBody}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(v1);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return "signature mismatch";
  return null;
}

createServer((req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405).end();
    return;
  }
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const err = verify(req.headers["bouncr-signature"], raw);
    if (err) {
      console.error(`✗ rejected: ${err}`);
      res.writeHead(400).end(JSON.stringify({ error: err }));
      return;
    }
    let p;
    try {
      p = JSON.parse(raw);
    } catch {
      res.writeHead(400).end(JSON.stringify({ error: "bad json" }));
      return;
    }
    if (granted.has(p.deal_id)) {
      console.log(`· deal ${p.deal_id} already granted — idempotent no-op`);
      res.writeHead(200).end(JSON.stringify({ ok: true, duplicate: true }));
      return;
    }
    granted.add(p.deal_id);
    const price = `$${(p.amount / 100).toFixed(2)} ${String(p.currency).toUpperCase()}`;
    console.log(`✓ GRANT: user ${p.end_user_ref} → ${p.plan_id} at ${price}/mo (deal ${p.deal_id})`);
    res.writeHead(200).end(JSON.stringify({ ok: true }));
  });
}).listen(PORT, () =>
  console.log(`reference merchant webhook consumer listening on http://localhost:${PORT} (verifying Bouncr-Signature)`),
);
