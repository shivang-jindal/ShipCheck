/**
 * Structured JSON logging with request-id correlation.
 * Secrets and personal data are never logged (Part A / A5).
 */

import pino, { type Logger } from 'pino';

export interface LoggerOptions {
  level: string;
  isProduction: boolean;
  name?: string;
}

export function createLogger(options: LoggerOptions): Logger {
  return pino({
    name: options.name ?? 'collectflow',
    level: options.isProduction ? options.level : 'debug',
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'headers.authorization',
        'headers.cookie',
        '*.password',
        '*.passwordHash',
        '*.token',
        '*.apiKey',
        '*.secret',
        'credentials.*',
      ],
      censor: '[redacted]',
    },
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

/** Fields that must never reach a log line or an error response. */
export const SENSITIVE_KEYS = [
  'password',
  'passwordhash',
  'token',
  'tokenhash',
  'secret',
  'apikey',
  'api_key',
  'authorization',
  'cookie',
  'credentials',
  'encryptedcredentials',
  'smtp_password',
];

export function redactObject<T>(value: T, depth = 0): T {
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((entry) => redactObject(entry, depth + 1)) as unknown as T;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.includes(key.toLowerCase())) {
      output[key] = '[redacted]';
    } else if (entry && typeof entry === 'object') {
      output[key] = redactObject(entry, depth + 1);
    } else {
      output[key] = entry;
    }
  }
  return output as T;
}