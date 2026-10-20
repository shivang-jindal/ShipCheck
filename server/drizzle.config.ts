import { defineConfig } from 'drizzle-kit';

/**
 * `drizzle-kit generate` only reads the schema and writes SQL migration files,
 * so it works without a live database. `drizzle-kit migrate`/`push` would need
 * DATABASE_URL; the application runs migrations itself through
 * `server/src/db/migrate.ts` so the same code path serves PGlite and Postgres.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgresql://localhost:5432/collectflow',
  },
  strict: true,
  verbose: true,
});