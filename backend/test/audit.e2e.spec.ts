import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { api, bearer, createApp, makeUser, seed, signIn, useIsolatedSchema } from './helpers';

describe('Audit log API (e2e, real PostgreSQL)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  const tok: Record<string, string> = {};

  beforeAll(async () => {
    process.env.THROTTLE_OFF = '1';
    await useIsolatedSchema('aud');
    ({ app, prisma } = await createApp());
    await seed(prisma);
    await prisma.role.updateMany({ data: { mfaRequired: false } });
    for (const [k, role] of [['admin', 'SUPER_ADMIN'], ['owner', 'OWNER'], ['manager', 'FARM_MANAGER'], ['acct', 'ACCOUNTANT']] as const) {
      const u = await makeUser(prisma, { roles: [role], fullName: `${k} user` });
      tok[k] = (await signIn(app, u.email)).accessToken;
    }
  });
  afterAll(async () => { await prisma.$disconnect(); await app.close(); });

  const get = (path: string, who: string) => api(app).get(`/v1${path}`).set(bearer(tok[who]));

  it('is limited to holders of audit.read', async () => {
    await get('/audit', 'manager').expect(403);
    await get('/audit', 'acct').expect(403);
    await get('/audit/verify', 'manager').expect(403);
    await api(app).get('/v1/audit').expect(401);
    await get('/audit', 'owner').expect(200);
    await get('/audit', 'admin').expect(200);
  });

  it('lists newest first with filters, paging and no hash internals', async () => {
    const all = (await get('/audit?limit=100', 'admin').expect(200)).body;
    expect(all.total).toBeGreaterThan(3);
    const seqs = all.items.map((r: { seq: string }) => BigInt(r.seq));
    expect([...seqs].sort((a, b) => (a < b ? 1 : -1))).toEqual(seqs);
    expect(all.items[0]).not.toHaveProperty('hash');
    expect(all.items[0]).not.toHaveProperty('prevHash');
    const logins = (await get('/audit?action=auth.*&limit=100', 'admin').expect(200)).body;
    expect(logins.items.length).toBeGreaterThan(0);
    expect(logins.items.every((r: { action: string }) => r.action.startsWith('auth.'))).toBe(true);
    const page2 = (await get('/audit?limit=2&page=2', 'admin').expect(200)).body;
    expect(page2.items).toHaveLength(2);
    expect(page2.items[0].id).toBe(all.items[2].id);
    await get('/audit?action=bad%20action', 'admin').expect(400);
    await get('/audit?userId=nope', 'admin').expect(400);
    await get('/audit?evil=1', 'admin').expect(400);
  });

  it('verifies the hash chain and reports the first tampered row', async () => {
    const ok = (await get('/audit/verify', 'admin').expect(200)).body;
    expect(ok).toMatchObject({ intact: true, firstInconsistentId: null });
    const row = await prisma.auditLog.findFirstOrThrow({ orderBy: { seq: 'asc' }, skip: 2 });
    await prisma.$executeRawUnsafe('ALTER TABLE "AuditLog" DISABLE TRIGGER audit_log_no_update_delete'); // simulate a privileged actor bypassing the trigger
    try {
      await prisma.$executeRawUnsafe(`UPDATE "AuditLog" SET "action" = 'tampered' WHERE id = '${row.id}'::uuid`);
      const bad = (await get('/audit/verify', 'admin').expect(200)).body;
      expect(bad).toMatchObject({ intact: false, firstInconsistentId: row.id });
    } finally {
      await prisma.$executeRawUnsafe(`UPDATE "AuditLog" SET "action" = '${row.action}' WHERE id = '${row.id}'::uuid`);
      await prisma.$executeRawUnsafe('ALTER TABLE "AuditLog" ENABLE TRIGGER audit_log_no_update_delete');
    }
    expect((await get('/audit/verify', 'admin').expect(200)).body.intact).toBe(true);
  });

  it('has no route that can change or delete audit rows', async () => {
    for (const m of ['post', 'put', 'patch', 'delete'] as const) {
      const r = await api(app)[m]('/v1/audit').set(bearer(tok.admin)).send({});
      expect([404, 405]).toContain(r.status);
    }
  });
});
