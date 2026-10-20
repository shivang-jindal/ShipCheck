import { Router } from 'express';
import { z } from 'zod';

import {
  changeMemberRoleSchema,
  createInvitationSchema,
  idParamSchema,
  transferOwnershipSchema,
  updateOrganizationSchema,
} from '@shipcheck/shared';

import type { Services } from '../../container.js';
import { asyncHandler, requirePermission } from '../middleware.js';
import { validate } from '../validate.js';

export function organizationRouter(services: Services): Router {
  // mergeParams keeps `:organizationId` visible to route-level validation.
  const router = Router({ mergeParams: true });

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const [organization, settings] = await Promise.all([
        services.organizations.get(req.organization!.id),
        services.organizations.getSettings(req.organization!.id),
      ]);
      res.json({ organization, role: req.organizationRole, permissions: req.permissions, settings });
    }),
  );

  router.patch(
    '/',
    requirePermission('settings.manage'),
    validate({ body: updateOrganizationSchema }),
    asyncHandler(async (req, res) => {
      res.json({
        organization: await services.organizations.update(
          req.organization!.id,
          req.principal!.user.id,
          req.body as never,
        ),
      });
    }),
  );

  /* ---------------------------------------------------------------------- */
  /* Members and invitations                                                */
  /* ---------------------------------------------------------------------- */

  router.get(
    '/members',
    asyncHandler(async (req, res) => {
      res.json({
        members: await services.organizations.listMembers(req.organization!.id),
        myRole: req.organizationRole,
      });
    }),
  );

  router.post(
    '/members/invitations',
    requirePermission('member.manage'),
    validate({ body: createInvitationSchema }),
    asyncHandler(async (req, res) => {
      const body = req.body as { email: string; role: 'admin' | 'member' | 'viewer' };
      const invitation = await services.organizations.invite({
        organizationId: req.organization!.id,
        email: body.email,
        role: body.role,
        invitedBy: req.principal!.user.id,
        actorRole: req.organizationRole!,
      });

      const acceptUrl = `${services.config.appUrl}/accept-invitation?token=${invitation.token}`;
      const verification = await services.emailAdapter.verifyConfiguration();

      let emailed = false;
      if (verification.ok) {
        const queued = await services.email.queueSystemEmail({
          organizationId: req.organization!.id,
          to: body.email,
          subject: `You have been invited to ${req.organization!.name} on ShipCheck`,
          bodyText: [
            `${req.principal!.user.displayName} invited you to join ${req.organization!.name} as ${body.role}.`,
            '',
            `Accept the invitation: ${acceptUrl}`,
            '',
            'The link expires in 7 days and can only be used once.',
          ].join('\n'),
          idempotencyKey: `invitation:${invitation.invitationId}`,
        });
        const delivery = await services.email.deliver(queued.messageId);
        emailed = delivery.status === 'sent';
      }

      res.status(201).json({
        invitation: {
          expiresAt: invitation.expiresAt.toISOString(),
          acceptUrl,
          emailed,
          emailConfigured: verification.ok,
        },
      });
    }),
  );

  router.get(
    '/members/invitations',
    requirePermission('member.manage'),
    asyncHandler(async (req, res) => {
      res.json({ invitations: await services.organizations.listInvitations(req.organization!.id) });
    }),
  );

  router.delete(
    '/members/invitations/:invitationId',
    requirePermission('member.manage'),
    validate({
      params: z.object({
        organizationId: idParamSchema.shape.id,
        invitationId: idParamSchema.shape.id,
      }),
    }),
    asyncHandler(async (req, res) => {
      await services.organizations.revokeInvitation(
        req.organization!.id,
        req.params.invitationId as string,
        req.principal!.user.id,
      );
      res.status(204).end();
    }),
  );

  router.patch(
    '/members/:memberId',
    requirePermission('member.manage'),
    validate({
      params: z.object({
        organizationId: idParamSchema.shape.id,
        memberId: idParamSchema.shape.id,
      }),
      body: changeMemberRoleSchema,
    }),
    asyncHandler(async (req, res) => {
      const member = await services.organizations.changeMemberRole({
        organizationId: req.organization!.id,
        membershipId: req.params.memberId as string,
        actorUserId: req.principal!.user.id,
        actorRole: req.organizationRole!,
        role: (req.body as { role: 'admin' | 'member' | 'viewer' }).role,
      });
      res.json({ member });
    }),
  );

  router.delete(
    '/members/:memberId',
    requirePermission('member.manage'),
    validate({
      params: z.object({
        organizationId: idParamSchema.shape.id,
        memberId: idParamSchema.shape.id,
      }),
    }),
    asyncHandler(async (req, res) => {
      await services.organizations.removeMember({
        organizationId: req.organization!.id,
        membershipId: req.params.memberId as string,
        actorUserId: req.principal!.user.id,
        actorRole: req.organizationRole!,
      });
      res.status(204).end();
    }),
  );

  router.post(
    '/transfer-ownership',
    requirePermission('ownership.transfer'),
    validate({ body: transferOwnershipSchema }),
    asyncHandler(async (req, res) => {
      const body = req.body as { membershipId: string; confirmation: string };
      const member = await services.organizations.transferOwnership({
        organizationId: req.organization!.id,
        membershipId: body.membershipId,
        actorUserId: req.principal!.user.id,
        confirmation: body.confirmation,
      });
      res.json({ member });
    }),
  );

  /* ---------------------------------------------------------------------- */
  /* Audit                                                                  */
  /* ---------------------------------------------------------------------- */

  router.get(
    '/audit',
    requirePermission('audit.view'),
    validate({
      query: z.object({
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(25),
        entityType: z.string().trim().max(50).optional(),
        action: z.string().trim().max(80).optional(),
      }),
    }),
    asyncHandler(async (req, res) => {
      res.json(await services.audit.list(req.organization!.id, req.query as never));
    }),
  );

  return router;
}