/** `npm run db:migrate` - applies pending SQL migrations to the configured database. */

import { loadConfig } from '../config.js';
import { createDatabase, runMigrations } from './client.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const handle = await createDatabase({
    databaseUrl: config.databaseUrl,
    pgliteDataDir: config.pgliteDataDir,
    poolMax: config.databasePoolMax,
  });
  try {
    const started = Date.now();
    const result = await runMigrations(handle);
    console.log(
      `[db:migrate] applied migrations from ${result.folder} to ${handle.driver} (${handle.describe}) in ${Date.now() - started}ms`,
    );
  } finally {
    await handle.close();
  }
}

main().catch((error: unknown) => {
  console.error('[db:migrate] failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});