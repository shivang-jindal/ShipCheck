/**
 * Email delivery boundary (Part A / A2, Part B / B9).
 *
 * The adapter contract deliberately distinguishes:
 *   - `configured`   - credentials are present
 *   - `deliversMessages` - a real provider will actually attempt delivery
 *   - `accepted`     - the provider accepted the message for delivery
 *
 * An accepted message is never reported as "delivered". The SMTP adapter does
 * not receive delivery receipts, so CollectFlow only ever shows `sent`.
 */

export type EmailFailureCode =
  | 'not_configured'
  | 'temporary'
  | 'permanent_recipient'
  | 'auth_failed'
  | 'provider_error';

export interface OutgoingEmail {
  to: string;
  from: string;
  replyTo?: string | null;
  subject: string;
  text: string;
  html?: string;
  /** Correlation id stored on the outbox row; never a provider secret. */
  idempotencyKey?: string;
}

export interface EmailSendResult {
  accepted: boolean;
  /** Exactly what we know about delivery: `accepted` or `rejected`. */
  status: 'accepted' | 'rejected';
  providerMessageId?: string;
  failureCode?: EmailFailureCode;
  /** Safe, non-secret explanation for the operator. */
  message: string;
}

export interface EmailAdapter {
  readonly name: string;
  /** True only when a real provider will attempt delivery. */
  readonly deliversMessages: boolean;
  readonly setupHint: string;
  verifyConfiguration(): Promise<{ ok: boolean; detail: string }>;
  send(message: OutgoingEmail): Promise<EmailSendResult>;
  close?(): Promise<void>;
}