import { Prisma, PrismaClient } from '@prisma/client';

/** Verifies the hand-written database constraints against a real PostgreSQL instance. */
describe('Database constraints (e2e)', () => {
  const prisma = new PrismaClient();
  const ids: { farm?: string; coop?: string; shift?: string; product?: string; unit?: string } = {};

  beforeAll(async () => {
    const farm = await prisma.farm.create({ data: { name: `T-${Date.now()}` } });
    ids.farm = farm.id;
    ids.coop = (await prisma.coop.create({ data: { farmId: farm.id, name: 'C1' } })).id;
    ids.shift = (await prisma.shift.upsert({ where: { code: 'MORNING' }, update: {}, create: { code: 'MORNING', name: 'Morning', sortOrder: 1 } })).id;
    ids.product = (await prisma.product.upsert({ where: { code: 'TABLE_EGG' }, update: {}, create: { code: 'TABLE_EGG', name: 'Table Egg' } })).id;
    ids.unit = (await prisma.productUnit.upsert({
      where: { productId_code: { productId: ids.product, code: 'CARTON' } }, update: {},
      create: { productId: ids.product, code: 'CARTON', name: 'Carton', eggsPerUnit: 360 },
    })).id;
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  const prod = (over: Partial<Prisma.ProductionRecordUncheckedCreateInput> = {}) =>
    prisma.productionRecord.create({
      data: { farmId: ids.farm!, coopId: ids.coop!, shiftId: ids.shift!, productionDate: new Date('2026-06-17'), totalEggs: 100, ...over },
    });

  it('allows only one ACTIVE production record per coop/date/shift, but voided ones may coexist', async () => {
    const first = await prod();
    await expect(prod()).rejects.toThrow();
    await prisma.productionRecord.update({ where: { id: first.id }, data: { status: 'VOIDED' } });
    await expect(prod()).resolves.toBeDefined();
  });

  it('rejects negative production quantities', async () => {
    await expect(prod({ productionDate: new Date('2026-06-18'), totalEggs: -1 })).rejects.toThrow();
  });

  it('blocks UPDATE and DELETE on the audit log (append-only)', async () => {
    const row = await prisma.auditLog.create({ data: { action: 'test.audit' } });
    await expect(prisma.auditLog.update({ where: { id: row.id }, data: { action: 'tampered' } })).rejects.toThrow(/append-only/);
    await expect(prisma.auditLog.delete({ where: { id: row.id } })).rejects.toThrow(/append-only/);
  });

  it('blocks UPDATE/DELETE on the inventory ledger and enforces sign per type', async () => {
    const base = { farmId: ids.farm!, productId: ids.product!, occurredAt: new Date() };
    const tx = await prisma.inventoryTransaction.create({ data: { ...base, type: 'PRODUCTION', quantityEggs: 500 } });
    await expect(prisma.inventoryTransaction.update({ where: { id: tx.id }, data: { quantityEggs: 1 } })).rejects.toThrow(/append-only/);
    await expect(prisma.inventoryTransaction.delete({ where: { id: tx.id } })).rejects.toThrow(/append-only/);
    await expect(prisma.inventoryTransaction.create({ data: { ...base, type: 'SALE', quantityEggs: 5 } })).rejects.toThrow();
    await expect(prisma.inventoryTransaction.create({ data: { ...base, type: 'PRODUCTION', quantityEggs: -5 } })).rejects.toThrow();
    await expect(prisma.inventoryTransaction.create({ data: { ...base, type: 'ADJUSTMENT', quantityEggs: 0 } })).rejects.toThrow();
  });

  it('prevents negative inventory balances', async () => {
    await expect(prisma.inventoryBalance.create({ data: { farmId: ids.farm!, productId: ids.product!, quantityEggs: -1 } })).rejects.toThrow();
  });

  it('enforces sale arithmetic and payment bounds at the database level', async () => {
    const sale = (o: Partial<Prisma.SaleUncheckedCreateInput>) =>
      prisma.sale.create({
        data: { farmId: ids.farm!, number: `S-${Math.random()}`, saleDate: new Date('2026-06-17'), subtotal: new Prisma.Decimal('6200.00'), total: new Prisma.Decimal('6200.00'), paymentStatus: 'PAID', paidAmount: new Prisma.Decimal('6200.00'), ...o },
      });
    await expect(sale({})).resolves.toBeDefined();
    await expect(sale({ total: new Prisma.Decimal('1.00') })).rejects.toThrow();               // total != subtotal - discount
    await expect(sale({ paidAmount: new Prisma.Decimal('9999.00') })).rejects.toThrow();       // overpaid
    await expect(sale({ subtotal: new Prisma.Decimal('-1'), total: new Prisma.Decimal('-1'), paidAmount: new Prisma.Decimal('0') })).rejects.toThrow();
  });

  it('keeps money exact (NUMERIC, no float drift)', async () => {
    const s = await prisma.sale.create({
      data: { farmId: ids.farm!, number: `S-${Math.random()}`, saleDate: new Date('2026-06-17'), subtotal: new Prisma.Decimal('0.30'), total: new Prisma.Decimal('0.30'), paymentStatus: 'UNPAID' },
    });
    expect(s.total.toString()).toBe('0.3');
    expect(new Prisma.Decimal('0.1').plus('0.2').toString()).toBe('0.3');
  });

  it('allows a single open price per unit and requires valid periods', async () => {
    const d = (s: string) => new Date(s);
    await prisma.price.create({ data: { productUnitId: ids.unit!, amount: new Prisma.Decimal('1550'), effectiveFrom: d('2026-06-17T00:00:00Z') } });
    await expect(prisma.price.create({ data: { productUnitId: ids.unit!, amount: new Prisma.Decimal('1600'), effectiveFrom: d('2026-07-01T00:00:00Z') } })).rejects.toThrow();
    await expect(prisma.price.create({ data: { productUnitId: ids.unit!, amount: new Prisma.Decimal('10'), effectiveFrom: d('2026-07-01T00:00:00Z'), effectiveTo: d('2026-06-01T00:00:00Z') } })).rejects.toThrow();
  });

  it('requires a date for expenses unless flagged for review (migration lineage)', async () => {
    const cat = await prisma.expenseCategory.upsert({ where: { code: 'FEED' }, update: {}, create: { code: 'FEED', name: 'Feed' } });
    const data = { farmId: ids.farm!, categoryId: cat.id, description: 'Concentrate', total: new Prisma.Decimal('11200') };
    await expect(prisma.expense.create({ data })).rejects.toThrow();
    await expect(prisma.expense.create({ data: { ...data, needsReview: true } })).resolves.toBeDefined();
  });

  it('enforces case-insensitive unique emails', async () => {
    await prisma.user.create({ data: { email: 'a@example.com' } });
    await expect(prisma.user.create({ data: { email: 'A@Example.com' } })).rejects.toThrow();
  });
});
