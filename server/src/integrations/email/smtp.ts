import nodemailer, { type Transporter } from 'nodemailer';

import type { EmailAdapter, EmailFailureCode, EmailSendResult, OutgoingEmail } from './types.js';

/**
 * SMTP adapter built on Nodemailer.
 *
 * `SMTP.sendMail` resolving means the provider accepted the message for
 * delivery - nothing more. ShipCheck therefore records status `sent`, never
 * `delivered`, because SMTP gives no delivery receipt.
 */
export class SmtpEmailAdapter implements EmailAdapter {
  readonly name = 'smtp';
  readonly deliversMessages = true;
  readonly setupHint =
    'Set SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASSWORD and FROM_EMAIL. Use provider sandbox credentials first, then verify with the "Send test email" action.';

  private transporter: Transporter | null = null;

  constructor(
    private readonly options: {
      host: string;
      port: number;
      secure: boolean;
      user: string | null;
      password: string | null;
    },
  ) {}

  private getTransporter(): Transporter {
    if (!this.transporter) {
      this.transporter = nodemailer.createTransport({
        host: this.options.host,
        port: this.options.port,
        secure: this.options.secure,
        auth:
          this.options.user && this.options.password
            ? { user: this.options.user, pass: this.options.password }
            : undefined,
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 20_000,
      });
    }
    return this.transporter;
  }

  async verifyConfiguration(): Promise<{ ok: boolean; detail: string }> {
    try {
      await this.getTransporter().verify();
      return { ok: true, detail: `SMTP ${this.options.host}:${this.options.port} accepted a connection.` };
    } catch (error) {
      return {
        ok: false,
        detail: `SMTP verification failed: ${safeMessage(error)}`,
      };
    }
  }

  async send(message: OutgoingEmail): Promise<EmailSendResult> {
    try {
      const info = await this.getTransporter().sendMail({
        to: message.to,
        from: message.from,
        replyTo: message.replyTo ?? undefined,
        subject: message.subject,
        text: message.text,
        html: message.html,
        headers: {
          'X-ShipCheck-Email-Kind': message.idempotencyKey ? 'transactional' : 'general',
        },
      });
      return {
        accepted: true,
        status: 'accepted',
        providerMessageId: info.messageId,
        message: 'The email provider accepted the message for delivery.',
      };
    } catch (error) {
      const code = classify(error);
      return {
        accepted: false,
        status: 'rejected',
        failureCode: code,
        message: `The email provider rejected the message: ${safeMessage(error)}`,
      };
    }
  }

  async close(): Promise<void> {
    this.transporter?.close();
    this.transporter = null;
  }
}

function classify(error: unknown): EmailFailureCode {
  const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : '';
  if (code === 'EAUTH' || code === 'EENVELOPE') return 'auth_failed';
  if (code === 'ECONNECTION' || code === 'ETIMEDOUT' || code === 'EDNS' || code === 'ESOCKET') {
    return 'temporary';
  }
  const message = safeMessage(error).toLowerCase();
  if (message.includes('invalid recipient') || message.includes('does not exist')) {
    return 'permanent_recipient';
  }
  return 'provider_error';
}

/** Never leaks credentials: only the error code and a short text summary. */
function safeMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/(password|pass|secret|token|api[_-]?key)\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .slice(0, 200);
}