import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuthUser, RequestMeta } from '../auth/auth.types';
import { EmailTokenService } from '../auth/email-token.service';
import { MfaService } from '../auth/mfa.service';
import { SessionService } from '../auth/session.service';
import { DomainEvents } from '../domain/events.service';
import { PrismaService } from '../prisma/prisma.service';
import type { InviteUserDto, ListUsersQuery } from './users.dto';

const userInclude = {
  profile: true,
  roles: { include: { role: { select: { code: true, name: true } } } },
} satisfies Prisma.UserInclude;

type UserRow = Prisma.UserGetPayload<{ include: typeof userInclude }>;

/** Never returns hashes, tokens or MFA material. */
const present = (u: UserRow) => ({
  id: u.id, email: u.email, fullName: u.profile?.fullName ?? null, phone: u.profile?.phone ?? null,
  status: u.status, emailVerified: u.emailVerified, mfaEnabled: u.mfaEnabled,
  lastLoginAt: u.lastLoginAt, createdAt: u.createdAt, roles: u.roles.map((r) => r.role.code),
});

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly emailTokens: EmailTokenService,
    private readonly sessions: SessionService,
    private readonly mfa: MfaService,
    private readonly events: DomainEvents,
  ) {}

  async list(q: ListUsersQuery) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 25;
    const where: Prisma.UserWhereInput = {
      deletedAt: null,
      ...(q.status ? { status: q.status } : {}),
      ...(q.q ? { OR: [{ email: { contains: q.q.toLowerCase() } }, { profile: { fullName: { contains: q.q, mode: 'insensitive' } } }] } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.user.findMany({ where, include: userInclude, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
      this.prisma.user.count({ where }),
    ]);
    return { items: rows.map(present), page, limit, total };
  }

  async get(id: string) {
    const u = await this.prisma.user.findFirst({ where: { id, deletedAt: null }, include: userInclude });
    if (!u) throw new NotFoundException('User not found.');
    return present(u);
  }

  async invite(actor: AuthUser, dto: InviteUserDto, meta: RequestMeta) {
    const roles = await this.resolveAssignableRoles(actor, dto.roleCodes);
    const exists = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (exists) throw new ConflictException('A user with this email already exists.');
    const { user, token } = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: dto.email, status: 'INVITED',
          profile: { create: { fullName: dto.fullName, phone: dto.phone } },
          roles: { create: roles.map((r) => ({ roleId: r.id })) },
        },
      });
      const token = await this.emailTokens.issue(user.id, 'INVITE', tx);
      await this.audit.record({
        action: 'user.invited', userId: actor.id, userName: actor.fullName, entityType: 'user', entityId: user.id,
        after: { email: dto.email, roles: dto.roleCodes }, ip: meta.ip, requestId: meta.requestId,
      }, tx);
      return { user, token };
    });
    await this.emailTokens.sendLink(user.email, 'INVITE', token);
    return this.get(user.id);
  }

  async resendInvite(actor: AuthUser, id: string, meta: RequestMeta) {
    const u = await this.prisma.user.findFirst({ where: { id, deletedAt: null } });
    if (!u) throw new NotFoundException('User not found.');
    if (u.status !== 'INVITED') throw new BadRequestException('This user has already accepted their invitation.');
    await this.assertCanManage(actor, id);
    const token = await this.emailTokens.issue(id, 'INVITE');
    await this.emailTokens.sendLink(u.email, 'INVITE', token);
    await this.audit.record({ action: 'user.invite_resent', userId: actor.id, userName: actor.fullName, entityType: 'user', entityId: id, ip: meta.ip, requestId: meta.requestId });
  }

  async setRoles(actor: AuthUser, id: string, roleCodes: string[], reason: string, meta: RequestMeta) {
    if (id === actor.id) throw new ForbiddenException('You cannot change your own roles.');
    await this.assertCanManage(actor, id);
    const roles = await this.resolveAssignableRoles(actor, roleCodes);
    const before = await this.currentRoleCodes(id);
    if (before.includes('SUPER_ADMIN') && !roleCodes.includes('SUPER_ADMIN')) await this.assertNotLastSuperAdmin(id);
    await this.prisma.$transaction(async (tx) => {
      await tx.userRole.deleteMany({ where: { userId: id } });
      await tx.userRole.createMany({ data: roles.map((r) => ({ userId: id, roleId: r.id })) });
      await this.audit.record({
        action: 'user.roles_changed', userId: actor.id, userName: actor.fullName, entityType: 'user', entityId: id,
        before: { roles: before }, after: { roles: roleCodes }, reason, ip: meta.ip, requestId: meta.requestId,
      }, tx);
    });
    this.events.emit({ name: 'access.changed', entityId: id, actorId: actor.id });
    return this.get(id);
  }

  async disable(actor: AuthUser, id: string, reason: string, meta: RequestMeta) {
    if (id === actor.id) throw new ForbiddenException('You cannot disable your own account.');
    await this.assertCanManage(actor, id);
    const target = await this.currentRoleCodes(id);
    if (target.includes('SUPER_ADMIN')) await this.assertNotLastSuperAdmin(id);
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id }, data: { status: 'DISABLED', tokenVersion: { increment: 1 } } }); // kills access tokens at once
      await this.audit.record({
        action: 'user.disabled', userId: actor.id, userName: actor.fullName, entityType: 'user', entityId: id, reason,
        ip: meta.ip, requestId: meta.requestId,
      }, tx);
    });
    await this.sessions.revokeAllForUser(id, 'account_disabled');
    this.events.emit({ name: 'user.status_changed', entityId: id, actorId: actor.id, data: { status: 'DISABLED' } });
    return this.get(id);
  }

  async reactivate(actor: AuthUser, id: string, reason: string, meta: RequestMeta) {
    await this.assertCanManage(actor, id);
    const u = await this.prisma.user.findFirst({ where: { id, deletedAt: null } });
    if (!u) throw new NotFoundException('User not found.');
    if (u.status !== 'DISABLED' && u.status !== 'LOCKED') throw new BadRequestException('This account is not disabled.');
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id }, data: { status: u.passwordHash ? 'ACTIVE' : 'INVITED', failedAttempts: 0, lockedUntil: null } });
      await this.audit.record({
        action: 'user.reactivated', userId: actor.id, userName: actor.fullName, entityType: 'user', entityId: id, reason,
        ip: meta.ip, requestId: meta.requestId,
      }, tx);
    });
    return this.get(id);
  }

  async listSessions(id: string) {
    await this.get(id);
    return this.sessions.listActive(id);
  }

  async revokeSessions(actor: AuthUser, id: string, reason: string, meta: RequestMeta): Promise<{ revoked: number }> {
    await this.assertCanManage(actor, id);
    await this.prisma.user.update({ where: { id }, data: { tokenVersion: { increment: 1 } } });
    const revoked = await this.sessions.revokeAllForUser(id, 'revoked_by_admin');
    await this.audit.record({ action: 'user.sessions_revoked', userId: actor.id, userName: actor.fullName, entityType: 'user', entityId: id, reason, after: { revoked }, ip: meta.ip, requestId: meta.requestId });
    return { revoked };
  }

  async resetMfa(actor: AuthUser, id: string, reason: string, meta: RequestMeta): Promise<void> {
    if (id === actor.id) throw new ForbiddenException('You cannot reset your own two-factor settings. Ask another administrator.');
    await this.assertCanManage(actor, id);
    await this.mfa.adminReset(id, { id: actor.id, name: actor.fullName }, reason, meta);
  }

  // ───────── privilege-escalation guards ─────────

  /** An actor may only hand out roles whose permissions they themselves hold (no self-promotion via a lower admin). */
  private async resolveAssignableRoles(actor: AuthUser, codes: string[]) {
    const roles = await this.prisma.role.findMany({ where: { code: { in: codes } }, include: { permissions: { include: { permission: true } } } });
    if (roles.length !== codes.length) throw new BadRequestException('One or more roles do not exist.');
    for (const r of roles) {
      const missing = r.permissions.filter((p) => !actor.permissions.includes(p.permission.code));
      if (missing.length) throw new ForbiddenException('You cannot assign a role with more privileges than your own.');
    }
    return roles;
  }

  /** Target's current roles must also be within the actor's own privileges (an Owner cannot touch a Super Admin). */
  private async assertCanManage(actor: AuthUser, targetId: string): Promise<void> {
    const target = await this.prisma.user.findFirst({
      where: { id: targetId, deletedAt: null },
      include: { roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } } },
    });
    if (!target) throw new NotFoundException('User not found.');
    for (const ur of target.roles) {
      if (ur.role.permissions.some((p) => !actor.permissions.includes(p.permission.code))) {
        throw new ForbiddenException('You cannot manage a user with more privileges than your own.');
      }
    }
  }

  private async currentRoleCodes(id: string): Promise<string[]> {
    return (await this.prisma.userRole.findMany({ where: { userId: id }, include: { role: true } })).map((r) => r.role.code);
  }

  private async assertNotLastSuperAdmin(id: string): Promise<void> {
    const others = await this.prisma.user.count({
      where: { id: { not: id }, status: 'ACTIVE', deletedAt: null, roles: { some: { role: { code: 'SUPER_ADMIN' } } } },
    });
    if (others === 0) throw new ConflictException('At least one active Super Admin must remain.');
  }
}
