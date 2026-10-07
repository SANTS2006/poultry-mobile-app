import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { api, bearer, createApp, makeUser, seed, signIn, useIsolatedSchema } from './helpers';

/**
 * Load and concurrency checks against real PostgreSQL. Budgets are deliberately generous (shared CI machines): they catch accidental
 * O(n²) queries and missing indexes, not micro-regressions. Real capacity planning needs production-like hardware.
 */
describe('Performance and concurrency (e2e, real PostgreSQL)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let token: string;
  let farmId: string;
  const SALES = 30_000;
  const timings: Record<string, number> = {};

  const timed = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const t = process.hrtime.bigint();
    const r = await fn();
    timings[name] = Number(process.hrtime.bigint() - t) / 1e6;
    return r;
  };

  beforeAll(async () => {
    process.env.THROTTLE_OFF = '1';
    await useIsolatedSchema('perf');
    ({ app, prisma } = await createApp());
    await seed(prisma);
    await prisma.role.updateMany({ data: { mfaRequired: false } });
    farmId = (await prisma.farm.create({ data: { name: 'Perf Farm' } })).id;
    const owner = await makeUser(prisma, { roles: ['OWNER'] });
    token = (await signIn(app, owner.email)).accessToken;

    const egg = await prisma.productUnit.findFirstOrThrow({ where: { code: 'EGG' } });
    const crate = await prisma.productUnit.findFirstOrThrow({ where: { code: 'CRATE' } });
    const feed = await prisma.expenseCategory.findFirstOrThrow({ where: { code: 'FEED' } });
    const coops = await Promise.all([1, 2, 3].map((i) => prisma.coop.create({ data: { farmId, name: `Coop ${i}` } })));
    const shifts = await prisma.shift.findMany();
    const start = Date.UTC(2025, 9, 1);
    const day = (i: number) => new Date(start + (i % 360) * 86_400_000);

    const production: Prisma.ProductionRecordCreateManyInput[] = [];
    for (let d = 0; d < 360; d++) for (const c of coops) for (const s of shifts) production.push({ farmId, coopId: c.id, shiftId: s.id, productionDate: day(d), totalEggs: 300 });
    await prisma.productionRecord.createMany({ data: production });

    const sales: Prisma.SaleCreateManyInput[] = [];
    const items: Prisma.SaleItemCreateManyInput[] = [];
    for (let i = 0; i < SALES; i++) {
      const id = randomUUID();
      sales.push({ id, farmId, number: `P-${i}`, saleDate: day(i), subtotal: '387.51', total: '387.51', paidAmount: '387.51', paymentStatus: 'PAID' });
      items.push({ saleId: id, productId: crate.productId, productUnitId: crate.id, quantity: 3, baseEggs: 90, unitPrice: '129.17', lineTotal: '387.51' });
    }
    for (let i = 0; i < sales.length; i += 5000) {
      await prisma.sale.createMany({ data: sales.slice(i, i + 5000) });
      await prisma.saleItem.createMany({ data: items.slice(i, i + 5000) });
    }
    await prisma.expense.createMany({ data: Array.from({ length: 5000 }, (_, i) => ({ farmId, categoryId: feed.id, description: `Feed ${i}`, total: '250.00', expenseDate: day(i) })) });
    await prisma.$executeRawUnsafe('ANALYZE');
    void egg;
  }, 300_000);
  afterAll(async () => {
    // eslint-disable-next-line no-console
    console.log('timings (ms):', JSON.stringify(Object.fromEntries(Object.entries(timings).map(([k, v]) => [k, Math.round(v)]))));
    await prisma.$disconnect();
    await app.close();
  });

  const get = (path: string) => api(app).get(`/v1${path}`).set(bearer(token));

  it('serves the dashboard and paged lists quickly with 30,000 sales', async () => {
    await timed('dashboard', () => get('/dashboard').expect(200));
    const r = await timed('sales page 1', () => get('/sales?limit=25').expect(200));
    expect(r.body.total).toBe(SALES);
    await timed('sales deep page', () => get('/sales?limit=25&page=1000').expect(200));
    await timed('production list', () => get('/production?limit=25').expect(200));
    await timed('expenses list', () => get('/expenses?limit=25').expect(200));
    for (const k of ['dashboard', 'sales page 1', 'sales deep page', 'production list', 'expenses list']) expect(timings[k]).toBeLessThan(2500);
  });

  it('builds year-long reports within budget and totals stay exact', async () => {
    const q = 'from=2025-10-01&to=2026-09-25&groupBy=month';
    const sales = await timed('sales report', () => get(`/reports/sales?${q}`).expect(200));
    expect(sales.body.summary.salesCount).toBe(SALES);
    expect(sales.body.summary.revenue).toBe('11625300.00'); // 30,000 × 387.51 exactly
    await timed('production report', () => get(`/reports/production?${q}`).expect(200));
    await timed('expenses report', () => get(`/reports/expenses?${q}`).expect(200));
    await timed('financial report', () => get(`/reports/financial?${q}`).expect(200));
    await timed('inventory report', () => get(`/reports/inventory?${q}`).expect(200));
    for (const k of ['sales report', 'production report', 'expenses report', 'financial report', 'inventory report']) expect(timings[k]).toBeLessThan(15000);
  });

  it('exports a large report as CSV within budget', async () => {
    const res = await timed('sales csv export (detail)', () => api(app).get('/v1/reports/sales/export?from=2025-10-01&to=2026-09-25&groupBy=month&format=csv').set(bearer(token)).expect(200));
    expect(res.text.split('\r\n').length).toBeGreaterThan(SALES);
    expect(timings['sales csv export (detail)']).toBeLessThan(30000);
  });

  it('under 40 concurrent sales for a 5-carton stock, never oversells and the ledger stays consistent', async () => {
    const carton = await prisma.productUnit.findFirstOrThrow({ where: { code: 'CARTON' } });
    await prisma.price.create({ data: { productUnitId: carton.id, amount: '1550', effectiveFrom: new Date('2026-01-01T00:00:00Z') } });
    const eggUnit = await prisma.productUnit.findFirstOrThrow({ where: { code: 'EGG' } });
    await prisma.inventoryBalance.deleteMany({});
    await prisma.inventoryTransaction.deleteMany({});
    await prisma.inventoryBalance.create({ data: { farmId, productId: eggUnit.productId, quantityEggs: 1800 } });
    await prisma.inventoryTransaction.create({ data: { farmId, productId: eggUnit.productId, type: 'OPENING', quantityEggs: 1800, occurredAt: new Date(), reason: 'perf' } });

    const results = await timed('40 concurrent sales', () => Promise.all(Array.from({ length: 40 }, () =>
      api(app).post('/v1/sales').set(bearer(token)).send({ items: [{ unit: 'CARTON', quantity: 1 }], clientId: randomUUID() }))));
    const ok = results.filter((r) => r.status === 201).length;
    const refused = results.filter((r) => r.status === 409 || r.status === 422).length;
    expect(ok).toBe(5); // exactly the stock that existed
    expect(ok + refused).toBe(40); // everything else was a clean refusal, no 500s
    const bal = await prisma.inventoryBalance.findFirstOrThrow({ where: { farmId } });
    const sum = await prisma.$queryRaw<{ s: bigint }[]>`SELECT COALESCE(SUM("quantityEggs"),0)::bigint s FROM "InventoryTransaction" WHERE "farmId" = ${farmId}::uuid`;
    expect(bal.quantityEggs).toBe(0);
    expect(Number(sum[0].s)).toBe(0);
  });

  it('idempotent replays under concurrency create exactly one record', async () => {
    const eggUnit = await prisma.productUnit.findFirstOrThrow({ where: { code: 'EGG' } });
    await prisma.inventoryBalance.update({ where: { farmId_productId: { farmId, productId: eggUnit.productId } }, data: { quantityEggs: 1000 } });
    await prisma.inventoryTransaction.create({ data: { farmId, productId: eggUnit.productId, type: 'ADJUSTMENT', quantityEggs: 1000, occurredAt: new Date(), reason: 'perf' } });
    const clientId = randomUUID();
    const rs = await Promise.all(Array.from({ length: 10 }, () => api(app).post('/v1/sales').set(bearer(token)).send({ items: [{ unit: 'CARTON', quantity: 1 }], clientId })));
    expect(rs.every((r) => [200, 201].includes(r.status))).toBe(true);
    expect(await prisma.sale.count({ where: { clientId } })).toBe(1);
    expect(new Set(rs.map((r) => r.body.id)).size).toBe(1);
  });
});
