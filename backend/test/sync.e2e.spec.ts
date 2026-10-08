import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { ApiClient } from '../../mobile/src/services/api-client';
import { MemorySecureStore, TokenManager } from '../../mobile/src/services/token-manager';
import { SyncEngine } from '../../mobile/src/sync/engine';
import { HttpSyncTransport } from '../../mobile/src/sync/http-transport';
import { ReferenceCache } from '../../mobile/src/sync/reference-cache';
import { MemoryOutboxStorage } from '../../mobile/src/sync/storage';
import { FakeNetwork } from '../../mobile/src/sync/test-helpers';
import type { NetworkMonitor } from '../../mobile/src/sync/types';
import { AuditService } from '../src/audit/audit.service';
import { DomainEvent, DomainEvents } from '../src/domain/events.service';
import { ProductionService } from '../src/production/production.service';
import { api, bearer, createApp, login, makeUser, PASSWORD, seed, signIn, useIsolatedSchema } from './helpers';

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

describe('Offline sync (e2e): push semantics, idempotency, conflicts and the real device engine over HTTP', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let baseUrl: string;
  let farmId: string;
  let coop1: string;
  let coop2: string;
  type Who = 'admin' | 'manager' | 'prod' | 'sales' | 'acct';
  const users = {} as Record<Who, { id: string; email: string; token: string; refresh: string }>;
  const events: DomainEvent[] = [];

  const push = (who: Who, operations: unknown[], extra: object = {}) => api(app).post('/v1/sync/push').set(bearer(users[who].token)).send({ deviceId: `dev-${who}`, operations, ...extra });
  const op = (type: string, payload: object, clientId = randomUUID()) => ({ clientId, type, payload });
  const post = (path: string, who: Who, body?: object) => api(app).post(`/v1${path}`).set(bearer(users[who].token)).send(body);
  const stock = async () => (await prisma.inventoryBalance.findFirst({ where: { farmId } }))?.quantityEggs ?? 0;
  const results = (res: { body: { results: { status: string; code?: string }[] } }) => res.body.results.map((r) => r.status);

  beforeAll(async () => {
    process.env.THROTTLE_OFF = '1';
    await useIsolatedSchema('sync');
    ({ app, prisma } = await createApp());
    await app.listen(0);
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}`;
    await seed(prisma);
    await prisma.role.updateMany({ data: { mfaRequired: false } });
    app.get(DomainEvents).on('*', (e) => events.push(e));
    farmId = (await prisma.farm.create({ data: { name: 'Sync Farm' } })).id;
    coop1 = (await prisma.coop.create({ data: { farmId, name: 'Coop 1' } })).id;
    coop2 = (await prisma.coop.create({ data: { farmId, name: 'Coop 2' } })).id;
    const carton = await prisma.productUnit.findFirstOrThrow({ where: { code: 'CARTON' } });
    await prisma.price.create({ data: { productUnitId: carton.id, amount: new Prisma.Decimal('1550'), effectiveFrom: new Date('2026-01-01T00:00:00Z') } });
    for (const [k, role] of [['admin', 'SUPER_ADMIN'], ['manager', 'FARM_MANAGER'], ['prod', 'PRODUCTION_STAFF'], ['sales', 'SALES_STAFF'], ['acct', 'ACCOUNTANT']] as const) {
      const u = await makeUser(prisma, { roles: [role], fullName: `${k} user` });
      const s = await signIn(app, u.email);
      users[k] = { id: u.id, email: u.email, token: s.accessToken, refresh: s.refreshToken };
    }
    await post('/inventory/adjustments', 'manager', { type: 'ADJUSTMENT', direction: 'INCREASE', unit: 'CARTON', quantity: 100, reason: 'opening stock for sync tests' }).expect(201); // 36,000 eggs
  });
  afterAll(async () => { await prisma.$disconnect(); await app.close(); });

  // ───────────────────────── /sync/push semantics ─────────────────────────
  describe('POST /sync/push', () => {
    const c1 = randomUUID(); const p1 = randomUUID(); const s1 = randomUUID(); const e1 = randomUUID();
    const batch = () => [
      op('customer.create', { name: 'Mama Kadi', phone: '+23276000001' }, c1),
      op('production.create', { coopId: coop1, shift: 'MORNING', productionDate: daysAgo(1), entries: [{ unit: 'CARTON', quantity: 1 }, { unit: 'CRATE', quantity: 7 }] }, p1),
      op('sale.create', { customerClientId: c1, items: [{ unit: 'CARTON', quantity: 2 }], saleDate: daysAgo(1) }, s1),
      op('expense.create', { categoryCode: 'FEED', description: 'Concentrate', quantity: '8', unitCost: '1400', expenseDate: daysAgo(1) }, e1),
    ];
    const entityIds: string[] = [];

    it('applies a mixed offline batch in order through the normal services (server-side pricing, ledger, audit)', async () => {
      events.length = 0;
      const before = await stock();
      const res = await push('manager', batch()).expect(200);
      expect(results(res)).toEqual(['accepted', 'accepted', 'accepted', 'accepted']);
      entityIds.push(...res.body.results.map((r: { entityId: string }) => r.entityId));
      expect(res.body.results.map((r: { entityType: string }) => r.entityType)).toEqual(['customer', 'production_record', 'sale', 'expense']);
      const sale = await prisma.sale.findUniqueOrThrow({ where: { id: entityIds[2] }, include: { items: true } });
      expect(sale).toMatchObject({ clientId: s1, customerId: entityIds[0], total: new Prisma.Decimal('3100') }); // priced by the server
      expect(sale.saleDate.toISOString().slice(0, 10)).toBe(daysAgo(1));
      expect((await prisma.customer.findUniqueOrThrow({ where: { id: entityIds[0] } })).clientId).toBe(c1);
      expect((await prisma.expense.findUniqueOrThrow({ where: { id: entityIds[3] } })).total.toString()).toBe('11200');
      expect(await stock()).toBe(before + 570 - 720);
      expect(events.map((e) => e.name)).toEqual(expect.arrayContaining(['customer.created', 'production.created', 'sale.created', 'expense.created']));
      expect((await prisma.syncOperation.findMany({ where: { clientId: { in: [c1, p1, s1, e1] } } })).every((r) => r.status === 'ACCEPTED' && r.userId === users.manager.id && r.deviceId === 'dev-manager')).toBe(true);
    });

    it('applies runs of independent records side by side but keeps results in the order sent, and keeps sales in order after the stock they need', async () => {
      const before = await stock();
      const ops = [
        ...(['MORNING', 'AFTERNOON', 'EVENING'] as const).flatMap((shift, i) => [
          op('production.create', { coopId: coop1, shift, productionDate: daysAgo(10 + i), entries: [{ unit: 'CRATE', quantity: 2 }] }),
          op('production.create', { coopId: coop2, shift, productionDate: daysAgo(10 + i), entries: [{ unit: 'CRATE', quantity: 1 }] }),
        ]),
        op('customer.create', { name: 'Parallel One' }), op('customer.create', { name: 'Parallel Two' }),
        op('sale.create', { items: [{ unit: 'CARTON', quantity: 1 }] }),
      ];
      const res = await push('manager', ops).expect(200);
      expect(res.body.results.map((r: { clientId: string }) => r.clientId)).toEqual(ops.map((o) => o.clientId)); // same order as sent
      expect(results(res)).toEqual(ops.map(() => 'accepted'));
      expect(await stock()).toBe(before + 3 * 60 + 3 * 30 - 360); // 3×(2+1) crates produced, 1 carton sold: nothing lost under concurrency
      const rec = (await api(app).get('/v1/inventory/reconciliation').set(bearer(users.manager.token)).expect(200)).body;
      expect(rec.consistent).toBe(true);
      expect(await app.get(AuditService).verifyChain(100_000)).toBeNull(); // the audit chain stays intact with parallel writers
    });

    it('two parallel records for the same coop, date and shift: one is accepted, the other is told it conflicts (never both)', async () => {
      const date = daysAgo(20);
      const a = op('production.create', { coopId: coop1, shift: 'MORNING', productionDate: date, entries: [{ unit: 'CRATE', quantity: 1 }] });
      const b = op('production.create', { coopId: coop1, shift: 'MORNING', productionDate: date, entries: [{ unit: 'CRATE', quantity: 3 }] });
      const res = await push('manager', [a, b]).expect(200);
      expect(results(res).sort()).toEqual(['accepted', 'conflict']);
      expect(await prisma.productionRecord.count({ where: { coopId: coop1, productionDate: new Date(`${date}T00:00:00Z`), status: 'ACTIVE' } })).toBe(1);
    });

    it('is idempotent: re-pushing the same operations answers "duplicate" with the same ids and changes nothing', async () => {
      events.length = 0;
      const before = { stock: await stock(), sales: await prisma.sale.count(), prod: await prisma.productionRecord.count(), exp: await prisma.expense.count(), cust: await prisma.customer.count() };
      const res = await push('manager', batch()).expect(200);
      expect(results(res)).toEqual(['duplicate', 'duplicate', 'duplicate', 'duplicate']);
      expect(res.body.results.map((r: { entityId: string }) => r.entityId)).toEqual(entityIds);
      expect({ stock: await stock(), sales: await prisma.sale.count(), prod: await prisma.productionRecord.count(), exp: await prisma.expense.count(), cust: await prisma.customer.count() }).toEqual(before);
      expect(events.filter((e) => !['sync.completed', 'notification.created'].includes(e.name))).toEqual([]); // a duplicate publishes no business events
    });

    it('refuses an operation id that belongs to another user', async () => {
      const res = await push('sales', [op('customer.create', { name: 'Hijack' }, c1)]).expect(200);
      expect(res.body.results[0]).toMatchObject({ status: 'rejected', code: 'CLIENT_ID_IN_USE', retryable: false });
    });

    it('authorises each operation on its own; one forbidden or invalid operation never blocks the rest', async () => {
      const okId = randomUUID();
      const res = await push('prod', [
        op('sale.create', { items: [{ unit: 'CARTON', quantity: 1 }] }), // production staff may not sell
        op('production.create', { coopId: coop2, shift: 'MORNING', entries: [{ unit: 'CRATE', quantity: 10 }] }, okId),
        op('expense.create', { categoryCode: 'FEED', description: 'Corn', total: '100' }),
        op('production.create', { coopId: coop2, shift: 'EVENING', entries: [{ unit: 'EGG', quantity: -5 }] }),
      ]).expect(200);
      expect(results(res)).toEqual(['rejected', 'accepted', 'rejected', 'rejected']);
      expect(res.body.results.map((r: { code?: string }) => r.code)).toEqual(['FORBIDDEN', undefined, 'FORBIDDEN', 'VALIDATION']);
      expect(res.body.results[3].message).toMatch(/quantity/i);
      expect(await prisma.productionRecord.count({ where: { clientId: okId } })).toBe(1);
    });

    it('rejects client-supplied totals, prices, unknown fields and impossible values with actionable messages', async () => {
      const res = await push('sales', [
        op('sale.create', { items: [{ unit: 'CARTON', quantity: 1 }], total: '1.00' }),
        op('sale.create', { items: [{ unit: 'CARTON', quantity: 1, unitPrice: '1' }] }),
        op('sale.create', { items: [{ unit: 'PALLET', quantity: 1 }] }),
        op('sale.create', { items: [{ unit: 'CARTON', quantity: 1 }], saleDate: '2999-01-01' }),
        op('sale.create', { items: [{ unit: 'CARTON', quantity: 1 }], createdById: users.admin.id }),
        op('customer.create', { name: 'X' }),
      ]).expect(200);
      expect(results(res)).toEqual(['rejected', 'rejected', 'rejected', 'rejected', 'rejected', 'rejected']);
      expect(res.body.results.slice(0, 3).map((r: { code: string }) => r.code)).toEqual(['VALIDATION', 'VALIDATION', 'VALIDATION']);
      expect(res.body.results[3].message).toMatch(/future/i);
    });

    it('ignores a client id inside the payload: the operation id is the only idempotency key', async () => {
      const opId = randomUUID(); const other = randomUUID();
      const res = await push('prod', [op('production.create', { clientId: other, coopId: coop1, shift: 'AFTERNOON', productionDate: daysAgo(2), entries: [{ unit: 'EGG', quantity: 30 }] }, opId)]).expect(200);
      expect(res.body.results[0].status).toBe('accepted');
      expect(await prisma.productionRecord.count({ where: { clientId: opId } })).toBe(1);
      expect(await prisma.productionRecord.count({ where: { clientId: other } })).toBe(0);
    });

    it('reports a stock conflict with details, creates nothing, and accepts the same operation once stock exists', async () => {
      const saleId = randomUUID();
      const before = { sales: await prisma.sale.count(), stock: await stock() };
      const big = op('sale.create', { items: [{ unit: 'CARTON', quantity: 5000 }] }, saleId);
      const r1 = (await push('sales', [big]).expect(200)).body.results[0];
      expect(r1).toMatchObject({ status: 'conflict', code: 'INSUFFICIENT_STOCK', retryable: false });
      expect(r1.detail.requestedEggs).toBe(5000 * 360);
      expect(r1.detail.availableEggs).toBe(before.stock);
      expect({ sales: await prisma.sale.count(), stock: await stock() }).toEqual(before); // nothing partial
      expect((await prisma.syncOperation.findUniqueOrThrow({ where: { clientId: saleId } })).status).toBe('CONFLICT');

      await post('/inventory/adjustments', 'manager', { type: 'ADJUSTMENT', direction: 'INCREASE', unit: 'CARTON', quantity: 5000, reason: 'late stock recorded' }).expect(201);
      const r2 = (await push('sales', [big]).expect(200)).body.results[0];
      expect(r2.status).toBe('accepted');
      const ledger = await prisma.syncOperation.findUniqueOrThrow({ where: { clientId: saleId } });
      expect(ledger).toMatchObject({ status: 'ACCEPTED', attempts: 2 });
    });

    it('detects two devices recording the same coop, date and shift', async () => {
      const a = op('production.create', { coopId: coop1, shift: 'EVENING', productionDate: daysAgo(3), entries: [{ unit: 'CRATE', quantity: 8 }] });
      const b = op('production.create', { coopId: coop1, shift: 'EVENING', productionDate: daysAgo(3), entries: [{ unit: 'CRATE', quantity: 9 }] });
      expect((await push('prod', [a]).expect(200)).body.results[0].status).toBe('accepted');
      const r = (await push('manager', [b]).expect(200)).body.results[0];
      expect(r).toMatchObject({ status: 'conflict', code: 'ALREADY_RECORDED' });
      expect(await prisma.productionRecord.count({ where: { coopId: coop1, productionDate: new Date(`${daysAgo(3)}T00:00:00Z`), status: 'ACTIVE' } })).toBe(1); // nothing overwritten
    });

    it('resolves dependencies by client id and rejects missing or ambiguous ones', async () => {
      const res = await push('sales', [
        op('sale.create', { customerClientId: randomUUID(), items: [{ unit: 'CARTON', quantity: 1 }] }),
        op('sale.create', { customerClientId: c1, customerId: randomUUID(), items: [{ unit: 'CARTON', quantity: 1 }] }),
        op('payment.create', { saleClientId: randomUUID(), amount: '10' }),
      ]).expect(200);
      expect(res.body.results.map((r: { code: string }) => r.code)).toEqual(['DEPENDENCY_MISSING', 'VALIDATION', 'DEPENDENCY_MISSING']);
    });

    it('treats unexpected server failures as retryable errors that are NOT recorded as an outcome', async () => {
      const id = randomUUID();
      const spy = jest.spyOn(ProductionService.prototype, 'create').mockRejectedValueOnce(new Error('connection to database lost: secret-host'));
      const res = await push('prod', [op('production.create', { coopId: coop2, shift: 'AFTERNOON', productionDate: daysAgo(4), entries: [{ unit: 'EGG', quantity: 12 }] }, id)]).expect(200);
      spy.mockRestore();
      expect(res.body.results[0]).toMatchObject({ status: 'error', code: 'SERVER_ERROR', retryable: true });
      expect(JSON.stringify(res.body)).not.toMatch(/secret-host|database lost/); // no internals leak
      expect(await prisma.syncOperation.count({ where: { clientId: id } })).toBe(0);
      const again = await push('prod', [op('production.create', { coopId: coop2, shift: 'AFTERNOON', productionDate: daysAgo(4), entries: [{ unit: 'EGG', quantity: 12 }] }, id)]).expect(200);
      expect(again.body.results[0].status).toBe('accepted');
    });

    it('applies server-side pricing at the sale date, so a price change between "sold offline" and "synced" is handled by the server', async () => {
      await post('/prices', 'admin', { unit: 'CARTON', amount: '1600', reason: 'price change for sync test' }).expect(201);
      const [old, fresh] = [randomUUID(), randomUUID()];
      const res = await push('sales', [op('sale.create', { items: [{ unit: 'CARTON', quantity: 1 }], saleDate: daysAgo(1) }, old), op('sale.create', { items: [{ unit: 'CARTON', quantity: 1 }], saleDate: today() }, fresh)]).expect(200);
      expect(results(res)).toEqual(['accepted', 'accepted']);
      expect((await prisma.sale.findUniqueOrThrow({ where: { clientId: old } })).total.toString()).toBe('1550'); // price in force on the sale date
      expect((await prisma.sale.findUniqueOrThrow({ where: { clientId: fresh } })).total.toString()).toBe('1600');
    });

    it('validates the request envelope', async () => {
      await push('sales', []).expect(400);
      await push('sales', Array.from({ length: 51 }, () => op('customer.create', { name: 'Bulk Customer' }))).expect(400);
      await push('sales', [op('sale.void', { id: randomUUID() })]).expect(400); // voids/corrections are online-only
      await push('sales', [op('inventory.adjust', {})]).expect(400);
      await push('sales', [{ clientId: 'not-a-uuid', type: 'customer.create', payload: { name: 'X Y' } }]).expect(400);
      await push('sales', [{ clientId: randomUUID(), type: 'customer.create' }]).expect(400);
      await push('sales', [op('customer.create', { name: 'Ok Name' })], { isAdmin: true }).expect(400);
      await api(app).post('/v1/sync/push').send({ operations: [] }).expect(401);
    });

    it('audits every push with outcome counts and keeps the audit chain verifiable', async () => {
      const logs = await prisma.auditLog.findMany({ where: { action: 'sync.push' } });
      expect(logs.length).toBeGreaterThan(5);
      expect(logs.some((l) => JSON.stringify(l.after).includes('"conflict":1'))).toBe(true);
      expect(await app.get(AuditService).verifyChain(100_000)).toBeNull();
    });
  });

  // ───────────────────────── /sync/reference ─────────────────────────
  describe('GET /sync/reference', () => {
    const ref = (who: Who, q = '') => api(app).get(`/v1/sync/reference${q}`).set(bearer(users[who].token));

    it('returns only what the role may see, and never financial customer data', async () => {
      const prod = (await ref('prod').expect(200)).body;
      expect(prod.coops.map((c: { name: string }) => c.name)).toEqual(['Coop 1', 'Coop 2']);
      expect(prod.units).toBeDefined();
      for (const k of ['prices', 'customers', 'inventory', 'expenseCategories', 'suppliers']) expect(prod[k]).toBeUndefined();
      const sales = (await ref('sales').expect(200)).body;
      expect(sales.prices).toEqual(expect.arrayContaining([{ unit: 'CARTON', amount: '1600' }]));
      expect(sales.inventory.quantityEggs).toBeGreaterThan(0);
      expect(sales.customers.length).toBeGreaterThan(0);
      expect(sales.coops).toBeUndefined();
      expect(JSON.stringify(sales.customers)).not.toMatch(/credit|outstanding|balance/i);
      expect(sales).toMatchObject({ businessDate: today(), incremental: false });
      const mgr = (await ref('manager').expect(200)).body;
      expect(mgr.expenseCategories.length).toBe(8);
      await api(app).get('/v1/sync/reference').expect(401);
    });

    it('is incremental for customers, with tombstones for removed ones, and validates the cursor', async () => {
      const first = (await ref('sales').expect(200)).body;
      const before = first.customers.length;
      const doomed = await prisma.customer.create({ data: { name: 'Temporary Customer' } });
      const add = (await ref('sales', `?since=${encodeURIComponent(first.cursor)}`).expect(200)).body;
      expect(add.incremental).toBe(true);
      expect(add.customers.map((c: { name: string }) => c.name)).toEqual(['Temporary Customer']);
      await prisma.customer.update({ where: { id: doomed.id }, data: { deletedAt: new Date() } });
      const del = (await ref('sales', `?since=${encodeURIComponent(add.cursor)}`).expect(200)).body;
      expect(del.customers).toEqual([{ id: doomed.id, deleted: true }]);
      expect((await ref('sales').expect(200)).body.customers).toHaveLength(before);
      await ref('sales', '?since=yesterday').expect(400);
    });
  });

  // ───────────────────────── real device engine over real HTTP ─────────────────────────
  describe('device engine ↔ server integration', () => {
    /** Builds a complete device stack for one user: secure store, token manager (real tokens), API client, engine. */
    async function device(who: Who, opts: { drop?: { push?: number }; network?: NetworkMonitor } = {}) {
      const s = await signIn(app, users[who].email, PASSWORD, { 'X-Device-Name': `phone-${who}-${randomUUID().slice(0, 4)}` });
      const store = new MemorySecureStore();
      let dropPushResponses = opts.drop?.push ?? 0;
      const fetchImpl = async (url: string, init?: Parameters<typeof fetch>[1]) => {
        const res = await fetch(url, init as never);
        if (url.endsWith('/v1/sync/push') && dropPushResponses > 0) { dropPushResponses--; await res.text(); throw new TypeError('connection reset'); } // server processed it; the reply never arrives
        return res as never;
      };
      const tokens = new TokenManager(store, baseUrl, fetchImpl as never);
      await tokens.setSession({ accessToken: s.accessToken, refreshToken: s.refreshToken, expiresIn: 900 });
      const client = new ApiClient(baseUrl, tokens, fetchImpl as never);
      const transport = new HttpSyncTransport(client);
      const storage = new MemoryOutboxStorage();
      const network = opts.network ?? new FakeNetwork(false); // starts offline
      const engine = new SyncEngine({ storage, transport, network, deviceId: `dev-${who}`, syncOnEnqueue: false, random: () => 0 });
      return { engine, tokens, client, storage, network: network as FakeNetwork, transport, session: s };
    }

    it('syncs a whole offline working day exactly once: customer → production → sale → expense → payment', async () => {
      const d = await device('manager');
      const before = { stock: await stock(), sales: await prisma.sale.count(), cust: await prisma.customer.count() };
      const cust = await d.engine.enqueue('customer.create', { name: 'Offline Customer' });
      await d.engine.enqueue('production.create', { coopId: coop2, shift: 'EVENING', productionDate: daysAgo(5), entries: [{ unit: 'CARTON', quantity: 2 }] });
      const sale = await d.engine.enqueue('sale.create', { customerClientId: cust.clientId, items: [{ unit: 'CARTON', quantity: 1 }], saleDate: daysAgo(5), amountPaid: '1550' });
      await d.engine.enqueue('expense.create', { categoryCode: 'TRANSPORT', description: 'Fuel', total: '250', expenseDate: daysAgo(5) });
      expect(await d.engine.summary()).toMatchObject({ pending: 4, unsynced: 4 });
      expect(await stock()).toBe(before.stock); // nothing reached the server yet

      d.network.set(true);
      const report = await d.engine.sync();
      expect(report).toMatchObject({ synced: 4, conflicts: 0, rejected: 0 });
      expect(await d.engine.summary()).toMatchObject({ unsynced: 0, synced: 4 });
      expect(await stock()).toBe(before.stock + 720 - 360);
      expect(await prisma.sale.count()).toBe(before.sales + 1);
      expect(await prisma.customer.count()).toBe(before.cust + 1);
      const synced = (await d.engine.list()).find((i) => i.clientId === sale.clientId)!;
      expect((await prisma.sale.findUniqueOrThrow({ where: { id: synced.entityId as string } })).customerId).not.toBeNull(); // dependency resolved
      // a farm manager may not record payments: the server refuses that one operation and the device keeps it visible
      const pay = await d.engine.enqueue('payment.create', { saleClientId: sale.clientId, amount: '10' });
      await d.engine.sync();
      expect((await d.storage.get(pay.clientId))).toMatchObject({ status: 'rejected', lastError: { code: 'FORBIDDEN' } });
    });

    it('survives a LOST RESPONSE: the server recorded everything, the device never heard, and the retry duplicates nothing', async () => {
      const d = await device('sales', { drop: { push: 1 } });
      const before = { stock: await stock(), sales: await prisma.sale.count() };
      await d.engine.enqueue('sale.create', { items: [{ unit: 'CARTON', quantity: 2 }] });
      d.network.set(true);
      const first = await d.engine.sync();
      expect(first.networkFailure).toBe(true);
      expect(await prisma.sale.count()).toBe(before.sales + 1); // the server DID record it
      expect((await d.engine.list())[0].status).toBe('pending'); // …but the device does not know
      const second = await d.engine.sync();
      expect(second.synced).toBe(1);
      expect((await d.engine.list())[0].status).toBe('synced');
      expect(await prisma.sale.count()).toBe(before.sales + 1); // still exactly one
      expect(await stock()).toBe(before.stock - 720); // stock deducted once
    });

    it('holds a stock conflict for a decision and completes it after the missing production is synced', async () => {
      const d = await device('manager');
      const eggs = await stock();
      const cartons = Math.floor(eggs / 360) + 3;
      const s = await d.engine.enqueue('sale.create', { items: [{ unit: 'CARTON', quantity: cartons }], saleDate: daysAgo(2) });
      d.network.set(true);
      await d.engine.sync();
      const held = (await d.storage.get(s.clientId))!;
      expect(held).toMatchObject({ status: 'conflict', lastError: { code: 'INSUFFICIENT_STOCK' } });
      expect(await d.engine.summary()).toMatchObject({ conflict: 1, unsynced: 1 }); // visible, never silently dropped
      await d.engine.sync();
      expect((await d.storage.get(s.clientId))!.status).toBe('conflict'); // not retried on its own

      await d.engine.enqueue('production.create', { coopId: coop1, shift: 'MORNING', productionDate: daysAgo(6), entries: [{ unit: 'CARTON', quantity: 10 }] });
      await d.engine.sync();
      await d.engine.resolve(s.clientId, 'retry');
      const r = await d.engine.sync();
      expect(r.synced).toBe(1);
      expect((await d.storage.get(s.clientId))!.status).toBe('synced');
    });

    it('two phones recording the same shift: one wins, the other is told and must decide (nothing overwritten)', async () => {
      const a = await device('prod'); const b = await device('manager');
      const slot = { coopId: coop2, shift: 'MORNING', productionDate: daysAgo(3) };
      await a.engine.enqueue('production.create', { ...slot, entries: [{ unit: 'CRATE', quantity: 8 }] });
      const mine = await b.engine.enqueue('production.create', { ...slot, entries: [{ unit: 'CRATE', quantity: 9 }] });
      a.network.set(true); b.network.set(true);
      expect((await a.engine.sync()).synced).toBe(1);
      await b.engine.sync();
      expect((await b.storage.get(mine.clientId))).toMatchObject({ status: 'conflict', lastError: { code: 'ALREADY_RECORDED' } });
      const winner = await prisma.productionRecord.findFirstOrThrow({ where: { coopId: coop2, productionDate: new Date(`${slot.productionDate}T00:00:00Z`), status: 'ACTIVE' } });
      expect(winner.totalEggs).toBe(240);
      await b.engine.resolve(mine.clientId, 'discard'); // the manager decides the first entry stands
      expect(await b.engine.summary()).toMatchObject({ unsynced: 0 });
      const log = JSON.parse((await b.storage.getKv('sync.discardLog')) as string);
      expect(log[0].payload.entries[0].quantity).toBe(9); // what was discarded is preserved
    });

    it('refreshes an expired access token once (single-flight) — parallel refreshes would trigger reuse detection and sign the device out', async () => {
      const d = await device('sales');
      await d.tokens.setSession({ accessToken: 'expired-garbage', refreshToken: d.session.refreshToken, expiresIn: 1 });
      await new Promise((r) => setTimeout(r, 1100));
      const calls = await Promise.all(Array.from({ length: 6 }, () => d.client.request<{ serverTime: string }>('GET', '/v1/sync/reference')));
      expect(calls).toHaveLength(6);
      expect(d.tokens.refreshCalls).toBe(1);
      const fresh = await d.tokens.getAccessToken();
      await api(app).get('/v1/auth/me').set(bearer(fresh)).expect(200); // session alive, not revoked by reuse detection
      expect(await prisma.auditLog.count({ where: { action: 'auth.refresh.reuse_detected', userId: users.sales.id } })).toBe(0);
    });

    it('keeps queued work safe when the account is disabled, and delivers it after sign-in is restored', async () => {
      const u = await makeUser(prisma, { roles: ['SALES_STAFF'] });
      const s = await signIn(app, u.email);
      const store = new MemorySecureStore();
      const tokens = new TokenManager(store, baseUrl, fetch as never);
      await tokens.setSession({ accessToken: s.accessToken, refreshToken: s.refreshToken, expiresIn: 900 });
      const engine = new SyncEngine({ storage: new MemoryOutboxStorage(), transport: new HttpSyncTransport(new ApiClient(baseUrl, tokens, fetch as never)), network: new FakeNetwork(true), syncOnEnqueue: false });
      const item = await engine.enqueue('sale.create', { items: [{ unit: 'CARTON', quantity: 1 }] });
      await post(`/users/${u.id}/disable`, 'admin', { reason: 'lost phone and reported' }).expect(200);
      const r = await engine.sync();
      expect(r.skipped).toBe('auth_required');
      expect((await engine.list())[0]).toMatchObject({ clientId: item.clientId, status: 'pending', attempts: 0 }); // safe on the device
      expect(await prisma.sale.count({ where: { createdById: u.id } })).toBe(0);

      await post(`/users/${u.id}/reactivate`, 'admin', { reason: 'phone recovered' }).expect(200);
      const again = (await login(app, u.email).expect(200)).body.tokens;
      await tokens.setSession({ accessToken: again.accessToken, refreshToken: again.refreshToken, expiresIn: 900 });
      expect((await engine.resumeAfterLogin()).synced).toBe(1);
      expect(await prisma.sale.count({ where: { createdById: u.id } })).toBe(1);
    });

    it('keeps the offline reference cache usable and refreshes it incrementally from the server', async () => {
      const d = await device('sales');
      const cache = new ReferenceCache(d.storage, d.transport);
      d.network.set(true);
      const first = await cache.refresh();
      expect(first.prices?.find((p) => p.unit === 'CARTON')?.amount).toBe('1600');
      await prisma.customer.create({ data: { name: 'Zed New Customer' } });
      const second = await cache.refresh();
      expect(second.customers.some((c) => c.name === 'Zed New Customer')).toBe(true);
      expect(second.customers.length).toBe(first.customers.length + 1);
      const offline = new ReferenceCache(d.storage, { push: d.transport.push.bind(d.transport), reference: async () => { throw new Error('offline'); } });
      await expect(offline.refresh()).rejects.toBeDefined();
      expect((await offline.load())?.customers.length).toBe(second.customers.length); // still usable offline
    });
  });
});
