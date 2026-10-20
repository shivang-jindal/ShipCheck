/** Organizations, membership, invitations and ShipCheck settings (C2, C3.10). */

import { and, eq, isNull } from 'drizzle-orm';

import { isValidTimeZone, type Role } from '@shipcheck/shared';

import type { AppDatabase } from '../db/client.js';
import {
  auditEvents,
  emailTemplates,
  invitations,
  memberships,
  notificationRules,
  organizationSettings,
  organizations,
  users,
} from '../db/schema.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../errors.js';
import { randomToken, sha256Hex } from '../lib/crypto.js';
import { slugify, uniqueSlug } from '../lib/util.js';
import type { AuditService } from './audit.service.js';
import { DEFAULT_NOTIFICATION_TEMPLATES } from '../integrations/email/templates.js';

const TRANSFER_PHRASE = 'TRANSFER OWNERSHIP';

export interface OrganizationRecord {
  id: string;
  name: string;
  slug: string;
  countryCode: string;
  timezone: string;
  baseCurrency: string;
  logoUrl: string | null;
  addressLine1: string | null;
  city: string | null;
  postalCode: string | null;
  createdAt: string;
}

export interface MemberRecord {
  id: string;
  userId: string;
  email: string;
  displayName: string;
  role: Role;
  status: string;
  createdAt: string;
}

export interface SettingsPatch {
  defaultCarrierCode: string;
  stalledAfterHours: number;
  autoOpenExceptions: boolean;
  defaultCooldownMinutes: number;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
}

export class OrganizationService {
  constructor(
    private readonly db: AppDatabase,
    private readonly audit: AuditService,
  ) {}

  async create(input: {
    name: string;
    countryCode: string;
    timezone: string;
    baseCurrency: string;
    ownerId: string;
    requestId?: string | null;
    ipAddress?: string | null;
  }): Promise<OrganizationRecord> {
    if (!isValidTimeZone(input.timezone)) {
      throw badRequest('Choose a valid IANA timezone, for example Europe/Berlin.', {
        timezone: ['Unknown timezone'],
      });
    }

    return this.db.transaction(async (tx) => {
      const baseSlug = slugify(input.name);
      const slug = await uniqueSlug(baseSlug, async (candidate) => {
        const rows = await tx
          .select({ id: organizations.id })
          .from(organizations)
          .where(eq(organizations.slug, candidate))
          .limit(1);
        return rows.length > 0;
      });

      const inserted = await tx
        .insert(organizations)
        .values({
          name: input.name.trim(),
          slug,
          countryCode: input.countryCode,
          timezone: input.timezone,
          baseCurrency: input.baseCurrency,
        })
        .returning();

      const organization = inserted[0]!;
      await tx.insert(memberships).values({
        organizationId: organization.id,
        userId: input.ownerId,
        role: 'owner',
        status: 'active',
      });
      await tx.insert(organizationSettings).values({ organizationId: organization.id });
      await tx.insert(auditEvents).values({
        organizationId: organization.id,
        actorUserId: input.ownerId,
        action: 'organization.created',
        entityType: 'organization',
        entityId: organization.id,
        requestId: input.requestId ?? null,
        ipAddress: input.ipAddress ?? null,
      });
      return toRecord(organization);
    });
  }

  async requireMembership(organizationId: string, userId: string): Promise<MemberRecord> {
    const rows = await this.db
      .select({
        membershipId: memberships.id,
        userId: memberships.userId,
        role: memberships.role,
        status: memberships.status,
        createdAt: memberships.createdAt,
        email: users.email,
        displayName: users.displayName,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.organizationId, organizationId), eq(memberships.userId, userId)))
      .limit(1);

