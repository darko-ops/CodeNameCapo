/**
 * Outbound transactional email. Resend in production (RESEND_API_KEY); a console
 * logger in the sandbox so the whole app still runs offline. The only mail Bouncr
 * sends is the password-reset link.
 */
export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export interface Mailer {
  send(msg: MailMessage): Promise<void>;
}

/** Sends via the Resend REST API (https://resend.com/docs/api-reference). */
export class ResendMailer implements Mailer {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  async send(msg: MailMessage): Promise<void> {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: this.from,
        to: [msg.to],
        subject: msg.subject,
        html: msg.html,
        ...(msg.text ? { text: msg.text } : {}),
      }),
    });
    if (!res.ok) {
      throw new Error(`resend ${res.status}: ${await res.text().catch(() => "")}`);
    }
  }
}

/** Sandbox mailer — logs the subject/recipient (never the link/secret). */
export class ConsoleMailer implements Mailer {
  async send(msg: MailMessage): Promise<void> {
    console.log(`[mail:sandbox] to=${msg.to} subject="${msg.subject}"`);
  }
}
