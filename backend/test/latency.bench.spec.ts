/* Manual benchmark (not part of the normal suite): how the API behaves when the database is far away.
     node scripts/latency-proxy.js --listen 5434 --target localhost:5433 --delay 125 &
     BENCH_PROXY_PORT=5434 DATABASE_URL=postgresql://postgres@localhost:5433/makarifor_test npx jest --config jest.e2e.config.js --runInBand test/latency.bench.spec.ts
   Setup talks to the database directly; every request measured afterwards goes through the delay proxy. */
import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { api, bearer, createApp, makeUser, PASSWORD, seed, useIsolatedSchema } from './helpers';

const time = async <T>(label: string, fn: () => Promise<T>, out: string[]): Promise<T> => { const t = Date.now(); const r = await fn(); out.push(`${label.padEnd(34)} ${String(Date.now() - t).padStart(6)} ms`); return r; };

describe('latency benchmark', () => {
  let app: INestApplication; let prisma: PrismaClient;
  const out: string[] = [];
  let farmId = ''; let coop = ''; let email = '';

  beforeAll(async () => {
    process.env.THROTTLE_OFF = '1';
    await useIsolatedSchema('bench');
    const direct = new PrismaClient(); // setup runs without delay
    await seed(direct);
    await direct.role.updateMany({ data: { mfaRequired: false } });
    farmId = (await direct.farm.create({ data: { name: 'Bench Farm' } })).id;
    coop = (await direct.coop.create({ data: { farmId, name: 'Coop 1' } })).id;
    for (const n of ['Coop 2', 'Coop 3']) await direct.coop.create({ data: { farmId, name: n } });
    const carton = await direct.productUnit.findFirstOrThrow({ where: { code: 'CARTON' } });
    await direct.price.create({ data: { productUnitId: carton.id, amount: new Prisma.Decimal('1550'), effectiveFrom: new Date('2026-01-01T00:00:00Z') } });
    email = (await makeUser(direct, { roles: ['PRODUCTION_STAFF'], fullName: 'Bench Prod' })).email;
    await direct.$disconnect();
    const proxy = process.env.BENCH_PROXY_PORT;
    if (proxy) {
      const u = new URL(process.env.DATABASE_URL as string); u.port = proxy;
      process.env.DATABASE_URL = u.toString(); process.env.DIRECT_DATABASE_URL = u.toString();
    }
    ({ app, prisma } = await createApp());
  }, 120_000);
  afterAll(async () => {
    process.stdout.write(`\n──── API timings with the database ${process.env.BENCH_PROXY_PORT ? 'behind the delay proxy' : 'direct'} ────\n${out.join('\n')}\n\n`);
    await prisma.$disconnect(); await app.close();
  });

  it('measures the requests a phone makes', async () => {
    const login = await time('POST /auth/login', () => api(app).post('/v1/auth/login').send({ email, password: PASSWORD }), out);
    expect(login.status).toBe(200);
    const t = login.body.tokens.accessToken as string;
    await time('GET /auth/me (1st)', () => api(app).get('/v1/auth/me').set(bearer(t)).expect(200), out);
    await time('GET /auth/me (2nd)', () => api(app).get('/v1/auth/me').set(bearer(t)).expect(200), out);
    await time('GET /dashboard (1st)', () => api(app).get('/v1/dashboard').set(bearer(t)).expect(200), out);
    await time('GET /dashboard (2nd)', () => api(app).get('/v1/dashboard').set(bearer(t)).expect(200), out);
    await time('GET /sync/reference', () => api(app).get('/v1/sync/reference').set(bearer(t)), out);
    await time('GET /production (list)', () => api(app).get('/v1/production?limit=25').set(bearer(t)).expect(200), out);
    const shifts = ['MORNING', 'AFTERNOON', 'EVENING'];
    let failures = 0;
    for (const [i, shift] of shifts.entries()) {
      const r = await time(`POST /sync/push production ${i + 1}`, () => api(app).post('/v1/sync/push').set(bearer(t)).send({ deviceId: 'bench', operations: [{ clientId: randomUUID(), type: 'production.create', payload: { coopId: coop, shift, entries: [{ unit: 'CRATE', quantity: 3 + i }] } }] }), out);
      if (r.body.results?.[0]?.status !== 'accepted') failures++;
    }
    const batch = await time('POST /sync/push 3 records at once', () => api(app).post('/v1/sync/push').set(bearer(t)).send({ deviceId: 'bench', operations: ['MORNING', 'AFTERNOON', 'EVENING'].map((shift, i) => ({ clientId: randomUUID(), type: 'production.create', payload: { coopId: coop, productionDate: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10), shift, entries: [{ unit: 'CRATE', quantity: 2 + i }] } })) }), out);
    out.push(`accepted in batch: ${(batch.body.results ?? []).filter((x: { status: string }) => x.status === 'accepted').length}/3; single pushes that failed: ${failures}`);
  }, 120_000);
});
