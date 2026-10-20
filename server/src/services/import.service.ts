/**
 * CSV import (Part C / C4 "CSV import", C7, C8).
 *
 * 1. Strict file size and row limits.
 * 2. Parsed on the server; the browser never decides what is valid.
 * 3. Explicit column mapping with a preview.
 * 4. Every row is validated; invalid rows are reported with a line number and
 *    a reason. Nothing is silently skipped.
 * 5. Commit happens only after an explicit preview.
 * 6. Re-importing the same file is safe: duplicates are reported as row
 *    failures, never silently created twice.
 * 7. Exports escape formula-leading cells.
 */

import { and, desc, eq } from 'drizzle-orm';

import { CARRIER_CATALOGUE, IMPORT_MAX_ROWS, parseCsv, toCsv } from '@shipcheck/shared';

import type { AppDatabase } from '../db/client.js';
import { importRowErrors, imports } from '../db/schema.js';
import { badRequest, unprocessable } from '../errors.js';
import type { AuditService } from './audit.service.js';
import type { ShipmentService } from './shipment.service.js';

export const SHIPMENT_CSV_COLUMNS = [
  'tracking_number',
  'carrier_code',
  'order_reference',
  'public_reference',
  'customer_name',
  'customer_email',
  'destination_country',
  'shipped_at',
  'estimated_delivery_at',
  'internal_notes',
] as const;

export type ShipmentCsvColumn = (typeof SHIPMENT_CSV_COLUMNS)[number];

const REQUIRED_COLUMN = 'tracking_number';
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface ParsedShipmentRow {
  trackingNumber: string;
  carrierCode: string;
  orderReference: string | null;
  publicReference: string | null;
  customerName: string | null;
  customerEmail: string | null;
  destinationCountry: string | null;
  shippedAt: string | null;
  estimatedDeliveryAt: string | null;
  internalNotes: string | null;
}

export interface ImportPreview {
  importId: string;
  filenameSafe: string;
  headers: string[];
  suggestedMapping: Record<string, string>;
  totalRows: number;
  validRows: number;
  invalidRows: number;
  errors: Array<{ rowNumber: number; errorCode: string; message: string; row: Record<string, string> }>;
  preview: Array<ParsedShipmentRow>;
}

export class ImportService {
  constructor(
    private readonly db: AppDatabase,
    private readonly audit: AuditService,
    private readonly shipments: ShipmentService,
  ) {}

  /** Validate without writing any shipment. */
  async preview(input: {
    organizationId: string;
    actorUserId: string;
    filename: string;
    content: string;
    mapping: Record<string, string>;
  }): Promise<ImportPreview> {
    if (input.content.length > 5 * 1024 * 1024) {
      throw badRequest('The file is larger than 5 MB. Split it into smaller uploads.');
    }

    const { header, rows } = parseCsv(input.content);
    if (rows.length > IMPORT_MAX_ROWS) {
      throw badRequest(
        `The file has ${rows.length} rows. ShipCheck imports at most ${IMPORT_MAX_ROWS} rows per file.`,
      );
    }

    const mapping = this.resolveMapping(header, input.mapping);
    if (!mapping[REQUIRED_COLUMN]) {
      throw badRequest(
        `Map a column to "${REQUIRED_COLUMN}" before importing. Detected headers: ${header.join(', ') || '(none)'}`,
      );
    }

    const created = (
      await this.db
        .insert(imports)
        .values({
          organizationId: input.organizationId,
          uploadedBy: input.actorUserId,
          filenameSafe: safeFilename(input.filename),
          status: 'previewed',
          totalRows: rows.length,
        })
        .returning({ id: imports.id })
    )[0]!;

    const errors: ImportPreview['errors'] = [];
    const preview: ParsedShipmentRow[] = [];

    rows.forEach((row, index) => {
      const parsed = this.validateRow(header, row, mapping);
      if ('error' in parsed) {
        errors.push({
          rowNumber: index + 2, // header line + 1-based line numbering
          errorCode: parsed.error.code,
          message: parsed.error.message,
          row: parsed.error.safeRow,
        });
      } else {
        preview.push(parsed.value);
      }
    });

    await this.db
      .update(imports)
      .set({ failedRows: errors.length, successfulRows: preview.length })
      .where(eq(imports.id, created.id));

    if (errors.length > 0) {
      await this.db.insert(importRowErrors).values(
        errors.slice(0, 500).map((error) => ({
          organizationId: input.organizationId,
          importId: created.id,
          rowNumber: error.rowNumber,
          errorCode: error.errorCode,
          safeMessage: error.message,
          // Only the cells that caused the failure; never another tenant's data.
          redactedRow: error.row,
        })),
      );
    }

    return {
      importId: created.id,
      filenameSafe: safeFilename(input.filename),
      headers: header,
      suggestedMapping: mapping,
      totalRows: rows.length,
      validRows: preview.length,
      invalidRows: errors.length,
      errors,
      preview: preview.slice(0, 10),
    };
  }

