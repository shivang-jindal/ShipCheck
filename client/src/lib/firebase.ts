/**
 * Google sign-in through Firebase.
 *
 * The Firebase web configuration is public by design: it identifies the
 * project, not a person. It is read from VITE_* variables at build time. When
 * it is missing the button renders disabled instead of failing after a click.
 */

import type { Auth } from 'firebase/auth';

const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

export const googleSignInConfigured =
  typeof config.apiKey === 'string' &&
  config.apiKey.length > 0 &&
  typeof config.authDomain === 'string' &&
  config.authDomain.length > 0 &&
  typeof config.projectId === 'string' &&
  config.projectId.length > 0 &&
  typeof config.appId === 'string' &&
  config.appId.length > 0;

/** The person closed the popup. That is not an error worth showing. */
export class GoogleSignInCancelled extends Error {
  constructor() {
    super('Google sign-in was cancelled.');
    this.name = 'GoogleSignInCancelled';
  }
}

let authPromise: Promise<Auth> | null = null;

async function firebaseAuth(): Promise<Auth> {
  authPromise ??= (async () => {
    const { initializeApp, getApps } = await import('firebase/app');
    const { getAuth } = await import('firebase/auth');
    const app =
      getApps()[0] ??
      initializeApp({
        apiKey: config.apiKey as string,
        authDomain: config.authDomain as string,
        projectId: config.projectId as string,
        appId: config.appId as string,
      });
    return getAuth(app);
  })();
  return authPromise;
}

/** Opens the Google popup and resolves with a Firebase ID token. */
export async function requestGoogleIdToken(): Promise<string> {
  if (!googleSignInConfigured) {
    throw new Error('Google sign-in is not configured for this deployment.');
  }

  const { GoogleAuthProvider, signInWithPopup } = await import('firebase/auth');
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });

  try {
    const credential = await signInWithPopup(await firebaseAuth(), provider);
    return await credential.user.getIdToken();
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
      throw new GoogleSignInCancelled();
    }
    throw error;
  }
}
