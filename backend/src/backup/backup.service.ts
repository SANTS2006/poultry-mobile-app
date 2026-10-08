import { Inject, Injectable, ConflictException, NotFoundException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BackupJob, BackupKind, Prisma, PrismaClient } from '@prisma/client';
import { createWriteStream } from 'fs';
import { mkdtemp, rm, stat, statfs } from 'fs/promises';
import { PinoLogger } from 'nestjs-pino';
import { tmpdir } from 'os';
import { join } from 'path';
import { pipeline } from 'stream/promises';
import { AuditService } from '../audit/audit.service';
import type { Env } from '../config/env';
import { SettingsService } from '../domain/settings.service';
import { MailComposer } from '../mail/mail-composer.service';
import { PrismaService } from '../prisma/prisma.service';
import { decryptFile, EncryptStream, HashTap, parseKey, sha256File } from './backup.crypto';
import { INVARIANTS } from './backup.invariants';
import { selectExpired } from './backup.retention';
import { LocalStorage, S3Storage, type BackupStorage } from './backup.storage';
import { databaseOf, describeTarget, pgEnv, runTool, startTool, withDatabase } from './pg-tools';

export const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MIN = [5, 15];
const STALE_RUNNING_MS = 3 * 3_600_000;
const FORMAT = 'pg_dump-custom+aes-256-gcm';
export const DUMP_TIMEOUT_MS = 2 * 3_600_000;

export interface Actor { id: string | null; name: string; ip?: string; requestId?: string }
export interface VerifyResult { ok: boolean; level: 'archive' | 'restore'; checks: { name: string; ok: boolean }[]; message?: string; at: string }

@Injectable()
export class BackupService {
  private store?: BackupStorage;
  private lastStaleAlert = 0;

  constructor(
    private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly mail: MailComposer,
    private readonly settings: SettingsService, private readonly logger: PinoLogger, @Inject(ConfigService) private readonly config: ConfigService<Env, true>,
  ) { this.logger.setContext(BackupService.name); }

  private cfg<K extends keyof Env>(k: K): Env[K] { return this.config.get(k, { infer: true }) as Env[K]; }

  get appEnv(): string { return this.cfg('APP_ENV'); }
  /** Backups run when explicitly enabled, or by default in staging/production. A valid encryption key is mandatory either way. */
  get enabled(): boolean {
    const flag = this.cfg('BACKUP_ENABLED');
    const on = flag ? flag === '1' : ['staging', 'production'].includes(this.appEnv);
    return on && this.hasKey;
  }
  get hasKey(): boolean { return Buffer.from(this.cfg('BACKUP_ENCRYPTION_KEY'), 'base64').length === 32; }
  get recoveryConfigured(): boolean { return !!this.cfg('RECOVERY_ADMIN_DATABASE_URL'); }
  get binDir(): string { return this.cfg('BACKUP_PG_BIN_DIR'); }
  get key(): Buffer { return parseKey(this.cfg('BACKUP_ENCRYPTION_KEY')); }

  storage(): BackupStorage {
    if (this.store) return this.store;
    this.store = this.cfg('BACKUP_STORAGE') === 's3'
      ? new S3Storage({ bucket: this.cfg('BACKUP_S3_BUCKET'), region: this.cfg('BACKUP_S3_REGION'), endpoint: this.cfg('BACKUP_S3_ENDPOINT') || undefined, accessKeyId: this.cfg('BACKUP_S3_ACCESS_KEY_ID'), secretAccessKey: this.cfg('BACKUP_S3_SECRET_ACCESS_KEY'), prefix: this.cfg('BACKUP_S3_PREFIX') })
      : new LocalStorage(this.cfg('BACKUP_LOCAL_DIR'));
    return this.store;
  }
  /** Tests inject a storage. */
  useStorage(s: BackupStorage): void { this.store = s; }

