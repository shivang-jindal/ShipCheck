/**
 * Database access.
 *
 * Two drivers share one Drizzle schema and one set of real PostgreSQL
 * migrations (Part A / A2):
 *
 *   - `pg` (node-postgres)  -> managed PostgreSQL, used in production and
 *                             whenever DATABASE_URL is set.
 *   - PGlite               -> an embedded, file-backed PostgreSQL 16 build for
 *                             local development, tests and CI. It speaks real
 *                             PostgreSQL SQL, so migrations, constraints,
 *                             transactions and window functions behave the same.
 *
 * `AppDatabase` is the node-postgres type because both drivers expose the same
 * `PgDatabase` query surface; the factory narrows the PGlite instance to it in
 * one documented place.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzleNodePg, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migrateNodePg } from 'drizzle-orm/node-postgres/migrator';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { Pool } from 'pg';

import * as schema from './schema.js';

export type AppDatabase = NodePgDatabase<typeof schema>;

export type DatabaseDriver = 'postgres' | 'pglite';

export interface DatabaseHandle {
  db: AppDatabase;
  driver: DatabaseDriver;
  describe: string;
  close: () => Promise<void>;
}

const here = dirname(fileURLToPath(import.meta.url));

/** `<repo>/server/drizzle` in dev and `<repo>/server/dist/drizzle` in builds. */
export function migrationsFolder(): string {
  const candidates = [
    resolve(here, '../drizzle'),
    resolve(here, '../../drizzle'),
    resolve(process.cwd(), 'drizzle'),
    resolve(process.cwd(), 'server/drizzle'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

export async function createDatabase(options: {
  databaseUrl?: string | null;
  pgliteDataDir?: string | null;
  poolMax?: number;
  /** `:memory:` keeps PGlite fully ephemeral, used by tests. */
  memory?: boolean;
}): Promise<DatabaseHandle> {
  if (options.databaseUrl) {
    const pool = new Pool({
      connectionString: options.databaseUrl,
      max: options.poolMax ?? 10,
      // Managed providers (Supabase, Neon, RDS) terminate TLS; require it unless
      // the operator explicitly points at a local socket.
      ssl: shouldUseSsl(options.databaseUrl) ? { rejectUnauthorized: false } : undefined,
    });
    const db = drizzleNodePg(pool, { schema });
    return {
      db,
      driver: 'postgres',
      describe: `postgres (${redactUrl(options.databaseUrl)})`,
      close: async () => {
        await pool.end();
      },
    };
  }

  const dataDir =
    options.memory || !options.pgliteDataDir
      ? undefined
      : resolve(process.cwd(), options.pgliteDataDir);
  if (dataDir) mkdirSync(dataDir, { recursive: true });

  const client = new PGlite({ dataDir });
  await client.waitReady;
  const db = drizzlePglite(client, { schema }) as unknown as AppDatabase;
  return {
    db,
    driver: 'pglite',
    describe: dataDir ? `pglite (${dataDir})` : 'pglite (in-memory)',
    close: async () => {
      await client.close();
    },
  };
}

/** Applies every pending SQL migration. Safe to run repeatedly. */
export async function runMigrations(
  handle: DatabaseHandle,
): Promise<{ applied: boolean; folder: string }> {
  const folder = migrationsFolder();
  if (!existsSync(folder)) {
    throw new Error(
      `Migration folder not found at ${folder}. Run "npm run db:generate" to create the first migration.`,
    );
  }
  if (handle.driver === 'postgres') {
    await migrateNodePg(handle.db, { migrationsFolder: folder });
  } else {
    await migratePglite(handle.db as never, { migrationsFolder: folder });
  }
  return { applied: true, folder };
}

function shouldUseSsl(url: string): boolean {
  return !/^postgres(ql)?:\/\/[^@]*@?(localhost|127\.0\.0\.1|\[::1\])/i.test(url) && !/sslmode=disable/i.test(url);
}

function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.hostname}:${parsed.port || '5432'}/${parsed.pathname.replace(/^\//, '')}`;
  } catch {
    return 'postgres';
  }
}

export { schema };