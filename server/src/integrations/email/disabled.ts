import type { EmailAdapter, EmailSendResult, OutgoingEmail } from './types.js';

/**
 * The default adapter: email is safely disabled until an operator configures a
 * provider. Nothing is queued for delivery and the UI shows "Not connected".
 */
export class DisabledEmailAdapter implements EmailAdapter {
  readonly name = 'disabled';
  readonly deliversMessages = false;
  readonly setupHint =
    'Set EMAIL_PROVIDER=smtp together with SMTP_HOST, SMTP_PORT and FROM_EMAIL, then restart the API. Until then invoices can still be downloaded as PDF and payments recorded manually.';

  async verifyConfiguration(): Promise<{ ok: boolean; detail: string }> {
    return { ok: false, detail: 'No email provider is configured. Email sending is disabled.' };
  }

  async send(_message: OutgoingEmail): Promise<EmailSendResult> {
    return {
      accepted: false,
      status: 'rejected',
      failureCode: 'not_configured',
      message: 'No email provider is configured.',
    };
  }
}