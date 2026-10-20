/**
 * Email templates for ShipCheck shipment notifications.
 *
 * Only an allow-listed placeholder set is substituted, and every value is
 * escaped so customer content can never inject markup.
 */

import { escapeHtml } from '../../lib/util.js';

export interface ShipmentTemplateContext {
  organizationName: string;
  trackingNumber: string;
  publicReference: string;
  carrierName: string;
  statusLabel: string;
  statusMessage: string;
  locationText: string;
  occurredAt: string;
  estimatedDelivery: string;
  publicUrl: string;
  exceptionTypeLabel: string;
  nextAction: string;
}

export const TEMPLATE_PLACEHOLDERS = [
  '{{organizationName}}',
  '{{trackingNumber}}',
  '{{publicReference}}',
  '{{carrierName}}',
  '{{statusLabel}}',
  '{{statusMessage}}',
  '{{locationText}}',
  '{{occurredAt}}',
  '{{estimatedDelivery}}',
  '{{publicUrl}}',
  '{{exceptionTypeLabel}}',
  '{{nextAction}}',
] as const;

export interface EmailTemplateDefinition {
  type: string;
  subject: string;
  bodyHtml: string;
}

const LAYOUT = (body: string) => `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f8fafc;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#0f172a;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:24px;">
    ${body}
    <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;" />
    <p style="font-size:12px;color:#64748b;margin:0;">
      Sent by ShipCheck on behalf of {{organizationName}}. ShipCheck reports what the carrier published or what
      an operator recorded; it is not the carrier and cannot guarantee delivery.
    </p>
  </div>
</body></html>`;

const STATUS_ROWS = `<table role="presentation" style="width:100%;border-collapse:collapse;margin:16px 0;font-size:14px;">
  <tr><td style="padding:6px 0;color:#64748b;">Tracking number</td><td style="padding:6px 0;text-align:right;font-weight:600;">{{trackingNumber}}</td></tr>
  <tr><td style="padding:6px 0;color:#64748b;">Carrier</td><td style="padding:6px 0;text-align:right;">{{carrierName}}</td></tr>
  <tr><td style="padding:6px 0;color:#64748b;">Latest update</td><td style="padding:6px 0;text-align:right;">{{statusLabel}}</td></tr>
  <tr><td style="padding:6px 0;color:#64748b;">Where</td><td style="padding:6px 0;text-align:right;">{{locationText}}</td></tr>
  <tr><td style="padding:6px 0;color:#64748b;">Updated</td><td style="padding:6px 0;text-align:right;">{{occurredAt}}</td></tr>
  <tr><td style="padding:6px 0;color:#64748b;">Estimated delivery</td><td style="padding:6px 0;text-align:right;">{{estimatedDelivery}}</td></tr>
</table>`;

const TRACK_BLOCK = `{{publicUrlBlock}}`;

const TRACK_BLOCK_DISABLED = `<p style="margin:0 0 16px;font-size:13px;color:#64748b;">
  No public tracking link has been published for this shipment. Please contact the sender for updates.
</p>`;

const STATUS_ROW_BLOCKER = `${STATUS_ROWS}
      ${TRACK_BLOCK}`;

export const DEFAULT_NOTIFICATION_TEMPLATES: EmailTemplateDefinition[] = [
  {
    type: 'shipment_created',
    subject: 'Your shipment {{trackingNumber}} is registered',
    bodyHtml: LAYOUT(`
      <h1 style="font-size:20px;margin:0 0 12px;">Shipment registered</h1>
      <p style="margin:0 0 8px;">Hello,</p>
      <p style="margin:0 0 12px;">We are now tracking your shipment{{publicReferenceBlock}}.</p>
      ${STATUS_ROWS}
      ${TRACK_BLOCK}
    `),
  },
  {
    type: 'in_transit',
    subject: 'Your shipment {{trackingNumber}} is in transit',
    bodyHtml: LAYOUT(`
      <h1 style="font-size:20px;margin:0 0 12px;">On its way</h1>
      <p style="margin:0 0 12px;">Your shipment is moving through the carrier network.</p>
      ${STATUS_ROW_BLOCKER}
    `),
  },
  {
    type: 'out_for_delivery',
    subject: 'Your shipment {{trackingNumber}} is out for delivery',
    bodyHtml: LAYOUT(`
      <h1 style="font-size:20px;margin:0 0 12px;">Out for delivery today</h1>
      <p style="margin:0 0 12px;">Your parcel is with the courier for final delivery.</p>
      ${STATUS_ROW_BLOCKER}
    `),
  },
  {
    type: 'delivered',
    subject: 'Your shipment {{trackingNumber}} was delivered',
    bodyHtml: LAYOUT(`
      <h1 style="font-size:20px;margin:0 0 12px;">Delivered</h1>
      <p style="margin:0 0 12px;">The carrier reported delivery{{publicReferenceBlock}}.</p>
      ${STATUS_ROW_BLOCKER}
    `),
  },
  {
    type: 'exception',
    subject: 'Action needed for shipment {{trackingNumber}}',
    bodyHtml: LAYOUT(`
      <h1 style="font-size:20px;margin:0 0 12px;">We need your help</h1>
      <p style="margin:0 0 12px;">
        There is a problem with this shipment: <strong>{{exceptionTypeLabel}}</strong>.
      </p>
      ${STATUS_ROW_BLOCKER}
      <p style="margin:0 0 12px;">Next step: {{nextAction}}</p>
    `),
  },
];

export function renderTemplate(template: string, context: ShipmentTemplateContext, isHtml: boolean): string {
  let output = template;
  output = output
    .replace(/\{\{publicUrlBlock\}\}/g, context.publicUrl ? TRACK_BLOCK : TRACK_BLOCK_DISABLED)
    .replace(
      /\{\{publicReferenceBlock\}\}/g,
      context.publicReference ? ` (reference ${context.publicReference})` : '',
    );

  const values: Record<string, string> = {
    organizationName: context.organizationName,
    trackingNumber: context.trackingNumber,
    publicReference: context.publicReference,
    carrierName: context.carrierName,
    statusLabel: context.statusLabel,
    statusMessage: context.statusMessage,
    locationText: context.locationText || 'Not provided',
    occurredAt: context.occurredAt,
    estimatedDelivery: context.estimatedDelivery || 'Not provided',
    publicUrl: context.publicUrl ?? '',
    exceptionTypeLabel: context.exceptionTypeLabel,
    nextAction: context.nextAction,
  };

  for (const key of Object.keys(values)) {
    const raw = values[key] ?? '';
    const safe = isHtml ? escapeHtml(raw) : raw.replace(/[\r\n]+/g, ' ');
    output = output.split(`{{${key}}}`).join(safe);
  }
  return output.replace(/\{\{[a-zA-Z]+\}\}/g, '');
}

export function renderPlainText(template: string, context: ShipmentTemplateContext): string {
  const withBlock = template
    .replace(/\{\{publicUrlBlock\}\}/g, context.publicUrl ? `Track it: ${context.publicUrl}` : 'No public tracking link is available for this shipment.')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ');
  return renderTemplate(withBlock, context, false)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}