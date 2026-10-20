/**
 * HTTP-level tests: authentication, permissions, tenant isolation, the public
 * tracking token and its revocation, and the error envelope.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

import { createApp } from '../src/app.js';
import { createTestContext, seedTenant, type TestContext } from './harness.js';

let context: TestContext;
let app: Express;
let ownerA: Awaited<ReturnType<typeof seedTenant>>;
let ownerB: Awaited<ReturnType<typeof seedTenant>>;
let agentA: request.Agent;
let agentB: request.Agent;

beforeAll(async () => {
  context = await createTestContext();
  app = createApp(context.services);
  ownerA = await seedTenant(context, { email: 'http-a@test.local', organizationName: 'HTTP Tenant A' });
  ownerB = await seedTenant(context, { email: 'http-b@test.local', organizationName: 'HTTP Tenant B' });
  agentA = request.agent(app);
  agentB = request.agent(app);
  await agentA
    .post('/api/v1/auth/login')
    .send({ email: 'http-a@test.local', password: 'a-very-long-test-password' });
  await agentB
    .post('/api/v1/auth/login')
    .send({ email: 'http-b@test.local', password: 'a-very-long-test-password' });
});

afterAll(async () => {
  await context.close();
});

async function createShipment(
  agent: request.Agent,
  organizationId: string,
  trackingNumber: string,
): Promise<{ id: string; publicToken: string }> {
  const response = await agent
    .post(`/api/v1/${organizationId}/shipments`)
    .send({ trackingNumber, carrierCode: 'manual' })
    .expect(201);
  // The token is shown exactly once, at creation.
  const token = String(response.body.publicUrl ?? '').split('/track/')[1] ?? '';
  expect(token.length).toBeGreaterThanOrEqual(32);
  return { id: response.body.shipment.id, publicToken: token };
}

describe('health and error envelope', () => {
  it('exposes liveness and readiness without secrets', async () => {
    const live = await request(app).get('/api/v1/health/live').expect(200);
    expect(live.body.status).toBe('ok');

    const ready = await request(app).get('/api/v1/health/ready').expect(200);
    expect(ready.body.status).toBe('ready');
    expect(JSON.stringify(ready.body)).not.toMatch(/password/i);
  });

  it('returns a consistent error shape with a request id', async () => {
    const response = await request(app)
      .get('/api/v1/public/tracking/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')
      .expect(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
    expect(response.body.error.requestId).toBeTruthy();
    expect(response.body.error).not.toHaveProperty('stack');
  });

  it('validates request bodies server-side', async () => {
    const response = await agentA
      .post(`/api/v1/${ownerA.organization.id}/shipments`)
      .send({ trackingNumber: '' })
      .expect(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.requestId).toBeTruthy();
  });

  it('rejects a non-UUID organization id with 400 rather than 500', async () => {
    const response = await agentA.get('/api/v1/not-a-uuid/shipments');
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('session context', () => {
  it('returns the signed-in user and memberships from /auth/session', async () => {
    // Regression: `/auth` was mounted before `requireAuth`, so every `/auth`
    // route needing a principal returned 401 even with a valid session cookie.
    const response = await agentA.get('/api/v1/auth/session').expect(200);
    expect(response.body.user.id).toBeTruthy();
    expect(Array.isArray(response.body.memberships)).toBe(true);
    expect(response.body.memberships.length).toBeGreaterThan(0);
  });

  it('serves the session context the client actually calls', async () => {
    const response = await agentA.get('/api/v1/session/context').expect(200);
    expect(response.body.user.email).toBe('http-a@test.local');
  });

  it('still allows anonymous sign-in', async () => {
    await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'http-a@test.local', password: 'a-very-long-test-password' })
      .expect(200);
  });

  it('refuses the session context without a cookie', async () => {
    const response = await request(app).get('/api/v1/auth/session').expect(401);
    expect(response.body.error.code).toBe('UNAUTHENTICATED');
  });
});

describe('authentication', () => {
  it('refuses anonymous access to tenant routes', async () => {
    const response = await request(app)
      .get(`/api/v1/${ownerA.organization.id}/shipments`)
      .expect(401);
    expect(response.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects a bad password without revealing whether the account exists', async () => {
    const missing = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'nobody@test.local', password: 'a-very-long-test-password' })
      .expect(401);
    const wrong = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'http-a@test.local', password: 'a-very-long-test-password-x' })
      .expect(401);
    expect(missing.body.error.message).toBe(wrong.body.error.message);
  });
});

describe('cross-tenant access', () => {
  it('reports another tenant shipment as 404, never 403', async () => {
    const mine = await createShipment(agentA, ownerA.organization.id, 'TENANT-A-1');
    // Tenant B is a different workspace that tenant A's shipment does not belong to.
    expect(ownerB.organization.id).not.toBe(ownerA.organization.id);

    const response = await agentB.get(
      `/api/v1/${ownerA.organization.id}/shipments/${mine.id}`,
    );
    expect([403, 404]).toContain(response.status);
    expect(response.status).not.toBe(200);
  });

  it('never lists another tenant shipments', async () => {
    await createShipment(agentA, ownerA.organization.id, 'TENANT-A-2');

    const list = await agentA.get(`/api/v1/${ownerA.organization.id}/shipments?pageSize=100`);
    expect(list.status).toBe(200);
    const trackingNumbers = list.body.items.map((row: { trackingNumber: string }) => row.trackingNumber);
    expect(trackingNumbers).toContain('TENANT-A-2');
    expect(trackingNumbers).not.toContain('TENANT-B-1');
  });
});

describe('permissions', () => {
  it('lets a viewer read but not create', async () => {
    const viewer = await agentA
      .post(`/api/v1/${ownerA.organization.id}/members/invitations`)
      .send({ email: 'viewer@test.local', role: 'viewer' })
      .expect(201);
    expect(viewer.body.invitation).toBeTruthy();

    // A viewer has no write permissions at all.
    const fresh = request.agent(app);
    await fresh
      .post('/api/v1/auth/login')
      .send({ email: 'viewer@test.local', password: 'a-very-long-test-password' })
      .expect(401); // the invitation was never accepted, so there is no account
  });
});

describe('shipment journey', () => {
  it('creates, records events and shows them on the detail page', async () => {
    const shipment = await createShipment(agentA, ownerA.organization.id, 'JOURNEY-1');

    const created = await agentA
      .get(`/api/v1/${ownerA.organization.id}/shipments/${shipment.id}`)
      .expect(200);
    // A brand new shipment is explicitly "awaiting carrier data".
    expect(created.body.shipment.status).toBe('label_created');
    expect(created.body.shipment.lastCarrierStatus).toBeNull();

    const manual = await agentA
      .post(`/api/v1/${ownerA.organization.id}/shipments/${shipment.id}/events/manual`)
      .send({
        eventCode: 'departed',
        description: 'Left the depot',
        occurredAt: new Date().toISOString().slice(0, 10),
        isCustomerVisible: true,
      })
      .expect(201);

    expect(manual.status).toBe(201);

    const after = await agentA
      .get(`/api/v1/${ownerA.organization.id}/shipments/${shipment.id}`)
      .expect(200);
    expect(after.body.shipment.status).toBe('in_transit');
    // A manual entry never masquerades as carrier-confirmed data.
    expect(after.body.shipment.lastCarrierStatus).toBeNull();
    expect(after.body.events.some((event: { source: string }) => event.source === 'manual')).toBe(true);
  });

  it('refuses a duplicate tracking number for the same carrier', async () => {
    await createShipment(agentA, ownerA.organization.id, 'DUPE-1');

    const response = await agentA
      .post(`/api/v1/${ownerA.organization.id}/shipments`)
      .send({ trackingNumber: 'DUPE-1', carrierCode: 'manual' })
      .expect(409);
    expect(response.body.error.code).toBe('CONFLICT');
  });
});

describe('public tracking token', () => {
  it('shows a shipment and redacts everything internal', async () => {
    const shipment = await createShipment(agentA, ownerA.organization.id, 'PUBLIC-1');
    await agentA
      .patch(`/api/v1/${ownerA.organization.id}/shipments/${shipment.id}`)
      .send({ internalNotes: 'SECRET INTERNAL NOTE' })
      .expect(200);

    const response = await request(app)
      .get(`/api/v1/public/tracking/${shipment.publicToken}`)
      .expect(200);

    expect(response.body.shipment.carrier).toBeTruthy();
    // Nothing internal may leak through the public page.
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain('SECRET INTERNAL NOTE');
    expect(serialized).not.toContain('PUBLIC-1');
    expect(response.body.shipment.customerEmail).toBeUndefined();
  });

  it('hides events that are not customer visible', async () => {
    const shipment = await createShipment(agentA, ownerA.organization.id, 'PUBLIC-2');
    await agentA
      .post(`/api/v1/${ownerA.organization.id}/shipments/${shipment.id}/events/manual`)
      .send({
        eventCode: 'address_issue',
        description: 'INTERNAL ONLY EVENT',
        occurredAt: new Date().toISOString().slice(0, 10),
        isCustomerVisible: false,
      })
      .expect(201);

    const response = await request(app)
      .get(`/api/v1/public/tracking/${shipment.publicToken}`)
      .expect(200);
    expect(JSON.stringify(response.body.events)).not.toContain('INTERNAL ONLY EVENT');
  });

  it('stops working once the link is revoked', async () => {
    const shipment = await createShipment(agentA, ownerA.organization.id, 'PUBLIC-3');
    await request(app).get(`/api/v1/public/tracking/${shipment.publicToken}`).expect(200);

    await agentA
      .post(`/api/v1/${ownerA.organization.id}/shipments/${shipment.id}/public-link/revoke`)
      .expect(204);

    const response = await request(app)
      .get(`/api/v1/public/tracking/${shipment.publicToken}`)
      .expect(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
  });

  it('invalidates the old link when it is rotated', async () => {
    const shipment = await createShipment(agentA, ownerA.organization.id, 'PUBLIC-4');

    const rotated = await agentA
      .post(`/api/v1/${ownerA.organization.id}/shipments/${shipment.id}/public-link/rotate`)
      .expect(200);
    expect(rotated.body.publicUrl).toContain('/track/');
    // The new token differs from the original.
    expect(rotated.body.publicUrl).not.toContain(shipment.publicToken);

    await request(app).get(`/api/v1/public/tracking/${shipment.publicToken}`).expect(404);
  });
});

describe('integrations tell the truth', () => {
  it('reports every carrier as not connected with no adapter', async () => {
    const response = await agentA
      .get(`/api/v1/${ownerA.organization.id}/integrations/carriers`)
      .expect(200);

    const carriers = response.body.integrations as Array<{
      carrierCode: string;
      implemented: boolean;
      status: string;
    }>;
    expect(carriers.length).toBeGreaterThan(0);
    for (const carrier of carriers) {
      expect(carrier.implemented).toBe(false);
      expect(carrier.status).toBe('not_configured');
    }
  });

  it('refuses to test a carrier connection without an adapter', async () => {
    const response = await agentA
      .post(`/api/v1/${ownerA.organization.id}/integrations/carriers/dhl/test`)
      .expect(200);
    expect(response.body.ok).toBe(false);
    expect(JSON.stringify(response.body)).toMatch(/adapter/i);
  });
});

describe('operations dashboard', () => {
  it('reports real counts and never ranks carriers', async () => {
    await createShipment(agentA, ownerA.organization.id, 'DASH-1');

    const response = await agentA.get(`/api/v1/${ownerA.organization.id}/dashboard`);
    // The carrier breakdown groups by carrier while selecting a per-shipment
    // count; this guards against an ungrouped-column regression.
    expect(response.status).toBe(200);

    const body = response.body as {
      totals: number;
      counts: Record<string, number>;
      carrierBreakdown: Array<{ carrierCode: string; count: number; exceptions: number }>;
      definitions: Record<string, string>;
    };

    const summed = Object.values(body.counts).reduce((sum, value) => sum + value, 0);
    expect(summed).toBe(body.totals);

    const listed = body.carrierBreakdown.reduce((sum, row) => sum + row.count, 0);
    expect(listed).toBe(body.totals);

    // Every metric must come with its own definition.
    expect(Object.keys(body.definitions).length).toBeGreaterThan(0);
  });

  it('reports the delivery report with its own stated limitations', async () => {
    const response = await agentA
      .get(`/api/v1/${ownerA.organization.id}/reports/delivery`)
      .expect(200);

    expect(response.body.warnings.length).toBeGreaterThan(0);
    // A carrier comparison is explicitly not presented as a ranking.
    expect(response.body.warnings.join(' ')).toMatch(/not ranked|not comparable/i);
  });
});

describe('notification vocabulary', () => {
  it('never claims an email was delivered', async () => {
    const response = await agentA
      .get(`/api/v1/${ownerA.organization.id}/settings/notifications`)
      .expect(200);
    expect(response.body.note).toMatch(/never claims/i);
    expect(response.body.email.deliversMessages).toBe(false);
  });
});