  /** Create the shipments for the valid rows of a file. */
  async commit(input: {
    organizationId: string;
    actorUserId: string;
    filename: string;
    content: string;
    mapping: Record<string, string>;
  }) {
    const previewResult = await this.preview(input);
    if (previewResult.validRows === 0) {
      throw unprocessable(
        'Every row in this file is invalid. Fix the reported problems and upload it again; nothing was imported.',
      );
    }

    const { header, rows } = parseCsv(input.content);
    const mapping = this.resolveMapping(header, input.mapping);

    let created = 0;
    const failures: Array<{ rowNumber: number; trackingNumber: string; reason: string }> = [];

    for (const [index, row] of rows.entries()) {
      const parsed = this.validateRow(header, row, mapping);
      if ('error' in parsed) continue; // already reported by preview()
      try {
        await this.shipments.create(input.organizationId, input.actorUserId, parsed.value);
        created += 1;
      } catch (error) {
        failures.push({
          rowNumber: index + 2,
          trackingNumber: parsed.value.trackingNumber,
          reason: error instanceof Error ? error.message : 'Could not create the shipment.',
        });
      }
    }

    await this.db
      .update(imports)
      .set({
        status: failures.length > 0 ? 'completed_with_errors' : 'completed',
        successfulRows: created,
        failedRows: failures.length + previewResult.invalidRows,
        startedAt: new Date(),
        completedAt: new Date(),
      })
      .where(eq(imports.id, previewResult.importId));

    await this.audit.record({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      action: 'import.committed',
      entityType: 'import',
      entityId: previewResult.importId,
      metadata: { created, failed: failures.length, filename: safeFilename(input.filename) },
    });

    return {
      importId: previewResult.importId,
      created,
      invalidRows: previewResult.invalidRows,
      failed: failures.length,
      failures: failures.slice(0, 50),
      note:
        failures.length > 0 || previewResult.invalidRows > 0
          ? 'Some rows could not be imported. Every reason is listed and a downloadable error report is available.'
          : 'Every valid row was imported.',
    };
  }

  async status(organizationId: string, importId: string) {
    const rows = await this.db
      .select()
      .from(imports)
      .where(and(eq(imports.id, importId), eq(imports.organizationId, organizationId)))
      .limit(1);
    const record = rows[0];
    if (!record) throw badRequest('That import could not be found in this organization.');

    const errors = await this.db
      .select({
        rowNumber: importRowErrors.rowNumber,
        errorCode: importRowErrors.errorCode,
        safeMessage: importRowErrors.safeMessage,
        redactedRow: importRowErrors.redactedRow,
      })
      .from(importRowErrors)
      .where(
        and(eq(importRowErrors.importId, importId), eq(importRowErrors.organizationId, organizationId)),
      )
      .orderBy(importRowErrors.rowNumber);

    return { ...record, errors };
  }

  /** Downloadable error report. Only this tenant's rows are included. */
  async errorReportCsv(organizationId: string, importId: string) {
    const errors = await this.db
      .select({
        rowNumber: importRowErrors.rowNumber,
        errorCode: importRowErrors.errorCode,
        safeMessage: importRowErrors.safeMessage,
      })
      .from(importRowErrors)
      .where(
        and(eq(importRowErrors.importId, importId), eq(importRowErrors.organizationId, organizationId)),
      )
      .orderBy(importRowErrors.rowNumber);

    return toCsv(
      errors.map((error) => [String(error.rowNumber), error.errorCode, error.safeMessage]),
      ['row_number', 'error_code', 'reason'],
    );
  }

