/**
 * Email outbox (Part C / C3.7).
 *
 * `sent` means the provider accepted the message. Plain SMTP does not report
 * delivery, so ShipCheck never claims an email was delivered.
 */

import { desc, eq, sql } from 'drizzle-orm';

import type { AppDatabase } from '../db/client.js';
import { emailMessages, emailTemplates } from '../db/schema.js';
import { notFound } from '../errors.js';
import type { EmailAdapter } from '../integrations/email/types.js';
import {
  renderPlainText,
  renderTemplate,
  type ShipmentTemplateContext,
} from '../integrations/email/templates.js';

export class EmailService {
  constructor(
    private readonly db: AppDatabase,
    private readonly adapter: EmailAdapter,
    private readonly fromAddress: string,
  ) {}

  get provider(): EmailAdapter {
    return this.adapter;
  }

  get from(): string {
    return this.fromAddress;
  }

  async queueInvoice(input: {
    organizationId: string;
    to: string;
    templateType: string;
    context: ShipmentTemplateContext;
    relatedShipmentId?: string | null;
    idempotencyKey?: string | null;
  }): Promise<{ messageId: string; deduplicated: boolean }> {
    if (input.idempotencyKey) {
      const existing = await this.db
        .select({ id: emailMessages.id })
        .from(emailMessages)
        .where(eq(emailMessages.idempotencyKey, input.idempotencyKey))
        .limit(1);
      if (existing[0]) return { messageId: existing[0].id, deduplicated: true };
    }

    const templates = await this.db
      .select()
      .from(emailTemplates)
      .where(
        sql`${emailTemplates.organizationId} = ${input.organizationId} and ${emailTemplates.type} = ${input.templateType}`,
      )
      .limit(1);
    const template = templates[0];

    const subject = template
      ? renderTemplate(template.subject, input.context, false)
      : `Shipment ${input.context.trackingNumber}`;
    const text = template ? renderPlainText(template.bodyHtml, input.context) : input.context.statusMessage;

    const inserted = await this.db
      .insert(emailMessages)
      .values({
        organizationId: input.organizationId,
        templateType: input.templateType,
        toAddress: input.to,
        fromAddress: this.fromAddress,
        subject,
        bodyText: text,
        status: 'queued',
        relatedShipmentId: input.relatedShipmentId ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
      })
      .returning({ id: emailMessages.id });

    return { messageId: inserted[0]?.id ?? '', deduplicated: false };
  }

  async queueSystemEmail(input: {
    organizationId: string | null;
    to: string;
    subject: string;
    bodyText: string;
    idempotencyKey?: string | null;
  }): Promise<{ messageId: string; deduplicated: boolean }> {
    if (input.idempotencyKey) {
      const existing = await this.db
        .select({ id: emailMessages.id })
        .from(emailMessages)
        .where(eq(emailMessages.idempotencyKey, input.idempotencyKey))
        .limit(1);
      if (existing[0]) return { messageId: existing[0].id, deduplicated: true };
    }
    const inserted = await this.db
      .insert(emailMessages)
      .values({
        organizationId: input.organizationId,
        templateType: 'system',
        toAddress: input.to,
        fromAddress: this.fromAddress,
        subject: input.subject,
        bodyText: input.bodyText,
        status: 'queued',
        idempotencyKey: input.idempotencyKey ?? null,
      })
      .returning({ id: emailMessages.id });
    return { messageId: inserted[0]?.id ?? '', deduplicated: false };
  }

  async deliver(messageId: string): Promise<{
    status: 'sent' | 'failed';
    retryable: boolean;
    message: string;
    providerMessageId: string | null;
  }> {
    const rows = await this.db.select().from(emailMessages).where(eq(emailMessages.id, messageId)).limit(1);
    const row = rows[0];
    if (!row) throw notFound('Email message');

    const result = await this.adapter.send({
      to: row.toAddress,
      from: row.fromAddress,
      subject: row.subject,
      text: row.bodyText ?? '',
      ...(row.idempotencyKey ? { idempotencyKey: row.idempotencyKey } : {}),
    });

    if (result.accepted) {
      await this.db
        .update(emailMessages)
        .set({
          status: 'sent',
          providerMessageId: result.providerMessageId ?? null,
          sentAt: new Date(),
          failureCode: null,
          safeFailureMessage: null,
        })
        .where(eq(emailMessages.id, messageId));
      return {
        status: 'sent',
        retryable: false,
        message: result.message,
        providerMessageId: result.providerMessageId ?? null,
      };
    }

    const permanent = result.failureCode === 'not_configured' || result.failureCode === 'permanent_recipient';
    await this.db
      .update(emailMessages)
      .set({
        status: 'failed',
        failureCode: result.failureCode ?? 'provider_error',
        safeFailureMessage: result.message.slice(0, 300),
      })
      .where(eq(emailMessages.id, messageId));

    return {
      status: 'failed',
      retryable: !permanent && result.failureCode !== 'auth_failed',
      message: result.message,
      providerMessageId: null,
    };
  }

  async outbox(organizationId: string, limit = 50) {
    return this.db
      .select({
        id: emailMessages.id,
        templateType: emailMessages.templateType,
        toAddress: emailMessages.toAddress,
        subject: emailMessages.subject,
        status: emailMessages.status,
        providerMessageId: emailMessages.providerMessageId,
        failureCode: emailMessages.failureCode,
        safeFailureMessage: emailMessages.safeFailureMessage,
        sentAt: emailMessages.sentAt,
        createdAt: emailMessages.createdAt,
      })
      .from(emailMessages)
      .where(eq(emailMessages.organizationId, organizationId))
      .orderBy(desc(emailMessages.createdAt))
      .limit(Math.min(limit, 200));
  }

  async stats(organizationId: string) {
    const rows = await this.db
      .select({ status: emailMessages.status, count: sql<number>`count(*)::int` })
      .from(emailMessages)
      .where(eq(emailMessages.organizationId, organizationId))
      .groupBy(emailMessages.status);
    return Object.fromEntries(rows.map((row) => [row.status, row.count]));
  }
}