    const row = rows[0];
    if (!row || row.status !== 'active') throw notFound('Organization');
    return {
      id: row.membershipId,
      userId: row.userId,
      email: row.email,
      displayName: row.displayName,
      role: row.role as Role,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async listMembers(organizationId: string): Promise<MemberRecord[]> {
    const rows = await this.db
      .select({
        membershipId: memberships.id,
        userId: memberships.userId,
        role: memberships.role,
        status: memberships.status,
        createdAt: memberships.createdAt,
        email: users.email,
        displayName: users.displayName,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.organizationId, organizationId))
      .orderBy(memberships.createdAt);

    return rows.map((row) => ({
      id: row.membershipId,
      userId: row.userId,
      email: row.email,
      displayName: row.displayName,
      role: row.role as Role,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async get(organizationId: string): Promise<OrganizationRecord> {
    const rows = await this.db
      .select()
      .from(organizations)
      .where(and(eq(organizations.id, organizationId), isNull(organizations.deletedAt)))
      .limit(1);
    if (!rows[0]) throw notFound('Organization');
    return toRecord(rows[0]);
  }

  async update(
    organizationId: string,
    actorUserId: string,
    patch: Partial<{
      name: string;
      countryCode: string;
      timezone: string;
      logoUrl: string | null;
      addressLine1: string | null;
      city: string | null;
      postalCode: string | null;
    }>,
  ): Promise<OrganizationRecord> {
    if (patch.timezone && !isValidTimeZone(patch.timezone)) {
      throw badRequest('Choose a valid IANA timezone.', { timezone: ['Unknown timezone'] });
    }
    const updated = await this.db
      .update(organizations)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(organizations.id, organizationId))
      .returning();
    if (!updated[0]) throw notFound('Organization');
    await this.audit.record({
      organizationId,
      actorUserId,
      action: 'organization.updated',
      entityType: 'organization',
      entityId: organizationId,
      metadata: { fields: Object.keys(patch) },
    });
    return toRecord(updated[0]);
  }

  async getSettings(organizationId: string) {
    const rows = await this.db
      .select()
      .from(organizationSettings)
      .where(eq(organizationSettings.organizationId, organizationId))
      .limit(1);
    return rows[0] ?? null;
  }

  async updateSettings(
    organizationId: string,
    actorUserId: string,
    patch: Partial<SettingsPatch>,
  ) {
    const updated = await this.db
      .insert(organizationSettings)
      .values({ organizationId, ...patch, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: organizationSettings.organizationId,
        set: { ...patch, updatedAt: new Date() },
      })
      .returning();
    await this.audit.record({
      organizationId,
      actorUserId,
      action: 'settings.updated',
      entityType: 'organization',
      entityId: organizationId,
      metadata: { fields: Object.keys(patch) },
    });
    return updated[0]!;
  }

  /* ---------------------------------------------------------------------- */

  async invite(input: {
    organizationId: string;
    email: string;
    role: Role;
    invitedBy: string;
    actorRole: Role;
  }): Promise<{ token: string; expiresAt: Date; invitationId: string }> {
    if (input.actorRole !== 'owner' && input.actorRole !== 'admin') {
      throw forbidden('Only an owner or admin can invite members.');
    }
    if (input.role === 'owner') {
      throw unprocessable('Ownership is transferred, not invited. Use Transfer ownership.');
    }
    const email = input.email.trim().toLowerCase();

    const existing = await this.db
      .select({ id: memberships.id })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.organizationId, input.organizationId), eq(users.email, email)))
      .limit(1);
    if (existing[0]) throw conflict('That person is already a member of this organization.');

    const token = randomToken(32);
    const expiresAt = new Date(Date.now() + 7 * 24 * 3_600_000);
    const inserted = await this.db
      .insert(invitations)
      .values({
        organizationId: input.organizationId,
        email,
        role: input.role,
        tokenHash: sha256Hex(token),
        expiresAt,
        invitedBy: input.invitedBy,
      })
      .returning({ id: invitations.id });

    await this.audit.record({
      organizationId: input.organizationId,
      actorUserId: input.invitedBy,
      action: 'member.invited',
      entityType: 'invitation',
      entityId: inserted[0]!.id,
      metadata: { role: input.role },
    });
    return { token, expiresAt, invitationId: inserted[0]!.id };
  }

  async listInvitations(organizationId: string) {
    const rows = await this.db
      .select({
        id: invitations.id,
        email: invitations.email,
        role: invitations.role,
        expiresAt: invitations.expiresAt,
        acceptedAt: invitations.acceptedAt,
        revokedAt: invitations.revokedAt,
        createdAt: invitations.createdAt,
      })
      .from(invitations)
      .where(and(eq(invitations.organizationId, organizationId), isNull(invitations.acceptedAt)))
      .orderBy(invitations.createdAt);

    return rows.map((row) => ({
      ...row,
      expiresAt: row.expiresAt.toISOString(),
      acceptedAt: row.acceptedAt?.toISOString() ?? null,
      revokedAt: row.revokedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      state: row.revokedAt ? 'revoked' : row.expiresAt.getTime() < Date.now() ? 'expired' : 'pending',
    }));
  }

  async revokeInvitation(organizationId: string, invitationId: string, actorUserId: string) {
    const updated = await this.db
      .update(invitations)
      .set({ revokedAt: new Date() })
      .where(and(eq(invitations.id, invitationId), eq(invitations.organizationId, organizationId)))
      .returning({ id: invitations.id });
    if (!updated[0]) throw notFound('Invitation');
    await this.audit.record({
      organizationId,
      actorUserId,
      action: 'member.invitation_revoked',
      entityType: 'invitation',
      entityId: invitationId,
    });
  }

  async acceptInvitation(token: string, userId: string): Promise<OrganizationRecord> {
    const rows = await this.db
      .select()
      .from(invitations)
      .where(and(eq(invitations.tokenHash, sha256Hex(token)), isNull(invitations.acceptedAt)))
      .limit(1);
    const invitation = rows[0];
    if (!invitation) throw badRequest('This invitation link is invalid or has already been used.');
    if (invitation.expiresAt.getTime() <= Date.now()) {
      throw badRequest('This invitation link has expired. Ask for a new invitation.');
    }

    return this.db.transaction(async (tx) => {
      const claimed = await tx
        .update(invitations)
        .set({ acceptedAt: new Date() })
        .where(and(eq(invitations.id, invitation.id), isNull(invitations.acceptedAt)))
        .returning({ id: invitations.id });
      if (!claimed[0]) throw conflict('This invitation has already been used.');

      const existing = await tx
        .select({ id: memberships.id })
        .from(memberships)
        .where(
          and(eq(memberships.organizationId, invitation.organizationId), eq(memberships.userId, userId)),
        )
        .limit(1);

      if (!existing[0]) {
        await tx.insert(memberships).values({
          organizationId: invitation.organizationId,
          userId,
          role: invitation.role,
          status: 'active',
          invitedBy: invitation.invitedBy,
        });
      }
      await tx.insert(auditEvents).values({
        organizationId: invitation.organizationId,
        actorUserId: userId,
        action: 'member.invitation_accepted',
        entityType: 'organization',
        entityId: invitation.organizationId,
      });
      const orgRows = await tx
        .select()
        .from(organizations)
        .where(eq(organizations.id, invitation.organizationId))
        .limit(1);
      return toRecord(orgRows[0]!);
    });
  }

  async changeMemberRole(input: {
    organizationId: string;
    membershipId: string;
    actorUserId: string;
    actorRole: Role;
    role: Role;
  }): Promise<MemberRecord> {
    if (input.actorRole !== 'owner' && input.actorRole !== 'admin') {
      throw forbidden('Only an owner or admin can change roles.');
    }
    const members = await this.listMembers(input.organizationId);
    const target = members.find((member) => member.id === input.membershipId);
    if (!target) throw notFound('Member');
    if (target.role === 'owner') {
      throw unprocessable(
        'An organization must always have an owner. Use Transfer ownership instead of changing the owner role.',
      );
    }

    await this.db
      .update(memberships)
      .set({ role: input.role, updatedAt: new Date() })
      .where(
        and(eq(memberships.id, input.membershipId), eq(memberships.organizationId, input.organizationId)),
      );

    await this.audit.record({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      action: 'member.role_changed',
      entityType: 'membership',
      entityId: input.membershipId,
      metadata: { from: target.role, to: input.role },
    });
    return { ...target, role: input.role };
  }

  async removeMember(input: {
    organizationId: string;
    membershipId: string;
    actorUserId: string;
    actorRole: Role;
  }): Promise<void> {
    if (input.actorRole !== 'owner' && input.actorRole !== 'admin') {
      throw forbidden('Only an owner or admin can remove members.');
    }
    const members = await this.listMembers(input.organizationId);
    const target = members.find((member) => member.id === input.membershipId);
    if (!target) throw notFound('Member');
    if (target.role === 'owner') throw unprocessable('The owner cannot be removed. Transfer ownership first.');
    if (target.userId === input.actorUserId) {
      throw unprocessable('You cannot remove your own membership. Ask another owner or admin.');
    }

    await this.db
      .delete(memberships)
      .where(
        and(eq(memberships.id, input.membershipId), eq(memberships.organizationId, input.organizationId)),
      );
    await this.audit.record({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      action: 'member.removed',
      entityType: 'membership',
      entityId: input.membershipId,
      metadata: { email: target.email },
    });
  }

  async transferOwnership(input: {
    organizationId: string;
    membershipId: string;
    actorUserId: string;
    confirmation: string;
  }): Promise<MemberRecord> {
    if (input.confirmation !== TRANSFER_PHRASE) {
      throw unprocessable(`Type ${TRANSFER_PHRASE} exactly to confirm the ownership transfer.`, {
        confirmation: ['Confirmation phrase does not match'],
      });
    }
    const members = await this.listMembers(input.organizationId);
    const actor = members.find((member) => member.userId === input.actorUserId);
    if (!actor || actor.role !== 'owner') {
      throw forbidden('Only the current owner can transfer ownership.');
    }
    const target = members.find((member) => member.id === input.membershipId);
    if (!target) throw notFound('Member');
    if (target.id === actor.id) throw unprocessable('You already own this organization.');

    return this.db.transaction(async (tx) => {
      await tx.update(memberships).set({ role: 'owner', updatedAt: new Date() }).where(eq(memberships.id, target.id));
      await tx.update(memberships).set({ role: 'admin', updatedAt: new Date() }).where(eq(memberships.id, actor.id));
      await tx.insert(auditEvents).values({
        organizationId: input.organizationId,
        actorUserId: input.actorUserId,
        action: 'organization.ownership_transferred',
        entityType: 'organization',
        entityId: input.organizationId,
        metadata: { fromUserId: actor.userId, toUserId: target.userId },
      });
      return { ...target, role: 'owner' as Role };
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Templates and notification rules                                       */
  /* ---------------------------------------------------------------------- */

  async seedTemplates(organizationId: string): Promise<void> {
    const existing = await this.db
      .select({ id: emailTemplates.id })
      .from(emailTemplates)
      .where(eq(emailTemplates.organizationId, organizationId))
      .limit(1);
    if (existing[0]) return;

    await this.db.insert(emailTemplates).values(
      DEFAULT_NOTIFICATION_TEMPLATES.map((template) => ({
        organizationId,
        type: template.type,
        subject: template.subject,
        bodyHtml: template.bodyHtml,
      })),
    );

    const settings = await this.getSettings(organizationId);
    await this.db.insert(notificationRules).values([
      {
        organizationId,
        eventType: 'shipment_created',
        enabled: false,
        templateId: 'shipment_created',
        cooldownMinutes: 0,
      },
      {
        organizationId,
        eventType: 'in_transit',
        enabled: false,
        templateId: 'in_transit',
        cooldownMinutes: settings?.defaultCooldownMinutes ?? 360,
      },
      {
        organizationId,
        eventType: 'out_for_delivery',
        enabled: false,
        templateId: 'out_for_delivery',
        cooldownMinutes: 0,
      },
      {
        organizationId,
        eventType: 'delivered',
        enabled: false,
        templateId: 'delivered',
        cooldownMinutes: 0,
      },
      {
        organizationId,
        eventType: 'exception',
        enabled: false,
        templateId: 'exception',
        cooldownMinutes: settings?.defaultCooldownMinutes ?? 360,
      },
    ]);
  }

  async listNotificationRules(organizationId: string) {
    return this.db
      .select()
      .from(notificationRules)
      .where(eq(notificationRules.organizationId, organizationId))
      .orderBy(notificationRules.eventType);
  }

  async updateNotificationRules(
    organizationId: string,
    actorUserId: string,
    rules: Array<{ eventType: string; enabled: boolean; cooldownMinutes: number }>,
  ) {
    for (const rule of rules) {
      await this.db
        .update(notificationRules)
        .set({ enabled: rule.enabled, cooldownMinutes: rule.cooldownMinutes, updatedAt: new Date() })
        .where(
          and(
            eq(notificationRules.organizationId, organizationId),
            eq(notificationRules.eventType, rule.eventType),
          ),
        );
    }
    await this.audit.record({
      organizationId,
      actorUserId,
      action: 'settings.notifications.updated',
      entityType: 'organization',
      entityId: organizationId,
      metadata: { rules },
    });
    return this.listNotificationRules(organizationId);
  }
}

export function toRecord(row: typeof organizations.$inferSelect): OrganizationRecord {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    countryCode: row.countryCode,
    timezone: row.timezone,
    baseCurrency: row.baseCurrency,
    logoUrl: row.logoUrl,
    addressLine1: row.addressLine1,
    city: row.city,
    postalCode: row.postalCode,
    createdAt: row.createdAt.toISOString(),
  };
}