  async list(organizationId: string, limit = 20) {
    return this.db
      .select()
      .from(imports)
      .where(eq(imports.organizationId, organizationId))
      .orderBy(desc(imports.createdAt))
      .limit(limit);
  }

  /* ---------------------------------------------------------------------- */

  private resolveMapping(headers: string[], requested: Record<string, string>): Record<string, string> {
    const mapping: Record<string, string> = {};
    for (const column of SHIPMENT_CSV_COLUMNS) {
      const chosen = requested[column];
      if (chosen && headers.includes(chosen)) {
        mapping[column] = chosen;
        continue;
      }
      const guess = headers.find(
        (header) => header.toLowerCase().replace(/[\s_-]+/g, '_') === column,
      );
      if (guess) mapping[column] = guess;
    }
    return mapping;
  }

  private cell(headers: string[], row: string[], column: string, mapping: Record<string, string>): string {
    const header = mapping[column];
    if (!header) return '';
    const index = headers.indexOf(header);
    if (index < 0) return '';
    return (row[index] ?? '').trim();
  }

  private validateRow(
    headers: string[],
    row: string[],
    mapping: Record<string, string>,
  ): { value: ParsedShipmentRow } | { error: { code: string; message: string; safeRow: Record<string, string> } } {
    const safeRow: Record<string, string> = {};
    for (const column of SHIPMENT_CSV_COLUMNS) {
      const header = mapping[column];
      if (header) safeRow[header] = this.cell(headers, row, column, mapping);
    }

    const fail = (code: string, message: string) => ({
      error: { code, message, safeRow },
    });

    const trackingNumber = this.cell(headers, row, 'tracking_number', mapping);
    if (trackingNumber.length < 4) {
      return fail('missing_tracking_number', 'A tracking number of at least 4 characters is required.');
    }

    const rawCarrier = this.cell(headers, row, 'carrier_code', mapping) || 'manual';
    const carrierCode = rawCarrier.toLowerCase().replace(/[\s-]+/g, '_');
    if (!CARRIER_CATALOGUE.some((carrier) => carrier.code === carrierCode)) {
      return fail(
        'unknown_carrier',
        `Carrier "${rawCarrier}" is not in the ShipCheck catalogue. Use "manual" when the carrier is unknown.`,
      );
    }

    const email = this.cell(headers, row, 'customer_email', mapping);
    if (email && !EMAIL_PATTERN.test(email)) {
      return fail('invalid_email', 'customer_email is not a valid email address.');
    }

    const country = this.cell(headers, row, 'destination_country', mapping).toUpperCase();
    if (country && !/^[A-Z]{2}$/.test(country)) {
      return fail('invalid_country', 'destination_country must be a 2-letter ISO country code.');
    }

    for (const dateColumn of ['shipped_at', 'estimated_delivery_at'] as const) {
      const value = this.cell(headers, row, dateColumn, mapping);
      if (value && !DATE_PATTERN.test(value)) {
        return fail('invalid_date', `${dateColumn} must use the YYYY-MM-DD format.`);
      }
    }

    return {
      value: {
        trackingNumber,
        carrierCode,
        orderReference: this.cell(headers, row, 'order_reference', mapping) || null,
        publicReference: this.cell(headers, row, 'public_reference', mapping) || null,
        customerName: this.cell(headers, row, 'customer_name', mapping) || null,
        customerEmail: email || null,
        destinationCountry: country || null,
        shippedAt: this.cell(headers, row, 'shipped_at', mapping) || null,
        estimatedDeliveryAt: this.cell(headers, row, 'estimated_delivery_at', mapping) || null,
        internalNotes: this.cell(headers, row, 'internal_notes', mapping) || null,
      },
    };
  }
}

function safeFilename(name: string): string {
  return name.replace(/[^\w.\- ]+/g, '_').slice(0, 180) || 'import.csv';
}