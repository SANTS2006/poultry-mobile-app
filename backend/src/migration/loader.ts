import { randomUUID } from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { ImportPlan } from './types';

export interface LoadOptions {
  openingStockEggs: number;
  sourceFile: string;
  sha256: string;
  /** injected in tests; defaults to a client built from DATABASE_URL */
  prisma?: PrismaClient;
}

export interface LoadResult {
  production: number;
  sales: number;
  expenses: number;
  skippedExisting: Record<string, number>;
}

const FARM_NAME = 'Makarifor Agriculture';
const noon = (date: string) => new Date(`${date}T12:00:00.000Z`);
const midnight = (date: string) => new Date(`${date}T00:00:00.000Z`);

/**
 * Loads a plan in ONE database transaction: either everything is written (with ledger, balance, import log and audit
 * record) or nothing is. Idempotent: every record carries a unique `sourceRef`, so re-running skips what already exists.
 */
export async function commitPlan(plan: ImportPlan, opts: LoadOptions): Promise<LoadResult> {
  const prisma = opts.prisma ?? new PrismaClient();
  try {
    return await prisma.$transaction((tx) => load(tx, plan, opts), { timeout: 120_000, maxWait: 20_000 });
  } finally {
    if (!opts.prisma) await prisma.$disconnect();
  }
}

