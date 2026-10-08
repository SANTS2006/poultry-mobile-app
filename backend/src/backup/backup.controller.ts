import { BadRequestException, Body, ConflictException, Controller, NotFoundException, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Res, StreamableFile } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { IsBoolean, IsInt, IsOptional, IsString, Matches, MaxLength, Max, Min, MinLength } from 'class-validator';
import { AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import type { AuthUser, RequestMeta } from '../auth/auth.types';
import { CurrentUser, Meta } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { PageQuery, paging } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';
import { BackupService, type Actor } from './backup.service';
import { RecoveryService } from './recovery.service';

const STRICT = { default: { limit: 5, ttl: 60_000 } };

class SettingsDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsString() @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'scheduleTime must be HH:MM (24-hour)' }) scheduleTime?: string;
  @IsOptional() @IsInt() @Min(7) @Max(365) retentionDays?: number;
  @IsOptional() @IsInt() @Min(0) @Max(36) keepMonthly?: number;
}
class VerifyDto { @IsOptional() @IsBoolean() deep?: boolean }
class ReauthDto {
  @IsString() @MinLength(1) @MaxLength(200) password!: string;
  @IsString() @MinLength(6) @MaxLength(20) code!: string;
}
class RecoverBody extends ReauthDto {
  @IsString() @MaxLength(60) confirm!: string;
  @IsString() @MaxLength(40) backupId!: string;
}

const actorOf = (u: AuthUser, m: RequestMeta): Actor & { id: string } => ({ id: u.id, name: u.fullName, ip: m.ip, requestId: m.requestId });

/** Backup management. Every route needs `backups.manage`, which only Super Admin holds; there is no public or owner-level access. */
@Controller('backups')
export class BackupController {
  constructor(private readonly backups: BackupService, private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly auth: AuthService) {}

  @RequirePermissions('backups.manage') @Get('status')
  status() { return this.backups.status(); }

  @RequirePermissions('backups.manage') @Get()
  async list(@Query() q: PageQuery) {
    const { page, limit, skip, take } = paging(q);
    const [rows, total] = await Promise.all([this.prisma.backupJob.findMany({ orderBy: { createdAt: 'desc' }, skip, take }), this.prisma.backupJob.count()]);
    return { items: rows.map((r) => this.backups.brief(r)), page, limit, total };
  }

  @RequirePermissions('backups.manage') @Patch('settings')
  async settings(@CurrentUser() user: AuthUser, @Body() dto: SettingsDto, @Meta() meta: RequestMeta) {
    const before = await this.backups.getSettings();
    await this.prisma.backupSetting.update({ where: { id: 1 }, data: dto });
    await this.audit.record({ action: 'backup.settings_changed', userId: user.id, userName: user.fullName, entityType: 'BackupSetting', entityId: '1', before: { enabled: before.enabled, scheduleTime: before.scheduleTime, retentionDays: before.retentionDays, keepMonthly: before.keepMonthly }, after: dto, ip: meta.ip, requestId: meta.requestId });
    return this.backups.status();
  }

  @RequirePermissions('backups.manage') @Throttle(STRICT) @HttpCode(202) @Post()
  async runNow(@CurrentUser() user: AuthUser, @Meta() meta: RequestMeta) {
    if (!this.backups.enabled) throw new BadRequestException('Backups are not enabled on this server (check BACKUP_ENCRYPTION_KEY).');
    await this.backups.requireIdle();
    const job = await this.backups.createJob('MANUAL', { triggeredById: user.id });
    if (!job) throw new ConflictException('Could not create the backup job.');
    await this.audit.record({ action: 'backup.manual_requested', userId: user.id, userName: user.fullName, entityType: 'BackupJob', entityId: job.id, ip: meta.ip, requestId: meta.requestId });
    void this.backups.execute(job.id, actorOf(user, meta)); // runs in the background; the screen polls the job
    return this.backups.brief(job);
  }

  @RequirePermissions('backups.manage') @Get(':id')
  async one(@Param('id', ParseUUIDPipe) id: string) {
    const j = await this.prisma.backupJob.findUnique({ where: { id } });
    if (!j) throw new NotFoundException('Backup not found');
    return this.backups.brief(j);
  }

  @RequirePermissions('backups.manage') @Throttle(STRICT) @HttpCode(202) @Post(':id/verify')
  async verify(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: VerifyDto, @Meta() meta: RequestMeta) {
    return this.backups.verify(id, { deep: dto.deep === true }, actorOf(user, meta));
  }

  /** Encrypted file for off-system custody. Needs the password and a fresh authenticator code, is rate-limited and audited. */
  @RequirePermissions('backups.manage') @Throttle({ default: { limit: 3, ttl: 60_000 } }) @HttpCode(200) @Post(':id/download')
  async download(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReauthDto, @Meta() meta: RequestMeta, @Res({ passthrough: true }) res: Response) {
    await this.auth.requirePasswordAndCode(user.id, dto.password, dto.code);
    const { job, stream } = await this.backups.downloadStream(id);
    await this.audit.record({ action: 'backup.downloaded', userId: user.id, userName: user.fullName, entityType: 'BackupJob', entityId: id, ip: meta.ip, requestId: meta.requestId });
    res.set({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="makarifor-${job.id}.dump.enc"`, 'Cache-Control': 'no-store' });
    return new StreamableFile(stream);
  }
}

@Controller('recoveries')
export class RecoveryController {
  constructor(private readonly recovery: RecoveryService) {}

  @RequirePermissions('backups.manage') @Get()
  list() { return this.recovery.list(); }

  @RequirePermissions('backups.manage') @Get(':id')
  one(@Param('id', ParseUUIDPipe) id: string) { return this.recovery.get(id); }

  @RequirePermissions('backups.manage') @Throttle({ default: { limit: 3, ttl: 60_000 } }) @HttpCode(202) @Post()
  start(@CurrentUser() user: AuthUser, @Body() dto: RecoverBody, @Meta() meta: RequestMeta) {
    return this.recovery.start(actorOf(user, meta), dto);
  }
}
