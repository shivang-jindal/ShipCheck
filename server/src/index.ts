/** API process entry point. */

import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createDatabase, runMigrations } from './db/client.js';
import { createServices } from './container.js';
import { createLogger } from './logger.js';
import { startWorker } from './jobs/worker.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel, isProduction: config.isProduction, name: 'api' });

  const database = await createDatabase({
    databaseUrl: config.databaseUrl,
    pgliteDataDir: config.pgliteDataDir,
    poolMax: config.databasePoolMax,
  });
  logger.info({ driver: database.driver, database: database.describe }, 'database connected');

  await runMigrations(database);
  const services = createServices({ db: database.db, config, logger });

  const app = createApp(services);
  const server = app.listen(config.port, () => {
    logger.info({ port: config.port, env: config.nodeEnv }, `ShipCheck API listening on ${config.port}`);
    for (const warning of config.warnings) logger.warn({ warning }, 'configuration warning');
  });

  // The API process may also run the worker when explicitly asked to; the
  // recommended deployment runs `npm run worker:start` separately.
  if (config.worker.enabled && process.env.WORKER_IN_API === 'true') {
    void startWorker(services);
    logger.info('background worker started inside the API process');
  }

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'shutting down');
    server.close(() => {
      void database.close().then(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  console.error('[shipcheck] failed to start:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});