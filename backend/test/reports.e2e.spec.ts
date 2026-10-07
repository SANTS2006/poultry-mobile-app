import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { InventoryService } from '../src/inventory/inventory.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { api, bearer, createApp, makeUser, seed, signIn, useIsolatedSchema } from './helpers';
import { extractPdfText } from './pdf-text';

type Who = 'admin' | 'owner' | 'manager' | 'prod' | 'sales' | 'acct';
const R = { from: '2026-06-01', to: '2026-06-30' };

/** Minimal RFC-4180 parser so the CSV the API produces is read back the way a spreadsheet would read it. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\r' && text[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; }
    else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

describe('Reports and exports (e2e, real PostgreSQL)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let farmId: string;
  const tok = {} as Record<Who, string>;
  const ids: Record<string, string> = {};

  const post = (path: string, who: Who, body?: object) => api(app).post(`/v1${path}`).set(bearer(tok[who])).send(body);
  const rep = (name: string, who: Who, q: Record<string, string | boolean> = {}) => api(app).get(`/v1/reports/${name}`).query({ ...R, ...q }).set(bearer(tok[who]));
  const exp = (name: string, who: Who, q: Record<string, string> = {}) =>
    api(app).get(`/v1/reports/${name}/export`).query({ ...R, ...q }).set(bearer(tok[who])).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
  const tableOf = (body: { tables: { name: string; rows: Record<string, unknown>[]; totals?: Record<string, unknown> }[] }, name: string) => body.tables.find((t) => t.name === name)!;

  beforeAll(async () => {
    process.env.THROTTLE_OFF = '1';
    await useIsolatedSchema('rep');
    ({ app, prisma } = await createApp());
    await seed(prisma);
    await prisma.role.updateMany({ data: { mfaRequired: false } });
    farmId = (await prisma.farm.create({ data: { name: 'Report Farm' } })).id;
    ids.coop1 = (await prisma.coop.create({ data: { farmId, name: 'Coop 1' } })).id;
    ids.coop2 = (await prisma.coop.create({ data: { farmId, name: 'Coop 2' } })).id;
    for (const [code, amount] of [['CARTON', '1550'], ['CRATE', '129.17']] as const) {
      const unit = await prisma.productUnit.findFirstOrThrow({ where: { code } });
      await prisma.price.create({ data: { productUnitId: unit.id, amount, effectiveFrom: new Date('2026-01-01T00:00:00Z') } });
    }
    await prisma.systemSetting.update({ where: { key: 'sales.creditEnabled' }, data: { value: true } });
    for (const [k, role] of [['admin', 'SUPER_ADMIN'], ['owner', 'OWNER'], ['manager', 'FARM_MANAGER'], ['prod', 'PRODUCTION_STAFF'], ['sales', 'SALES_STAFF'], ['acct', 'ACCOUNTANT']] as const) {
      const u = await makeUser(prisma, { roles: [role], fullName: `${k} user` });
      ids[k] = u.id;
      tok[k] = (await signIn(app, u.email)).accessToken;
    }

    // opening stock 1 June (the workbook has none; the ledger needs it before sales can be recorded)
    const egg = await prisma.productUnit.findFirstOrThrow({ where: { code: 'EGG' } });
    await app.get(PrismaService).$transaction((tx) => app.get(InventoryService).post(tx, {
      farmId, productId: egg.productId, type: 'OPENING', quantityEggs: 5000, occurredAt: new Date('2026-06-01T12:00:00Z'), reason: 'opening stock',
    }));

    // production (owner may back-date)
    const prodRec = (productionDate: string, coopId: string, shift: string, quantity: number) =>
      post('/production', 'owner', { productionDate, coopId, shift, entries: [{ unit: 'EGG', quantity }] }).expect(201);
    await prodRec('2026-06-15', ids.coop1, 'MORNING', 570);
    await prodRec('2026-06-15', ids.coop2, 'MORNING', 300);
    await prodRec('2026-06-16', ids.coop1, 'MORNING', 360);
    await prodRec('2026-06-16', ids.coop1, 'EVENING', 30);
    await prodRec('2026-06-22', ids.coop2, 'EVENING', 90);
    await prodRec('2026-06-30', ids.coop1, 'MORNING', 720);
    const wrong = await prodRec('2026-06-18', ids.coop2, 'MORNING', 1000);
    await post(`/production/${wrong.body.id}/void`, 'admin', { reason: 'entered in the wrong period' }).expect(200);

    // customers, sales
    ids.kadi = (await post('/customers', 'owner', { name: 'Mama Kadi', type: 'REGULAR', creditAllowed: true, creditLimit: '5000' }).expect(201)).body.id;
    const sale = (saleDate: string, items: object[], extra: object = {}) => post('/sales', 'owner', { saleDate, items, ...extra }).expect(201);
    await sale('2026-06-15', [{ unit: 'CARTON', quantity: 2 }]);
    ids.saleB = (await sale('2026-06-16', [{ unit: 'CARTON', quantity: 1 }], { customerId: ids.kadi, amountPaid: '500' })).body.id;
    await sale('2026-06-22', [{ unit: 'CRATE', quantity: 3 }]);
    ids.saleD = (await sale('2026-06-25', [{ unit: 'CRATE', quantity: 14 }], { customerId: ids.kadi, amountPaid: '0' })).body.id;
    await sale('2026-06-30', [{ unit: 'CARTON', quantity: 1 }], { discount: '50' });
    const gone = await sale('2026-06-20', [{ unit: 'CARTON', quantity: 1 }]);
    await post(`/sales/${gone.body.id}/void`, 'admin', { reason: 'customer returned the goods' }).expect(200);

    // a later collection against the unpaid sale, then make every payment fall on its business date
    await post('/payments', 'owner', { saleId: ids.saleD, amount: '400' }).expect(201);
    await prisma.$executeRawUnsafe(`UPDATE "Payment" p SET "paidAt" = s."saleDate" + interval '12 hours' FROM "Sale" s WHERE p."saleId" = s.id`);
    await prisma.$executeRawUnsafe(`UPDATE "Payment" SET "paidAt" = '2026-06-25T12:00:00Z' WHERE "saleId" = '${ids.saleD}' AND amount = 400`);

    // expenses
    ids.supplier = (await post('/suppliers', 'admin', { name: 'Feed Mill' }).expect(201)).body.id;
    const exps = (expenseDate: string, b: object) => post('/expenses', 'owner', { expenseDate, ...b }).expect(201);
    await exps('2026-06-10', { categoryCode: 'FEED', description: 'Concentrate', quantity: '8', unitCost: '1400', supplierId: ids.supplier });
    await exps('2026-06-12', { categoryCode: 'TRANSPORT', description: 'Delivery', total: '250' });
    await exps('2026-06-20', { categoryCode: 'FEED', description: 'Corn', total: '40000' });
    await exps('2026-06-28', { categoryCode: 'MISC', description: '=cmd|evil', total: '100' });
    const bad = await exps('2026-06-29', { categoryCode: 'MISC', description: 'typo', total: '999' });
    await post(`/expenses/${bad.body.id}/void`, 'admin', { reason: 'entered twice by mistake' }).expect(200);
  });
  afterAll(async () => { await prisma.$disconnect(); await app.close(); });

  describe('production report', () => {
    it('counts only active records and reports exact totals, splits and best day', async () => {
      const b = (await rep('production', 'manager').expect(200)).body;
      expect(b.summary).toMatchObject({ totalEggs: 2070, recordCount: 6, daysRecorded: 4, bestDay: '2026-06-15', bestDayEggs: 870, averageEggsPerRecordedDay: '517.5' });
      const coops = Object.fromEntries(tableOf(b, 'byCoop').rows.map((r) => [r.coop, r.eggs]));
      expect(coops).toEqual({ 'Coop 1': 1680, 'Coop 2': 390 });
      const shifts = Object.fromEntries(tableOf(b, 'byShift').rows.map((r) => [r.shift, r.eggs]));
      expect(shifts).toMatchObject({ MORNING: 1950, EVENING: 120 });
      expect(b.meta).toMatchObject({ report: 'production', from: R.from, to: R.to, groupBy: 'day' });
    });
    it('shows empty days as zero and week/month buckets add up to the same total', async () => {
      const day = tableOf((await rep('production', 'manager').expect(200)).body, 'trend');
      expect(day.rows).toHaveLength(30);
      const sum = (rows: Record<string, unknown>[]) => rows.reduce((a, r) => a + (r.eggs as number), 0);
      expect(sum(day.rows)).toBe(2070);
      const week = tableOf((await rep('production', 'manager', { groupBy: 'week' }).expect(200)).body, 'trend');
      expect(sum(week.rows)).toBe(2070);
      expect(week.rows.find((r) => r.period === 'Week of 2026-06-15')!.eggs).toBe(1260); // 15 Jun 870 + 16 Jun 390; 22 Jun (a Monday) starts the next week
      const month = tableOf((await rep('production', 'manager', { groupBy: 'month' }).expect(200)).body, 'trend');
      expect(month.rows).toEqual([expect.objectContaining({ period: '2026-06', eggs: 2070 })]);
    });
    it('filters by coop and shift, and includes detail rows only when asked', async () => {
      const f = (await rep('production', 'manager', { coopId: ids.coop2, shift: 'EVENING' }).expect(200)).body;
      expect(f.summary.totalEggs).toBe(90);
      expect(f.tables.some((t: { name: string }) => t.name === 'details')).toBe(false);
      const d = (await rep('production', 'manager', { detail: true }).expect(200)).body;
      expect(tableOf(d, 'details').rows).toHaveLength(6);
    });
  });

  describe('sales report', () => {
    it('reports exact revenue, discounts, credit and excludes voided sales', async () => {
      const b = (await rep('sales', 'owner').expect(200)).body;
      expect(b.summary).toMatchObject({ revenue: '8345.89', salesCount: 5, eggsSold: 1950, discounts: '50.00', paid: '5887.51', outstanding: '2458.38', averageSale: '1669.18' });
      const st = Object.fromEntries(tableOf(b, 'byPaymentStatus').rows.map((r) => [r.status, r.count]));
      expect(st).toEqual({ PAID: 3, PARTIAL: 2 }) // the later 400 collection turned the unpaid sale into a partial one;
    });
    it('filters by customer, walk-in and payment status', async () => {
      expect((await rep('sales', 'owner', { customerId: ids.kadi }).expect(200)).body.summary).toMatchObject({ salesCount: 2, revenue: '3358.38' });
      expect((await rep('sales', 'owner', { walkIn: true }).expect(200)).body.summary).toMatchObject({ salesCount: 3, revenue: '4987.51' });
      expect((await rep('sales', 'owner', { paymentStatus: 'PARTIAL' }).expect(200)).body.summary.salesCount).toBe(2);
      expect((await rep('sales', 'owner', { paymentStatus: 'UNPAID' }).expect(200)).body.summary.salesCount).toBe(0);
    });
    it('hides per-customer balances from anyone without customers.financial', async () => {
      const owner = tableOf((await rep('sales', 'owner').expect(200)).body, 'byCustomer');
      expect(owner.rows.find((r) => r.customer === 'Mama Kadi')).toMatchObject({ paid: '900.00', outstanding: '2458.38' });
      const mgr = await rep('sales', 'manager');
      // a manager may read sales? (sales.read yes) but has no customers.financial
      expect(mgr.status).toBe(200);
      const t = tableOf(mgr.body, 'byCustomer');
      expect(t.rows.every((r) => !('paid' in r) && !('outstanding' in r))).toBe(true);
    });
  });

  describe('expenses report', () => {
    it('sums active expenses only and computes category shares', async () => {
      const b = (await rep('expenses', 'owner').expect(200)).body;
      expect(b.summary).toMatchObject({ total: '51550.00', itemCount: 4, largestCategory: 'Feed', largestCategoryTotal: '51200.00' });
      const feed = tableOf(b, 'byCategory').rows.find((r) => r.category === 'Feed')!;
      expect(feed.share).toBe('99.3');
      expect(tableOf(b, 'bySupplier').rows.find((r) => r.supplier === 'Feed Mill')).toMatchObject({ total: '11200.00' });
    });
  });

  describe('inventory report', () => {
    it('reconciles opening, production, sales and closing from the ledger', async () => {
      const b = (await rep('inventory', 'owner').expect(200)).body;
      expect(b.summary).toMatchObject({ openingEggs: 0, openingStockEnteredEggs: 5000, producedEggs: 3070, soldEggs: 2310, closingEggs: 5760 });
    });
    it('extended to today the closing figure equals the live balance (corrections included)', async () => {
      const b = (await rep('inventory', 'owner', { to: new Date().toISOString().slice(0, 10) }).expect(200)).body;
      const live = (await prisma.inventoryBalance.findFirstOrThrow({ where: { farmId } })).quantityEggs;
      expect(b.summary.closingEggs).toBe(live);
      expect(b.summary.closingMatchesCurrentBalance).toBe(true);
      expect(b.summary.correctionEggs).toBe(-1000 + 360);
    });
  });

  describe('financial report (cash flow, never "profit")', () => {
    it('separates sales value, cash received and expenses with exact decimals', async () => {
      const b = (await rep('financial', 'owner').expect(200)).body;
      expect(b.summary).toMatchObject({ salesValue: '8345.89', cashReceived: '5887.51', expenses: '51550.00', netCashFlow: '-45662.49', salesMinusExpenses: '-43204.11', outstandingCustomerBalancesToday: '2458.38' });
      expect(b.meta.title.toLowerCase()).toContain('cash flow');
      expect(b.meta.notes.join(' ')).toContain('NOT profit');
      expect(JSON.stringify(b).toLowerCase()).not.toMatch(/"[a-z]*profit[a-z]*":/); // no profit-named field
    });
    it('needs sales, expense and payment permissions together; receivables only with customers.financial', async () => {
      await rep('financial', 'manager').expect(403); // no payments.read
      const acct = (await rep('financial', 'acct').expect(200)).body; // sales.read + expenses.read + payments.read
      expect(acct.summary.netCashFlow).toBe('-45662.49');
    });
    it('buckets payments by the business time zone, not UTC', async () => {
      // 12:00 UTC is midnight of the NEXT day in Auckland
      await prisma.systemSetting.update({ where: { key: 'business.timezone' }, data: { value: 'Pacific/Auckland' } });
      try {
        const b = (await rep('financial', 'owner', { from: '2026-06-26', to: '2026-06-26' }).expect(200)).body;
        expect(b.summary.cashReceived).toBe('400.00');
      } finally {
        await prisma.systemSetting.update({ where: { key: 'business.timezone' }, data: { value: 'Africa/Freetown' } });
      }
      const b = (await rep('financial', 'owner', { from: '2026-06-26', to: '2026-06-26' }).expect(200)).body;
      expect(b.summary.cashReceived).toBe('0.00');
    });
  });

  describe('permissions', () => {
    it('requires reports.read for viewing and reports.export for downloading', async () => {
      await rep('production', 'prod').expect(403);
      await rep('sales', 'sales').expect(403);
      for (const name of ['production', 'sales', 'expenses', 'inventory']) {
        await rep(name, 'manager').expect(200); // a manager may view…
        await exp(name, 'manager', { format: 'csv' }).expect(403); // …but not download
        await exp(name, 'manager', { format: 'pdf' }).expect(403);
      }
      await exp('financial', 'manager', { format: 'csv' }).expect(403);
      await exp('sales', 'sales', { format: 'csv' }).expect(403);
      await api(app).get('/v1/reports/production').query(R).expect(401);
    });
    it('never returns data the caller may not otherwise see', async () => {
      await rep('production', 'acct').expect(403); // accountant has no production.read
      await rep('inventory', 'acct').expect(403);
      await rep('sales', 'acct').expect(200);
      await rep('expenses', 'acct').expect(200);
      await exp('production', 'acct', { format: 'csv' }).expect(403);
    });
  });

  describe('validation', () => {
    it('rejects bad, reversed, oversized or unknown parameters', async () => {
      await api(app).get('/v1/reports/sales').set(bearer(tok.owner)).expect(400);
      await rep('sales', 'owner', { from: '2026-06-30', to: '2026-06-01' }).expect(400);
      await rep('sales', 'owner', { from: '2026-02-30' }).expect(400);
      await rep('sales', 'owner', { from: '2025-01-01', to: '2026-06-30' }).expect(400); // > 366 days
      await rep('sales', 'owner', { groupBy: 'year' }).expect(400);
      await rep('sales', 'owner', { customerId: 'not-a-uuid' }).expect(400);
      await rep('sales', 'owner', { farmId: 'x' }).expect(400); // unknown parameter
      await exp('sales', 'owner', { format: 'xlsx' }).expect(400);
      await exp('sales', 'owner', { format: 'csv', table: 'nope' }).expect(400);
    });
  });

  describe('CSV export', () => {
    it('has a BOM, CRLF line ends, exact values and neutralises spreadsheet formulas', async () => {
      const res = await exp('expenses', 'owner', { format: 'csv' }).expect(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['content-disposition']).toContain('makarifor-expenses-2026-06-01_2026-06-30.csv');
      const text = (res.body as Buffer).toString('utf8');
      expect(text.charCodeAt(0)).toBe(0xfeff);
      expect(text).toContain('\r\n');
      const rows = parseCsv(text.slice(1));
      const evil = rows.find((r) => r.some((c) => c.includes('cmd|evil')))!;
      expect(evil.find((c) => c.includes('cmd|evil'))).toBe("'=cmd|evil"); // prefixed, so a spreadsheet shows text instead of running it
      const details = rows.find((r) => r.includes('Corn'))!;
      expect(details).toContain('40000.00');
    });
    it('can export a single table', async () => {
      const res = await exp('production', 'acct', { format: 'csv', table: 'byCoop' });
      expect(res.status).toBe(403); // acct cannot see production at all
      const ok = await exp('production', 'owner', { format: 'csv', table: 'byCoop' }).expect(200);
      const rows = parseCsv((ok.body as Buffer).toString('utf8').slice(1)).filter((r) => r.length > 1 || r[0]);
      expect(rows[0][0]).toBe('By coop');
      expect(rows.some((r) => r[0] === 'Coop 1' && r[1] === '1680')).toBe(true);
      expect(rows.some((r) => r[0] === 'Recorded by' || r[0] === 'Records')).toBe(false); // other tables not included
    });
    it('hides customer balances in exports for users without customers.financial', async () => {
      await prisma.rolePermission.deleteMany({ where: { role: { code: 'ACCOUNTANT' }, permission: { code: 'customers.financial' } } });
      try {
        const u = await makeUser(prisma, { roles: ['ACCOUNTANT'] });
        const t = (await signIn(app, u.email)).accessToken;
        const res = await api(app).get('/v1/reports/sales/export').query({ ...R, format: 'csv' }).set(bearer(t)).expect(200);
        const lines = res.text.split('\r\n');
        expect(lines[lines.indexOf('By customer') + 1]).toBe('Customer,Sales,Revenue (NLe)'); // no Paid / Outstanding columns
        expect(res.text).not.toContain('Outstanding customer balances');
        const fin = (await api(app).get('/v1/reports/financial').query(R).set(bearer(t)).expect(200)).body;
        expect(fin.summary).not.toHaveProperty('outstandingCustomerBalancesToday');
        expect(fin.tables.some((x: { name: string }) => x.name === 'receivables')).toBe(false);
      } finally {
        const p = await prisma.permission.findFirstOrThrow({ where: { code: 'customers.financial' } });
        const r = await prisma.role.findFirstOrThrow({ where: { code: 'ACCOUNTANT' } });
        await prisma.rolePermission.create({ data: { roleId: r.id, permissionId: p.id } });
      }
    });
  });

  describe('PDF export', () => {
    it('produces a real PDF whose text carries the figures, title and caveats', async () => {
      const res = await exp('financial', 'owner', { format: 'pdf' }).expect(200);
      const buf = res.body as Buffer;
      expect(res.headers['content-type']).toContain('application/pdf');
      expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
      const { total, text } = extractPdfText(buf);
      expect(total).toBeGreaterThanOrEqual(1);
      expect(text).toContain('Financial report (cash flow)');
      expect(text).toContain('-45662.49');
      expect(text).toContain('NOT profit');
      expect(text).toContain('owner user'); // who generated it
    });
  });

  describe('audit', () => {
    it('records every export (who, what, range, format) but never the data itself', async () => {
      const before = await prisma.auditLog.count({ where: { action: 'report.exported' } });
      await exp('sales', 'owner', { format: 'csv', paymentStatus: 'UNPAID' }).expect(200);
      const rows = await prisma.auditLog.findMany({ where: { action: 'report.exported' }, orderBy: { seq: 'desc' }, take: 1 });
      expect(await prisma.auditLog.count({ where: { action: 'report.exported' } })).toBe(before + 1);
      expect(rows[0].userId).toBe(ids.owner);
      expect(rows[0].entityId).toBe('sales');
      expect(rows[0].after).toMatchObject({ format: 'csv', from: R.from, to: R.to, filters: { paymentStatus: 'UNPAID' } });
      expect(JSON.stringify(rows[0].after)).not.toContain('Mama Kadi');
      // denied and invalid attempts leave no export record
      await exp('sales', 'sales', { format: 'csv' }).expect(403);
      await exp('sales', 'owner', { format: 'csv', from: '2026-06-30', to: '2026-06-01' }).expect(400);
      expect(await prisma.auditLog.count({ where: { action: 'report.exported' } })).toBe(before + 1);
    });
  });
});
