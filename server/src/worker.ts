/** Standalone background worker process. */

import { loadConfig } from './config.js';
import { createDatabase, runMigrations } from './db/client.js';
import { createServices } from './container.js';
import { createLogger } from './logger.js';
import { startWorker } from './jobs/worker.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({
    level: config.logLevel,
    isProduction: config.isProduction,
    name: 'worker',
  });

  const database = await createDatabase({
    databaseUrl: config.databaseUrl,
    pgliteDataDir: config.pgliteDataDir,
    poolMax: Math.max(2, Math.floor(config.databasePoolMax / 2)),
  });
  logger.info({ driver: database.driver }, 'worker database connected');
  await runMigrations(database);

  const services = createServices({ db: database.db, config, logger });
  const handle = await startWorker(services);

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'worker shutting down');
    await handle.stop();
    await database.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  console.error('[shipcheck-worker] failed to start:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});