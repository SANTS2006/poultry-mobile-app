import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { randomBytes } from 'crypto';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { EncryptionService } from '../src/common/crypto/encryption.service';
import { base32Encode } from '../src/common/crypto/totp';
import { BackupScheduler } from '../src/backup/backup.scheduler';
import { BackupService } from '../src/backup/backup.service';
import { confirmPhrase, RecoveryService } from '../src/backup/recovery.service';
import { AuthService } from '../src/auth/auth.service';
import { MailService } from '../src/mail/mail.service';
import { api, bearer, createApp, makeUser, PASSWORD, seed, signIn, totpAt } from './helpers';

describe('Backups and recovery (e2e: real PostgreSQL, real pg_dump / pg_restore, real encryption)', () => {
  let app: INestApplication; let prisma: PrismaClient; let backups: BackupService; let scheduler: BackupScheduler; let recovery: RecoveryService; let mail: MailService;
  let admin: string; let owner: string; let secret: string;
  const dropAfter: string[] = [];
  const storeDir = process.env.BACKUP_LOCAL_DIR as string;
  const code = (stepOffset: number) => totpAt(secret, Date.now() + stepOffset * 30_000);
  const waitFor = async <T>(fn: () => Promise<T | null | undefined | false>, ms = 60_000): Promise<T> => {
    const end = Date.now() + ms;
    for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 200)); }
  };
  const dbExists = async (name: string) => (await prisma.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int n FROM pg_database WHERE datname = '${name}'`))[0].n === 1;

  beforeAll(async () => {
    process.env.THROTTLE_OFF = '1';
    ({ app, prisma, mail } = await createApp());
    await seed(prisma);
    await prisma.role.updateMany({ data: { mfaRequired: false } });
    backups = app.get(BackupService); scheduler = app.get(BackupScheduler); recovery = app.get(RecoveryService);
    const a = await makeUser(prisma, { roles: ['SUPER_ADMIN'], fullName: 'Root Admin' });
    admin = (await signIn(app, a.email)).accessToken;
    owner = (await signIn(app, (await makeUser(prisma, { roles: ['OWNER'] })).email)).accessToken;
    // second factor for re-authentication, added after sign-in so it does not consume a code
    const b32 = base32Encode(randomBytes(20)); secret = b32;
    await prisma.mfaSecret.create({ data: { userId: a.id, secretEncrypted: app.get(EncryptionService).encrypt(b32), confirmedAt: new Date() } });
    await prisma.backupSetting.upsert({ where: { id: 1 }, update: { scheduleTime: '00:00', enabled: true }, create: { id: 1, scheduleTime: '00:00' } });
  });

  afterAll(async () => {
    for (const n of dropAfter) await backups.dropDatabase(n).catch(() => undefined);
    await recovery.idle();
    await prisma.$disconnect(); await app.close();
  });

  describe('authorization', () => {
    it('only the Super Admin can see or use any backup route (owner 403, anonymous 401)', async () => {
      const routes: [string, string][] = [['get', '/backups/status'], ['get', '/backups'], ['post', '/backups'], ['patch', '/backups/settings'], ['get', '/recoveries'], ['post', '/recoveries'],
        ['post', '/backups/00000000-0000-4000-8000-000000000000/verify'], ['post', '/backups/00000000-0000-4000-8000-000000000000/download']];
      for (const [m, path] of routes) {
        await (api(app) as never as Record<string, (u: string) => import('supertest').Test>)[m](`/v1${path}`).set(bearer(owner)).send({}).expect(403);
        await (api(app) as never as Record<string, (u: string) => import('supertest').Test>)[m](`/v1${path}`).send({}).expect(401);
      }
    });
    it('the permission is held by Super Admin only', async () => {
      const holders = await prisma.rolePermission.findMany({ where: { permission: { code: 'backups.manage' } }, include: { role: true } });
      expect(holders.map((h) => h.role.code)).toEqual(['SUPER_ADMIN']);
    });
    it('settings are validated', async () => {
      await api(app).patch('/v1/backups/settings').set(bearer(admin)).send({ retentionDays: 3 }).expect(400);
      await api(app).patch('/v1/backups/settings').set(bearer(admin)).send({ scheduleTime: '25:99' }).expect(400);
      await api(app).patch('/v1/backups/settings').set(bearer(admin)).send({ retentionDays: 30, keepMonthly: 3 }).expect(200);
      expect((await prisma.auditLog.findFirst({ where: { action: 'backup.settings_changed' } }))?.userName).toBe('Root Admin');
      await api(app).patch('/v1/backups/settings').set(bearer(admin)).send({ retentionDays: 14, keepMonthly: 6 }).expect(200);
    });
  });

  let first: string;
  describe('manual backup through the API', () => {
    it('runs in the background, produces an encrypted, checksummed, verified backup and audits it', async () => {
      const res = await api(app).post('/v1/backups').set(bearer(admin)).expect(202);
      first = res.body.id;
      const job = await waitFor(async () => { const j = await prisma.backupJob.findUnique({ where: { id: first } }); return j && ['SUCCESSFUL', 'FAILED'].includes(j.status) && j.verification !== 'NOT_VERIFIED' ? j : null; });
      expect(job.error).toBeNull();
      expect(job.status).toBe('SUCCESSFUL');
      expect(job).toMatchObject({ kind: 'MANUAL', encrypted: true, verification: 'VERIFIED', destination: 'local disk', format: 'pg_dump-custom+aes-256-gcm' });
      expect(Number(job.sizeBytes)).toBeGreaterThan(1000);
      expect(job.sha256).toMatch(/^[0-9a-f]{64}$/);
      const file = await readFile(join(storeDir, job.storageKey as string));
      expect(file.subarray(0, 5).toString()).toBe('MKBK1');
      expect(file.includes(Buffer.from('PGDMP'))).toBe(false); // plain pg_dump header is not visible
      expect(file.includes(Buffer.from('admin@'))).toBe(false);
      const actions = (await prisma.auditLog.findMany({ where: { entityId: first }, select: { action: true } })).map((a) => a.action);
      expect(actions).toEqual(expect.arrayContaining(['backup.manual_requested', 'backup.succeeded', 'backup.verified']));
    });
    it('the dashboard status reports it, with an honest warning that local disk is not off-site', async () => {
      const s = (await api(app).get('/v1/backups/status').set(bearer(admin)).expect(200)).body;
      expect(s).toMatchObject({ health: 'ok', enabled: true, destination: 'local disk', offsite: false, latestSuccess: { id: first, verification: 'VERIFIED' } });
      expect(s.warnings.join(' ')).toMatch(/same server/);
      expect(JSON.stringify(s)).not.toMatch(/postgresql:\/\/|password/i);
      const list = (await api(app).get('/v1/backups').set(bearer(admin)).expect(200)).body;
      expect(list.items.some((i: { id: string }) => i.id === first)).toBe(true);
    });
    it('refuses a second manual backup while one is running', async () => {
      const j = await backups.createJob('MANUAL');
      await prisma.backupJob.update({ where: { id: j!.id }, data: { status: 'RUNNING', startedAt: new Date() } });
      await api(app).post('/v1/backups').set(bearer(admin)).expect(409);
      await prisma.backupJob.update({ where: { id: j!.id }, data: { status: 'FAILED', finishedAt: new Date(), error: 'test' } });
    });
  });

  describe('verification', () => {
    it('a deep verification restores into an isolated database, checks the business invariants and cleans up', async () => {
      const r = (await api(app).post(`/v1/backups/${first}/verify`).set(bearer(admin)).send({ deep: true }).expect(202)).body;
      expect(r).toMatchObject({ ok: true, level: 'restore' });
      expect(r.checks.map((c: { name: string }) => c.name)).toEqual(expect.arrayContaining(['Stock balance equals the ledger sum', 'Audit log is append-only (triggers restored)']));
      expect(r.checks.every((c: { ok: boolean }) => c.ok)).toBe(true);
      const left = await prisma.$queryRawUnsafe<{ datname: string }[]>(`SELECT datname FROM pg_database WHERE datname LIKE 'verify\\_%'`);
      expect(left).toEqual([]);
      // an archive-level re-check does not downgrade the deeper result
      await backups.verify(first, { deep: false });
      expect(((await prisma.backupJob.findUniqueOrThrow({ where: { id: first } })).verificationDetail as { level: string }).level).toBe('restore');
    });
    it('a tampered stored file is detected and marked failed (and administrators are alerted)', async () => {
      const job = await prisma.backupJob.findUniqueOrThrow({ where: { id: first } });
      const path = join(storeDir, job.storageKey as string);
      const good = await readFile(path);
      const bad = Buffer.from(good); bad[200] ^= 0xff;
      await writeFile(path, bad);
      mail.outbox.length = 0;
      try {
        const r = (await api(app).post(`/v1/backups/${first}/verify`).set(bearer(admin)).send({}).expect(202)).body;
        expect(r.ok).toBe(false);
        expect(r.message).toMatch(/Checksum mismatch/);
        expect((await prisma.backupJob.findUniqueOrThrow({ where: { id: first } })).verification).toBe('FAILED');
        expect(mail.outbox.some((m) => /verification FAILED/.test(m.subject))).toBe(true);
      } finally { await writeFile(path, good); }
      await backups.verify(first, { deep: false });
      expect((await prisma.backupJob.findUniqueOrThrow({ where: { id: first } })).verification).toBe('VERIFIED');
    });
  });

  describe('scheduler', () => {
    const today = () => new Date();
    it('several instances ticking at once create and run exactly one backup for the day', async () => {
      await prisma.backupJob.deleteMany({ where: { kind: 'SCHEDULED' } });
      const results = await Promise.all([1, 2, 3, 4].map(() => scheduler.tick(today())));
      // only this process's `busy` flag serialises ticks; the unique window key is what stops other instances
      const jobs = await prisma.backupJob.findMany({ where: { kind: 'SCHEDULED' } });
      expect(jobs).toHaveLength(1);
      expect(jobs[0].windowKey).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(results.filter((r) => r.started).length).toBeLessThanOrEqual(1);
      await waitFor(async () => (await prisma.backupJob.findUniqueOrThrow({ where: { id: jobs[0].id } })).status === 'SUCCESSFUL');
      // the same day again: nothing new
      await scheduler.tick(today());
      expect(await prisma.backupJob.count({ where: { kind: 'SCHEDULED' } })).toBe(1);
    });
    it('two services racing for the same window: the database lets only one create the job', async () => {
      const key = '2099-01-01';
      const made = await Promise.all([1, 2, 3, 4, 5].map(() => backups.createJob('SCHEDULED', { windowKey: key })));
      expect(made.filter(Boolean)).toHaveLength(1);
      await prisma.backupJob.deleteMany({ where: { windowKey: key } });
    });
    it('only one caller can claim and run a job', async () => {
      const j = (await backups.createJob('MANUAL'))!;
      const runs = await Promise.all([backups.execute(j.id), backups.execute(j.id), backups.execute(j.id)]);
      expect(runs.every((r) => r.id === j.id)).toBe(true);
      expect(await prisma.auditLog.count({ where: { action: 'backup.succeeded', entityId: j.id } })).toBe(1);
    });
  });

  describe('failure handling', () => {
    it('a failed backup is recorded, stores nothing, does not touch earlier backups, alerts, and a scheduled one is retried with backoff', async () => {
      const before = await prisma.backupJob.findMany({ where: { status: 'SUCCESSFUL' }, select: { id: true, storageKey: true } });
      const bin = jest.spyOn(backups, 'binDir', 'get').mockReturnValue('/nonexistent-pg-bin');
      mail.outbox.length = 0;
      const j = (await backups.createJob('SCHEDULED', { windowKey: '2098-05-05' }))!;
      const r = await backups.execute(j.id);
      expect(r.status).toBe('FAILED');
      expect(r.error).toMatch(/pg_dump/);
      expect(r.storageKey).toBeNull(); expect(r.sha256).toBeNull();
      expect(r.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
      expect(r.error).not.toMatch(/postgresql:\/\//);
      expect(mail.outbox).toHaveLength(0); // first failure of a scheduled job retries quietly
      for (const b of before) expect(await backups.storage().exists(b.storageKey as string)).toBe(true);

      // retries are bounded: attempt 2 fails, attempt 3 fails, then it alerts and gives up
      await prisma.backupJob.update({ where: { id: j.id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
      expect((await backups.retry(j.id))?.attempt).toBe(2);
      expect((await backups.retry(j.id))?.attempt).toBe(3);
      expect(await backups.retry(j.id)).toBeNull();
      expect(mail.outbox.some((m) => /Backup FAILED/.test(m.subject))).toBe(true);
      expect((await prisma.backupJob.findUniqueOrThrow({ where: { id: j.id } })).nextAttemptAt).toBeNull();
      bin.mockRestore();

      // and the scheduler retries a transient failure once the problem is gone
      const j2 = (await backups.createJob('SCHEDULED', { windowKey: '2098-05-06' }))!;
      const bin2 = jest.spyOn(backups, 'binDir', 'get').mockReturnValue('/nonexistent-pg-bin');
      await backups.execute(j2.id); bin2.mockRestore();
      await prisma.backupJob.update({ where: { id: j2.id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
      const out = await scheduler.tick(new Date());
      expect(out.retried).toBe(j2.id);
      expect((await prisma.backupJob.findUniqueOrThrow({ where: { id: j2.id } })).status).toBe('SUCCESSFUL');
      await prisma.backupJob.deleteMany({ where: { windowKey: { in: ['2098-05-05', '2098-05-06'] } } });
    });
    it('explains a missing pg_dump in plain words (and warns on the dashboard before it fails)', async () => {
      const bin = jest.spyOn(backups, 'binDir', 'get').mockReturnValue('/nonexistent-pg-bin');
      try {
        expect((await backups.status()).warnings.join(' ')).toMatch(/pg_dump is not installed/);
        const j = (await backups.createJob('MANUAL'))!;
        expect((await backups.execute(j.id)).error).toMatch(/was not found.*BACKUP_PG_BIN_DIR/);
      } finally { bin.mockRestore(); }
    });
    it('a backup "running" for hours (the process died) is failed so it can be retried', async () => {
      const j = (await backups.createJob('SCHEDULED', { windowKey: '2097-01-01' }))!;
      await prisma.backupJob.update({ where: { id: j.id }, data: { status: 'RUNNING', startedAt: new Date(Date.now() - 4 * 3_600_000) } });
      expect(await backups.failStale()).toBeGreaterThanOrEqual(1);
      expect((await prisma.backupJob.findUniqueOrThrow({ where: { id: j.id } })).error).toMatch(/interrupted/);
      await prisma.backupJob.delete({ where: { id: j.id } });
    });
    it('warns when backups are overdue and shows the failure on the dashboard', async () => {
      await prisma.backupJob.updateMany({ where: { status: 'SUCCESSFUL' }, data: { finishedAt: new Date(Date.now() - 40 * 3_600_000) } });
      mail.outbox.length = 0;
      await backups.checkFreshness(new Date(Date.now() + 7 * 3_600_000)); // past the 6 h alert throttle
      expect(mail.outbox.some((m) => /overdue/i.test(m.subject))).toBe(true);
      expect((await api(app).get('/v1/backups/status').set(bearer(admin))).body.health).toBe('stale');
      await prisma.backupJob.updateMany({ where: { status: 'SUCCESSFUL' }, data: { finishedAt: new Date() } });
    });
  });

  describe('retention', () => {
    it('removes expired backups from storage and the list, but never the newest or the last verified one', async () => {
      const old = (await backups.createJob('MANUAL'))!;
      await backups.execute(old.id);
      const done = await prisma.backupJob.findUniqueOrThrow({ where: { id: old.id } });
      await prisma.backupJob.update({ where: { id: old.id }, data: { createdAt: new Date(Date.now() - 100 * 86_400_000), verification: 'NOT_VERIFIED' } });
      await prisma.backupSetting.update({ where: { id: 1 }, data: { keepMonthly: 0 } });
      const { deleted } = await backups.applyRetention();
      expect(deleted).toContain(old.id);
      expect(await backups.storage().exists(done.storageKey as string)).toBe(false);
      expect((await prisma.backupJob.findUniqueOrThrow({ where: { id: old.id } })).deletedAt).not.toBeNull();
      expect(await backups.storage().exists((await prisma.backupJob.findUniqueOrThrow({ where: { id: first } })).storageKey as string)).toBe(true);
      expect((await backups.status()).latestSuccess).not.toBeNull();
      await prisma.backupSetting.update({ where: { id: 1 }, data: { keepMonthly: 6 } });
    });
  });

  describe('download', () => {
    it('needs the password and a valid authenticator code, is audited, and returns the encrypted bytes', async () => {
      await api(app).post(`/v1/backups/${first}/download`).set(bearer(admin)).send({ password: 'wrong-password-123', code: code(0) }).expect(403);
      await api(app).post(`/v1/backups/${first}/download`).set(bearer(admin)).send({ password: PASSWORD, code: '000000' }).expect(401);
      const res = await api(app).post(`/v1/backups/${first}/download`).set(bearer(admin)).send({ password: PASSWORD, code: code(-1) }).buffer(true).parse((r, cb) => { const c: Buffer[] = []; r.on('data', (d: Buffer) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); }).expect(200);
      const stored = await readFile(join(storeDir, (await prisma.backupJob.findUniqueOrThrow({ where: { id: first } })).storageKey as string));
      expect((res.body as Buffer).equals(stored)).toBe(true);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(await prisma.auditLog.count({ where: { action: 'backup.downloaded', entityId: first } })).toBe(1);
    });
  });

  describe('recovery', () => {
    const body = (extra: object = {}) => ({ backupId: first, password: PASSWORD, code: code(1), confirm: confirmPhrase(first), ...extra });
    it('is refused without the exact confirmation phrase, with a wrong password, or for an unverified backup', async () => {
      await api(app).post('/v1/recoveries').set(bearer(admin)).send(body({ confirm: 'yes please' })).expect(400);
      await api(app).post('/v1/recoveries').set(bearer(admin)).send(body({ password: 'not-my-password-1' })).expect(403);
      const unverified = (await backups.createJob('MANUAL'))!;
      await backups.execute(unverified.id);
      await prisma.backupJob.update({ where: { id: unverified.id }, data: { verification: 'NOT_VERIFIED' } });
      await api(app).post('/v1/recoveries').set(bearer(admin)).send(body({ backupId: unverified.id, confirm: confirmPhrase(unverified.id) })).expect(400);
      await api(app).post('/v1/recoveries').set(bearer(admin)).send(body({ backupId: '00000000-0000-4000-8000-000000000000' })).expect(404);
      await api(app).post('/v1/recoveries').set(bearer(owner)).send(body()).expect(403);
      expect(await prisma.recoveryOperation.count()).toBe(0);
      expect(await prisma.auditLog.count({ where: { action: 'recovery.reauth_failed' } })).toBeGreaterThanOrEqual(1);
    });
    it('takes a safety snapshot, restores into a NEW database, verifies it and leaves production untouched', async () => {
      const usersBefore = await prisma.user.count();
      const res = await api(app).post('/v1/recoveries').set(bearer(admin)).send(body()).expect(202);
      expect(res.body.status).toBe('RUNNING');
      // a second recovery cannot start while one is running (re-authentication is stubbed: an authenticator code works only once)
      const reauth = jest.spyOn(app.get(AuthService), 'requirePasswordAndCode').mockResolvedValue();
      await api(app).post('/v1/recoveries').set(bearer(admin)).send(body()).expect(409);
      reauth.mockRestore();
      await recovery.idle();
      const op = (await api(app).get(`/v1/recoveries/${res.body.id}`).set(bearer(admin)).expect(200)).body;
      expect(op.error).toBeNull();
      expect(op.status).toBe('SUCCEEDED');
      const dbName: string = op.report.database; dropAfter.push(dbName);
      expect(dbName).toMatch(/^recovery_\d{12}_[0-9a-f]{8}$/);
      expect(await dbExists(dbName)).toBe(true);
      expect(op.report.checks.every((c: { ok: boolean }) => c.ok)).toBe(true);
      expect(op.report.compatibility.missing).toEqual([]);
      expect(JSON.stringify(op)).not.toMatch(/postgresql:\/\/|password/i);
      const snap = await prisma.backupJob.findUniqueOrThrow({ where: { id: op.preSnapshotId } });
      expect(snap).toMatchObject({ kind: 'PRE_RESTORE', status: 'SUCCESSFUL' });
      expect(await prisma.user.count()).toBe(usersBefore);
      const restored = new PrismaClient({ datasourceUrl: backups['cfg']('RECOVERY_ADMIN_DATABASE_URL').replace(/\/postgres$/, `/${dbName}`) });
      expect(await restored.user.count()).toBeGreaterThan(0);
      await restored.$disconnect();
      const actions = (await prisma.auditLog.findMany({ where: { entityId: op.id }, select: { action: true } })).map((a) => a.action);
      expect(actions).toEqual(expect.arrayContaining(['recovery.requested', 'recovery.succeeded']));
      expect((await api(app).get('/v1/recoveries').set(bearer(admin)).expect(200)).body[0].id).toBe(op.id);
    });
    it('stops before touching anything when the safety snapshot cannot be made', async () => {
      const reauth = jest.spyOn(app.get(AuthService), 'requirePasswordAndCode').mockResolvedValue();
      const bin = jest.spyOn(backups, 'binDir', 'get').mockReturnValue('/nonexistent-pg-bin');
      const dbsBefore = (await prisma.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int n FROM pg_database WHERE datname LIKE 'recovery\\_%'`))[0].n;
      try {
        const res = await api(app).post('/v1/recoveries').set(bearer(admin)).send(body()).expect(202);
        await recovery.idle();
        const op = await prisma.recoveryOperation.findUniqueOrThrow({ where: { id: res.body.id } });
        expect(op.status).toBe('FAILED');
        expect(op.error).toMatch(/safety snapshot/);
        expect((op.report as { steps: { ok: boolean }[] }).steps.some((s) => !s.ok)).toBe(true);
        expect((await prisma.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int n FROM pg_database WHERE datname LIKE 'recovery\\_%'`))[0].n).toBe(dbsBefore);
      } finally { bin.mockRestore(); reauth.mockRestore(); }
    });
    it('refuses to restore over, or drop, the production database', async () => {
      const prodDb = new URL(process.env.DATABASE_URL as string).pathname.slice(1);
      await expect(backups.restoreToNewDatabase('/dev/null', prodDb)).rejects.toThrow(/production/);
      await expect(backups.dropDatabase(prodDb)).rejects.toThrow(/did not create/);
      await expect(backups.dropDatabase('postgres')).rejects.toThrow(/did not create/);
      await expect(backups.restoreToNewDatabase('/dev/null', 'x; DROP DATABASE postgres')).rejects.toThrow(/Invalid/);
    });
  });
});
