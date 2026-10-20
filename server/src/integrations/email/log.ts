import { appendFile } from 'node:fs/promises';

import type { EmailAdapter, EmailSendResult, OutgoingEmail } from './types.js';

/**
 * Development-only transport.
 *
 * It writes each message to `server/.data/outbox/` and accepts it, so the whole
 * reminder pipeline can be exercised without a provider. It NEVER delivers
 * anything, and `deliversMessages` is `false` so the UI can say so. The API
 * refuses to start with this transport in production.
 */
export class LogEmailAdapter implements EmailAdapter {
  readonly name = 'log';
  readonly deliversMessages = false;
  readonly setupHint =
    'EMAIL_PROVIDER=log captures messages to server/.data/outbox instead of delivering them. Configure SMTP to send real email.';

  constructor(private readonly outboxDir: string) {}

  async verifyConfiguration(): Promise<{ ok: boolean; detail: string }> {
    return {
      ok: true,
      detail: `Development outbox active at ${this.outboxDir}. Messages are captured, not delivered.`,
    };
  }

  async send(message: OutgoingEmail): Promise<EmailSendResult> {
    const safeId = `dev_${Date.now().toString(36)}`;
    const payload = [
      '--- ShipCheck development outbox (NOT DELIVERED) ---',
      `to: ${message.to}`,
      `from: ${message.from}`,
      `subject: ${message.subject}`,
      '',
      message.text,
      '',
    ].join('\n');
    try {
      await appendFile(`${this.outboxDir}/${safeId}.eml`, payload, 'utf8');
    } catch (error) {
      return {
        accepted: false,
        status: 'rejected',
        failureCode: 'temporary',
        message: `Could not write the development outbox: ${error instanceof Error ? error.message : 'unknown error'}`,
      };
    }
    return {
      accepted: true,
      status: 'accepted',
      providerMessageId: safeId,
      message: 'Captured in the development outbox. Nothing was delivered.',
    };
  }
}