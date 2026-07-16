/**
 * SMS channel (Spec §10 — "the widget is a dumb terminal", and SMS is just
 * another one). Outbound texts go through an injectable SmsSender: Twilio in
 * production (TWILIO_* env), a console logger in the sandbox so the whole app
 * still runs offline. Inbound texts arrive on POST /v1/webhooks/sms and run the
 * SAME Extract→Engine→Validate turn as the web widget — the floor holds no
 * matter which pipe the words travel through.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export interface SmsSender {
  /** Send one text. `to` is E.164. Throws on any non-2xx / network failure. */
  send(to: string, body: string): Promise<void>;
}

/**
 * Normalize a user-typed phone number to E.164, or null if it can't be one.
 * Bare 10-digit (or 1-prefixed 11-digit) numbers are assumed US; anything else
 * must arrive with an explicit +country prefix — guessing a country code sends
 * a paid text to a stranger.
 */
export function normalizePhone(raw: string): string | null {
  const cleaned = raw.trim().replace(/[\s().\-]/g, "");
  const m = /^(\+?)(\d{7,15})$/.exec(cleaned);
  if (!m) return null;
  const [, plus, digits] = m as unknown as [string, string, string];
  if (plus) return digits.length >= 8 ? `+${digits}` : null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/** Sends via the Twilio REST API (no SDK — one form-encoded POST). */
export class TwilioSms implements SmsSender {
  constructor(
    private readonly accountSid: string,
    private readonly authToken: string,
    private readonly from: string,
  ) {}

  async send(to: string, body: string): Promise<void> {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`,
      {
        method: "POST",
        headers: {
          authorization:
            "Basic " + Buffer.from(`${this.accountSid}:${this.authToken}`).toString("base64"),
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ To: to, From: this.from, Body: body }).toString(),
      },
    );
    if (!res.ok) {
      throw new Error(`twilio ${res.status}: ${await res.text().catch(() => "")}`);
    }
  }
}

/** Sandbox sender — logs the whole text so a local `npm run serve` demo is
 *  readable end-to-end (sandbox only; nothing here reaches a real carrier). */
export class ConsoleSms implements SmsSender {
  async send(to: string, body: string): Promise<void> {
    console.log(`[sms:sandbox] to=${to} body=${JSON.stringify(body)}`);
  }
}

/**
 * Verify Twilio's `X-Twilio-Signature` on an inbound webhook: Base64(HMAC-SHA1
 * over the exact public URL + the form params concatenated in sorted-key order),
 * keyed by the account auth token. Constant-time compare.
 */
export function verifyTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
  signature: string | undefined,
): boolean {
  if (!signature) return false;
  const data =
    url +
    Object.keys(params)
      .sort()
      .map((k) => k + params[k])
      .join("");
  const expected = Buffer.from(createHmac("sha1", authToken).update(data).digest("base64"));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** A TwiML reply document; no message → an empty <Response/> (send nothing). */
export function twiml(message?: string | null): string {
  const esc = (s: string) =>
    s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${message ? `<Message>${esc(message)}</Message>` : ""}</Response>`;
}