async function load(tx: Prisma.TransactionClient, plan: ImportPlan, opts: LoadOptions): Promise<LoadResult> {
  // ── reference data must already be seeded (permissions/roles are not our business here) ──
  const product = await tx.product.findUnique({ where: { code: 'TABLE_EGG' }, include: { units: true } });
  if (!product) throw new Error('Reference data missing. Run `npm run db:seed` before importing.');
  const unitId = new Map(product.units.map((u) => [u.code, u.id]));
  const unitEggs = new Map(product.units.map((u) => [u.code, u.eggsPerUnit]));
  const shifts = new Map((await tx.shift.findMany()).map((s) => [s.code, s.id]));
  const categories = new Map((await tx.expenseCategory.findMany()).map((c) => [c.code, c.id]));
  for (const code of new Set(plan.expenses.map((e) => e.categoryCode))) if (!categories.has(code)) throw new Error(`Expense category ${code} is not seeded`);
  for (const p of plan.production) if (!shifts.has(p.shift)) throw new Error(`Shift ${p.shift} is not seeded`);
  // The database's unit table is the source of truth for conversions; the plan must agree with it.
  for (const p of plan.production) for (const e of p.entries) {
    if (unitEggs.get(e.unit) !== e.baseEggs / e.quantity && e.quantity > 0) throw new Error('Unit conversion in the plan differs from the database unit table; refusing to import');
  }

  // ── farm and coops ──
  const farm = (await tx.farm.findFirst({ where: { name: FARM_NAME, deletedAt: null } })) ?? (await tx.farm.create({ data: { name: FARM_NAME } }));
  const coopId = new Map<string, string>();
  for (const name of plan.coops) {
    const c = (await tx.coop.findUnique({ where: { farmId_name: { farmId: farm.id, name } } })) ?? (await tx.coop.create({ data: { farmId: farm.id, name } }));
    coopId.set(name, c.id);
  }

  const existing = async (rows: Promise<{ sourceRef: string | null }[]>) => new Set((await rows).map((r) => r.sourceRef).filter((x): x is string => !!x));
  const havePrd = await existing(tx.productionRecord.findMany({ where: { farmId: farm.id, sourceRef: { not: null } }, select: { sourceRef: true } }));
  const haveSale = await existing(tx.sale.findMany({ where: { farmId: farm.id, sourceRef: { not: null } }, select: { sourceRef: true } }));
  const haveExp = await existing(tx.expense.findMany({ where: { farmId: farm.id, sourceRef: { not: null } }, select: { sourceRef: true } }));
  const skipped: Record<string, number> = {};

  // ── production + PRODUCTION ledger rows ──
  const newProd = plan.production.filter((p) => !havePrd.has(p.sourceRef));
  skipped.production = plan.production.length - newProd.length;
  const prdIds = newProd.map(() => randomUUID());
  await tx.productionRecord.createMany({
    data: newProd.map((p, i) => ({
      id: prdIds[i], farmId: farm.id, coopId: coopId.get(p.coop) as string, shiftId: shifts.get(p.shift) as string,
      productionDate: midnight(p.date), totalEggs: p.totalEggs, sourceRef: p.sourceRef, needsReview: p.needsReview,
      notes: 'Imported from Excel workbook',
    })),
  });
  await tx.productionEntry.createMany({
    data: newProd.flatMap((p, i) => p.entries.map((e) => ({ recordId: prdIds[i], productUnitId: unitId.get(e.unit) as string, quantity: e.quantity, baseEggs: e.baseEggs }))),
  });
  await tx.inventoryTransaction.createMany({
    data: newProd.flatMap((p, i) => (p.totalEggs > 0 ? [{
      farmId: farm.id, productId: product.id, type: 'PRODUCTION' as const, quantityEggs: p.totalEggs, occurredAt: noon(p.date),
      sourceType: 'production_record', sourceId: prdIds[i], sourceRef: p.sourceRef, needsReview: p.needsReview, reason: 'Imported from Excel workbook',
    }] : [])),
  });

  // ── price history (never overwrite an existing price) ──
  const cartonUnit = unitId.get('CARTON') as string;
  let pricesLoaded = 0;
  if ((await tx.price.count({ where: { productUnitId: cartonUnit } })) === 0) {
    for (const pr of plan.prices) {
      await tx.price.create({ data: { productUnitId: cartonUnit, amount: pr.amount, effectiveFrom: midnight(pr.effectiveFrom), effectiveTo: pr.effectiveTo ? midnight(pr.effectiveTo) : null, reason: 'Imported from Excel workbook (Sheet1 price column)' } });
      pricesLoaded++;
    }
  } else skipped.prices = plan.prices.length;

  // ── sales, cash payments, SALE ledger rows ──
  const newSales = plan.sales.filter((s) => !haveSale.has(s.sourceRef));
  skipped.sales = plan.sales.length - newSales.length;
  for (const s of newSales) {
    const id = randomUUID();
    await tx.sale.create({
      data: {
        id, farmId: farm.id, number: `XL-${s.date}`, saleDate: midnight(s.date), subtotal: s.total, discount: 0, total: s.total, paidAmount: s.total,
        paymentStatus: 'PAID', sourceRef: s.sourceRef, needsReview: s.needsReview, notes: ['Imported from Excel workbook (walk-in, cash)', s.note].filter(Boolean).join('. '),
        items: { create: s.items.map((i) => ({ productId: product.id, productUnitId: unitId.get(i.unit) as string, quantity: i.quantity, baseEggs: i.baseEggs, unitPrice: i.unitPrice, lineTotal: i.lineTotal })) },
      },
    });
    await tx.payment.create({ data: { saleId: id, amount: s.total, method: 'CASH', paidAt: noon(s.date), reference: `import ${s.sourceRef}` } });
    await tx.inventoryTransaction.create({
      data: {
        farmId: farm.id, productId: product.id, type: 'SALE', quantityEggs: -s.items.reduce((a, i) => a + i.baseEggs, 0), occurredAt: noon(s.date),
        sourceType: 'sale', sourceId: id, sourceRef: s.sourceRef, needsReview: s.needsReview, reason: 'Imported from Excel workbook',
      },
    });
  }

  // ── expenses ──
  const newExp = plan.expenses.filter((e) => !haveExp.has(e.sourceRef));
  skipped.expenses = plan.expenses.length - newExp.length;
  await tx.expense.createMany({
    data: newExp.map((e) => ({
      farmId: farm.id, categoryId: categories.get(e.categoryCode) as string, description: e.description,
      quantity: e.quantity === null ? null : new Prisma.Decimal(e.quantity), unitCost: e.unitCost, total: e.total,
      expenseDate: midnight(e.date), paymentMethod: 'CASH' as const, notes: e.notes ?? null, originalText: e.originalText,
      needsReview: e.needsReview, sourceRef: e.sourceRef,
    })),
  });

  // ── operator-supplied opening stock (only when explicitly provided; never invented) ──
  if (opts.openingStockEggs > 0) {
    const ref = 'import:opening-stock';
    if (!(await tx.inventoryTransaction.findUnique({ where: { sourceRef: ref } }))) {
      const first = plan.production.map((p) => p.date).sort()[0] ?? plan.sales.map((s) => s.date).sort()[0];
      await tx.inventoryTransaction.create({
        data: { farmId: farm.id, productId: product.id, type: 'OPENING', quantityEggs: opts.openingStockEggs, occurredAt: midnight(first), sourceRef: ref, needsReview: true, reason: 'Opening stock supplied by the operator at import time (--opening-stock); confirm with a physical count' },
      });
    }
  }

  // ── balance = ledger sum (the balance is a cache of the ledger, never edited by hand) ──
  const [{ sum }] = await tx.$queryRaw<{ sum: bigint | null }[]>`
    SELECT COALESCE(SUM("quantityEggs"), 0)::bigint AS sum FROM "InventoryTransaction" WHERE "farmId" = ${farm.id}::uuid AND "productId" = ${product.id}::uuid`;
  const balance = Number(sum ?? 0);
  if (balance < 0) throw new Error(`Import would leave a negative stock balance (${balance}). Nothing was written. Supply --opening-stock (at least ${-balance} eggs) once the real opening stock is known.`);
  await tx.inventoryBalance.upsert({
    where: { farmId_productId: { farmId: farm.id, productId: product.id } },
    create: { farmId: farm.id, productId: product.id, quantityEggs: balance }, update: { quantityEggs: balance },
  });

  // ── import log + audit (same transaction) ──
  const batch = await tx.importBatch.create({
    data: {
      sourceFile: opts.sourceFile.split('/').pop() as string, sourceSha256: opts.sha256, dryRun: false, finishedAt: new Date(),
      summary: { production: newProd.length, sales: newSales.length, expenses: newExp.length, prices: pricesLoaded, skipped, balanceEggs: balance, openingStockEggs: opts.openingStockEggs } as Prisma.InputJsonValue,
    },
  });
  await tx.importIssue.createMany({
    data: plan.issues.map((i) => ({ batchId: batch.id, severity: i.severity, sheet: i.sheet, cell: i.cell ?? null, code: i.code, message: i.message, original: i.original ?? null })),
  });
  await new AuditService(tx as unknown as PrismaService).record({
    action: 'migration.excel_import', entityType: 'import_batch', entityId: batch.id,
    after: { production: newProd.length, sales: newSales.length, expenses: newExp.length, sourceSha256: opts.sha256 },
  }, tx);

  return { production: newProd.length, sales: newSales.length, expenses: newExp.length, skippedExisting: skipped };
}
