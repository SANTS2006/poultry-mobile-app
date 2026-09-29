import { Controller, Get, Query } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsDate, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { PageQuery, paging } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from './audit.service';

class AuditQuery extends PageQuery {
  /** exact action ("sale.created") or a prefix ending in ".*" ("auth.*") */
  @IsOptional() @IsString() @MaxLength(80) @Matches(/^[a-z0-9_.]+(\.\*)?$/i) action?: string;
  @IsOptional() @IsUUID() userId?: string;
  @IsOptional() @IsString() @MaxLength(40) @Matches(/^[a-z0-9_]+$/i) entityType?: string;
  @IsOptional() @IsString() @MaxLength(80) entityId?: string;
  @IsOptional() @Type(() => Date) @IsDate() from?: Date;
  @IsOptional() @Type(() => Date) @IsDate() to?: Date;
}

/** Read-only view of the tamper-evident audit trail for administrators. There is deliberately no write, edit or delete route. */
@Controller('audit')
export class AuditController {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  @RequirePermissions('audit.read') @Get()
  async list(@Query() q: AuditQuery) {
    const { page, limit, skip, take } = paging(q);
    const where: Prisma.AuditLogWhereInput = {
      ...(q.action ? (q.action.endsWith('.*') ? { action: { startsWith: q.action.slice(0, -1) } } : { action: q.action }) : {}),
      ...(q.userId ? { userId: q.userId } : {}), ...(q.entityType ? { entityType: q.entityType } : {}), ...(q.entityId ? { entityId: q.entityId } : {}),
      ...(q.from || q.to ? { createdAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.auditLog.findMany({ where, orderBy: { seq: 'desc' }, skip, take }),
      this.prisma.auditLog.count({ where }),
    ]);
    return {
      items: rows.map((r) => ({
        id: r.id, seq: r.seq.toString(), at: r.createdAt, action: r.action, userId: r.userId, userName: r.userName, entityType: r.entityType, entityId: r.entityId,
        before: r.before, after: r.after, reason: r.reason, ip: r.ip, deviceInfo: r.deviceInfo, requestId: r.requestId,
      })),
      page, limit, total,
    };
  }

  /** Recomputes the hash chain over the oldest 10,000 rows (`checked` says how many were covered; `total` is the whole log). */
  @RequirePermissions('audit.read') @Get('verify')
  async verify() {
    const total = await this.prisma.auditLog.count();
    const firstBadId = await this.audit.verifyChain();
    return { intact: firstBadId === null, firstInconsistentId: firstBadId, checked: Math.min(total, 10_000), total };
  }
}
