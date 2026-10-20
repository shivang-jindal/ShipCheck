/**
 * Development / demo seed (`npm run db:seed`).
 *
 * Refuses to run against a production database. A production account always
 * starts empty.
 */

import { eq } from 'drizzle-orm';

import { addDaysIso, todayIso } from '@shipcheck/shared';

import { loadConfig } from '../config.js';
import { createDatabase, runMigrations } from './client.js';
import { createServices } from '../container.js';
import { createLogger } from '../logger.js';

const DEMO_EMAIL = process.env.SEED_EMAIL ?? 'demo@shipcheck.test';
const DEMO_PASSWORD = process.env.SEED_PASSWORD ?? 'shipcheck-demo-1234';

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.isProduction) {
    throw new Error('Refusing to seed a production database. Run the seed command against a development database.');
  }

  const database = await createDatabase({
    databaseUrl: config.databaseUrl,
    pgliteDataDir: config.pgliteDataDir,
  });
  await runMigrations(database);

  const logger = createLogger({ level: 'info', isProduction: false, name: 'seed' });
  const services = createServices({ db: database.db, config, logger });

  try {
    const { users } = await import('./schema.js');
    const existing = await database.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, DEMO_EMAIL))
      .limit(1);
    if (existing[0]) {
      console.log(`[db:seed] ${DEMO_EMAIL} already exists; nothing to do.`);
      return;
    }

    const { user } = await services.auth.register({
      email: DEMO_EMAIL,
      password: DEMO_PASSWORD,
      displayName: 'Demo Ops',
    });

    const organization = await services.organizations.create({
      name: 'Demo Fulfilment',
      countryCode: 'GB',
      timezone: 'Europe/London',
      baseCurrency: 'GBP',
      ownerId: user.id,
    });
    await services.organizations.seedTemplates(organization.id);

    const today = todayIso('Europe/London');

    const moving = await services.shipments.create(organization.id, user.id, {
      trackingNumber: 'DEMO123456789',
      carrierCode: 'manual',
      orderReference: 'ORD-1001',
      publicReference: 'PKG-A1',
      customerName: 'Ada Lovelace',
      customerEmail: 'ada@example.test',
      destinationCountry: 'GB',
      shippedAt: addDaysIso(today, -3),
      estimatedDeliveryAt: addDaysIso(today, 1),
    });

    await services.shipments.addManualEvent(organization.id, user.id, moving.shipment.id, {
      eventCode: 'in_transit',
      description: 'Departed the origin depot (recorded manually).',
      locationText: 'Birmingham, UK',
      occurredAt: addDaysIso(today, -1),
      isCustomerVisible: true,
    });

    const delayed = await services.shipments.create(organization.id, user.id, {
      trackingNumber: 'DEMO987654321',
      carrierCode: 'manual',
      orderReference: 'ORD-1002',
      publicReference: 'PKG-B2',
      customerName: 'Grace Hopper',
      customerEmail: 'grace@example.test',
      destinationCountry: 'IE',
      shippedAt: addDaysIso(today, -9),
    });

    await services.exceptions.open(organization.id, {
      shipmentId: delayed.shipment.id,
      type: 'stalled',
      severity: 'high',
      detail: 'No tracking event recorded for several days.',
      createdBy: user.id,
    });
    await services.shipments.markDerivedStatus(organization.id, delayed.shipment.id, 'exception');

    const delivered = await services.shipments.create(organization.id, user.id, {
      trackingNumber: 'DEMO555000111',
      carrierCode: 'manual',
      orderReference: 'ORD-0999',
      customerName: 'Alan Turing',
      destinationCountry: 'GB',
      shippedAt: addDaysIso(today, -12),
    });
    await services.shipments.addManualEvent(organization.id, user.id, delivered.shipment.id, {
      eventCode: 'delivered',
      description: 'Left with a neighbour (recorded manually).',
      locationText: 'Manchester, UK',
      occurredAt: addDaysIso(today, -4),
      isCustomerVisible: true,
    });

    console.log('[db:seed] demo workspace created.');
    console.log(`           email:      ${DEMO_EMAIL}`);
    console.log(`           password:   ${DEMO_PASSWORD}`);
    console.log(`           organization: ${organization.name} (${organization.slug})`);
    console.log('           shipments:  3 (in transit, exception, delivered)');
    console.log('           note:       every event above was recorded manually - no carrier is connected.');
  } finally {
    await database.close();
  }
}

main().catch((error: unknown) => {
  console.error('[db:seed] failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});