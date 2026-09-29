import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Decides WHO may receive a notification. Recipients are always computed on the server from role, permission and account status;
 * the mobile app never chooses who is notified.
 */
@Injectable()
export class RecipientsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Active users holding one of `roles` and (optionally) a permission that entitles them to see the underlying data. */
  async byRoles(opts: { roles: string[]; permission?: string; excludeUserId?: string }): Promise<string[]> {
    const users = await this.prisma.user.findMany({
      where: {
        status: 'ACTIVE', deletedAt: null, ...(opts.excludeUserId ? { id: { not: opts.excludeUserId } } : {}),
        roles: { some: { role: { code: { in: opts.roles }, ...(opts.permission ? { permissions: { some: { permission: { code: opts.permission } } } } : {}) } } },
      },
      select: { id: true },
    });
    return users.map((u) => u.id);
  }

  /** Active users who can see the dashboard (daily summary audience). */
  async withPermission(permission: string): Promise<string[]> {
    const users = await this.prisma.user.findMany({
      where: { status: 'ACTIVE', deletedAt: null, roles: { some: { role: { permissions: { some: { permission: { code: permission } } } } } } },
      select: { id: true },
    });
    return users.map((u) => u.id);
  }

  async permissionsOf(userId: string): Promise<string[]> {
    const rows = await this.prisma.rolePermission.findMany({ where: { role: { users: { some: { userId } } } }, select: { permission: { select: { code: true } } } });
    return [...new Set(rows.map((r) => r.permission.code))];
  }
}
