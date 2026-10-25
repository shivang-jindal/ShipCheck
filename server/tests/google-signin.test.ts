/**
 * Google sign-in: token verification and account creation.
 *
 * The sign-in token is the security boundary, so these tests cover the ways a
 * token can be wrong (audience, issuer, provider, unverified email) as well as
 * the happy path. The key set is local, and the remote JWKS endpoint is stubbed,
 * so nothing here depends on Google being reachable.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWTVerifyGetKey,
} from 'jose';

import { GoogleTokenError, verifyFirebaseIdToken } from '../src/lib/firebase.js';
import { createTestContext, type TestContext } from './harness.js';

const PROJECT_ID = 'nexhub-github-test';

let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
let jwks: JWTVerifyGetKey;
let context: TestContext;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  const publicJwk = { ...(await exportJWK(pair.publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
  jwks = createLocalJWKSet({ keys: [publicJwk] });

  // The production verifier fetches Google's published keys. Serving those keys
  // from a stub keeps the service-level test offline while exercising the same
  // code path, including the cached remote key set.
  vi.stubGlobal(
    'fetch',
    async () =>
      new Response(JSON.stringify({ keys: [publicJwk] }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'cache-control': 'public, max-age=600',
        },
      }),
  );

  context = await createTestContext({ FIREBASE_PROJECT_ID: PROJECT_ID });
});

afterAll(async () => {
  await context.close();
  vi.unstubAllGlobals();
});

async function makeToken(
  overrides: {
    audience?: string;
    issuer?: string;
    provider?: string;
    emailVerified?: boolean;
    email?: string;
  } = {},
): Promise<string> {
  return new SignJWT({
    email: overrides.email ?? 'Owner@Example.com',
    email_verified: overrides.emailVerified ?? true,
    name: 'Demo Owner',
    firebase: { sign_in_provider: overrides.provider ?? 'google.com' },
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(overrides.issuer ?? `https://securetoken.google.com/${PROJECT_ID}`)
    .setAudience(overrides.audience ?? PROJECT_ID)
    .setSubject('firebase-user-1')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}

describe('verifyFirebaseIdToken', () => {
  it('accepts a Google token issued for this project', async () => {
    const identity = await verifyFirebaseIdToken(await makeToken(), PROJECT_ID, jwks);

    expect(identity).toEqual({
      subject: 'firebase-user-1',
      email: 'owner@example.com',
      displayName: 'Demo Owner',
    });
  });

  it('rejects a token minted for another project', async () => {
    await expect(
      verifyFirebaseIdToken(await makeToken({ audience: 'someone-else' }), PROJECT_ID, jwks),
    ).rejects.toBeInstanceOf(GoogleTokenError);
  });

  it('rejects a token from another issuer', async () => {
    await expect(
      verifyFirebaseIdToken(
        await makeToken({ issuer: 'https://securetoken.google.com/someone-else' }),
        PROJECT_ID,
        jwks,
      ),
    ).rejects.toBeInstanceOf(GoogleTokenError);
  });

  it('rejects a token that was not a Google sign-in', async () => {
    await expect(
      verifyFirebaseIdToken(await makeToken({ provider: 'password' }), PROJECT_ID, jwks),
    ).rejects.toBeInstanceOf(GoogleTokenError);
  });

  it('rejects an unverified Google email', async () => {
    await expect(
      verifyFirebaseIdToken(await makeToken({ emailVerified: false }), PROJECT_ID, jwks),
    ).rejects.toBeInstanceOf(GoogleTokenError);
  });

  it('rejects a tampered token', async () => {
    const token = await makeToken();
    const parts = token.split('.');
    const forged = `${parts[0]}.${parts[1]}.${'A'.repeat(43)}`;

    await expect(
      verifyFirebaseIdToken(forged, PROJECT_ID, jwks),
    ).rejects.toBeInstanceOf(GoogleTokenError);
  });
});

describe('signInWithGoogle', () => {
  it('reuses one account for repeated sign-ins and never sets a password', async () => {
    const idToken = await makeToken();

    const first = await context.services.auth.signInWithGoogle({
      idToken,
      meta: { userAgent: 'vitest' },
    });
    expect(first.user.email).toBe('owner@example.com');
    expect(first.user.displayName).toBe('Demo Owner');

    const second = await context.services.auth.signInWithGoogle({
      idToken,
    });
    expect(second.user.id).toBe(first.user.id);

    // A Google-created account must not be usable with a guessed password.
    await expect(
      context.services.auth.signIn({
        email: 'owner@example.com',
        password: 'not-the-password',
      }),
    ).rejects.toThrow();
  });

  it('refuses a token for a different project', async () => {
    await expect(
      context.services.auth.signInWithGoogle({
        idToken: await makeToken({ audience: 'someone-else' }),
      }),
    ).rejects.toThrow();
  });

  it('refuses every request when no project is configured', async () => {
    const unconfigured = await createTestContext();
    try {
      await expect(
        unconfigured.services.auth.signInWithGoogle({ idToken: await makeToken() }),
      ).rejects.toThrow(/not configured/i);
    } finally {
      await unconfigured.close();
    }
  });
});
