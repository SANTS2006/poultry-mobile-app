import { INestApplication } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { AuditService } from '../src/audit/audit.service';
import { DomainEvent, DomainEvents } from '../src/domain/events.service';
import { deriveUuid } from '../src/common/derive-uuid';
import { api, bearer, createApp, makeUser, seed, signIn, useIsolatedSchema } from './helpers';

const uuid = () => require('crypto').randomUUID() as string; // eslint-disable-line @typescript-eslint/no-require-imports
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

describe('Core operations: production, inventory, sales, customers, payments, expenses (e2e, real PostgreSQL)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let events: DomainEvent[];
  let farmId: string;
  let coop1: string;
  let coop2: string;
  const tok: Record<'admin' | 'owner' | 'manager' | 'prod' | 'sales' | 'acct', string> = { admin: '', owner: '', manager: '', prod: '', sales: '', acct: '' };
  const ids: Record<string, string> = {};

  const post = (path: string, who: keyof typeof tok, body?: object) => api(app).post(`/v1${path}`).set(bearer(tok[who])).send(body);
  const get = (path: string, who: keyof typeof tok) => api(app).get(`/v1${path}`).set(bearer(tok[who]));
  const patch = (path: string, who: keyof typeof tok, body: object) => api(app).patch(`/v1${path}`).set(bearer(tok[who])).send(body);
  const balance = async () => (await prisma.inventoryBalance.findFirst({ where: { farmId } }))?.quantityEggs ?? 0;
  const ledgerSum = async () => Number((await prisma.$queryRaw<{ s: bigint }[]>`SELECT COALESCE(SUM("quantityEggs"),0)::bigint s FROM "InventoryTransaction" WHERE "farmId" = ${farmId}::uuid`)[0].s);
  // notification.created / sync.completed are follow-on events raised asynchronously by other modules; the guarantees below concern business events
  const business = () => events.filter((e) => !['notification.created', 'sync.completed'].includes(e.name));
  const names = () => business().map((e) => e.name);

  beforeAll(async () => {
    process.env.THROTTLE_OFF = '1';
    await useIsolatedSchema('ops');
    ({ app, prisma } = await createApp());
    await seed(prisma);
    await prisma.role.updateMany({ data: { mfaRequired: false } });
    events = [];
    app.get(DomainEvents).on('*', (e) => events.push(e));

    const farm = await prisma.farm.create({ data: { name: 'Test Farm' } });
    farmId = farm.id;
    coop1 = (await prisma.coop.create({ data: { farmId, name: 'Coop 1' } })).id;
    coop2 = (await prisma.coop.create({ data: { farmId, name: 'Coop 2' } })).id;
    const carton = await prisma.productUnit.findFirstOrThrow({ where: { code: 'CARTON' } });
    await prisma.price.create({ data: { productUnitId: carton.id, amount: new Prisma.Decimal('1550'), effectiveFrom: new Date('2026-01-01T00:00:00Z') } });

    for (const [k, role] of [['admin', 'SUPER_ADMIN'], ['owner', 'OWNER'], ['manager', 'FARM_MANAGER'], ['prod', 'PRODUCTION_STAFF'], ['sales', 'SALES_STAFF'], ['acct', 'ACCOUNTANT']] as const) {
      const u = await makeUser(prisma, { roles: [role], fullName: `${k} user` });
      ids[k] = u.id;
      tok[k] = (await signIn(app, u.email)).accessToken;
    }
    // crate price is NOT defined in the workbook: an administrator sets it
    await post('/prices', 'admin', { unit: 'CRATE', amount: '129.17', reason: 'initial crate price' }).expect(201);
  });
  afterAll(async () => { await prisma.$disconnect(); await app.close(); });

  // ───────────────────────── catalog / prices ─────────────────────────
  describe('catalog and prices', () => {
    it('lists units and coops for production staff, but prices only for those who may see them', async () => {
      const units = (await get('/units', 'prod').expect(200)).body;
      expect(units).toEqual(expect.arrayContaining([{ code: 'CARTON', eggsPerUnit: 360 }, { code: 'CRATE', eggsPerUnit: 30 }, { code: 'EGG', eggsPerUnit: 1 }]));
      expect((await get('/coops', 'prod').expect(200)).body.map((c: { name: string }) => c.name)).toEqual(['Coop 1', 'Coop 2']);
      await get('/products', 'prod').expect(403);
      const products = (await get('/products', 'sales').expect(200)).body;
      const carton = products[0].units.find((u: { code: string }) => u.code === 'CARTON');
      expect(carton.currentPrice).toBe('1550');
      expect(products[0].units.find((u: { code: string }) => u.code === 'EGG').currentPrice).toBeNull();
    });

    it('only price managers can change prices; changes are append-only and audited', async () => {
      await post('/prices', 'sales', { unit: 'CARTON', amount: '1600', reason: 'nice try' }).expect(403);
      await post('/prices', 'manager', { unit: 'CARTON', amount: '1600', reason: 'nice try' }).expect(403);
      await post('/prices', 'admin', { unit: 'CARTON', amount: '15.999', reason: 'bad decimals' }).expect(400);
      await post('/prices', 'admin', { unit: 'CARTON', amount: '0', reason: 'zero price' }).expect(400);
      await post('/prices', 'admin', { unit: 'CARTON', amount: '1550', reason: 'same price again' }).expect(201); // unchanged: no new row
      expect(await prisma.price.count({ where: { productUnit: { code: 'CARTON' } } })).toBe(1);
    });

    it('coop management needs farms.manage', async () => {
      await post('/coops', 'manager', { name: 'Coop X' }).expect(403);
      const c = await post('/coops', 'admin', { name: 'Coop 3' }).expect(201);
      await patch(`/coops/${c.body.id}`, 'admin', { active: false }).expect(200);
      await prisma.coop.update({ where: { id: c.body.id }, data: { deletedAt: new Date() } });
    });
  });

  // ───────────────────────── production ─────────────────────────
  describe('production', () => {
    it('converts units with the database unit table, records the ledger and publishes events after commit', async () => {
      events.length = 0;
      const clientId = uuid();
      const res = await post('/production', 'prod', { coopId: coop1, shift: 'MORNING', entries: [{ unit: 'CARTON', quantity: 1 }, { unit: 'CRATE', quantity: 7 }, { unit: 'EGG', quantity: 0 }], clientId }).expect(201);
      ids.prod1 = res.body.id;
      expect(res.body.totalEggs).toBe(570); // 1×360 + 7×30
      expect(res.body.entries).toEqual(expect.arrayContaining([{ unit: 'CARTON', quantity: 1, baseEggs: 360 }, { unit: 'CRATE', quantity: 7, baseEggs: 210 }]));
      expect(await balance()).toBe(570);
      expect(await ledgerSum()).toBe(570);
      const tx = await prisma.inventoryTransaction.findFirstOrThrow({ where: { sourceId: res.body.id } });
      expect(tx).toMatchObject({ type: 'PRODUCTION', quantityEggs: 570, createdById: ids.prod });
      expect(names()).toEqual(['production.created', 'inventory.updated']);
      expect(await prisma.auditLog.count({ where: { action: 'production.created', entityId: res.body.id } })).toBe(1);
    });

    it('is idempotent for offline re-sends and refuses another user re-using a client id', async () => {
      const clientId = uuid();
      const body = { coopId: coop2, shift: 'MORNING', entries: [{ unit: 'CRATE', quantity: 10 }], clientId };
      const first = await post('/production', 'prod', body).expect(201);
      events.length = 0;
      const replay = await post('/production', 'prod', body).expect(200);
      expect(replay.body.id).toBe(first.body.id);
      expect(await prisma.productionRecord.count({ where: { clientId } })).toBe(1);
      expect(await balance()).toBe(570 + 300);
      expect(business()).toEqual([]); // a replay publishes nothing
      await post('/production', 'manager', body).expect(409);
      ids.prod2 = first.body.id;
    });

    it('rejects a second record for the same coop, date and shift, but allows another shift', async () => {
      await post('/production', 'prod', { coopId: coop1, shift: 'MORNING', entries: [{ unit: 'EGG', quantity: 5 }] }).expect(409);
      await post('/production', 'prod', { coopId: coop1, shift: 'AFTERNOON', entries: [{ unit: 'EGG', quantity: 30 }] }).expect(201);
    });

    it('validates input (negative, unknown unit, duplicates, limits, dates, unknown coop, mass assignment)', async () => {
      const ok = { coopId: coop2, shift: 'EVENING', entries: [{ unit: 'EGG', quantity: 1 }] };
      await post('/production', 'prod', { ...ok, entries: [{ unit: 'EGG', quantity: -1 }] }).expect(400);
      await post('/production', 'prod', { ...ok, entries: [{ unit: 'PALLET', quantity: 1 }] }).expect(400);
      await post('/production', 'prod', { ...ok, entries: [{ unit: 'EGG', quantity: 1.5 }] }).expect(400);
      await post('/production', 'prod', { ...ok, entries: [{ unit: 'EGG', quantity: 1 }, { unit: 'EGG', quantity: 2 }] }).expect(400);
      await post('/production', 'prod', { ...ok, entries: [] }).expect(400);
      await post('/production', 'prod', { ...ok, entries: [{ unit: 'CARTON', quantity: 500 }] }).expect(400); // 180,000 eggs > limit
      await post('/production', 'prod', { ...ok, productionDate: '2999-01-01' }).expect(400);
      await post('/production', 'prod', { ...ok, productionDate: '2026-02-30' }).expect(400);
      await post('/production', 'prod', { ...ok, coopId: uuid() }).expect(400);
      await post('/production', 'prod', { ...ok, shift: 'NIGHT' }).expect(400);
      await post('/production', 'prod', { ...ok, totalEggs: 999_999 }).expect(400); // client cannot dictate totals
      await post('/production', 'prod', { ...ok, recordedById: ids.admin }).expect(400);
      expect(await balance()).toBe(570 + 300 + 30);
    });

    it('enforces permissions and the back-dating rule', async () => {
      await post('/production', 'sales', { coopId: coop1, shift: 'EVENING', entries: [{ unit: 'EGG', quantity: 1 }] }).expect(403);
      await get('/production', 'acct').expect(403);
      await get('/production', 'prod').expect(200);
      const old = { coopId: coop1, shift: 'EVENING', productionDate: daysAgo(10), entries: [{ unit: 'EGG', quantity: 12 }] };
      await post('/production', 'prod', old).expect(403); // older than 7 days needs a manager
      await post('/production', 'manager', old).expect(201);
    });

    it('corrects with optimistic locking: stale versions are refused and only the delta hits the ledger', async () => {
      const before = await balance();
      const rec = (await get(`/production/${ids.prod1}`, 'prod').expect(200)).body;
      await patch(`/production/${ids.prod1}`, 'prod', { entries: [{ unit: 'CARTON', quantity: 2 }], version: rec.version, reason: 'miscounted' }).expect(403);
      await patch(`/production/${ids.prod1}`, 'manager', { entries: [{ unit: 'CARTON', quantity: 2 }], version: rec.version }).expect(400); // reason required
      const fixed = await patch(`/production/${ids.prod1}`, 'manager', { entries: [{ unit: 'CARTON', quantity: 2 }], version: rec.version, reason: 'miscounted cartons' }).expect(200);
      expect(fixed.body).toMatchObject({ totalEggs: 720, version: 2 });
      expect(await balance()).toBe(before + 150);
      const tx = await prisma.inventoryTransaction.findFirstOrThrow({ where: { sourceId: ids.prod1, type: 'CORRECTION' } });
      expect(tx.quantityEggs).toBe(150);
      expect(tx.reason).toBe('miscounted cartons');
      await patch(`/production/${ids.prod1}`, 'manager', { entries: [{ unit: 'CARTON', quantity: 3 }], version: rec.version, reason: 'stale write' }).expect(409);
      const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'production.corrected', entityId: ids.prod1 } });
      expect(JSON.stringify(audit.before)).toContain('570');
      expect(JSON.stringify(audit.after)).toContain('CARTON');
      expect(await ledgerSum()).toBe(await balance());
    });

    it('voids with a reversing ledger entry (delete permission needed) and frees the slot', async () => {
      const before = await balance();
      await post(`/production/${ids.prod2}/void`, 'manager', { reason: 'entered in wrong coop' }).expect(403);
      await post(`/production/${ids.prod2}/void`, 'admin', { reason: 'x' }).expect(400);
      const v = await post(`/production/${ids.prod2}/void`, 'admin', { reason: 'entered in wrong coop' }).expect(200);
      expect(v.body.status).toBe('VOIDED');
      expect(await balance()).toBe(before - 300);
      await post(`/production/${ids.prod2}/void`, 'admin', { reason: 'again again' }).expect(409);
      await patch(`/production/${ids.prod2}`, 'manager', { entries: [{ unit: 'EGG', quantity: 1 }], version: v.body.version, reason: 'edit voided' }).expect(409);
      await post('/production', 'prod', { coopId: coop2, shift: 'MORNING', entries: [{ unit: 'CRATE', quantity: 11 }] }).expect(201);
      expect(await ledgerSum()).toBe(await balance());
    });

    it('lists with server-side pagination and filters', async () => {
      const all = (await get('/production?limit=2&page=1', 'prod').expect(200)).body;
      expect(all.items).toHaveLength(2);
      expect(all.total).toBeGreaterThan(3);
      const c2 = (await get(`/production?coopId=${coop2}&shift=MORNING`, 'prod').expect(200)).body;
      expect(c2.items.every((i: { coop: { id: string }; shift: string }) => i.coop.id === coop2 && i.shift === 'MORNING')).toBe(true);
      const range = (await get(`/production?from=${daysAgo(12)}&to=${daysAgo(8)}`, 'prod').expect(200)).body;
      expect(range.items).toHaveLength(1);
      const voided = (await get('/production?status=VOIDED', 'prod').expect(200)).body;
      expect(voided.items.map((i: { id: string }) => i.id)).toContain(ids.prod2);
      await get('/production?limit=101', 'prod').expect(400);
      await get('/production?from=yesterday', 'prod').expect(400);
    });
  });

  // ───────────────────────── inventory ─────────────────────────
  describe('inventory', () => {
    it('reports the balance with a carton/crate/egg breakdown and a low-stock flag', async () => {
      const inv = (await get('/inventory', 'sales').expect(200)).body;
      const eggs = await balance();
      expect(inv.quantityEggs).toBe(eggs);
      expect(inv.breakdown.cartons * 360 + inv.breakdown.crates * 30 + inv.breakdown.eggs).toBe(eggs);
      expect(inv.lowStock).toBe(eggs < 1000);
      await get('/inventory', 'acct').expect(403);
    });

    it('adjusts stock only with permission, reason and direction; never below zero; idempotently', async () => {
      const start = await balance();
      await post('/inventory/adjustments', 'sales', { type: 'DAMAGE', unit: 'EGG', quantity: 5, reason: 'cracked eggs' }).expect(403);
      await post('/inventory/adjustments', 'manager', { type: 'ADJUSTMENT', unit: 'EGG', quantity: 5, reason: 'recount' }).expect(400); // direction
      await post('/inventory/adjustments', 'manager', { type: 'DAMAGE', direction: 'INCREASE', unit: 'EGG', quantity: 5, reason: 'recount' }).expect(400);
      await post('/inventory/adjustments', 'manager', { type: 'DAMAGE', unit: 'EGG', quantity: 5, reason: 'x' }).expect(400); // reason too short
      const clientId = uuid();
      const dmg = await post('/inventory/adjustments', 'manager', { type: 'DAMAGE', unit: 'CRATE', quantity: 1, reason: 'crate dropped', clientId }).expect(201);
      expect(dmg.body).toMatchObject({ type: 'DAMAGE', quantityEggs: -30, balanceEggs: start - 30 });
      await post('/inventory/adjustments', 'manager', { type: 'DAMAGE', unit: 'CRATE', quantity: 1, reason: 'crate dropped', clientId }).expect(200);
      await post('/inventory/adjustments', 'manager', { type: 'ADJUSTMENT', direction: 'INCREASE', unit: 'CRATE', quantity: 1, reason: 'found one more crate' }).expect(201);
      const before = await ledgerSum();
      const huge = await post('/inventory/adjustments', 'manager', { type: 'LOSS', unit: 'CARTON', quantity: 9000, reason: 'flood loss' }).expect(409);
      expect(huge.body.message).toMatch(/Insufficient stock/);
      expect(await ledgerSum()).toBe(before); // nothing written
      expect(await balance()).toBe(start - 30 + 30);
    });

    it('keeps balance and ledger identical and exposes the transaction history with filters', async () => {
      const rec = (await get('/inventory/reconciliation', 'manager').expect(200)).body;
      expect(rec.consistent).toBe(true);
      const tx = (await get('/inventory/transactions?type=PRODUCTION&limit=5', 'manager').expect(200)).body;
      expect(tx.items.every((t: { type: string; quantityEggs: number }) => t.type === 'PRODUCTION' && t.quantityEggs > 0)).toBe(true);
      await get('/inventory/transactions?type=BOGUS', 'manager').expect(400);
      const one = (await get(`/inventory/transactions/${tx.items[0].id}`, 'manager').expect(200)).body;
      expect(one).toMatchObject({ id: tx.items[0].id, type: 'PRODUCTION' });
      expect(typeof one.balanceAfterEggs).toBe('number');
      await get('/inventory/transactions/00000000-0000-4000-8000-000000000000', 'manager').expect(404);
      await get('/inventory/transactions/not-a-uuid', 'manager').expect(400);
      await expect(prisma.inventoryTransaction.update({ where: { id: tx.items[0].id }, data: { quantityEggs: 1 } })).rejects.toThrow(/append-only/);
    });
  });

  // ───────────────────────── customers ─────────────────────────
  describe('customers', () => {
    it('lets sales staff create customers but not set credit terms; financial data is permission-controlled', async () => {
      const clientId = uuid();
      const c = await post('/customers', 'sales', { name: 'Mama Kadi', phone: '+23276000001', type: 'REGULAR', clientId }).expect(201);
      ids.cust = c.body.id;
      expect(c.body.outstandingBalance).toBeUndefined();
      expect(c.body.creditLimit).toBeUndefined();
      await post('/customers', 'sales', { name: 'Mama Kadi', phone: '+23276000001', type: 'REGULAR', clientId }).expect(200); // replay
      expect(await prisma.customer.count({ where: { clientId } })).toBe(1);
      await post('/customers', 'sales', { name: 'Greedy', creditAllowed: true }).expect(403);
      await post('/customers', 'sales', { name: 'Greedy', creditLimit: '99999' }).expect(403);
      const seen = (await get(`/customers/${ids.cust}`, 'acct').expect(200)).body;
      expect(seen.outstandingBalance).toBe('0');
      expect(seen.creditAllowed).toBe(false);
      await get(`/customers/${ids.cust}/statement`, 'sales').expect(403);
      await get(`/customers/${ids.cust}/statement`, 'acct').expect(200);
      await post('/customers', 'prod', { name: 'Nope' }).expect(403);
      await post('/customers', 'sales', { name: 'X' }).expect(400);
    });

    it('updates with optimistic locking; only financial roles change credit terms', async () => {
      const cur = (await get(`/customers/${ids.cust}`, 'owner').expect(200)).body;
      await patch(`/customers/${ids.cust}`, 'sales', { version: cur.version, phone: '+23276000002' }).expect(200);
      await patch(`/customers/${ids.cust}`, 'sales', { version: cur.version, phone: '+23276000003' }).expect(409); // stale
      await patch(`/customers/${ids.cust}`, 'sales', { version: cur.version + 1, creditAllowed: true }).expect(403);
      await patch(`/customers/${ids.cust}`, 'acct', { version: cur.version + 1, notes: 'x' }).expect(403); // read-only role
      const ok = await patch(`/customers/${ids.cust}`, 'owner', { version: cur.version + 1, creditAllowed: true, creditLimit: '3000.00' }).expect(200);
      expect(ok.body).toMatchObject({ creditAllowed: true, creditLimit: '3000', version: cur.version + 2 });
      await patch(`/customers/${ids.cust}`, 'owner', { version: ok.body.version, creditLimit: '12.345' }).expect(400);
    });

    it('searches and paginates', async () => {
      await post('/customers', 'sales', { name: 'Alhaji Bah', phone: '+23276111111' }).expect(201);
      const r = (await get('/customers?q=kadi', 'sales').expect(200)).body;
      expect(r.items).toHaveLength(1);
      expect((await get('/customers?q=%2B23276111', 'sales').expect(200)).body.items).toHaveLength(1);
      expect((await get('/customers?limit=1', 'sales').expect(200)).body.total).toBeGreaterThan(1);
    });
  });

  // ───────────────────────── sales ─────────────────────────
  describe('sales', () => {
    it('computes everything on the server with the authoritative price (exact decimals) and deducts stock', async () => {
      events.length = 0;
      const stock = await balance();
      const res = await post('/sales', 'sales', { items: [{ unit: 'CARTON', quantity: 2 }, { unit: 'CRATE', quantity: 3 }], clientId: uuid() }).expect(201);
      ids.sale1 = res.body.id;
      expect(res.body.items).toEqual(expect.arrayContaining([
        { unit: 'CARTON', quantity: 2, baseEggs: 720, unitPrice: '1550', lineTotal: '3100' },
        { unit: 'CRATE', quantity: 3, baseEggs: 90, unitPrice: '129.17', lineTotal: '387.51' },
      ]));
      expect(res.body).toMatchObject({ subtotal: '3487.51', total: '3487.51', paidAmount: '3487.51', outstanding: '0', paymentStatus: 'PAID', customer: null });
      expect(res.body.payments).toHaveLength(1);
      expect(await balance()).toBe(stock - 810);
      const tx = await prisma.inventoryTransaction.findFirstOrThrow({ where: { sourceId: res.body.id } });
      expect(tx).toMatchObject({ type: 'SALE', quantityEggs: -810, createdById: ids.sales });
      expect(names()).toEqual(['sale.created', 'inventory.updated', 'payment.created']);
      expect(res.body.number).toMatch(/^S-\d{8}-[0-9A-F]{8}$/);
    });

    it('never accepts client-supplied prices or totals', async () => {
      const item = { unit: 'CARTON', quantity: 1 };
      await post('/sales', 'sales', { items: [{ ...item, unitPrice: '1' }] }).expect(400);
      await post('/sales', 'sales', { items: [item], total: '1.00' }).expect(400);
      await post('/sales', 'sales', { items: [item], subtotal: '1.00' }).expect(400);
      await post('/sales', 'sales', { items: [{ ...item, lineTotal: '1' }] }).expect(400);
      await post('/sales', 'sales', { items: [item], createdById: ids.admin }).expect(400);
    });

    it('validates quantities, units, duplicates and dates', async () => {
      await post('/sales', 'sales', { items: [] }).expect(400);
      await post('/sales', 'sales', { items: [{ unit: 'CARTON', quantity: 0 }] }).expect(400);
      await post('/sales', 'sales', { items: [{ unit: 'CARTON', quantity: 1.5 }] }).expect(400);
      await post('/sales', 'sales', { items: [{ unit: 'BOX', quantity: 1 }] }).expect(400);
      await post('/sales', 'sales', { items: [{ unit: 'CARTON', quantity: 1 }, { unit: 'CARTON', quantity: 1 }] }).expect(400);
      await post('/sales', 'sales', { items: [{ unit: 'CARTON', quantity: 1 }], saleDate: '2999-01-01' }).expect(400);
      await post('/sales', 'sales', { items: [{ unit: 'CARTON', quantity: 1 }], customerId: uuid() }).expect(400);
      await post('/sales', 'sales', { items: [{ unit: 'CARTON', quantity: 1 }], saleDate: daysAgo(40) }).expect(403);
      await post('/sales', 'prod', { items: [{ unit: 'CARTON', quantity: 1 }] }).expect(403);
      await post('/sales', 'acct', { items: [{ unit: 'CARTON', quantity: 1 }] }).expect(403);
    });

    it('refuses to sell a unit that has no price (no guessing)', async () => {
      const r = await post('/sales', 'sales', { items: [{ unit: 'EGG', quantity: 10 }] }).expect(422);
      expect(r.body.message).toMatch(/No price is configured for egg/);
    });

    it('rolls back completely when stock is insufficient: no sale, no payment, no ledger row, no event, no audit', async () => {
      events.length = 0;
      const [sales, pays, ledger, stock, audits] = [await prisma.sale.count(), await prisma.payment.count(), await ledgerSum(), await balance(), await prisma.auditLog.count({ where: { action: 'sale.created' } })];
      const r = await post('/sales', 'sales', { items: [{ unit: 'CARTON', quantity: 5000 }] }).expect(409);
      expect(r.body.message).toMatch(/Insufficient stock/);
      expect([await prisma.sale.count(), await prisma.payment.count(), await ledgerSum(), await balance(), await prisma.auditLog.count({ where: { action: 'sale.created' } })]).toEqual([sales, pays, ledger, stock, audits]);
      expect(business()).toEqual([]);
    });

    it('cannot oversell under concurrency: two simultaneous sales for the last eggs → exactly one succeeds', async () => {
      const stock = await balance();
      // leave exactly 5 cartons' worth (1800 eggs) if possible, then race two 4-carton sales
      const target = 1800;
      if (stock > target) await post('/inventory/adjustments', 'manager', { type: 'LOSS', unit: 'EGG', quantity: stock - target, reason: 'test: set up concurrency scenario' }).expect(201);
      else await post('/inventory/adjustments', 'manager', { type: 'ADJUSTMENT', direction: 'INCREASE', unit: 'EGG', quantity: target - stock, reason: 'test: set up concurrency scenario' }).expect(201);
      const results = await Promise.all([0, 1].map(() => post('/sales', 'sales', { items: [{ unit: 'CARTON', quantity: 4 }], clientId: uuid() })));
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(await balance()).toBe(target - 1440);
      expect(await ledgerSum()).toBe(await balance());
    });

    it('applies credit rules: disabled by default, registered + approved customers only, within the limit', async () => {
      await post('/inventory/adjustments', 'manager', { type: 'ADJUSTMENT', direction: 'INCREASE', unit: 'CARTON', quantity: 30, reason: 'test stock for credit scenarios' }).expect(201);
      const partial = { items: [{ unit: 'CARTON', quantity: 1 }], amountPaid: '500' };
      await post('/sales', 'sales', { ...partial, customerId: ids.cust }).expect(422); // credit not enabled
      await prisma.systemSetting.update({ where: { key: 'sales.creditEnabled' }, data: { value: true } });
      await post('/sales', 'sales', partial).expect(422); // walk-in cannot owe
      const other = (await post('/customers', 'sales', { name: 'No Credit Nora' }).expect(201)).body.id;
      await post('/sales', 'sales', { ...partial, customerId: other }).expect(422); // not approved
      const stock = await balance();
      const s1 = await post('/sales', 'sales', { ...partial, customerId: ids.cust }).expect(201);
      ids.credit1 = s1.body.id;
      expect(s1.body).toMatchObject({ total: '1550', paidAmount: '500', outstanding: '1050', paymentStatus: 'PARTIAL' });
      expect(await balance()).toBe(stock - 360);
      const s2 = await post('/sales', 'sales', { items: [{ unit: 'CARTON', quantity: 1 }], amountPaid: '1550', customerId: ids.cust }).expect(201); // fully paid: no credit needed
      expect(s2.body.paymentStatus).toBe('PAID');
      const unpaid = await post('/sales', 'sales', { items: [{ unit: 'CARTON', quantity: 1 }], amountPaid: '0', customerId: ids.cust }).expect(201);
      ids.credit2 = unpaid.body.id;
      expect(unpaid.body).toMatchObject({ paymentStatus: 'UNPAID', paidAmount: '0' });
      expect(unpaid.body.payments).toHaveLength(0);
      const stockBefore = await balance();
      await post('/sales', 'sales', { items: [{ unit: 'CARTON', quantity: 1 }], amountPaid: '0', customerId: ids.cust }).expect(422); // 2600 owed + 1550 > the 3000 limit
      expect(await balance()).toBe(stockBefore); // refused before touching stock
      await post('/sales', 'sales', { items: [{ unit: 'CARTON', quantity: 1 }], amountPaid: '9999', customerId: ids.cust }).expect(400);
      const owed = (await get(`/customers/${ids.cust}`, 'acct').expect(200)).body.outstandingBalance;
      expect(owed).toBe('2600');
    });

    it('needs owner-level rights (sales.update) for discounts and rejects impossible ones', async () => {
      const body = { items: [{ unit: 'CARTON', quantity: 2 }], discount: '100' };
      await post('/sales', 'sales', body).expect(403);
      await post('/sales', 'manager', body).expect(403); // a farm manager records sales but does not grant discounts
      const ok = await post('/sales', 'owner', body).expect(201);
      expect(ok.body).toMatchObject({ subtotal: '3100', discount: '100', total: '3000' });
      await post('/sales', 'owner', { ...body, discount: '5000' }).expect(400);
      await post('/sales', 'owner', { ...body, discount: '3100' }).expect(400); // zero total
    });

    it('is idempotent for offline re-sends and keeps historical prices when prices change', async () => {
      const clientId = uuid();
      const body = { items: [{ unit: 'CARTON', quantity: 1 }], clientId };
      const first = await post('/sales', 'sales', body).expect(201);
      const stock = await balance();
      events.length = 0;
      const replay = await post('/sales', 'sales', body).expect(200);
      expect(replay.body.id).toBe(first.body.id);
      expect(await prisma.sale.count({ where: { clientId } })).toBe(1);
      expect(await balance()).toBe(stock);
      expect(business()).toEqual([]);
      await post('/sales', 'manager', body).expect(409);

      await post('/prices', 'admin', { unit: 'CARTON', amount: '1600', reason: 'feed cost increase' }).expect(201);
      const later = await post('/sales', 'sales', { items: [{ unit: 'CARTON', quantity: 1 }] }).expect(201);
      expect(later.body.items[0].unitPrice).toBe('1600');
      expect((await get(`/sales/${first.body.id}`, 'sales').expect(200)).body.items[0].unitPrice).toBe('1550'); // history intact
      const back = await post('/sales', 'sales', { items: [{ unit: 'CARTON', quantity: 1 }], saleDate: daysAgo(2) }).expect(201);
      expect(back.body.items[0].unitPrice).toBe('1550'); // price in force on the sale date
      const hist = (await get('/prices?unit=CARTON', 'admin').expect(200)).body;
      expect(hist).toHaveLength(2);
      expect(hist[1].effectiveTo).not.toBeNull();
      expect(await prisma.auditLog.count({ where: { action: 'price.changed' } })).toBeGreaterThanOrEqual(2);
    });

    it('lists and filters with pagination, and hides sales from production staff', async () => {
      const all = (await get('/sales?limit=3', 'acct').expect(200)).body;
      expect(all.items).toHaveLength(3);
      expect(all.total).toBeGreaterThan(5);
      const partial = (await get('/sales?paymentStatus=PARTIAL', 'acct').expect(200)).body;
      expect(partial.items.every((s: { paymentStatus: string }) => s.paymentStatus === 'PARTIAL')).toBe(true);
      const cust = (await get(`/sales?customerId=${ids.cust}`, 'sales').expect(200)).body;
      expect(cust.items.every((s: { customer: { id: string } }) => s.customer.id === ids.cust)).toBe(true);
      expect((await get('/sales?walkIn=true', 'sales').expect(200)).body.items.every((s: { customer: unknown }) => s.customer === null)).toBe(true);
      expect((await get(`/sales?from=${today()}&to=${today()}`, 'sales').expect(200)).body.total).toBeGreaterThan(0);
      await get('/sales', 'prod').expect(403);
      await get('/sales?paymentStatus=WEIRD', 'sales').expect(400);
    });

    it('voids with a reason: stock returns via a correction, payments are voided, financial history is kept', async () => {
      const stock = await balance();
      const sale = (await get(`/sales/${ids.sale1}`, 'sales').expect(200)).body;
      await post(`/sales/${ids.sale1}/void`, 'sales', { reason: 'customer returned goods' }).expect(403);
      await post(`/sales/${ids.sale1}/void`, 'admin', { reason: 'x' }).expect(400);
      const v = await post(`/sales/${ids.sale1}/void`, 'admin', { reason: 'customer returned goods' }).expect(200);
      expect(v.body.status).toBe('VOIDED');
      expect(v.body.payments.every((p: { status: string }) => p.status === 'VOIDED')).toBe(true);
      expect(await balance()).toBe(stock + 810);
      const corr = await prisma.inventoryTransaction.findFirstOrThrow({ where: { sourceId: ids.sale1, type: 'CORRECTION' } });
      expect(corr.quantityEggs).toBe(810);
      await post(`/sales/${ids.sale1}/void`, 'admin', { reason: 'again again' }).expect(409);
      expect(await prisma.sale.count({ where: { id: ids.sale1 } })).toBe(1); // still there
      expect(sale.total).toBe('3487.51');
      expect((await get('/sales?status=VOIDED', 'acct').expect(200)).body.items.map((s: { id: string }) => s.id)).toContain(ids.sale1);
      expect(await ledgerSum()).toBe(await balance());
    });
  });

  // ───────────────────────── payments ─────────────────────────
  describe('payments', () => {
    it('pays a sale in instalments, never above what is outstanding', async () => {
      events.length = 0;
      const p1 = await post('/payments', 'sales', { saleId: ids.credit1, amount: '300.50', method: 'MOBILE_MONEY' }).expect(201);
      expect(p1.body.allocations).toEqual([expect.objectContaining({ saleId: ids.credit1, amount: '300.5' })]);
      expect(await prisma.sale.findUniqueOrThrow({ where: { id: ids.credit1 } })).toMatchObject({ paymentStatus: 'PARTIAL' });
      expect(names()).toEqual(['payment.created', 'sale.updated']);
      await post('/payments', 'sales', { saleId: ids.credit1, amount: '749.51' }).expect(400); // 1 cent too much (750.5 outstanding... 1050-300.50)
      const p2 = await post('/payments', 'acct', { saleId: ids.credit1, amount: '749.50' }).expect(201);
      expect(p2.body.payments[0].amount).toBe('749.5');
      const s = await prisma.sale.findUniqueOrThrow({ where: { id: ids.credit1 } });
      expect(s.paymentStatus).toBe('PAID');
      expect(s.paidAmount.toString()).toBe('1550');
      await post('/payments', 'acct', { saleId: ids.credit1, amount: '0.01' }).expect(400); // nothing left
    });

    it('validates the request shape and permissions', async () => {
      await post('/payments', 'acct', { amount: '10' }).expect(400); // neither target
      await post('/payments', 'acct', { saleId: ids.credit2, customerId: ids.cust, amount: '10' }).expect(400); // both
      await post('/payments', 'acct', { saleId: ids.credit2, amount: '-5' }).expect(400);
      await post('/payments', 'acct', { saleId: ids.credit2, amount: '0' }).expect(400);
      await post('/payments', 'acct', { saleId: ids.credit2, amount: '1.005' }).expect(400);
      await post('/payments', 'acct', { saleId: uuid(), amount: '5' }).expect(404);
      await post('/payments', 'prod', { saleId: ids.credit2, amount: '5' }).expect(403);
      await post('/payments', 'acct', { saleId: ids.credit2, amount: '5', received: 'me' }).expect(400);
      await get('/payments', 'prod').expect(403);
    });

    it('allocates a customer payment to the oldest unpaid sales first', async () => {
      // credit2 (1550 unpaid) + a fresh partial sale
      const s3r = await post('/sales', 'sales', { items: [{ unit: 'CARTON', quantity: 1 }], amountPaid: '1000', customerId: ids.cust }); if (s3r.status !== 201) throw new Error(JSON.stringify(s3r.body)); const s3 = s3r.body;
      const clientId = uuid();
      const res = await post('/payments', 'acct', { customerId: ids.cust, amount: '1800', clientId }).expect(201);
      expect(res.body.allocations.map((a: { saleId: string; amount: string }) => [a.saleId, a.amount])).toEqual([[ids.credit2, '1550'], [s3.id, '250']]);
      expect(await prisma.sale.findUniqueOrThrow({ where: { id: ids.credit2 } })).toMatchObject({ paymentStatus: 'PAID' });
      expect(await prisma.sale.findUniqueOrThrow({ where: { id: s3.id } })).toMatchObject({ paymentStatus: 'PARTIAL' });
      // replay is idempotent
      const again = await post('/payments', 'acct', { customerId: ids.cust, amount: '1800', clientId }).expect(200);
      expect(again.body.allocations).toHaveLength(2);
      expect(await prisma.payment.count({ where: { clientId: { in: [deriveUuid(clientId, 0), deriveUuid(clientId, 1)] } } })).toBe(2); // one row per allocated sale, none duplicated by the replay
      const owed = (await get(`/customers/${ids.cust}`, 'acct').expect(200)).body.outstandingBalance;
      expect(owed).toBe('350'); // s3 was sold at the new 1600 price: 1600-1000-250
      await post('/payments', 'acct', { customerId: ids.cust, amount: '350.01' }).expect(400); // more than owed
      ids.sale3 = s3.id;
    });

    it('cannot be overpaid by concurrent cashiers (row locks)', async () => {
      const results = await Promise.all([0, 1, 2].map(() => post('/payments', 'acct', { saleId: ids.sale3, amount: '350' })));
      expect(results.map((r) => r.status).sort()).toEqual([201, 400, 400]);
      const s = await prisma.sale.findUniqueOrThrow({ where: { id: ids.sale3 } });
      expect(s.paidAmount.toString()).toBe('1600');
    });

    it('voids a payment (restricted, reason required) and restores the outstanding amount', async () => {
      const pay = await prisma.payment.findFirstOrThrow({ where: { saleId: ids.credit1, status: 'ACTIVE' }, orderBy: { paidAt: 'desc' } });
      await post(`/payments/${pay.id}/void`, 'acct', { reason: 'entered twice by mistake' }).expect(403);
      const v = await post(`/payments/${pay.id}/void`, 'admin', { reason: 'entered twice by mistake' }).expect(200);
      expect(v.body.status).toBe('VOIDED');
      const s = await prisma.sale.findUniqueOrThrow({ where: { id: ids.credit1 } });
      expect(s.paymentStatus).toBe('PARTIAL');
      expect(s.paidAmount.plus(pay.amount).toString()).toBe('1550');
      await post(`/payments/${pay.id}/void`, 'admin', { reason: 'again again' }).expect(409);
    });

    it('lists payments with filters', async () => {
      const r = (await get(`/payments?saleId=${ids.credit1}`, 'acct').expect(200)).body;
      expect(r.items.every((p: { saleId: string }) => p.saleId === ids.credit1)).toBe(true);
      expect((await get('/payments?method=MOBILE_MONEY', 'acct').expect(200)).body.items.length).toBeGreaterThan(0);
    });
  });

  // ───────────────────────── expenses ─────────────────────────
  describe('expenses', () => {
    const base = { categoryCode: 'FEED', description: 'Concentrate', expenseDate: today() };

    it('computes the total on the server from quantity × unit cost and rejects disagreement', async () => {
      const r = await post('/expenses', 'manager', { ...base, quantity: '8', unitCost: '1400.00', clientId: uuid() }).expect(201);
      ids.exp1 = r.body.id;
      expect(r.body).toMatchObject({ total: '11200', quantity: '8', unitCost: '1400', category: { code: 'FEED' }, needsReview: false });
      await post('/expenses', 'manager', { ...base, quantity: '8', unitCost: '1400', total: '11200' }).expect(201);
      await post('/expenses', 'manager', { ...base, quantity: '8', unitCost: '1400', total: '11000' }).expect(400);
      await post('/expenses', 'manager', { ...base, quantity: '8' }).expect(400);
      await post('/expenses', 'manager', base).expect(400);
      await post('/expenses', 'manager', { ...base, total: '0' }).expect(400);
      await post('/expenses', 'manager', { ...base, total: '-5' }).expect(400);
      const frac = await post('/expenses', 'manager', { ...base, quantity: '2.5', unitCost: '333.33' }).expect(201);
      expect(frac.body.total).toBe('833.33'); // 833.325 rounded to cents, exactly
    });

    it('validates category, supplier, dates and mass assignment', async () => {
      await post('/expenses', 'manager', { ...base, total: '100', categoryCode: 'NOPE' }).expect(400);
      await post('/expenses', 'manager', { ...base, total: '100', supplierId: uuid() }).expect(400);
      await post('/expenses', 'manager', { ...base, total: '100', expenseDate: '2999-01-01' }).expect(400);
      await post('/expenses', 'manager', { ...base, total: '100', expenseDate: daysAgo(200) }).expect(403);
      await post('/expenses', 'manager', { ...base, total: '100', status: 'VOIDED' }).expect(400);
      await post('/expenses', 'manager', { ...base, total: '100', needsReview: true }).expect(400);
    });

    it('enforces who may record and who may read financial data', async () => {
      await post('/expenses', 'sales', { ...base, total: '100' }).expect(403);
      await post('/expenses', 'prod', { ...base, total: '100' }).expect(403);
      await post('/expenses', 'acct', { ...base, total: '100' }).expect(403); // finance reads, does not record
      await get('/expenses', 'acct').expect(200);
      await get('/expenses', 'manager').expect(200);
      await get('/expenses', 'prod').expect(403);
      await get('/expenses', 'sales').expect(403);
      await get('/expense-categories', 'manager').expect(200);
    });

    it('supports suppliers and links expenses to them', async () => {
      await post('/suppliers', 'manager', { name: 'Mr Ibrahim' }).expect(403);
      const s = await post('/suppliers', 'owner', { name: 'Mr Ibrahim', phone: '+23278000000' }).expect(201);
      await get('/suppliers', 'manager').expect(200);
      const e = await post('/expenses', 'manager', { ...base, categoryCode: 'FEED', description: 'Corn', total: '15000', supplierId: s.body.id }).expect(201);
      expect(e.body.supplier).toEqual({ id: s.body.id, name: 'Mr Ibrahim' });
      await patch(`/suppliers/${s.body.id}`, 'owner', { active: false }).expect(200);
      await post('/expenses', 'manager', { ...base, total: '100', supplierId: s.body.id }).expect(400); // inactive supplier
    });

    it('is idempotent for offline re-sends', async () => {
      const clientId = uuid();
      const body = { ...base, description: 'Diesel', total: '155', categoryCode: 'UTILITIES', clientId };
      const a = await post('/expenses', 'manager', body).expect(201);
      const b = await post('/expenses', 'manager', body).expect(200);
      expect(b.body.id).toBe(a.body.id);
      expect(await prisma.expense.count({ where: { clientId } })).toBe(1);
      await post('/expenses', 'owner', body).expect(409);
    });

    it('edits with reason + version, clears the review flag, audits before/after; stale writes are refused', async () => {
      const imported = await prisma.expense.create({ data: { farmId, categoryId: (await prisma.expenseCategory.findFirstOrThrow({ where: { code: 'MISC' } })).id, description: 'Abu Kamara', total: new Prisma.Decimal('5000'), expenseDate: new Date(`${today()}T00:00:00Z`), needsReview: true } });
      await patch(`/expenses/${imported.id}`, 'manager', { version: 1, description: 'x' }).expect(403);
      await patch(`/expenses/${imported.id}`, 'owner', { version: 1, categoryCode: 'LABOUR' }).expect(400); // reason
      const fixed = await patch(`/expenses/${imported.id}`, 'owner', { version: 1, categoryCode: 'LABOUR', description: 'Abu Kamara (wages)', reason: 'confirmed as wages with the owner' }).expect(200);
      expect(fixed.body).toMatchObject({ category: { code: 'LABOUR' }, needsReview: false, version: 2, total: '5000' });
      await patch(`/expenses/${imported.id}`, 'owner', { version: 1, total: '6000', reason: 'stale attempt' }).expect(409);
      const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'expense.updated', entityId: imported.id } });
      expect(JSON.stringify(log.before)).toContain('MISC');
      expect(JSON.stringify(log.after)).toContain('LABOUR');
      expect(log.reason).toBe('confirmed as wages with the owner');
      const changed = await patch(`/expenses/${imported.id}`, 'owner', { version: 2, quantity: '4', unitCost: '1250', reason: 'recalculated' }).expect(200);
      expect(changed.body.total).toBe('5000');
    });

    it('voids instead of deleting, hides voided rows by default, and totals the filtered list exactly', async () => {
      await post(`/expenses/${ids.exp1}/void`, 'manager', { reason: 'duplicate entry' }).expect(403);
      await post(`/expenses/${ids.exp1}/void`, 'owner', { reason: 'x' }).expect(400);
      const v = await post(`/expenses/${ids.exp1}/void`, 'owner', { reason: 'duplicate entry' }).expect(200);
      expect(v.body.status).toBe('VOIDED');
      expect(await prisma.expense.count({ where: { id: ids.exp1 } })).toBe(1);
      await post(`/expenses/${ids.exp1}/void`, 'owner', { reason: 'again again' }).expect(409);
      await patch(`/expenses/${ids.exp1}`, 'owner', { version: v.body.version, description: 'edit voided', reason: 'edit voided' }).expect(409);
      const listed = (await get('/expenses?categoryCode=FEED', 'acct').expect(200)).body;
      expect(listed.items.some((e: { id: string }) => e.id === ids.exp1)).toBe(false);
      const sum = listed.items.reduce((a: Prisma.Decimal, e: { total: string }) => a.plus(e.total), new Prisma.Decimal(0));
      expect(listed.totalAmount).toBe(sum.toString());
      expect((await get('/expenses?status=VOIDED', 'acct').expect(200)).body.items.map((e: { id: string }) => e.id)).toContain(ids.exp1);
      expect((await get('/expenses?needsReview=true', 'acct').expect(200)).body.items.every((e: { needsReview: boolean }) => e.needsReview)).toBe(true);
      expect((await get('/expenses?q=diesel', 'acct').expect(200)).body.items).toHaveLength(1);
    });
  });

  // ───────────────────────── cross-cutting ─────────────────────────
  describe('integrity', () => {
    it('keeps the cached balance equal to the ledger after every operation above', async () => {
      expect((await get('/inventory/reconciliation', 'owner').expect(200)).body.consistent).toBe(true);
      const bal = await prisma.inventoryBalance.findFirstOrThrow({ where: { farmId } });
      expect(bal.quantityEggs).toBeGreaterThanOrEqual(0);
    });

    it('reconciles money: Σ paid on active sales = Σ active payments', async () => {
      const sales = await prisma.sale.aggregate({ where: { status: 'ACTIVE' }, _sum: { paidAmount: true } });
      const pays = await prisma.payment.aggregate({ where: { status: 'ACTIVE', sale: { status: 'ACTIVE' } }, _sum: { amount: true } });
      expect(sales._sum.paidAmount!.toString()).toBe(pays._sum.amount!.toString());
      const bad = await prisma.$queryRaw<{ id: string }[]>`SELECT s.id FROM "Sale" s WHERE s.status = 'ACTIVE' AND s."paidAmount" <> COALESCE((SELECT SUM(p.amount) FROM "Payment" p WHERE p."saleId" = s.id AND p.status = 'ACTIVE'), 0)`;
      expect(bad).toEqual([]);
    });

    it('produced a verifiable audit trail for every mutation', async () => {
      expect(await app.get(AuditService).verifyChain(100_000)).toBeNull();
      const actions = (await prisma.auditLog.findMany({ select: { action: true } })).map((a) => a.action);
      for (const a of ['production.created', 'production.corrected', 'production.voided', 'sale.created', 'sale.voided', 'payment.created', 'payment.voided', 'expense.created', 'expense.updated', 'expense.voided', 'customer.created', 'customer.updated', 'price.changed', 'inventory.damage']) {
        expect(actions).toContain(a);
      }
    });
  });
});
