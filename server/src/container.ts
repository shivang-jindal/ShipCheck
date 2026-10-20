/** Service container for ShipCheck. */

import type { Permission, Role } from '@shipcheck/shared';
import { permissionsForRole } from '@shipcheck/shared';
import type { Logger } from 'pino';

import type { AppConfig } from './config.js';
import type { AppDatabase } from './db/client.js';
import { JobQueue } from './jobs/queue.js';
import { DisabledEmailAdapter } from './integrations/email/disabled.js';
import { LogEmailAdapter } from './integrations/email/log.js';
import { SmtpEmailAdapter } from './integrations/email/smtp.js';
import type { EmailAdapter } from './integrations/email/types.js';
import { AuditService } from './services/audit.service.js';
import { AuthService } from './services/auth.service.js';
import { EmailService } from './services/email.service.js';
import { ExceptionService } from './services/exception.service.js';
import { ImportService } from './services/import.service.js';
import { IntegrationService } from './services/integration.service.js';
import { NotificationService } from './services/notification.service.js';
import { OrganizationService } from './services/organization.service.js';
import { ReportService } from './services/report.service.js';
import { ShipmentService } from './services/shipment.service.js';
import { ExportService } from './services/export.service.js';

export interface Services {
  config: AppConfig;
  logger: Logger;
  db: AppDatabase;
  audit: AuditService;
  auth: AuthService;
  organizations: OrganizationService;
  shipments: ShipmentService;
  exceptions: ExceptionService;
  imports: ImportService;
  integrations: IntegrationService;
  notifications: NotificationService;
  reports: ReportService;
  exports: ExportService;
  email: EmailService;
  emailAdapter: EmailAdapter;
  jobs: JobQueue;
  permissionsFor: (role: Role) => Permission[];
}

export function createServices(options: {
  db: AppDatabase;
  config: AppConfig;
  logger: Logger;
}): Services {
  const { db, config, logger } = options;

  const adapter = createEmailAdapter(config);
  const audit = new AuditService(db);
  const jobs = new JobQueue(db);
  const auth = new AuthService(db, config.session.ttlHours);
  const organizations = new OrganizationService(db, audit);
  const shipments = new ShipmentService(db, audit);
  const exceptions = new ExceptionService(db, audit);
  const imports = new ImportService(db, audit, shipments);
  const integrations = new IntegrationService(db, audit, config.encryptionKey);
  const email = new EmailService(
    db,
    adapter,
    config.email.from ?? 'ShipCheck <no-reply@shipcheck.local>',
  );
  const notifications = new NotificationService(db, email, jobs);
  const reports = new ReportService(db, exceptions);
  const exports = new ExportService(db, audit);

  return {
    config,
    logger,
    db,
    audit,
    auth,
    organizations,
    shipments,
    exceptions,
    imports,
    integrations,
    notifications,
    reports,
    exports,
    email,
    emailAdapter: adapter,
    jobs,
    permissionsFor: permissionsForRole,
  };
}

export function createEmailAdapter(config: AppConfig): EmailAdapter {
  switch (config.email.provider) {
    case 'smtp':
      return new SmtpEmailAdapter({
        host: config.email.host!,
        port: config.email.port ?? 587,
        secure: config.email.secure,
        user: config.email.user,
        password: config.email.password,
      });
    case 'log':
      return new LogEmailAdapter(`${process.cwd()}/server/.data/outbox`);
    case 'disabled':
    default:
      return new DisabledEmailAdapter();
  }
}