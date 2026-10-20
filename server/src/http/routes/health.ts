import { Router } from 'express';

import type { Services } from '../../container.js';
import { asyncHandler } from '../middleware.js';

export function healthRouter(services: Services): Router {
  const router = Router();

  router.get(
    '/live',
    asyncHandler(async (_req, res) => {
      res.json({ status: 'ok', service: 'collectflow-api', version: '1.0.0' });
    }),
  );

  router.get(
    '/ready',
    asyncHandler(async (_req, res) => {
      const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];

      let databaseOk = false;
      try {
        await services.db.execute('select 1');
        databaseOk = true;
      } catch (error) {
        checks.push({
          name: 'database',
          ok: false,
          detail: error instanceof Error ? error.message : 'connection failed',
        });
      }
      if (databaseOk) checks.push({ name: 'database', ok: true });

      const email = await services.emailAdapter.verifyConfiguration();
      checks.push({
        name: 'email',
        // Not being able to send is degraded, not unready: the product works
        // with PDF download and manual payments.
        ok: true,
        detail: `${services.emailAdapter.name}: ${email.detail}`,
      });

      const ready = checks.every((check) => check.ok);
      res.status(ready ? 200 : 503).json({
        status: ready ? 'ready' : 'not_ready',
        checks,
        warnings: services.config.warnings,
        environment: services.config.nodeEnv,
      });
    }),
  );

  router.get(
    '/info',
    asyncHandler(async (_req, res) => {
      res.json({
        service: 'collectflow-api',
        environment: services.config.nodeEnv,
        worker: services.config.worker,
        email: {
          provider: services.emailAdapter.name,
          deliversMessages: services.emailAdapter.deliversMessages,
          setupHint: services.emailAdapter.setupHint,
        },
        warnings: services.config.warnings,
      });
    }),
  );

  return router;
}