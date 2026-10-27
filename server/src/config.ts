/**
 * Environment configuration (Part A / A8).
 *
 * Required variables are validated on startup and a clear, secret-free message
 * is printed when something is missing. Nothing is silently defaulted to a
 * production credential.
 */

import './load-env.js';

import { z } from 'zod';

const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((value) =>
    typeof value === 'boolean'
      ? value
      : ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase()),
  );

const optionalString = z
  .string()
  .trim()
  .transform((value) => (value.length === 0 ? undefined : value))
  .optional();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  API_URL: z.string().url().default('http://localhost:4000'),
  APP_URL: z.string().url().default('http://localhost:5173'),
  /** Extra allowed origins for CORS, comma separated. */
  APP_URLS: optionalString,

  DATABASE_URL: optionalString,
  PGLITE_DATA_DIR: optionalString,
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

  /** Email delivery. Email stays safely disabled until SMTP is configured. */
  EMAIL_PROVIDER: z.enum(['disabled', 'smtp', 'log']).default('disabled'),
  SMTP_HOST: optionalString,
  SMTP_PORT: z.coerce.number().int().min(1).max(65_535).optional(),
  SMTP_SECURE: booleanish.default(false),
  SMTP_USER: optionalString,
  SMTP_PASSWORD: optionalString,
  FROM_EMAIL: optionalString,
  EMAIL_REPLY_TO: optionalString,

  /**
   * 32-byte key (64 hex characters) used to encrypt integration credentials
   * at rest. Required only when an integration stores credentials.
   */
  ENCRYPTION_KEY: optionalString,

  /**
   * Firebase project id used to verify Google sign-in ID tokens. Optional: with
   * no value the Google button renders disabled and the endpoint refuses work.
   * This is an identifier, not a secret.
   */
  FIREBASE_PROJECT_ID: optionalString,

  /** Background worker. */
  WORKER_ENABLED: booleanish.default(true),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(200).max(60_000).default(2_000),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(3),

  SESSION_COOKIE_NAME: z.string().trim().min(1).default('shipcheck_session'),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 365).default(24 * 14),
  COOKIE_SECURE: booleanish.optional(),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  TRUST_PROXY: booleanish.default(false),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(300),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(20),

  SEED_DEMO_DATA: booleanish.default(false),
});

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  isProduction: boolean;
  port: number;
  apiUrl: string;
  appUrl: string;
  allowedOrigins: string[];
  databaseUrl: string | null;
  pgliteDataDir: string;
  databasePoolMax: number;
  email: {
    provider: 'disabled' | 'smtp' | 'log';
    host: string | null;
    port: number | null;
    secure: boolean;
    user: string | null;
    password: string | null;
    from: string | null;
    replyTo: string | null;
    /** True only when the adapter can actually hand a message to a provider. */
    deliversMessages: boolean;
  };
  encryptionKey: Buffer | null;
  firebase: {
    /** Null when Google sign-in is not configured. */
    projectId: string | null;
  };
  worker: {
    enabled: boolean;
    pollIntervalMs: number;
    concurrency: number;
  };
  session: {
    cookieName: string;
    ttlHours: number;
    cookieSecure: boolean;
  };
  logLevel: string;
  trustProxy: boolean;
  rateLimit: { windowMs: number; max: number; authMax: number };
  seedDemoData: boolean;
  /** Startup warnings surfaced through /health/ready and the dashboard. */
  warnings: string[];
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  const env = parsed.data;
  const warnings: string[] = [];

  const encryptionKey = parseEncryptionKey(env.ENCRYPTION_KEY, warnings);

  if (env.EMAIL_PROVIDER === 'smtp') {
    if (!env.SMTP_HOST || !env.FROM_EMAIL) {
      throw new Error(
        'EMAIL_PROVIDER=smtp requires SMTP_HOST and FROM_EMAIL. Set EMAIL_PROVIDER=disabled to run without email.',
      );
    }
  } else if (env.EMAIL_PROVIDER === 'log') {
    if (env.NODE_ENV === 'production') {
      throw new Error('EMAIL_PROVIDER=log is a development-only transport and cannot be used in production.');
    }
    warnings.push(
      'EMAIL_PROVIDER=log: messages are written to the log and the outbox only. Nothing is delivered. No delivery is claimed.',
    );
  }

  if (!env.DATABASE_URL) {
    warnings.push(
      'DATABASE_URL is not set: using the embedded PGlite PostgreSQL instance. Use a managed PostgreSQL database in production.',
    );
  }

  if (env.NODE_ENV === 'production' && env.COOKIE_SECURE === false) {
    warnings.push('COOKIE_SECURE should stay enabled in production.');
  }

  if (!env.FIREBASE_PROJECT_ID) {
    warnings.push(
      'FIREBASE_PROJECT_ID is not set: Google sign-in is disabled, and the web app has no other sign-in method.',
    );
  }

  const cookieSecure = env.COOKIE_SECURE ?? env.NODE_ENV === 'production';

  return {
    nodeEnv: env.NODE_ENV,
    isProduction: env.NODE_ENV === 'production',
    port: env.PORT,
    apiUrl: env.API_URL,
    appUrl: env.APP_URL,
    allowedOrigins: dedupe([env.APP_URL, ...(env.APP_URLS?.split(',') ?? [])].filter(Boolean) as string[]),
    databaseUrl: env.DATABASE_URL ?? null,
    pgliteDataDir: env.PGLITE_DATA_DIR ?? '.data/pgdata',
    databasePoolMax: env.DATABASE_POOL_MAX,
    email: {
      provider: env.EMAIL_PROVIDER,
      host: env.SMTP_HOST ?? null,
      port: env.SMTP_PORT ?? null,
      secure: env.SMTP_SECURE,
      user: env.SMTP_USER ?? null,
      password: env.SMTP_PASSWORD ?? null,
      from: env.FROM_EMAIL ?? null,
      replyTo: env.EMAIL_REPLY_TO ?? null,
      deliversMessages: env.EMAIL_PROVIDER === 'smtp',
    },
    encryptionKey,
    firebase: {
      projectId: env.FIREBASE_PROJECT_ID ?? null,
    },
    worker: {
      enabled: env.WORKER_ENABLED,
      pollIntervalMs: env.WORKER_POLL_INTERVAL_MS,
      concurrency: env.WORKER_CONCURRENCY,
    },
    session: {
      cookieName: env.SESSION_COOKIE_NAME,
      ttlHours: env.SESSION_TTL_HOURS,
      cookieSecure,
    },
    logLevel: env.LOG_LEVEL,
    trustProxy: env.TRUST_PROXY,
    rateLimit: {
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      max: env.RATE_LIMIT_MAX,
      authMax: env.AUTH_RATE_LIMIT_MAX,
    },
    seedDemoData: env.SEED_DEMO_DATA,
    warnings,
  };
}

function parseEncryptionKey(value: string | undefined, warnings: string[]): Buffer | null {
  if (!value) {
    warnings.push(
      'ENCRYPTION_KEY is not set: integration credentials cannot be stored. Payment/email credentials stay unavailable until it is configured.',
    );
    return null;
  }
  if (!/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error('ENCRYPTION_KEY must be 64 hexadecimal characters (32 bytes). Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  }
  return Buffer.from(value, 'hex');
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}