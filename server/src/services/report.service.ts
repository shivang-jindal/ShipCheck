/**
 * Operations dashboard and delivery analytics (Part C / C3.1, C3.9).
 *
 * Every metric is derived from shipment and event records. Sample sizes and
 * the data window are always shown, and carrier comparisons are only produced
 * with an explicit warning about comparability.
 */

import { and, count, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';

import { SHIPMENT_STATUS_LABELS, todayIso, type ShipmentStatus } from '@shipcheck/shared';

import type { AppDatabase } from '../db/client.js';
import { shipmentExceptions, shipments } from '../db/schema.js';
import type { ExceptionService } from './exception.service.js';
import { carrierName } from './shipment.service.js';

export interface OperationsDashboard {
  generatedAt: string;
  range: { from: string; to: string };
  counts: Record<ShipmentStatus, number>;
  totals: number;
  openExceptions: number;
  untrackedWithoutCarrier: number;
  staleShipments: number;
  recentExceptions: Array<{
    id: string;
    trackingNumber: string;
    type: string;
    severity: string;
    openedAt: string;
  }>;
  oldestOpenExceptionHours: number;
  carrierBreakdown: Array<{ carrierCode: string; carrierName: string; count: number; exceptions: number }>;
  agingList: Array<{
    shipmentId: string;
    trackingNumber: string;
    customerName: string | null;
    carrierCode: string;
    status: ShipmentStatus;
    lastEventAt: string | null;
    ageHours: number;
    openExceptions: number;
  }>;
  definitions: Record<string, string>;
}

export class ReportService {
  constructor(
    private readonly db: AppDatabase,
    private readonly exceptions: ExceptionService,
  ) {}

  async dashboard(organizationId: string, range: { from?: string; to?: string }): Promise<OperationsDashboard> {
    const to = range.to ?? todayIso('UTC');
    const from = range.from ?? `${to.slice(0, 7)}-01`;

    const statusRows = await this.db
      .select({ status: shipments.status, total: sql<number>`count(*)::int` })
      .from(shipments)
      .where(
        and(
          eq(shipments.organizationId, organizationId),
          sql`${shipments.archivedAt} is null`,
        ),
      )
      .groupBy(shipments.status);

    const counts = Object.fromEntries(statusRows.map((row) => [row.status, row.total])) as Record<
      ShipmentStatus,
      number
    >;
    const totals = statusRows.reduce((sum, row) => sum + row.total, 0);

    const exceptionSummary = await this.exceptions.summary(organizationId);

    const manualRows = await this.db
      .select({ total: sql<number>`count(*)::int` })
      .from(shipments)
      .where(
        and(
          eq(shipments.organizationId, organizationId),
          eq(shipments.carrierCode, 'manual'),
          sql`${shipments.archivedAt} is null`,
        ),
      );

    const staleCutoff = new Date(Date.now() - 72 * 3_600_000);
    const staleRows = await this.db
      .select({ total: sql<number>`count(*)::int` })
      .from(shipments)
      .where(
        and(
          eq(shipments.organizationId, organizationId),
          sql`${shipments.archivedAt} is null`,
          sql`${shipments.status} in ('label_created','in_transit','out_for_delivery')`,
          sql`(${shipments.lastEventAt} is null or ${shipments.lastEventAt} < ${staleCutoff})`,
        ),
      );

    const recentExceptions = await this.db
      .select({
        id: shipmentExceptions.id,
        trackingNumber: shipments.trackingNumber,
        type: shipmentExceptions.type,
        severity: shipmentExceptions.severity,
        openedAt: shipmentExceptions.openedAt,
      })
      .from(shipmentExceptions)
      .innerJoin(shipments, eq(shipments.id, shipmentExceptions.shipmentId))
      .where(
        and(
          eq(shipmentExceptions.organizationId, organizationId),
          inArray(shipmentExceptions.status, ['open', 'acknowledged']),
        ),
      )
      .orderBy(desc(shipmentExceptions.openedAt))
      .limit(10);

    /**
     * Per-carrier counts.
     *
     * The per-shipment exception count is computed in an inner query first.
     * Selecting it directly alongside `GROUP BY carrier_code` would reference
     * `shipments.id` from an ungrouped outer query, which PostgreSQL rejects.
     */
    const carrierRows = await this.db.execute<{
      carrier_code: string;
      total: number;
      exceptions: number;
    }>(sql`
      select per_carrier.carrier_code,
             count(*)::int as total,
             coalesce(sum(per_carrier.exceptions), 0)::int as exceptions
        from (
          select s.carrier_code,
                 (select count(*)::int
                    from shipment_exceptions e
                   where e.shipment_id = s.id
                     and e.status in ('open','acknowledged')) as exceptions
            from shipments s
           where s.organization_id = ${organizationId}
             and s.archived_at is null
        ) as per_carrier
       group by per_carrier.carrier_code
       order by count(*) desc
    `).then((result) => result.rows);

    const agingList = await this.db
      .select({
        shipmentId: shipments.id,
        trackingNumber: shipments.trackingNumber,
        customerName: shipments.customerName,
        carrierCode: shipments.carrierCode,
        status: shipments.status,
        lastEventAt: shipments.lastEventAt,
        openExceptions: sql<number>`(
          select count(*)::int from shipment_exceptions e
           where e.shipment_id = shipments.id and e.status in ('open','acknowledged')
        )`,
      })
      .from(shipments)
      .where(
        and(
          eq(shipments.organizationId, organizationId),
          sql`${shipments.archivedAt} is null`,
          inArray(shipments.status, ['label_created', 'in_transit', 'out_for_delivery', 'exception']),
        ),
      )
      .orderBy(sql`${shipments.lastEventAt} asc nulls first`)
      .limit(15);

    return {
      generatedAt: new Date().toISOString(),
      range: { from, to },
      counts,
      totals,
      openExceptions:
        (exceptionSummary.byStatus.open ?? 0) + (exceptionSummary.byStatus.acknowledged ?? 0),
      untrackedWithoutCarrier: manualRows[0]?.total ?? 0,
      staleShipments: staleRows[0]?.total ?? 0,
      recentExceptions: recentExceptions.map((row) => ({
        ...row,
        openedAt: row.openedAt.toISOString(),
      })),
      oldestOpenExceptionHours: exceptionSummary.oldestOpenHours,
      carrierBreakdown: carrierRows.map((row) => ({
        carrierCode: row.carrier_code,
        carrierName: carrierName(row.carrier_code),
        count: Number(row.total),
        exceptions: Number(row.exceptions),
      })),
      agingList: agingList.map((row) => ({
        ...row,
        status: row.status as ShipmentStatus,
        lastEventAt: row.lastEventAt?.toISOString() ?? null,
        ageHours: row.lastEventAt
          ? Math.round((Date.now() - row.lastEventAt.getTime()) / 3_600_000)
          : -1,
      })),
      definitions: {
        labelCreated:
          'Shipments registered in ShipCheck with no carrier data received yet. They are not "delayed" by ShipCheck.',
        inTransit: 'Latest meaningful event maps to "in transit".',
        outForDelivery: 'Latest meaningful event maps to "out for delivery".',
        delivered: 'A carrier-reported or manually recorded delivery event exists.',
        exception: 'The latest meaningful event is a delivery exception, failed delivery or address issue.',
        returnedToSender: 'The shipment was returned to the sender.',
        unknown: 'The event code was not recognised. ShipCheck stores it safely and never guesses a meaning.',
        staleShipments:
          'No tracking event for more than 72 hours while the shipment is still moving. A carrier outage does NOT create this state; only shipment staleness does.',
      },
    };
  }

  /** Delivery outcomes, transit time and delay aging for a window. */
  async deliveryReport(
    organizationId: string,
    options: { from?: string; to?: string; carrierCode?: string },
  ) {
    const to = options.to ?? todayIso('UTC');
    const from = options.from ?? `${to.slice(0, 4)}-01-01`;

    const filters = [
      eq(shipments.organizationId, organizationId),
      gte(shipments.createdAt, new Date(`${from}T00:00:00.000Z`)),
      lte(shipments.createdAt, new Date(`${to}T23:59:59.999Z`)),
    ];
    if (options.carrierCode) filters.push(eq(shipments.carrierCode, options.carrierCode));

    const outcomeRows = await this.db
      .select({ status: shipments.status, total: sql<number>`count(*)::int` })
      .from(shipments)
      .where(and(...filters))
      .groupBy(shipments.status);

    // Average transit time only where BOTH endpoints are known.
    const transit = await this.db
      .select({
        carrierCode: shipments.carrierCode,
        sampleSize: sql<number>`count(*)::int`,
        averageHours: sql<number>`coalesce(round(avg(extract(epoch from (${shipments.deliveredAt} - ${shipments.shippedAt})) / 3600)::numeric, 1), 0)::bigint`,
      })
      .from(shipments)
      .where(
        and(
          ...filters,
          sql`${shipments.deliveredAt} is not null and ${shipments.shippedAt} is not null`,
        ),
      )
      .groupBy(shipments.carrierCode);

    const exceptionRows = await this.exceptions.openedBetween(
      organizationId,
      new Date(`${from}T00:00:00.000Z`),
      new Date(`${to}T23:59:59.999Z`),
    );

    const byCarrier: Record<string, { total: number; critical: number }> = {};
    for (const row of exceptionRows) {
      const entry = byCarrier[row.carrierCode] ?? { total: 0, critical: 0 };
      entry.total += 1;
      if (row.severity === 'critical') entry.critical += 1;
      byCarrier[row.carrierCode] = entry;
    }

    const sampleSize = transit.reduce((sum, row) => sum + row.sampleSize, 0);

    return {
      range: { from, to },
      outcomes: outcomeRows.map((row) => ({
        status: row.status as ShipmentStatus,
        label: SHIPMENT_STATUS_LABELS[row.status as ShipmentStatus] ?? row.status,
        count: row.total,
        share:
          outcomeRows.reduce((sum, item) => sum + item.total, 0) > 0
            ? Math.round((row.total / outcomeRows.reduce((sum, item) => sum + item.total, 0)) * 100)
            : 0,
      })),
      totalShipments: outcomeRows.reduce((sum, row) => sum + row.total, 0),
      averageTransitHoursByCarrier: transit.map((row) => ({
        carrierCode: row.carrierCode,
        carrierName: carrierName(row.carrierCode),
        sampleSize: row.sampleSize,
        averageHours: Number(row.averageHours),
      })),
      exceptionsByCarrier: Object.entries(byCarrier).map(([carrierCode, value]) => ({
        carrierCode,
        carrierName: carrierName(carrierCode),
        total: value.total,
        critical: value.critical,
      })),
      delayAging: await this.delayBuckets(organizationId, from, to),
      warnings: [
        `Average transit time is based on ${sampleSize} delivered shipment(s) with both a ship date and a delivery date. Small samples are not comparable.`,
        'Carrier performance is not ranked. Routes, services and data quality differ, so a comparison here would be misleading.',
        'Manual entries are included and labelled as manual; they are not carrier-confirmed data.',
      ],
    };
  }

  private async delayBuckets(organizationId: string, from: string, to: string) {
    const rows = await this.db
      .select({
        openedAt: shipmentExceptions.openedAt,
        resolvedAt: shipmentExceptions.resolvedAt,
      })
      .from(shipmentExceptions)
      .where(
        and(
          eq(shipmentExceptions.organizationId, organizationId),
          gte(shipmentExceptions.openedAt, new Date(`${from}T00:00:00.000Z`)),
          lte(shipmentExceptions.openedAt, new Date(`${to}T23:59:59.999Z`)),
        ),
      );

    const buckets = [
      { label: 'Under 4 hours', maxHours: 4, count: 0 },
      { label: '4-24 hours', maxHours: 24, count: 0 },
      { label: '1-3 days', maxHours: 72, count: 0 },
      { label: 'More than 3 days', maxHours: Number.POSITIVE_INFINITY, count: 0 },
    ];

    for (const row of rows) {
      const hours = Math.round(
        ((row.resolvedAt ?? new Date()).getTime() - row.openedAt.getTime()) / 3_600_000,
      );
      for (const bucket of buckets) {
        if (hours < bucket.maxHours) {
          bucket.count += 1;
          break;
        }
      }
    }
    return buckets;
  }

  async countShipments(organizationId: string) {
    const rows = await this.db
      .select({ total: count() })
      .from(shipments)
      .where(eq(shipments.organizationId, organizationId));
    return rows[0]?.total ?? 0;
  }
}