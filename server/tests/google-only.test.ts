/**
 * Production is Google-only.
 *
 * The browser no longer renders password forms, so the matching endpoints must
 * also be unreachable: leaving them live in production would keep a credential
 * surface that nobody can see, audit or reset. Development and tests keep them
 * because the seeded demo account, the smoke script and the HTTP tests use them.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

import { createApp } from '../src/app.js';
import { createTestContext, type TestContext } from './harness.js';

let context: TestContext;
let app: Express;

beforeAll(async () => {
  context = await createTestContext({ NODE_ENV: 'production' });
  app = createApp(context.services);
});

afterAll(async () => {
  await context.close();
});

describe('production password endpoints', () => {
  const cases: Array<{ path: string; body: Record<string, string> }> = [
    {
      path: '/api/v1/auth/register',
      body: { email: 'new@example.test', password: 'a-very-long-password', displayName: 'New' },
    },
    {
      path: '/api/v1/auth/login',
      body: { email: 'demo@example.test', password: 'a-very-long-password' },
    },
    {
      path: '/api/v1/auth/password/forgot',
      body: { email: 'demo@example.test' },
    },
    {
      path: '/api/v1/auth/password/reset',
      body: { token: 'a'.repeat(43), password: 'a-very-long-password' },
    },
    {
      path: '/api/v1/auth/password/change',
      body: { currentPassword: 'a-very-long-password', newPassword: 'another-long-password' },
    },
  ];

  for (const { path, body } of cases) {
    it(`returns 404 for POST ${path}`, async () => {
      const response = await request(app).post(path).send(body);
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
    });
  }

  it('keeps the Google endpoint routed', async () => {
    // No FIREBASE_PROJECT_ID in the test environment, so the service refuses to
    // work - but it must refuse as a configured route, not as a missing one.
    const response = await request(app)
      .post('/api/v1/auth/google')
      .send({ idToken: 'a'.repeat(40) });
    expect(response.status).not.toBe(404);
    expect(response.body.error.code).toBe('INTEGRATION_UNAVAILABLE');
  });
});
