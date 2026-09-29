import { Body, Controller, ForbiddenException, Get, NotFoundException, Param, ParseUUIDPipe, Put } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import type { AuthUser, RequestMeta } from '../auth/auth.types';
import { CurrentUser, Meta } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { SetRolePermissionsDto } from '../users/users.dto';

@Controller()
export class RolesController {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  /** Role list is needed to invite users. */
  @RequirePermissions('users.manage') @Get('roles')
  async roles() {
    const rows = await this.prisma.role.findMany({ include: { permissions: { include: { permission: true } } }, orderBy: { name: 'asc' } });
    return rows.map((r) => ({ id: r.id, code: r.code, name: r.name, description: r.description, mfaRequired: r.mfaRequired, isSystem: r.isSystem, permissions: r.permissions.map((p) => p.permission.code).sort() }));
  }

  @RequirePermissions('roles.manage', 'permissions.manage') @Get('permissions')
  permissions() {
    return this.prisma.permission.findMany({ orderBy: { code: 'asc' } });
  }

  @RequirePermissions('roles.manage', 'permissions.manage') @Put('roles/:id/permissions')
  async setPermissions(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SetRolePermissionsDto, @Meta() meta: RequestMeta) {
    const role = await this.prisma.role.findUnique({ where: { id }, include: { permissions: { include: { permission: true } } } });
    if (!role) throw new NotFoundException('Role not found.');
    if (role.code === 'SUPER_ADMIN') throw new ForbiddenException('The Super Admin role cannot be modified.');
    const perms = await this.prisma.permission.findMany({ where: { code: { in: dto.permissionCodes } } });
    if (perms.length !== dto.permissionCodes.length) throw new NotFoundException('One or more permissions do not exist.');
    const before = role.permissions.map((p) => p.permission.code).sort();
    await this.prisma.$transaction(async (tx) => {
      await tx.rolePermission.deleteMany({ where: { roleId: id } });
      await tx.rolePermission.createMany({ data: perms.map((p) => ({ roleId: id, permissionId: p.id })) });
      await this.audit.record({
        action: 'role.permissions_changed', userId: actor.id, userName: actor.fullName, entityType: 'role', entityId: id,
        before: { permissions: before }, after: { permissions: [...dto.permissionCodes].sort() }, reason: dto.reason, ip: meta.ip, requestId: meta.requestId,
      }, tx);
    });
    return { id, code: role.code, permissions: [...dto.permissionCodes].sort() };
  }
}
