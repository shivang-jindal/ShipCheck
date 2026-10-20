/**
 * Cryptographic helpers.
 *
 * Password hashing uses Argon2id from `@node-rs/argon2` (a maintained library
 * with prebuilt binaries) - never a hand-rolled KDF (Part A / A2).
 * Session and public-link tokens are 256-bit random values stored only as
 * SHA-256 hashes, which is a database-backed opaque session, not a
 * self-implemented token-signing scheme.
 */

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';

const ARGON_OPTIONS = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} as const;

export async function hashPassword(password: string): Promise<string> {
  return argonHash(password, ARGON_OPTIONS);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argonVerify(hash, password);
  } catch {
    return false;
  }
}

/** 32 bytes of CSPRNG entropy, base64url encoded. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function sha256Buffer(value: Buffer | string): Buffer {
  return createHash('sha256').update(value).digest();
}

export function hmacSha256Hex(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

/** Constant-time string comparison that never throws on length mismatch. */
export function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  if (bufferA.length !== bufferB.length) {
    // Still burn a comparison so the timing profile is flat.
    timingSafeEqual(bufferA, bufferA);
    return false;
  }
  return timingSafeEqual(bufferA, bufferB);
}

/* -------------------------------------------------------------------------- */
/* Credential encryption at rest (AES-256-GCM)                               */
/* -------------------------------------------------------------------------- */

export interface SealedPayload {
  v: 1;
  iv: string;
  tag: string;
  data: string;
}

export function sealCredentials(key: Buffer, value: Record<string, string>): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const payload: SealedPayload = {
    v: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: encrypted.toString('base64'),
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

export function openCredentials(key: Buffer, sealed: string): Record<string, string> {
  const payload = JSON.parse(Buffer.from(sealed, 'base64').toString('utf8')) as SealedPayload;
  if (payload.v !== 1) throw new Error('Unsupported credential payload version');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(payload.iv, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(payload.data, 'base64')),
    decipher.final(),
  ]);
  return JSON.parse(decrypted.toString('utf8')) as Record<string, string>;
}

/** Mask a secret for display: keeps a short suffix, never the value. */
export function maskSecret(value: string | undefined | null): string | null {
  if (!value) return null;
  if (value.length <= 4) return '*'.repeat(value.length);
  return `${'*'.repeat(Math.min(8, value.length - 4))}${value.slice(-4)}`;
}