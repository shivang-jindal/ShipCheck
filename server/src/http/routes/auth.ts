import { Router, type CookieOptions, type RequestHandler, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';

import {
  acceptInvitationSchema,
  changePasswordSchema,
  createOrganizationSchema,
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
  updateProfileSchema,
} from '@shipcheck/shared';

import type { Services } from '../../container.js';
import { asyncHandler, requireAuthenticated } from '../middleware.js';
import { validate } from '../validate.js';

const organizationSwitchParams = z.object({ organizationId: z.string().uuid() });

/** A Firebase ID token is a JWT; bound the size before any parsing. */
const googleSignInSchema = z.object({
  idToken: z.string().trim().min(20).max(10_000),
});

export function authRouter(services: Services): Router {
  const router = Router();

  /**
   * Credential endpoints get a much tighter budget than the global limiter:
   * these are the only routes where an attacker can guess a secret. Successful
   * requests are not counted, so a legitimate user who signs in repeatedly is
   * never locked out, while a run of failures is.
   */
  const credentialLimit = rateLimit({
    windowMs: services.config.rateLimit.windowMs,
    limit: services.config.rateLimit.authMax,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    handler: (_req, res) => {
      res.status(429).json({
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many failed attempts. Please wait a minute and try again.',
        },
      });
    },
  });
  const credentialLimiter: RequestHandler = credentialLimit;

  function setSessionCookie(res: Response, token: string, expiresAt: Date): void {
    const options: CookieOptions = {
      httpOnly: true,
      secure: services.config.session.cookieSecure,
      sameSite: 'lax',
      path: '/',
      expires: expiresAt,
    };
    res.cookie(services.config.session.cookieName, token, options);
  }

  router.post(
    '/register',
    credentialLimiter,
    validate({ body: registerSchema }),
    asyncHandler(async (req, res) => {
      const { user, session } = await services.auth.register({
        ...(req.body as { email: string; password: string; displayName: string }),
        meta: { ipAddress: req.clientIp, userAgent: req.userAgent },
      });
      setSessionCookie(res, session.token, session.expiresAt);
      const payload = await services.auth.sessionPayload(user.id, null);
      res.status(201).json(payload);
    }),
  );

  router.post(
    '/login',
    credentialLimiter,
    validate({ body: loginSchema }),
    asyncHandler(async (req, res) => {
      const { user, session } = await services.auth.signIn({
        ...(req.body as { email: string; password: string }),
        meta: { ipAddress: req.clientIp, userAgent: req.userAgent },
      });
      setSessionCookie(res, session.token, session.expiresAt);
      const payload = await services.auth.sessionPayload(user.id, null);
      res.json(payload);
    }),
  );

  router.post(
    '/google',
    credentialLimiter,
    validate({ body: googleSignInSchema }),
    asyncHandler(async (req, res) => {
      const { user, session } = await services.auth.signInWithGoogle({
        idToken: (req.body as { idToken: string }).idToken,
        meta: { ipAddress: req.clientIp, userAgent: req.userAgent },
      });
      setSessionCookie(res, session.token, session.expiresAt);
      const payload = await services.auth.sessionPayload(user.id, null);
      res.json(payload);
    }),
  );

  router.post(
    '/logout',
    asyncHandler(async (req, res) => {
      await services.auth.revokeSession(req.cookies?.[services.config.session.cookieName]);
      res.clearCookie(services.config.session.cookieName, { path: '/' });
      res.status(204).end();
    }),
  );

  router.get(
    '/session',
    asyncHandler(async (req, res) => {
      if (!req.principal) {
        res.status(401).json({
          error: { code: 'UNAUTHENTICATED', message: 'No active session.', requestId: req.requestId },
        });
        return;
      }
      res.json(
        await services.auth.sessionPayload(
          req.principal.user.id,
          req.principal.activeOrganizationId,
        ),
      );
    }),
  );

  router.get(
    '/me',
    requireAuthenticated(),
    asyncHandler(async (req, res) => {
      res.json({ user: req.principal!.user });
    }),
  );

  router.patch(
    '/me',
    requireAuthenticated(),
    validate({ body: updateProfileSchema }),
    asyncHandler(async (req, res) => {
      const user = await services.auth.updateProfile(
        req.principal!.user.id,
        (req.body as { displayName?: string }).displayName,
      );
      res.json({ user });
    }),
  );

  router.post(
    '/password/change',
    requireAuthenticated(),
    validate({ body: changePasswordSchema }),
    asyncHandler(async (req, res) => {
      const body = req.body as { currentPassword: string; newPassword: string };
      await services.auth.changePassword(
        req.principal!.user.id,
        body.currentPassword,
        body.newPassword,
      );
      res.clearCookie(services.config.session.cookieName, { path: '/' });
      res.status(204).end();
    }),
  );

  router.post(
    '/password/forgot',
    credentialLimiter,
    validate({ body: forgotPasswordSchema }),
    asyncHandler(async (req, res) => {
      const { email } = req.body as { email: string };
      const result = await services.auth.requestPasswordReset(email);
      const verification = await services.emailAdapter.verifyConfiguration();

      let emailed = false;
      if (result.token && verification.ok && services.email.from) {
        const queued = await services.email.queueSystemEmail({
          organizationId: null,
          to: email,
          subject: 'Reset your ShipCheck password',
          bodyText: [
            'A password reset was requested for your ShipCheck account.',
            '',
            `Reset link: ${services.config.appUrl}/reset-password?token=${result.token}`,
            '',
            'The link expires in 60 minutes. If you did not request it, you can ignore this message.',
          ].join('\n'),
        });
        await services.email.deliver(queued.messageId);
        emailed = true;
      }

      res.json({
        ok: true,
        message:
          'If that account exists, a reset link has been sent. Without a working email provider the link is only reachable in development logs.',
        resetEmailAvailable: emailed,
      });
    }),
  );

  router.post(
    '/password/reset',
    credentialLimiter,
    validate({ body: resetPasswordSchema }),
    asyncHandler(async (req, res) => {
      const { token, password } = req.body as { token: string; password: string };
      await services.auth.resetPassword(token, password);
      res.status(204).end();
    }),
  );

  /* ---------------------------------------------------------------------- */
  /* Organizations                                                           */
  /* ---------------------------------------------------------------------- */

  router.get(
    '/organizations',
    requireAuthenticated(),
    asyncHandler(async (req, res) => {
      res.json({ organizations: await services.auth.membershipsFor(req.principal!.user.id) });
    }),
  );

  router.post(
    '/organizations',
    requireAuthenticated(),
    validate({ body: createOrganizationSchema }),
    asyncHandler(async (req, res) => {
      const body = req.body as {
        name: string;
        countryCode: string;
        timezone: string;
        baseCurrency: string;
      };
      const organization = await services.organizations.create({
        ...body,
        ownerId: req.principal!.user.id,
        requestId: req.requestId,
        ipAddress: req.clientIp,
      });
      await services.organizations.seedTemplates(organization.id);
      res.status(201).json({ organization });
    }),
  );

  router.post(
    '/organizations/:organizationId/switch',
    requireAuthenticated(),
    validate({ params: organizationSwitchParams }),
    asyncHandler(async (req, res) => {
      const organizationId = req.params.organizationId as string;
      // Membership is checked before the session pointer is moved.
      await services.organizations.requireMembership(organizationId, req.principal!.user.id);
      await services.auth.setActiveOrganization(req.principal!.sessionId, organizationId);
      res.json(await services.auth.sessionPayload(req.principal!.user.id, organizationId));
    }),
  );

  router.post(
    '/accept-invitation',
    requireAuthenticated(),
    validate({ body: acceptInvitationSchema }),
    asyncHandler(async (req, res) => {
      const { token } = req.body as { token: string };
      const organization = await services.organizations.acceptInvitation(
        token,
        req.principal!.user.id,
      );
      await services.organizations.seedTemplates(organization.id);
      res.status(201).json({
        organization,
        session: await services.auth.sessionPayload(req.principal!.user.id, organization.id),
      });
    }),
  );

  return router;
}