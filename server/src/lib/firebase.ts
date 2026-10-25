/**
 * Firebase ID token verification.
 *
 * The browser receives an ID token from Firebase after a Google popup. That
 * token is an ordinary JWT signed by Google for the Firebase project, so it can
 * be checked here without a service account: the signature is verified against
 * Google's published keys, and the issuer and audience bind the token to this
 * project. No claim is trusted until `jwtVerify` has returned.
 */

import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

/** One identity that Google vouched for. */
export interface GoogleIdentity {
  subject: string;
  email: string;
  displayName: string | null;
}

/**
 * Every reason a token cannot be trusted. Callers must turn this into a
 * generic sign-in failure: the detail is useful in a log, not to a caller.
 */
export class GoogleTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoogleTokenError';
  }
}

const FIREBASE_KEYS = new URL(
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com',
);

let remoteKeys: JWTVerifyGetKey | null = null;

function defaultKeys(): JWTVerifyGetKey {
  remoteKeys ??= createRemoteJWKSet(FIREBASE_KEYS);
  return remoteKeys;
}

/**
 * Verifies a Firebase ID token for `projectId` and returns the Google identity
 * it asserts. `keys` is injectable so tests can verify against a local key set
 * without reaching the network.
 */
export async function verifyFirebaseIdToken(
  idToken: string,
  projectId: string,
  keys: JWTVerifyGetKey = defaultKeys(),
): Promise<GoogleIdentity> {
  let payload: Record<string, unknown>;
  try {
    const verified = await jwtVerify(idToken, keys, {
      algorithms: ['RS256'],
      audience: projectId,
      issuer: `https://securetoken.google.com/${projectId}`,
    });
    payload = verified.payload;
  } catch {
    throw new GoogleTokenError('The Google sign-in token is not valid for this project.');
  }

  const subject = typeof payload.sub === 'string' ? payload.sub : '';
  if (subject.length === 0) {
    throw new GoogleTokenError('The Google sign-in token has no subject.');
  }

  const firebase = payload.firebase as { sign_in_provider?: unknown } | undefined;
  if (firebase?.sign_in_provider !== 'google.com') {
    throw new GoogleTokenError('The token was not issued for a Google sign-in.');
  }

  const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
  if (email.length === 0) {
    throw new GoogleTokenError('The Google account has no email address.');
  }
  if (payload.email_verified !== true) {
    throw new GoogleTokenError('The Google account email address is not verified.');
  }

  const rawName = typeof payload.name === 'string' ? payload.name.trim() : '';
  return {
    subject,
    email,
    displayName: rawName.length > 0 ? rawName.slice(0, 120) : null,
  };
}
