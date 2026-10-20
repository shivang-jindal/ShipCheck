/**
 * REST API router.
 *
 * Route structure
 * ---------------
 *   GET    /api/health
 *   POST   /api/auth/local/register|signin|password/reset|...   (development only)
 *   GET    /api/me
 *   PATCH  /api/me
 *   GET    /api/workspaces
 *   POST   /api/workspaces
 *   *      /api/workspaces/:workspaceId/...                    (membership enforced)
 *         customers | invoices | payments | reminders | reports
 *         | billing | activity | settings
 *   POST   /api/billing/webhook                                (signature verified)
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import type { ServiceFactory, Services } from '../../container.js';
import { CURRENCY_EXPONENTS } from '../../domain/currency.js';
import { DEFAULT_REMINDER_RULES, TEMPLATE_PLACEHOLDERS } from '../../domain/reminderTemplate.js';
import { billingUnconfigured, forbidden, notFound } from '../../errors.js';
import {
  asyncHandler,
  requireAuth,
  requireWorkspace,
  requireWorkspaceAdmin,
  requireWorkspaceWrite,
  validate,
} from '../middleware.js';
import {
  activityQuery,
  archiveBody,
  changePlanBody,
  checkoutBody,
  customerBody,
  customerListQuery,
  customerParams,
  customerPatch,
  dashboardQuery,
  importBody,
  invoiceBody,
  invoiceListQuery,
  invoiceParams,
  invoicePatch,
  localRegisterBody,
  localSignInBody,
  memberBody,
  memberParams,
  memberRolePatch,
  onboardingBody,
  passwordChangeBody,
  passwordResetBody,
  passwordResetRequestBody,
  paymentBody,
  paymentListQuery,
  paymentParams,
  profilePatch,
  reminderEventListQuery,
  reminderJobListQuery,
  reminderRuleBody,
  reminderRulePatch,
  reportQuery,
  ruleParams,
  sendNowBody,
  statusBody,
  suppressionBody,
  uuid,
  voidPaymentBody,
  workspaceBody,
  workspaceParams,
  workspacePatch,
} from '../schemas.js';
import { SAFE_REDIRECT_PATH } from '../safeRedirect.js';

const memberParamsSchema = z.object({ workspaceId: uuid, memberId: uuid });

export function createApiRouter(factory: ServiceFactory): Router {
  const router = Router();
  const config = factory.config;

  const authenticate = (req: Request) =>
    factory.forRequest(AuthTokenOf(req)).auth.authenticate(req.header('authorization'));

  // A tiny helper so the same extraction logic is used everywhere.
  function AuthTokenOf(_req: Request): string | undefined {
    const header = _req.header('authorization');
    if (!header) return undefined;
    return header.replace(/^Bearer\s+/i, '');
  }

  const auth = requireAuth(async (req) => {
    const token = AuthTokenOf(req);
    if (!token) return null;
    return factory.forRequest(token).auth.authenticate(req.header('authorization'));
  });

  // ---------- Health ---------------------------------------------------------

  router.get(
    '/health',
    asyncHandler(async (_req, res) => {
      const email = await factory.email.verifyConfiguration();
      res.json({
        status: 'ok',
        version: '1.0.0',
        brand: 'CollectFlow',
        uptimeSeconds: Math.round(process.uptime()),
        dataMode: config.dataMode,
        email: {
          provider: factory.email.capabilities.name,
          deliversMessages: factory.email.capabilities.deliversMessages,
          detail: email.detail,
        },
        billing: {
          provider: config.billing.provider,
          configured: config.billing.provider !== 'disabled',
          webhookSecretConfigured: Boolean(config.billing.webhookSecret),
        },
        worker: { enabled: config.worker.enabled, intervalSeconds: config.worker.intervalSeconds },
        warnings: config.warnings,
        environment: config.nodeEnv,
      });
    }),
  );

  // ---------- Local development authentication ------------------------------

  const localAuth = Router();
  localAuth.post(
    '/register',
    validate({ body: localRegisterBody }),
    asyncHandler(async (req, res) => {
      if (config.dataMode !== 'local') throw notFound('Route');
      const services = factory.forRequest();
      const session = await services.auth.localRegister({ ...req.body, repo: services.repo });
      res.status(201).json(session);
    }),
  );

  localAuth.post(
    '/signin',
    validate({ body: localSignInBody }),
    asyncHandler(async (req, res) => {
      if (config.dataMode !== 'local') throw notFound('Route');
      const services = factory.forRequest();
      res.json(await services.auth.localSignIn(req.body));
    }),
  );

  localAuth.post(
    '/password/change',
    auth,
    validate({ body: passwordChangeBody }),
    asyncHandler(async (req, res) => {
      if (config.dataMode !== 'local') throw notFound('Route');
      const services = factory.forRequest();
      await services.auth.localChangePassword({
        userId: req.principal!.userId,
        currentPassword: req.body.currentPassword,
        newPassword: req.body.newPassword,
      });
      res.status(204).end();
    }),
  );

  localAuth.post(
    '/password/reset',
    validate({ body: passwordResetRequestBody }),
    asyncHandler(async (req, res) => {
      const services = factory.forRequest();
      const redirectTo = req.body.redirectTo ?? config.appUrls[0] ?? '/';
      const result = await services.auth.requestPasswordReset({
        email: req.body.email,
        redirectTo,
      });
      // The response is identical whether or not the account exists.
      res.json({
        ok: true,
        message: 'If that account exists, a reset link has been sent.',
        ...(result.developmentToken ? { developmentToken: result.developmentToken } : {}),
      });
    }),
  );

  localAuth.post(
    '/password/reset/confirm',
    validate({ body: passwordResetBody }),
    asyncHandler(async (req, res) => {
      if (config.dataMode !== 'local') throw notFound('Route');
      const services = factory.forRequest();
      await services.auth.localResetPassword(req.body);
      res.status(204).end();
    }),
  );

  router.use('/auth/local', localAuth);

  // ---------- Current user ---------------------------------------------------

  router.get(
    '/me',
    auth,
    asyncHandler(async (req, res) => {
      const services = factory.forRequest(AuthTokenOf(req));
      const profile = await services.repo.getProfile(req.principal!.userId);
      const workspaces = await services.workspaces.listForUser(req.principal!.userId);
      res.json({
        user: {
          id: req.principal!.userId,
          email: req.principal!.email,
          displayName: profile?.displayName ?? req.principal!.displayName,
        },
        profile,
        workspaces,
        defaultWorkspaceId: workspaces[0]?.id ?? null,
        onboardingComplete: workspaces.length > 0,
        authMode: config.dataMode === 'local' ? 'local' : 'supabase',
      });
    }),
  );

  router.patch(
    '/me',
    auth,
    validate({ body: profilePatch }),
    asyncHandler(async (req, res) => {
      const services = factory.forRequest(AuthTokenOf(req));
      const profile = await services.repo.updateProfile(
        req.principal!.userId,
        req.body.displayName,
      );
      res.json({ profile });
    }),
  );

  // ---------- Workspaces -----------------------------------------------------

  router.get(
    '/workspaces',
    auth,
    asyncHandler(async (req, res) => {
      const services = factory.forRequest(AuthTokenOf(req));
      res.json({ workspaces: await services.workspaces.listForUser(req.principal!.userId) });
    }),
  );

  router.post(
    '/workspaces',
    auth,
    validate({ body: workspaceBody }),
    asyncHandler(async (req, res) => {
      const services = factory.forRequest(AuthTokenOf(req));
      const workspace = await services.workspaces.create({ ...req.body, ownerId: req.principal!.userId });
      res.status(201).json({ workspace });
    }),
  );

  // ---------- Workspace-scoped routes ---------------------------------------

  const ws = Router();
  ws.use(auth, requireWorkspace(factory.forRequest().workspaces));
  const write = requireWorkspaceWrite(factory.forRequest().workspaces);
  const admin = requireWorkspaceAdmin(factory.forRequest().workspaces);

  const services = (req: Request): Services => factory.forRequest(AuthTokenOf(req));

  ws.get(
    '/',
    asyncHandler(async (req, res) => {
      const { workspace, role } = req.principal
        ? await services(req).workspaces.requireMembership(
            req.params.workspaceId as string,
            req.principal.userId,
          )
        : { workspace: req.workspace!, role: req.workspaceRole! };
      res.json({ workspace, role });
    }),
  );

  ws.patch(
    '/',
    admin,
    validate({ body: workspacePatch }),
    asyncHandler(async (req, res) => {
      const workspace = await services(req).workspaces.update(
        req.params.workspaceId as string,
        req.principal!.userId,
        req.body,
      );
      res.json({ workspace });
    }),
  );

  ws.get(
    '/members',
    asyncHandler(async (req, res) => {
      res.json({
        members: await services(req).workspaces.listMembers(
          req.params.workspaceId as string,
          req.principal!.userId,
        ),
      });
    }),
  );

  ws.post(
    '/members',
    admin,
    validate({ body: memberBody }),
    asyncHandler(async (req, res) => {
      const member = await services(req).workspaces.addMember({
        workspaceId: req.params.workspaceId as string,
        actorUserId: req.principal!.userId,
        memberUserId: req.body.userId,
        role: req.body.role,
      });
      res.status(201).json({ member });
    }),
  );

  ws.patch(
    '/members/:memberId',
    admin,
    validate({ body: memberRolePatch }),
    asyncHandler(async (req, res) => {
      const member = await services(req).workspaces.updateMemberRole({
        workspaceId: req.params.workspaceId as string,
        actorUserId: req.principal!.userId,
        memberUserId: req.params.memberId as string,
        role: req.body.role,
      });
      res.json({ member });
    }),
  );

  ws.delete(
    '/members/:memberId',
    admin,
    asyncHandler(async (req, res) => {
      await services(req).workspaces.removeMember({
        workspaceId: req.params.workspaceId as string,
        actorUserId: req.principal!.userId,
        memberUserId: req.params.memberId as string,
      });
      res.status(204).end();
    }),
  );

  // ---------- Onboarding -----------------------------------------------------

  ws.post(
    '/onboarding',
    write,
    validate({ body: onboardingBody }),
    asyncHandler(async (req, res) => {
      const svc = services(req);
      const workspaceId = req.params.workspaceId as string;
      const body = req.body as z.infer<typeof onboardingBody>;

      const workspace = await svc.workspaces.update(workspaceId, req.principal!.userId, {
        name: body.workspaceName,
        defaultCurrency: body.defaultCurrency,
        timezone: body.timezone,
      });

      let customerId: string | null = null;
      if (body.createFirstCustomer && body.firstCustomerEmail && body.firstCustomerName) {
        const existing = await svc.repo.findCustomerByEmail(workspaceId, body.firstCustomerEmail);
        customerId =
          existing?.id ??
          (
            await svc.customers.create(workspaceId, req.principal!.userId, {
              name: body.firstCustomerName,
              email: body.firstCustomerEmail,
            })
          ).id;
      }

      // Explicit confirmation is required before automatic sending is enabled.
      const autoReminders = Boolean(body.enableScheduledReminders && body.automaticRemindersConsent);
      if (autoReminders) {
        const existingRules = await svc.reminders.listRules(workspaceId);
        if (existingRules.length === 0) {
          for (const rule of DEFAULT_REMINDER_RULES) {
            await svc.reminders.createRule(workspace, req.principal!.userId, {
              name: rule.name,
              daysOffset: rule.daysOffset,
              messageTemplate: rule.messageTemplate,
              kind: 'transactional',
              enabled: false,
            });
          }
        }
        await svc.activity.record({
          workspaceId,
          actorUserId: req.principal!.userId,
          entityType: 'workspace',
          entityId: workspaceId,
          action: 'reminders.automatic_sending_confirmed',
        });
      }

      res.json({ workspace, customerId, automaticRemindersEnabled: autoReminders });
    }),
  );

  // ---------- Customers ------------------------------------------------------

  ws.get(
    '/customers',
    write,
    validate({ query: customerListQuery }),
    asyncHandler(async (req, res) => {
      const result = await services(req).customers.list(req.params.workspaceId as string, {
        page: req.query.page as number,
        pageSize: req.query.pageSize as number,
        search: req.query.search as string | undefined,
        includeArchived: req.query.includeArchived as boolean | undefined,
        sort: req.query.sort as 'name',
        order: req.query.order as 'asc',
      });
      res.json(result);
    }),
  );

  ws.post(
    '/customers',
    write,
    validate({ body: customerBody }),
    asyncHandler(async (req, res) => {
      const customer = await services(req).customers.create(
        req.params.workspaceId as string,
        req.principal!.userId,
        req.body,
      );
      res.status(201).json({ customer });
    }),
  );

  ws.get(
    '/customers/:customerId',
    write,
    validate({ params: customerParams }),
    asyncHandler(async (req, res) => {
      res.json(
        await services(req).customers.detail(
          req.params.workspaceId as string,
          req.params.customerId as string,
        ),
      );
    }),
  );

  ws.patch(
    '/customers/:customerId',
    write,
    validate({ params: customerParams, body: customerPatch }),
    asyncHandler(async (req, res) => {
      const customer = await services(req).customers.update(
        req.params.workspaceId as string,
        req.principal!.userId,
        req.params.customerId as string,
        req.body,
      );
      res.json({ customer });
    }),
  );

  ws.post(
    '/customers/:customerId/archive',
    write,
    validate({ params: customerParams, body: archiveBody }),
    asyncHandler(async (req, res) => {
      const customer = await services(req).customers.setArchived(
        req.params.workspaceId as string,
        req.principal!.userId,
        req.params.customerId as string,
        req.body.archived,
      );
      res.json({ customer });
    }),
  );

  // ---------- Invoices -------------------------------------------------------

  ws.get(
    '/invoices',
    write,
    validate({ query: invoiceListQuery }),
    asyncHandler(async (req, res) => {
      res.json(
        await services(req).invoices.list(req.params.workspaceId as string, {
          page: req.query.page as number,
          pageSize: req.query.pageSize as number,
          search: req.query.search as string | undefined,
          status: req.query.status as never,
          customerId: req.query.customerId as string | undefined,
          dueFrom: req.query.dueFrom as string | undefined,
          dueTo: req.query.dueTo as string | undefined,
          includeArchived: req.query.includeArchived as boolean | undefined,
          sort: req.query.sort as 'due_date',
          order: req.query.order as 'asc',
        }),
      );
    }),
  );

  ws.post(
    '/invoices',
    write,
    validate({ body: invoiceBody }),
    asyncHandler(async (req, res) => {
      const svc = services(req);
      const invoice = await svc.invoices.create(req.workspace!, req.principal!.userId, req.body);
      res.status(201).json({ invoice });
    }),
  );

  ws.get(
    '/invoices/:invoiceId',
    write,
    validate({ params: invoiceParams }),
    asyncHandler(async (req, res) => {
      res.json(
        await services(req).invoices.detail(
          req.params.workspaceId as string,
          req.params.invoiceId as string,
        ),
      );
    }),
  );

  ws.patch(
    '/invoices/:invoiceId',
    write,
    validate({ params: invoiceParams, body: invoicePatch }),
    asyncHandler(async (req, res) => {
      const invoice = await services(req).invoices.update(
        req.workspace!,
        req.principal!.userId,
        req.params.invoiceId as string,
        req.body,
      );
      res.json({ invoice });
    }),
  );

  ws.post(
    '/invoices/:invoiceId/status',
    write,
    validate({ params: invoiceParams, body: statusBody }),
    asyncHandler(async (req, res) => {
      const invoice = await services(req).invoices.setStatus(
        req.workspace!,
        req.principal!.userId,
        req.params.invoiceId as string,
        req.body.status,
      );
      res.json({ invoice });
    }),
  );

  ws.post(
    '/invoices/:invoiceId/archive',
    write,
    validate({ params: invoiceParams, body: archiveBody }),
    asyncHandler(async (req, res) => {
      const invoice = await services(req).invoices.setArchived(
        req.workspace!,
        req.principal!.userId,
        req.params.invoiceId as string,
        req.body.archived,
      );
      res.json({ invoice });
    }),
  );

  ws.get(
    '/invoices/:invoiceId/reminders/preview',
    write,
    validate({ params: invoiceParams, query: z.object({ ruleId: uuid.optional() }) }),
    asyncHandler(async (req, res) => {
      res.json(
        await services(req).reminders.preview(
          req.workspace!,
          req.params.invoiceId as string,
          req.query.ruleId as string | undefined,
        ),
      );
    }),
  );

  ws.post(
    '/invoices/:invoiceId/reminders/send',
    write,
    validate({ params: invoiceParams, body: sendNowBody }),
    asyncHandler(async (req, res) => {
      const result = await services(req).reminders.sendNow(
        req.workspace!,
        req.principal!.userId,
        req.params.invoiceId as string,
        req.body.ruleId as string | undefined,
      );
      res.json(result);
    }),
  );

  ws.post(
    '/invoices/:invoiceId/reminders/cancel',
    write,
    validate({ params: invoiceParams }),
    asyncHandler(async (req, res) => {
      const cancelled = await services(req).reminders.cancelJobs(
        req.workspace!,
        req.principal!.userId,
        req.params.invoiceId as string,
      );
      res.json({ cancelled });
    }),
  );

  ws.post(
    '/invoices/:invoiceId/reminders/resume',
    write,
    validate({ params: invoiceParams }),
    asyncHandler(async (req, res) => {
      const queued = await services(req).reminders.resumeJobs(
        req.workspace!,
        req.principal!.userId,
        req.params.invoiceId as string,
      );
      res.json({ queued });
    }),
  );

  // ---------- Payments -------------------------------------------------------

  ws.get(
    '/payments',
    write,
    validate({ query: paymentListQuery }),
    asyncHandler(async (req, res) => {
      res.json(
        await services(req).payments.list(req.params.workspaceId as string, {
          page: req.query.page as number,
          pageSize: req.query.pageSize as number,
          invoiceId: req.query.invoiceId as string | undefined,
          customerId: req.query.customerId as string | undefined,
          from: req.query.from as string | undefined,
          to: req.query.to as string | undefined,
          includeVoided: req.query.includeVoided as boolean | undefined,
        }),
      );
    }),
  );

  ws.post(
    '/invoices/:invoiceId/payments',
    write,
    validate({ params: invoiceParams, body: paymentBody }),
    asyncHandler(async (req, res) => {
      const result = await services(req).payments.record(
        req.workspace!,
        req.principal!.userId,
        req.params.invoiceId as string,
        req.body,
      );
      res.status(201).json(result);
    }),
  );

  ws.post(
    '/payments/:paymentId/void',
    write,
    validate({ params: paymentParams, body: voidPaymentBody }),
    asyncHandler(async (req, res) => {
      const result = await services(req).payments.voidPayment(
        req.workspace!,
        req.principal!.userId,
        req.params.paymentId as string,
        req.body.reason,
      );
      res.json(result);
    }),
  );

  // ---------- Reminder rules -------------------------------------------------

  ws.get(
    '/reminder-rules',
    write,
    asyncHandler(async (req, res) => {
      res.json({ rules: await services(req).reminders.listRules(req.params.workspaceId as string) });
    }),
  );

  ws.post(
    '/reminder-rules',
    admin,
    validate({ body: reminderRuleBody }),
    asyncHandler(async (req, res) => {
      const rule = await services(req).reminders.createRule(
        req.workspace!,
        req.principal!.userId,
        req.body,
      );
      res.status(201).json({ rule });
    }),
  );

  ws.patch(
    '/reminder-rules/:ruleId',
    admin,
    validate({ params: ruleParams, body: reminderRulePatch }),
    asyncHandler(async (req, res) => {
      const rule = await services(req).reminders.updateRule(
        req.workspace!,
        req.principal!.userId,
        req.params.ruleId as string,
        req.body,
      );
      res.json({ rule });
    }),
  );

  ws.delete(
    '/reminder-rules/:ruleId',
    admin,
    validate({ params: ruleParams }),
    asyncHandler(async (req, res) => {
      await services(req).reminders.deleteRule(
        req.workspace!,
        req.principal!.userId,
        req.params.ruleId as string,
      );
      res.status(204).end();
    }),
  );

  ws.get(
    '/reminder-templates',
    write,
    asyncHandler(async (_req, res) => {
      res.json({
        placeholders: TEMPLATE_PLACEHOLDERS,
        defaults: DEFAULT_REMINDER_RULES,
      });
    }),
  );

  // ---------- Follow-up queue & history --------------------------------------

  ws.get(
    '/reminders/jobs',
    write,
    validate({ query: reminderJobListQuery }),
    asyncHandler(async (req, res) => {
      res.json(
        await services(req).reminders.listJobs(req.params.workspaceId as string, {
          page: req.query.page as number,
          pageSize: req.query.pageSize as number,
          status: req.query.status as never,
          invoiceId: req.query.invoiceId as string | undefined,
          from: req.query.from as string | undefined,
          to: req.query.to as string | undefined,
        }),
      );
    }),
  );

  ws.get(
    '/reminders/history',
    write,
    validate({ query: reminderEventListQuery }),
    asyncHandler(async (req, res) => {
      res.json(
        await services(req).reminders.listEvents(req.params.workspaceId as string, {
          page: req.query.page as number,
          pageSize: req.query.pageSize as number,
          invoiceId: req.query.invoiceId as string | undefined,
          status: req.query.status as never,
          from: req.query.from as string | undefined,
          to: req.query.to as string | undefined,
        }),
      );
    }),
  );

  ws.get(
    '/reminders/suppressions',
    admin,
    asyncHandler(async (req, res) => {
      res.json({
        suppressions: await services(req).reminders.listSuppressions(
          req.params.workspaceId as string,
        ),
      });
    }),
  );

  ws.post(
    '/reminders/suppressions',
    admin,
    validate({ body: suppressionBody }),
    asyncHandler(async (req, res) => {
      const suppression = await services(req).reminders.addSuppression(
        req.workspace!,
        req.principal!.userId,
        req.body,
      );
      res.status(201).json({ suppression });
    }),
  );

  ws.delete(
    '/reminders/suppressions/:suppressionId',
    admin,
    validate({ params: z.object({ workspaceId: uuid, suppressionId: uuid }) }),
    asyncHandler(async (req, res) => {
      await services(req).reminders.removeSuppression(
        req.workspace!,
        req.principal!.userId,
        req.params.suppressionId as string,
      );
      res.status(204).end();
    }),
  );

  // ---------- Dashboard & reports -------------------------------------------

  ws.get(
    '/dashboard',
    write,
    validate({ query: dashboardQuery }),
    asyncHandler(async (req, res) => {
      res.json(
        await services(req).dashboard.dashboard(req.workspace!, {
          daysAhead: req.query.daysAhead as number,
          from: req.query.from as string | undefined,
          to: req.query.to as string | undefined,
        }),
      );
    }),
  );

  ws.get(
    '/reports',
    write,
    validate({ query: reportQuery }),
    asyncHandler(async (req, res) => {
      res.json(
        await services(req).dashboard.report(req.workspace!, {
          from: req.query.from as string | undefined,
          to: req.query.to as string | undefined,
        }),
      );
    }),
  );

  ws.get(
    '/activity',
    write,
    validate({ query: activityQuery }),
    asyncHandler(async (req, res) => {
      res.json(
        await services(req).repo.listActivity(req.params.workspaceId as string, {
          page: req.query.page as number,
          pageSize: req.query.pageSize as number,
          entityType: req.query.entityType as string | undefined,
          entityId: req.query.entityId as string | undefined,
          action: req.query.action as string | undefined,
        }),
      );
    }),
  );

  // ---------- Billing --------------------------------------------------------

  ws.get(
    '/billing',
    write,
    asyncHandler(async (req, res) => {
      const overview = await services(req).billing.overview(req.workspace!);
      res.json({
        ...overview,
        currencies: Object.entries(CURRENCY_EXPONENTS).map(([code, exponent]) => ({
          code,
          exponent,
        })),
      });
    }),
  );

  ws.post(
    '/billing/plan',
    admin,
    validate({ body: changePlanBody }),
    asyncHandler(async (req, res) => {
      const result = await services(req).billing.changePlan({
        workspace: req.workspace!,
        actorUserId: req.principal!.userId,
        planCode: req.body.planCode,
      });
      res.json(result);
    }),
  );

  ws.post(
    '/billing/checkout',
    admin,
    validate({ body: checkoutBody }),
    asyncHandler(async (req, res) => {
      const svc = services(req);
      const safeSuccess = sanitizeRedirect(req.body.successUrl, config.appUrls);
      const safeCancel = sanitizeRedirect(req.body.cancelUrl, config.appUrls);
      if (!safeSuccess || !safeCancel) {
        throw forbidden('Checkout return URLs must point at the configured app origin');
      }
      const result = await svc.billing.startCheckout({
        workspace: req.workspace!,
        planCode: req.body.planCode,
        successUrl: safeSuccess,
        cancelUrl: safeCancel,
        customerEmail: req.principal!.email,
      });
      res.json(result);
    }),
  );

  // ---------- Import / export ------------------------------------------------

  ws.post(
    '/imports/preview',
    write,
    validate({ body: importBody }),
    asyncHandler(async (req, res) => {
      await services(req).billing.requireFeature(req.workspace!, 'csvImport');
      res.json(
        services(req).transfer.preview({
          kind: req.body.kind,
          content: req.body.content,
          ...(req.body.fileName ? { fileName: req.body.fileName } : {}),
        }),
      );
    }),
  );

  ws.post(
    '/imports/validate',
    write,
    validate({ body: importBody }),
    asyncHandler(async (req, res) => {
      const svc = services(req);
      await svc.billing.requireFeature(req.workspace!, 'csvImport');
      res.json(
        await svc.transfer.validate({
          workspace: req.workspace!,
          kind: req.body.kind,
          content: req.body.content,
          mapping: req.body.mapping ?? {},
          ...(req.body.duplicateMode ? { duplicateMode: req.body.duplicateMode } : {}),
        }),
      );
    }),
  );

  ws.post(
    '/imports/commit',
    write,
    validate({ body: importBody }),
    asyncHandler(async (req, res) => {
      const svc = services(req);
      await svc.billing.requireFeature(req.workspace!, 'csvImport');
      res.json(
        await svc.transfer.commit({
          workspace: req.workspace!,
          actorUserId: req.principal!.userId,
          kind: req.body.kind,
          content: req.body.content,
          mapping: req.body.mapping ?? {},
          confirm: Boolean(req.body.confirm),
          ...(req.body.duplicateMode ? { duplicateMode: req.body.duplicateMode } : {}),
        }),
      );
    }),
  );

  ws.get(
    '/exports/:dataset',
    write,
    validate({ params: z.object({ workspaceId: uuid, dataset: z.enum(['customers', 'invoices', 'payments', 'reminders']) }) }),
    asyncHandler(async (req, res) => {
      const svc = services(req);
      await svc.billing.requireFeature(req.workspace!, 'csvImport');
      const workspaceId = req.params.workspaceId as string;
      const dataset = req.params.dataset as 'customers';
      const result =
        dataset === 'customers'
          ? await svc.transfer.exportCustomers(workspaceId)
          : dataset === 'invoices'
            ? await svc.transfer.exportInvoices(workspaceId)
            : dataset === 'payments'
              ? await svc.transfer.exportPayments(workspaceId)
              : await svc.transfer.exportReminderHistory(workspaceId);

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
      res.send(result.csv);
    }),
  );

  router.use('/workspaces/:workspaceId', ws);

  // ---------- Billing webhook (no user auth) --------------------------------

  router.post(
    '/billing/webhook',
    asyncHandler(async (req: Request, res: Response) => {
      const services = factory.forAdmin();
      const verification = services.billing.billingProvider.verifyWebhookSignature(
        JSON.stringify(req.body ?? {}),
        req.headers as Record<string, string | string[] | undefined>,
      );
      if (!verification.ok) {
        // An unconfigured or unverifiable webhook is never processed.
        if (!config.billing.webhookSecret) {
          throw billingUnconfigured('No billing webhook secret is configured');
        }
        throw forbidden(`Webhook signature verification failed (${verification.reason})`);
      }
      const parsed = services.billing.billingProvider.parseWebhookEvent(JSON.stringify(req.body ?? {}));
      if (!parsed) throw badRequestPayload();
      const { sha256Hex } = await import('../../domain/idempotency.js');
      const result = await services.billing.handleWebhookEvent({
        providerEventId: parsed.providerEventId,
        eventType: parsed.eventType,
        payloadSha256: sha256Hex(JSON.stringify(parsed.payload)),
        payload: parsed.payload,
      });
      res.json(result);
    }),
  );

  function badRequestPayload() {
    return Object.assign(new Error('Unsupported webhook payload'), {
      status: 400,
      code: 'bad_request',
      issues: [],
      expose: true,
      meta: {},
      name: 'AppError',
      toJSON: () => ({ error: { code: 'bad_request', message: 'Unsupported webhook payload' } }),
    });
  }

  // ---------- Reference data -------------------------------------------------

  router.get(
    '/reference',
    asyncHandler(async (_req, res) => {
      res.json({
        currencies: Object.entries(CURRENCY_EXPONENTS).map(([code, exponent]) => ({
          code,
          exponent,
        })),
        templatePlaceholders: TEMPLATE_PLACEHOLDERS,
        defaultReminderRules: DEFAULT_REMINDER_RULES,
        safeRedirectHint: SAFE_REDIRECT_PATH,
      });
    }),
  );

  return router;
}

/** Only same-origin URLs (or relative paths) are accepted as return targets. */
export function sanitizeRedirect(value: string, allowedOrigins: string[]): string | null {
  try {
    const url = new URL(value);
    const allowed = allowedOrigins.some((origin) => {
      try {
        return new URL(origin).origin === url.origin;
      } catch {
        return false;
      }
    });
    return allowed ? url.toString() : null;
  } catch {
    return null;
  }
}