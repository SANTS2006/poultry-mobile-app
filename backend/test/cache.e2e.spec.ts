import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import { SettingsService } from '../src/domain/settings.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { api, bearer, createApp, makeUser, seed, signIn, useIsolatedSchema } from './helpers';

/**
 * Speed-ups must never weaken security or show stale figures. These tests turn the caches ON (they are off in all other tests) and check
 * that the things that matter still take effect immediately.
 */
describe('Caching and slow-database safety (e2e, real PostgreSQL)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let coop: string;
  let adminTok: string;
  let mgrTok: string;
  let farmId: string;

  beforeAll(async () => {
    process.env.THROTTLE_OFF = '1';
    process.env.FORCE_CACHE = '1';
    await useIsolatedSchema('cache');
    ({ app, prisma } = await createApp());
    await seed(prisma);
    await prisma.role.updateMany({ data: { mfaRequired: false } });
    farmId = (await prisma.farm.create({ data: { name: 'Cache Farm' } })).id;
    coop = (await prisma.coop.create({ data: { farmId, name: 'Coop 1' } })).id;
    adminTok = (await signIn(app, (await makeUser(prisma, { roles: ['SUPER_ADMIN'] })).email)).accessToken;
    mgrTok = (await signIn(app, (await makeUser(prisma, { roles: ['FARM_MANAGER'] })).email)).accessToken;
  });
  afterAll(async () => { delete process.env.FORCE_CACHE; await prisma.$disconnect(); await app.close(); });

  it('lets a database transaction run for longer than the old 5-second limit', async () => {
    const db = app.get(PrismaService);
    const started = Date.now();
    await db.$transaction(async (tx) => { await tx.$executeRaw`SELECT pg_sleep(5.5)`; await tx.$queryRaw`SELECT 1`; });
    expect(Date.now() - started).toBeGreaterThanOrEqual(5500);
  }, 30_000);

  it('a cached sign-in state is dropped the moment the user is disabled or signed out everywhere', async () => {
    const u = await makeUser(prisma, { roles: ['SALES_STAFF'] });
    const s = await signIn(app, u.email);
    await api(app).get('/v1/auth/me').set(bearer(s.accessToken)).expect(200); // now cached
    await api(app).get('/v1/auth/me').set(bearer(s.accessToken)).expect(200);
    await api(app).post(`/v1/users/${u.id}/disable`).set(bearer(adminTok)).send({ reason: 'cache check' }).expect(200);
    await api(app).get('/v1/auth/me').set(bearer(s.accessToken)).expect(401); // immediately, not after the cache time limit

    const v = await makeUser(prisma, { roles: ['SALES_STAFF'] });
    const t = await signIn(app, v.email);
    await api(app).get('/v1/auth/me').set(bearer(t.accessToken)).expect(200);
    await api(app).post('/v1/auth/logout-all').set(bearer(t.accessToken)).expect(204);
    await api(app).get('/v1/auth/me').set(bearer(t.accessToken)).expect(401);
  });

  it('changed roles and permissions apply on the next request even when the old answer was cached', async () => {
    const u = await makeUser(prisma, { roles: ['SALES_STAFF'] });
    const s = await signIn(app, u.email);
    await api(app).get('/v1/sales').set(bearer(s.accessToken)).expect(200);
    const prod = await prisma.role.findUniqueOrThrow({ where: { code: 'PRODUCTION_STAFF' } });
    await api(app).put(`/v1/users/${u.id}/roles`).set(bearer(adminTok)).send({ roleCodes: ['PRODUCTION_STAFF'], reason: 'cache check' }).expect(200);
    expect(prod.id).toBeTruthy();
    await api(app).get('/v1/sales').set(bearer(s.accessToken)).expect(403);
  });

  it('settings changed through the app are visible straight away', async () => {
    const settings = app.get(SettingsService);
    expect(await settings.get<number>('production.maxEggsPerRecord')).toBeGreaterThan(0);
    await settings.set('production.maxEggsPerRecord', 123, (await prisma.user.findFirstOrThrow()).id);
    expect(await settings.get<number>('production.maxEggsPerRecord')).toBe(123);
  });

  it('the dashboard shows a new record at once (it is cached, and every business event empties the cache)', async () => {
    const before = (await api(app).get('/v1/dashboard').set(bearer(mgrTok)).expect(200)).body;
    await api(app).get('/v1/dashboard').set(bearer(mgrTok)).expect(200); // served from the cache
    await api(app).post('/v1/production').set(bearer(mgrTok)).send({ coopId: coop, shift: 'MORNING', entries: [{ unit: 'CRATE', quantity: 2 }], clientId: randomUUID() }).expect(201);
    const after = (await api(app).get('/v1/dashboard').set(bearer(mgrTok)).expect(200)).body;
    expect(after.production.todayEggs).toBe(before.production.todayEggs + 60);
  });

  it('stock moves in one statement: refuses to go below zero and never loses an update under concurrency', async () => {
    const inv = (await api(app).get('/v1/inventory').set(bearer(mgrTok)).expect(200)).body;
    const start = inv.quantityEggs as number;
    const sells = await Promise.all(Array.from({ length: 4 }, () => api(app).post('/v1/inventory/adjustments').set(bearer(mgrTok)).send({ type: 'LOSS', unit: 'EGG', quantity: Math.ceil(start / 3), reason: 'concurrency check', clientId: randomUUID() })));
    const ok = sells.filter((r) => r.status === 200 || r.status === 201).length;
    const refused = sells.filter((r) => r.status === 409).length;
    expect(ok + refused).toBe(4);
    expect(refused).toBeGreaterThanOrEqual(1); // 4 × a third of the stock cannot all fit
    const rec = (await api(app).get('/v1/inventory/reconciliation').set(bearer(mgrTok)).expect(200)).body;
    expect(rec.consistent).toBe(true);
    expect(rec.balanceEggs).toBeGreaterThanOrEqual(0);
  });
});