  // ── settings ────────────────────────────────────────────────────────────────────────────────
  async getSettings() {
    return this.prisma.backupSetting.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } });
  }

  // ── jobs ────────────────────────────────────────────────────────────────────────────────────
  /** Creates a PENDING job. For scheduled jobs `windowKey` is unique, so a second instance gets `null` instead of a duplicate. */
  async createJob(kind: BackupKind, o: { windowKey?: string; triggeredById?: string | null } = {}): Promise<BackupJob | null> {
    const s = await this.getSettings();
    try {
      return await this.prisma.backupJob.create({
        data: {
          kind, windowKey: o.windowKey ?? null, triggeredById: o.triggeredById ?? null, environment: this.appEnv,
          retentionUntil: new Date(Date.now() + s.retentionDays * 86_400_000),
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return null;
      throw e;
    }
  }

  async anyRunning(): Promise<boolean> {
    return (await this.prisma.backupJob.count({ where: { status: 'RUNNING', startedAt: { gt: new Date(Date.now() - STALE_RUNNING_MS) } } })) > 0;
  }

  /** Marks backups that have been "running" for hours (the process died) as failed, so they can be retried and alerted on. */
  async failStale(now = new Date()): Promise<number> {
    const r = await this.prisma.backupJob.updateMany({
      where: { status: 'RUNNING', startedAt: { lt: new Date(now.getTime() - STALE_RUNNING_MS) } },
      data: { status: 'FAILED', finishedAt: now, error: 'The backup was interrupted (the server restarted or the process was stopped).', nextAttemptAt: now },
    });
    return r.count;
  }

  /** Runs one job to completion. Never throws: failures are recorded on the job. Safe to call twice: only one caller wins the claim. */
  async execute(jobId: string, actor?: Actor): Promise<BackupJob> {
    const claimed = await this.prisma.backupJob.updateMany({ where: { id: jobId, status: 'PENDING' }, data: { status: 'RUNNING', startedAt: new Date(), error: null, nextAttemptAt: null } });
    if (claimed.count !== 1) return this.prisma.backupJob.findUniqueOrThrow({ where: { id: jobId } });
    return this.runClaimed(jobId, actor);
  }

  /** Retry of a failed scheduled job: claim FAILED → RUNNING with attempt+1 (compare-and-set, so two instances cannot both retry). */
  async retry(jobId: string): Promise<BackupJob | null> {
    const cur = await this.prisma.backupJob.findUnique({ where: { id: jobId } });
    if (!cur || cur.status !== 'FAILED' || cur.attempt >= MAX_ATTEMPTS) return null;
    const c = await this.prisma.backupJob.updateMany({ where: { id: jobId, status: 'FAILED', attempt: cur.attempt }, data: { status: 'RUNNING', attempt: cur.attempt + 1, startedAt: new Date(), finishedAt: null, error: null, nextAttemptAt: null } });
    return c.count === 1 ? this.runClaimed(jobId) : null;
  }

  private async runClaimed(jobId: string, actor?: Actor): Promise<BackupJob> {
    const job = await this.prisma.backupJob.findUniqueOrThrow({ where: { id: jobId } });
    const dir = await mkdtemp(join(tmpdir(), 'mk-backup-'));
    try {
      if (!this.hasKey) throw new Error('BACKUP_ENCRYPTION_KEY is not configured');
      const file = join(dir, 'dump.enc');
      const prodUrl = this.cfg('DIRECT_DATABASE_URL');
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
      const storageKey = `${stamp.slice(0, 4)}/${stamp.slice(4, 6)}/makarifor-${stamp}-${job.id}.dump.enc`;

      const { child, done } = startTool('pg_dump', ['--format=custom', '--compress=6', '--no-owner', '--no-privileges'], pgEnv(prodUrl), this.binDir);
      const tap = new HashTap();
      const timer = setTimeout(() => child.kill('SIGKILL'), DUMP_TIMEOUT_MS);
      let writeErr: unknown;
      const piped = pipeline(child.stdout!, new EncryptStream(this.key, job.id), tap, createWriteStream(file, { mode: 0o600 })).catch((e) => { writeErr = e; child.kill('SIGKILL'); });
      const [res] = await Promise.all([done, piped]);
      clearTimeout(timer);
      if (writeErr) throw new Error('Could not write the backup file');
      // The exit status — not the existence of a file — decides success.
      if (res.code !== 0) throw new Error(`pg_dump failed (exit ${res.code}): ${res.stderr.trim() || 'no output'}`);
      const sha = tap.digest();
      const size = (await stat(file)).size;

      const store = this.storage();
      await store.put(storageKey, file);
      const version = await this.serverVersion();
      await this.prisma.backupJob.update({
        where: { id: job.id },
        data: { status: 'SUCCESSFUL', finishedAt: new Date(), sizeBytes: BigInt(size), sha256: sha, format: FORMAT, encrypted: true, destination: store.label, storageKey, dbName: databaseOf(prodUrl), serverVersion: version, error: null },
      });
      await this.audit.record({ action: 'backup.succeeded', userId: actor?.id ?? null, userName: actor?.name ?? 'system', entityType: 'BackupJob', entityId: job.id, after: { kind: job.kind, sizeBytes: size, destination: store.label } });
      // Read the stored copy back and check it: a backup nobody has read is only a hope.
      await this.verify(job.id, { deep: false }).catch(() => undefined);
      return this.prisma.backupJob.findUniqueOrThrow({ where: { id: job.id } });
    } catch (e) {
      const message = (e instanceof Error ? e.message : 'Unknown error').slice(0, 1500);
      const attempt = job.attempt;
      const willRetry = job.kind === 'SCHEDULED' && attempt < MAX_ATTEMPTS;
      const failed = await this.prisma.backupJob.update({
        where: { id: job.id },
        data: { status: 'FAILED', finishedAt: new Date(), error: message, nextAttemptAt: willRetry ? new Date(Date.now() + (RETRY_DELAYS_MIN[attempt - 1] ?? 15) * 60_000) : null },
      });
      this.logger.error({ jobId: job.id, attempt }, `Backup failed: ${message}`);
      await this.audit.record({ action: 'backup.failed', userId: actor?.id ?? null, userName: actor?.name ?? 'system', entityType: 'BackupJob', entityId: job.id, after: { kind: job.kind, attempt, error: message, willRetry } }).catch(() => undefined);
      if (!willRetry) await this.alert('Backup FAILED', [`A ${job.kind.toLowerCase()} database backup failed after ${attempt} attempt(s).`, `Reason: ${message}`, 'Open Administration → Backups for details. No earlier backup was overwritten.']);
      return failed;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private async serverVersion(): Promise<string | undefined> {
    try { const r = await this.prisma.$queryRaw<{ v: string }[]>`SHOW server_version`; return r[0]?.v; } catch { return undefined; }
  }

  // ── verification ────────────────────────────────────────────────────────────────────────────
  /**
   * archive: fetch the stored copy, compare the checksum, authenticate/decrypt it and make sure pg_restore can read its table of contents.
   * deep:    additionally restore it into a scratch database on the recovery server and run the business-invariant checks.
   */
  async verify(jobId: string, o: { deep: boolean }, actor?: Actor): Promise<VerifyResult> {
    const job = await this.prisma.backupJob.findUnique({ where: { id: jobId } });
    if (!job || job.deletedAt) throw new NotFoundException('Backup not found');
    if (job.status !== 'SUCCESSFUL' || !job.storageKey || !job.sha256) throw new BadRequestException('Only a successful backup can be verified.');
    if (o.deep && !this.recoveryConfigured) throw new BadRequestException('Restore testing needs RECOVERY_ADMIN_DATABASE_URL to be configured.');
    const dir = await mkdtemp(join(tmpdir(), 'mk-verify-'));
    const checks: VerifyResult['checks'] = [];
    let message: string | undefined;
    let ok: boolean;
    try {
      const enc = join(dir, 'dump.enc'); const plain = join(dir, 'dump');
      await this.storage().get(job.storageKey, enc);
      const sha = await sha256File(enc);
      checks.push({ name: 'Checksum matches the stored copy', ok: sha === job.sha256 });
      if (sha !== job.sha256) throw new Error('Checksum mismatch: the stored backup is corrupt or was altered.');
      await decryptFile(enc, plain, this.key, job.id);
      checks.push({ name: 'Decrypted and authenticated', ok: true });
      const list = await runTool('pg_restore', ['--list', plain], {}, this.binDir, 300_000);
      checks.push({ name: 'Archive is readable by pg_restore', ok: list.code === 0 });
      if (list.code !== 0) throw new Error(`pg_restore cannot read the archive: ${list.stderr.trim()}`);
      if (o.deep) {
        const scratch = await this.restoreToNewDatabase(plain, `verify_${Date.now()}`);
        try { checks.push(...scratch.checks); checks.push({ name: 'Restored into an isolated database', ok: true }); }
        finally { await this.dropDatabase(scratch.name); }
      }
      ok = checks.every((c) => c.ok);
      if (!ok) message = 'One or more checks failed.';
    } catch (e) {
      message = (e instanceof Error ? e.message : 'Verification failed').slice(0, 1000);
      ok = false;
    } finally { await rm(dir, { recursive: true, force: true }); }

    const result: VerifyResult = { ok, level: o.deep ? 'restore' : 'archive', checks, message, at: new Date().toISOString() };
    // A deep result is never downgraded by a later archive-level check.
    const prev = (job.verificationDetail as Partial<VerifyResult> | null) ?? null;
    const keepDeep = !o.deep && ok && prev?.level === 'restore' && prev.ok;
    await this.prisma.backupJob.update({ where: { id: job.id }, data: { verification: ok ? 'VERIFIED' : 'FAILED', verifiedAt: new Date(), verificationDetail: (keepDeep ? prev : result) as unknown as Prisma.InputJsonValue } });
    await this.audit.record({ action: ok ? 'backup.verified' : 'backup.verification_failed', userId: actor?.id ?? null, userName: actor?.name ?? 'system', entityType: 'BackupJob', entityId: job.id, after: { level: result.level, ok, message } }).catch(() => undefined);
    if (!ok) await this.alert('Backup verification FAILED', [`Backup ${job.id.slice(0, 8)} did not pass its ${result.level} check.`, message ?? '']);
    return result;
  }

  // ── restore primitives (also used by the recovery workflow) ─────────────────────────────────
  private admin(): PrismaClient {
    return new PrismaClient({ datasourceUrl: this.cfg('RECOVERY_ADMIN_DATABASE_URL') });
  }

  /** Creates database `name` on the recovery server, restores `plainDump` into it and runs the invariant checks. Production is never touched. */
  async restoreToNewDatabase(plainDump: string, name: string): Promise<{ name: string; url: string; checks: { name: string; ok: boolean }[] }> {
    if (!/^[a-z][a-z0-9_]{2,62}$/.test(name)) throw new Error('Invalid database name');
    const adminUrl = this.cfg('RECOVERY_ADMIN_DATABASE_URL');
    if (!adminUrl) throw new Error('RECOVERY_ADMIN_DATABASE_URL is not configured');
    if (name === databaseOf(this.cfg('DATABASE_URL')) || name === databaseOf(this.cfg('DIRECT_DATABASE_URL'))) throw new Error('Refusing to restore over the production database');
    const admin = this.admin();
    try { await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`); } finally { await admin.$disconnect(); }
    const url = withDatabase(adminUrl, name);
    const r = await runTool('pg_restore', ['--no-owner', '--no-privileges', '--exit-on-error', `--dbname=${name}`, plainDump], pgEnv(adminUrl), this.binDir, DUMP_TIMEOUT_MS);
    if (r.code !== 0) { await this.dropDatabase(name); throw new Error(`pg_restore failed (exit ${r.code}): ${r.stderr.trim()}`); }
    const target = new PrismaClient({ datasourceUrl: url });
    const checks: { name: string; ok: boolean }[] = [];
    try {
      for (const inv of INVARIANTS) {
        try { const rows = await target.$queryRawUnsafe<{ ok: boolean }[]>(inv.sql); checks.push({ name: inv.name, ok: rows[0]?.ok === true }); }
        catch { checks.push({ name: inv.name, ok: false }); }
      }
    } finally { await target.$disconnect(); }
    return { name, url, checks };
  }

  async dropDatabase(name: string): Promise<void> {
    if (!/^(verify|recovery)_[a-z0-9_]+$/.test(name)) throw new Error('Refusing to drop a database this service did not create');
    const admin = this.admin();
    try { await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`); } finally { await admin.$disconnect(); }
  }

  /** Fetches, checks and decrypts a stored backup into `dir`; returns the plaintext dump path. */
  async fetchPlain(job: BackupJob, dir: string): Promise<string> {
    if (!job.storageKey || !job.sha256) throw new BadRequestException('This backup has no stored file.');
    const enc = join(dir, 'dump.enc'); const plain = join(dir, 'dump');
    await this.storage().get(job.storageKey, enc);
    if ((await sha256File(enc)) !== job.sha256) throw new Error('Checksum mismatch: the stored backup is corrupt or was altered.');
    const free = await statfs(dir).then((s) => Number(s.bavail) * Number(s.bsize), () => Number.MAX_SAFE_INTEGER);
    if (free < Number(job.sizeBytes ?? 0) * 3) throw new Error('Not enough free disk space to restore this backup.');
    await decryptFile(enc, plain, this.key, job.id);
    return plain;
  }

  // ── retention ───────────────────────────────────────────────────────────────────────────────
  async applyRetention(now = new Date()): Promise<{ deleted: string[] }> {
    const s = await this.getSettings();
    const jobs = await this.prisma.backupJob.findMany({ where: { status: 'SUCCESSFUL', deletedAt: null }, select: { id: true, kind: true, status: true, verification: true, createdAt: true, deletedAt: true, storageKey: true } });
    const expired = selectExpired(jobs, now, { retentionDays: s.retentionDays, keepMonthly: s.keepMonthly });
    const deleted: string[] = [];
    for (const id of expired) {
      const j = jobs.find((x) => x.id === id)!;
      try {
        if (j.storageKey) await this.storage().delete(j.storageKey);
        await this.prisma.backupJob.update({ where: { id }, data: { deletedAt: now } });
        await this.audit.record({ action: 'backup.expired_deleted', userName: 'system', entityType: 'BackupJob', entityId: id, reason: `Older than the ${s.retentionDays}-day retention policy` });
        deleted.push(id);
      } catch (e) { this.logger.error({ jobId: id, err: e }, 'Retention could not delete a backup'); }
    }
    return { deleted };
  }

  // ── status & alerts ─────────────────────────────────────────────────────────────────────────
  async status(now = new Date()) {
    const [s, latestOk, latestFail, running, latestVerified] = await Promise.all([
      this.getSettings(),
      this.prisma.backupJob.findFirst({ where: { status: 'SUCCESSFUL', deletedAt: null }, orderBy: { createdAt: 'desc' } }),
      this.prisma.backupJob.findFirst({ where: { status: 'FAILED' }, orderBy: { createdAt: 'desc' } }),
      this.prisma.backupJob.findFirst({ where: { status: 'RUNNING' } }),
      this.prisma.backupJob.findFirst({ where: { status: 'SUCCESSFUL', verification: 'VERIFIED', deletedAt: null }, orderBy: { createdAt: 'desc' } }),
    ]);
    const ageHours = latestOk ? (now.getTime() - (latestOk.finishedAt ?? latestOk.createdAt).getTime()) / 3_600_000 : null;
    const stale = this.cfg('BACKUP_STALE_HOURS');
    const store = this.storage();
    const storage = await store.health();
    const enabled = this.enabled && s.enabled;
    const health: 'disabled' | 'never' | 'stale' | 'failing' | 'ok' = !enabled ? 'disabled' : !latestOk ? 'never' : ageHours! > stale ? 'stale' : latestFail && latestFail.createdAt > latestOk.createdAt ? 'failing' : 'ok';
    const warnings: string[] = [];
    if (!this.hasKey) warnings.push('BACKUP_ENCRYPTION_KEY is not set: backups cannot run.');
    if (!store.offsite) warnings.push('Backups are stored on the same server as the API. Configure BACKUP_STORAGE=s3 so a copy survives the loss of this server.');
    if (!storage.ok) warnings.push(storage.detail ?? 'Backup storage is not reachable.');
    if (!this.recoveryConfigured) warnings.push('RECOVERY_ADMIN_DATABASE_URL is not set: restore tests and recovery are unavailable.');
    if (latestOk && !latestVerified) warnings.push('No backup has been verified yet.');
    return {
      health, enabled, environment: this.appEnv, timezone: await this.settings.get<string>('business.timezone'),
      scheduleTime: s.scheduleTime, retentionDays: s.retentionDays, keepMonthly: s.keepMonthly,
      destination: store.label, offsite: store.offsite, storageOk: storage.ok, recoveryConfigured: this.recoveryConfigured,
      database: describeTarget(this.cfg('DIRECT_DATABASE_URL')),
      latestSuccess: latestOk ? this.brief(latestOk) : null, latestFailure: latestFail ? this.brief(latestFail) : null, running: running ? this.brief(running) : null,
      backupAgeHours: ageHours === null ? null : Math.round(ageHours * 10) / 10, staleAfterHours: stale, warnings,
    };
  }

  brief(j: BackupJob) {
    return {
      id: j.id, kind: j.kind, status: j.status, attempt: j.attempt, createdAt: j.createdAt, startedAt: j.startedAt, finishedAt: j.finishedAt,
      sizeBytes: j.sizeBytes === null ? null : Number(j.sizeBytes), sha256: j.sha256, format: j.format, encrypted: j.encrypted, destination: j.destination,
      retentionUntil: j.retentionUntil, verification: j.verification, verifiedAt: j.verifiedAt, verificationDetail: j.verificationDetail, error: j.error,
      nextAttemptAt: j.nextAttemptAt, environment: j.environment, dbName: j.dbName, serverVersion: j.serverVersion, deleted: !!j.deletedAt,
    };
  }

  /** Warns when no good backup exists for too long (at most every 6 hours). */
  async checkFreshness(now = new Date()): Promise<void> {
    if (!this.enabled) return;
    const st = await this.status(now);
    if ((st.health === 'stale' || st.health === 'never') && now.getTime() - this.lastStaleAlert > 6 * 3_600_000) {
      this.lastStaleAlert = now.getTime();
      await this.alert(st.health === 'never' ? 'No backup has ever completed' : 'Backups are overdue', [st.health === 'never' ? 'The system has not completed a single backup yet.' : `The last successful backup is ${st.backupAgeHours} hours old (limit ${st.staleAfterHours} hours).`, 'Open Administration → Backups to see the latest failure.']);
    }
  }

  async alert(subject: string, lines: string[]): Promise<void> {
    try {
      const configured = this.cfg('BACKUP_ALERT_EMAILS');
      const to = configured.length ? configured : (await this.prisma.user.findMany({ where: { status: 'ACTIVE', deletedAt: null, roles: { some: { role: { code: 'SUPER_ADMIN' } } } }, select: { email: true } })).map((u) => u.email);
      for (const addr of to) await this.mail.send(addr, `[Makarifor] ${subject}`, { preheader: subject, heading: subject, paragraphs: lines.filter(Boolean), note: 'This is an automated message about the system backups.' });
      this.logger.warn({ subject }, 'Backup alert sent');
    } catch (e) { this.logger.error({ err: e }, 'Could not send backup alert'); }
  }

  /** Download of the (still encrypted) file for off-system custody. */
  async downloadStream(jobId: string) {
    const job = await this.prisma.backupJob.findUnique({ where: { id: jobId } });
    if (!job || job.deletedAt || job.status !== 'SUCCESSFUL' || !job.storageKey) throw new NotFoundException('Backup not found');
    return { job, stream: await this.storage().stream(job.storageKey) };
  }

  async requireIdle(): Promise<void> {
    if (await this.anyRunning()) throw new ConflictException('A backup is already running. Wait for it to finish.');
  }
}
