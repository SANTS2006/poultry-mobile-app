import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { mkdtemp, rm } from 'fs/promises';
import { PinoLogger } from 'nestjs-pino';
import { tmpdir } from 'os';
import { join } from 'path';
import { AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { BackupService, type Actor } from './backup.service';
import { describeTarget } from './pg-tools';

export const confirmPhrase = (backupId: string) => `RESTORE ${backupId.slice(0, 8).toUpperCase()}`;

/**
 * Controlled recovery. The API never overwrites the live database: it restores the chosen backup into a NEW database on the recovery
 * server, checks it, and reports. An operator then promotes it by pointing DATABASE_URL at it (docs/operations/backup-recovery-dr.md),
 * which keeps "restore" and "go live with old data" as two separate, deliberate steps.
 */
@Injectable()
export class RecoveryService {
  private readonly running = new Set<Promise<unknown>>();

  constructor(
    private readonly prisma: PrismaService, private readonly backups: BackupService, private readonly audit: AuditService,
    private readonly auth: AuthService, private readonly logger: PinoLogger,
  ) { this.logger.setContext(RecoveryService.name); }

  /** Resolves when no recovery is in flight (used by tests and graceful shutdown). */
  async idle(): Promise<void> { while (this.running.size) await Promise.allSettled([...this.running]); }

  async start(actor: Actor & { id: string }, dto: { backupId: string; password: string; code: string; confirm: string }) {
    if (!this.backups.enabled) throw new BadRequestException('Backups are not enabled on this server.');
    if (!this.backups.recoveryConfigured) throw new BadRequestException('Recovery is not configured: set RECOVERY_ADMIN_DATABASE_URL to a server where a recovery database may be created.');
    const backup = await this.prisma.backupJob.findUnique({ where: { id: dto.backupId } });
    if (!backup || backup.deletedAt) throw new NotFoundException('Backup not found');
    if (backup.status !== 'SUCCESSFUL' || backup.verification !== 'VERIFIED') throw new BadRequestException('Only a successful, verified backup can be restored. Verify it first.');
    if (dto.confirm.trim() !== confirmPhrase(backup.id)) throw new BadRequestException(`Type ${confirmPhrase(backup.id)} to confirm.`);
    try { await this.auth.requirePasswordAndCode(actor.id, dto.password, dto.code); }
    catch (e) {
      await this.audit.record({ action: 'recovery.reauth_failed', userId: actor.id, userName: actor.name, entityType: 'BackupJob', entityId: backup.id, ip: actor.ip, requestId: actor.requestId }).catch(() => undefined);
      throw e instanceof ForbiddenException ? e : new ForbiddenException('Your password or code is incorrect.');
    }

    const op = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(748202)`; // one recovery at a time, even across instances
      if (await tx.recoveryOperation.count({ where: { status: 'RUNNING', startedAt: { gt: new Date(Date.now() - 4 * 3_600_000) } } })) throw new ConflictException('A recovery is already in progress.');
      return tx.recoveryOperation.create({ data: { backupId: backup.id, requestedById: actor.id, requestedByName: actor.name, target: 'new database on the recovery server' } });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    await this.audit.record({ action: 'recovery.requested', userId: actor.id, userName: actor.name, entityType: 'RecoveryOperation', entityId: op.id, after: { backupId: backup.id, backupTakenAt: backup.createdAt }, ip: actor.ip, requestId: actor.requestId });

    const p = this.run(op.id, actor).finally(() => this.running.delete(p));
    this.running.add(p);
    return this.view(op);
  }

  private async run(opId: string, actor: Actor): Promise<void> {
    const op = await this.prisma.recoveryOperation.findUniqueOrThrow({ where: { id: opId }, include: { backup: true } });
    const dir = await mkdtemp(join(tmpdir(), 'mk-recover-'));
    const steps: { step: string; ok: boolean; detail?: string }[] = [];
    try {
      // 1. A fresh, protected snapshot of the current state. If it cannot be made, nothing else happens.
      const snap = await this.backups.createJob('PRE_RESTORE', { triggeredById: actor.id });
      if (!snap) throw new Error('Could not create the safety snapshot job.');
      const snapDone = await this.backups.execute(snap.id, actor);
      await this.prisma.recoveryOperation.update({ where: { id: opId }, data: { preSnapshotId: snap.id } });
      if (snapDone.status !== 'SUCCESSFUL') throw new Error(`The safety snapshot of the current database failed, so the recovery was stopped: ${snapDone.error ?? 'unknown error'}`);
      steps.push({ step: 'Safety snapshot of the current database', ok: true });

      // 2. Fetch, authenticate, decrypt.
      const plain = await this.backups.fetchPlain(op.backup, dir);
      steps.push({ step: 'Backup fetched, checksum and authenticity verified', ok: true });

      // 3. Restore into a brand-new database and run the checks.
      const name = `recovery_${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}_${op.id.slice(0, 8).replace(/-/g, '')}`;
      const restored = await this.backups.restoreToNewDatabase(plain, name);
      steps.push({ step: `Restored into database "${name}"`, ok: true });

      // 4. Compatibility with this version of the application: every migration the live code expects must exist in the backup.
      const compat = await this.compatibility(restored.url);
      steps.push({ step: 'Schema compatible with this version of the application', ok: compat.missing.length === 0, detail: compat.missing.length ? `Backup lacks migrations: ${compat.missing.join(', ')} (run "prisma migrate deploy" after promoting)` : undefined });
      const allOk = restored.checks.every((c) => c.ok);
      const report = { steps, checks: restored.checks, database: name, server: describeTarget(restored.url), compatibility: compat, backupTakenAt: op.backup.createdAt, next: 'Review the restored database, then follow the promotion steps in docs/operations/backup-recovery-dr.md. Nothing has been switched yet.' };
      await this.prisma.recoveryOperation.update({ where: { id: opId }, data: { status: allOk ? 'SUCCEEDED' : 'FAILED', finishedAt: new Date(), target: describeTarget(restored.url), report: report as unknown as Prisma.InputJsonValue, error: allOk ? null : 'The restored database failed one or more integrity checks.' } });
      await this.audit.record({ action: allOk ? 'recovery.succeeded' : 'recovery.failed', userId: actor.id, userName: actor.name, entityType: 'RecoveryOperation', entityId: opId, after: { database: name, checksPassed: allOk } });
    } catch (e) {
      const message = (e instanceof Error ? e.message : 'Recovery failed').slice(0, 1500);
      steps.push({ step: 'Recovery stopped', ok: false, detail: message });
      await this.prisma.recoveryOperation.update({ where: { id: opId }, data: { status: 'FAILED', finishedAt: new Date(), error: message, report: { steps } as unknown as Prisma.InputJsonValue } }).catch(() => undefined);
      await this.audit.record({ action: 'recovery.failed', userId: actor.id, userName: actor.name, entityType: 'RecoveryOperation', entityId: opId, after: { error: message } }).catch(() => undefined);
      await this.backups.alert('Database recovery FAILED', [`A recovery requested by ${actor.name} failed.`, message]);
      this.logger.error({ opId }, `Recovery failed: ${message}`);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }

  private async compatibility(url: string): Promise<{ missing: string[] }> {
    const live = (await this.prisma.$queryRaw<{ migration_name: string }[]>`SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL`).map((r) => r.migration_name);
    const c = new PrismaClient({ datasourceUrl: url });
    try {
      const have = new Set((await c.$queryRawUnsafe<{ migration_name: string }[]>('SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL')).map((r) => r.migration_name));
      return { missing: live.filter((m) => !have.has(m)) };
    } catch { return { missing: ['(migration table unreadable)'] }; } finally { await c.$disconnect(); }
  }

  view(op: { id: string; backupId: string; requestedByName: string; status: string; target: string; preSnapshotId: string | null; startedAt: Date; finishedAt: Date | null; report: unknown; error: string | null }) {
    return { id: op.id, backupId: op.backupId, requestedBy: op.requestedByName, status: op.status, target: op.target, preSnapshotId: op.preSnapshotId, startedAt: op.startedAt, finishedAt: op.finishedAt, report: op.report, error: op.error };
  }

  async list(take = 20) {
    return (await this.prisma.recoveryOperation.findMany({ orderBy: { startedAt: 'desc' }, take })).map((o) => this.view(o));
  }
  async get(id: string) {
    const o = await this.prisma.recoveryOperation.findUnique({ where: { id } });
    if (!o) throw new NotFoundException('Recovery not found');
    return this.view(o);
  }
}
