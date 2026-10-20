/**
 * Domain rules: status normalization, event de-duplication, out-of-order
 * events, unknown codes, CSV parsing and the honest carrier boundary (C4).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  escapeCsvCell,
  IMPORT_MAX_ROWS,
  normalizeStatus,
  parseCsv,
  type ShipmentInput,
} from '@shipcheck/shared';

import { createTestContext, seedTenant, type TestContext } from './harness.js';

let context: TestContext;

beforeAll(async () => {
  context = await createTestContext();
});

afterAll(async () => {
  await context.close();
});

function shipmentInput(overrides: Partial<ShipmentInput> = {}): ShipmentInput {
  return {
    trackingNumber: 'TRK-0001',
    carrierCode: 'manual',
    orderReference: null,
    publicReference: null,
    customerName: null,
    customerEmail: null,
    destinationCountry: null,
    shippedAt: null,
    estimatedDeliveryAt: null,
    internalNotes: null,
    ...overrides,
  };
}

describe('status normalization (C4 step 7)', () => {
  it('maps known carrier codes case-insensitively', () => {
    expect(normalizeStatus('delivered')).toBe('delivered');
    expect(normalizeStatus('DELIVERED')).toBe('delivered');
    expect(normalizeStatus('Out For Delivery')).toBe('out_for_delivery');
    expect(normalizeStatus('out-for-delivery')).toBe('out_for_delivery');
    expect(normalizeStatus('info_received')).toBe('label_created');
    expect(normalizeStatus('pod')).toBe('delivered');
  });

  it('maps an unrecognised code to unknown rather than guessing', () => {
    expect(normalizeStatus('wibble')).toBe('unknown');
    expect(normalizeStatus('TENTH_MOON')).toBe('unknown');
    expect(normalizeStatus('')).toBe('unknown');
  });
});

describe('event de-duplication and ordering (C4 steps 5-7)', () => {
  it('is not pinned to "label created" by the synthetic creation record', async () => {
    const { user, organization } = await seedTenant(context, {
      email: 'bootstrap@test.local',
      organizationName: 'Bootstrap Co',
    });
    const created = await context.services.shipments.create(
      organization.id,
      user.id,
      shipmentInput({ trackingNumber: 'BOOTSTRAP-1' }),
    );
    const shipmentId = created.shipment.id;

    // The creation record is stamped `now`; a carrier event is backdated.
    await context.services.shipments.appendEvent(organization.id, shipmentId, {
      source: 'carrier',
      eventCode: 'in_transit',
      description: 'Moving through the network',
      eventAt: new Date('2020-06-01T09:00:00.000Z'),
      providerEventId: 'boot-1',
    });

    const detail = await context.services.shipments.detail(organization.id, shipmentId);
    // The real event must win, otherwise no shipment could ever progress.
    expect(detail.shipment.status).toBe('in_transit');
    expect(detail.shipment.lastEventAt).toBe('2020-06-01T09:00:00.000Z');
    // The creation record is still on the timeline.
    expect(detail.events.length).toBeGreaterThan(1);
  });

  it('ignores a repeated provider event id', async () => {
    const { user, organization } = await seedTenant(context, {
      email: 'dedupe@test.local',
      organizationName: 'Dedupe Co',
    });
    const created = await context.services.shipments.create(
      organization.id,
      user.id,
      shipmentInput({ trackingNumber: 'DEDUPE-1' }),
    );
    const shipmentId = created.shipment.id;

    const event = {
      source: 'carrier' as const,
      eventCode: 'departed',
      description: 'Left the depot',
      eventAt: new Date('2026-01-02T10:00:00.000Z'),
      providerEventId: 'carrier-event-1',
    };

    const first = await context.services.shipments.appendEvent(
      organization.id,
      shipmentId,
      event,
    );
    expect(first.deduplicated).toBe(false);

    const second = await context.services.shipments.appendEvent(
      organization.id,
      shipmentId,
      event,
    );
    // The duplicate is reported, not silently written twice.
    expect(second.deduplicated).toBe(true);

    const detail = await context.services.shipments.detail(organization.id, shipmentId);
    const departed = detail.events.filter((candidate) => candidate.providerEventId === 'carrier-event-1');
    expect(departed).toHaveLength(1);
  });

  it('derives status from the newest event time, not arrival order', async () => {
    const { user, organization } = await seedTenant(context, {
      email: 'ordering@test.local',
      organizationName: 'Ordering Co',
    });
    const created = await context.services.shipments.create(
      organization.id,
      user.id,
      shipmentInput({ trackingNumber: 'ORDER-1' }),
    );
    const shipmentId = created.shipment.id;

    // Arrives newest-first.
    await context.services.shipments.appendEvent(organization.id, shipmentId, {
      source: 'carrier',
      eventCode: 'delivered',
      description: 'Delivered',
      eventAt: new Date('2026-02-02T12:00:00.000Z'),
      providerEventId: 'e-delivered',
    });
    await context.services.shipments.appendEvent(organization.id, shipmentId, {
      source: 'carrier',
      eventCode: 'departed',
      description: 'Departed',
      eventAt: new Date('2026-02-01T08:00:00.000Z'),
      providerEventId: 'e-departed',
    });

    const detail = await context.services.shipments.detail(organization.id, shipmentId);
    expect(detail.shipment.status).toBe('delivered');
    expect(detail.shipment.lastEventAt).toBe('2026-02-02T12:00:00.000Z');
  });

  it('does not downgrade status when an older event arrives late', async () => {
    const { user, organization } = await seedTenant(context, {
      email: 'nodowngrade@test.local',
      organizationName: 'No Downgrade Co',
    });
    const created = await context.services.shipments.create(
      organization.id,
      user.id,
      shipmentInput({ trackingNumber: 'NODOWN-1' }),
    );
    const shipmentId = created.shipment.id;

    await context.services.shipments.appendEvent(organization.id, shipmentId, {
      source: 'carrier',
      eventCode: 'out_for_delivery',
      description: 'Out for delivery',
      eventAt: new Date('2026-03-02T09:00:00.000Z'),
      providerEventId: 'late-1',
    });
    await context.services.shipments.appendEvent(organization.id, shipmentId, {
      source: 'carrier',
      eventCode: 'in_transit',
      description: 'Still moving',
      eventAt: new Date('2026-03-01T09:00:00.000Z'),
      providerEventId: 'late-0',
    });

    const detail = await context.services.shipments.detail(organization.id, shipmentId);
    expect(detail.shipment.status).toBe('out_for_delivery');
  });

  it('stores an unknown carrier code as unknown and keeps the raw wording', async () => {
    const { user, organization } = await seedTenant(context, {
      email: 'unknown@test.local',
      organizationName: 'Unknown Co',
    });
    const created = await context.services.shipments.create(
      organization.id,
      user.id,
      shipmentInput({ trackingNumber: 'UNKNOWN-1' }),
    );
    const shipmentId = created.shipment.id;

    await context.services.shipments.appendEvent(organization.id, shipmentId, {
      source: 'carrier',
      eventCode: 'something_carriers_never_said',
      description: 'Unrecognized carrier wording',
      eventAt: new Date('2026-04-01T09:00:00.000Z'),
      providerEventId: 'u-1',
    });

    const detail = await context.services.shipments.detail(organization.id, shipmentId);
    expect(detail.shipment.lastCarrierStatus).toBe('unknown');
    const stored = detail.events.find((event) => event.providerEventId === 'u-1');
    // The original code is preserved for the operator, never overwritten.
    expect(stored?.eventCode).toBe('something_carriers_never_said');
  });
});

describe('manual events are labelled (C3.3)', () => {
  it('marks a manual event as manual and hides it from the customer by default', async () => {
    const { user, organization } = await seedTenant(context, {
      email: 'manual@test.local',
      organizationName: 'Manual Co',
    });
    const created = await context.services.shipments.create(
      organization.id,
      user.id,
      shipmentInput({ trackingNumber: 'MANUAL-1' }),
    );
    const shipmentId = created.shipment.id;

    await context.services.shipments.addManualEvent(
      organization.id,
      user.id,
      shipmentId,
      {
        eventCode: 'delivered',
        description: 'Customer confirmed by phone',
        occurredAt: '2024-05-01',
        isCustomerVisible: false,
      },
    );

    const detail = await context.services.shipments.detail(organization.id, shipmentId);
    const manual = detail.events.filter((event) => event.eventCode === 'delivered');
    expect(manual).toHaveLength(1);
    expect(manual[0]?.source).toBe('manual');
    expect(manual[0]?.isCustomerVisible).toBe(false);
  });
});

describe('carrier boundary is honest (C3.2)', () => {
  it('reports every carrier as not implemented and never claims a connection', async () => {
    const { organization } = await seedTenant(context, {
      email: 'carrier@test.local',
      organizationName: 'Carrier Co',
    });

    const carriers = await context.services.integrations.list(organization.id);
    expect(carriers.length).toBeGreaterThan(0);
    for (const carrier of carriers) {
      expect(carrier.implemented).toBe(false);
      expect(carrier.status).not.toBe('configured');
      // The limitation must be stated, not hidden.
      expect(carrier.limitations.join(' ')).toMatch(/no automated polling|adapter|implement/i);
    }
  });

  it('refuses to poll a carrier that has no adapter', async () => {
    const { organization } = await seedTenant(context, {
      email: 'poll@test.local',
      organizationName: 'Poll Co',
    });

    await expect(context.services.integrations.pollCarrier(organization.id, 'dhl')).rejects.toMatchObject({
      code: 'INTEGRATION_UNAVAILABLE',
    });
  });

  it('reports a failed connection test truthfully', async () => {
    const { organization, user } = await seedTenant(context, {
      email: 'testconn@test.local',
      organizationName: 'Test Conn Co',
    });

    const result = await context.services.integrations.test(organization.id, 'dhl', user.id);
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/no implemented adapter/i);
    expect(result.status).toBe('not_configured');

    const carriers = await context.services.integrations.list(organization.id);
    const dhl = carriers.find((carrier) => carrier.carrierCode === 'dhl');
    expect(dhl?.lastErrorCode).toBe('adapter_not_implemented');
  });
});

describe('CSV import (C4)', () => {
  it('maps columns, validates rows and reports every problem', async () => {
    const { organization, user } = await seedTenant(context, {
      email: 'import@test.local',
      organizationName: 'Import Co',
    });

    const csv = [
      'Tracking Number,Carrier,Client Email,Country',
      'IMP-1,ups,buyer@example.com,US',
      'IMP-2,,not-an-email,US',
      ',dhl,buyer@example.com,DE',
    ].join('\n');

    const preview = await context.services.imports.preview({
      organizationId: organization.id,
      actorUserId: user.id,
      filename: 'shipments.csv',
      content: csv,
      // Column matching is exact after normalization; a synonym like
      // "Client Email" is never guessed at, so the mapping is explicit.
      mapping: { customer_email: 'Client Email', destination_country: 'Country' },
    });

    expect(preview.totalRows).toBe(3);
    expect(preview.validRows).toBe(1);
    expect(preview.invalidRows).toBe(2);
    expect(preview.errors.some((error) => error.errorCode === 'missing_tracking_number')).toBe(true);
    expect(preview.errors.some((error) => error.errorCode === 'invalid_email')).toBe(true);
    // Row numbers point at the real line in the file.
    expect(preview.errors.map((error) => error.rowNumber).sort()).toEqual([3, 4]);
  });

  it('refuses to preview without a tracking_number column', async () => {
    const { organization, user } = await seedTenant(context, {
      email: 'nocol@test.local',
      organizationName: 'No Column Co',
    });

    await expect(
      context.services.imports.preview({
        organizationId: organization.id,
        actorUserId: user.id,
        filename: 'bad.csv',
        content: 'name,city\nWidget,London',
        mapping: {},
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('rejects a file with more rows than the import limit', async () => {
    const { organization, user } = await seedTenant(context, {
      email: 'toomany@test.local',
      organizationName: 'Too Many Co',
    });

    const header = 'tracking_number\n';
    const rows = Array.from({ length: IMPORT_MAX_ROWS + 5 }, (_, index) => `TOOBIG-${index}`).join('\n');
    await expect(
      context.services.imports.preview({
        organizationId: organization.id,
        actorUserId: user.id,
        filename: 'huge.csv',
        content: header + rows,
        mapping: {},
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('never lets a formula-leading cell reach a spreadsheet', async () => {
    // The escaping guarantee itself.
    expect(escapeCsvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(escapeCsvCell('+1')).toBe("'+1");
    expect(escapeCsvCell('normal')).toBe('normal');

    const { organization, user } = await seedTenant(context, {
      email: 'formula@test.local',
      organizationName: 'Formula Co',
    });

    // A row whose failing cell begins with '='.
    const csv = ['tracking_number,customer_email', 'FORMULA-1,=not an email'].join('\n');
    const preview = await context.services.imports.preview({
      organizationId: organization.id,
      actorUserId: user.id,
      filename: 'formula.csv',
      content: csv,
      mapping: {},
    });

    expect(preview.errors).toHaveLength(1);

    // The error report carries only the row number, code and reason, so no
    // submitted value can ever be rendered as a live formula.
    const report = await context.services.imports.errorReportCsv(organization.id, preview.importId);
    expect(report).toContain('row_number');
    expect(report).not.toMatch(/^[^\n]*,\s*=|\r\n[0-9]+,[^,]*,\s*=/m);

    // The created CSV export escapes every cell it writes.
    const created = await context.services.shipments.create(
      organization.id,
      user.id,
      {
        trackingNumber: 'EXPORT-FORMULA-1',
        carrierCode: 'manual',
        orderReference: '=SUM(1:9)',
        publicReference: null,
        customerName: '+1',
        customerEmail: null,
        destinationCountry: null,
        shippedAt: null,
        estimatedDeliveryAt: null,
        internalNotes: null,
      },
    );
    expect(created.shipment.id).toBeTruthy();

    const exported = await context.services.exports.shipmentsCsv({
      organizationId: organization.id,
      actorUserId: user.id,
      includeCustomerEmail: false,
    });
    expect(exported.csv).toContain("'=SUM(1:9)");

    // No exported cell may begin with a formula trigger.
    const { rows } = parseCsv(exported.csv);
    for (const row of rows) {
      for (const cell of row) {
        expect(['=', '+', '-', '@']).not.toContain(cell.charAt(0));
      }
    }
  });
});