import { fromDbDate } from '../common/dates';
import { bucketLabel, bucketStart, bucketsBetween } from './period';
import { col, table } from './common';
import { loadUserNames, type ReportContext } from './context';
import type { ReportResult } from './report.types';

interface Move { d: Date; type: string; s: bigint }

/** Egg stock movements from the append-only ledger: opening balance, production, sales, losses, adjustments, closing balance per period. */
export async function inventoryReport(c: ReportContext): Promise<ReportResult> {
  const { prisma, farmId, req, tz } = c;
  const from = req.from, to = req.to;
  const [{ open }] = await prisma.$queryRaw<{ open: bigint }[]>`
    SELECT COALESCE(SUM("quantityEggs"), 0)::bigint AS open FROM "InventoryTransaction"
    WHERE "farmId" = ${farmId}::uuid AND ("occurredAt" AT TIME ZONE ${tz})::date < ${from}::date`;
  const moves = await prisma.$queryRaw<Move[]>`
    SELECT ("occurredAt" AT TIME ZONE ${tz})::date AS d, "type"::text AS type, SUM("quantityEggs")::bigint AS s FROM "InventoryTransaction"
    WHERE "farmId" = ${farmId}::uuid AND ("occurredAt" AT TIME ZONE ${tz})::date BETWEEN ${from}::date AND ${to}::date GROUP BY 1, 2`;

  const KEYS = ['production', 'sold', 'usage', 'damaged', 'lost', 'adjustments', 'corrections', 'openingStock'] as const;
  type K = (typeof KEYS)[number];
  const keyOf = (t: string): K => ({ PRODUCTION: 'production', SALE: 'sold', USAGE: 'usage', DAMAGE: 'damaged', LOSS: 'lost', ADJUSTMENT: 'adjustments', TRANSFER: 'adjustments', CORRECTION: 'corrections', OPENING: 'openingStock' } as Record<string, K>)[t] ?? 'adjustments';
  const buckets = new Map<string, Record<K, number>>();
  const empty = () => Object.fromEntries(KEYS.map((k) => [k, 0])) as Record<K, number>;
  const totals = empty();
  for (const m of moves) {
    const b = bucketStart(fromDbDate(m.d), req.groupBy);
    const row = buckets.get(b) ?? empty();
    const v = Number(m.s);
    row[keyOf(m.type)] += v; totals[keyOf(m.type)] += v;
    buckets.set(b, row);
  }
  let closing = Number(open);
  let negativePeriod: string | null = null;
  const rows = bucketsBetween(from, to, req.groupBy).map((b) => {
    const r = buckets.get(b) ?? empty();
    const net = KEYS.reduce((a, k) => a + r[k], 0);
    const opening = closing;
    closing += net;
    if (closing < 0 && !negativePeriod) negativePeriod = bucketLabel(b, req.groupBy);
    // outflows are shown as positive quantities under their own heading; net keeps the sign
    return { period: bucketLabel(b, req.groupBy), opening, production: r.production, openingStock: r.openingStock, sold: -r.sold, usage: -r.usage, damaged: -r.damaged, lost: -r.lost, adjustments: r.adjustments, corrections: r.corrections, net, closing };
  });
  const [{ live }] = await prisma.$queryRaw<{ live: bigint }[]>`SELECT COALESCE(SUM("quantityEggs"), 0)::bigint AS live FROM "InventoryBalance" WHERE "farmId" = ${farmId}::uuid`;

  const tables = [
    table('movements', `Stock movements by ${req.groupBy} (eggs)`, [col('period', 'Period'), col('opening', 'Opening', 'int'), col('production', 'Produced', 'int'), col('openingStock', 'Opening stock entered', 'int'), col('sold', 'Sold', 'int'), col('usage', 'Own use', 'int'), col('damaged', 'Damaged', 'int'), col('lost', 'Lost', 'int'), col('adjustments', 'Adjustments', 'int'), col('corrections', 'Corrections', 'int'), col('net', 'Net change', 'int'), col('closing', 'Closing', 'int')],
      rows, { period: 'Total', opening: Number(open), production: totals.production, openingStock: totals.openingStock, sold: -totals.sold, usage: -totals.usage, damaged: -totals.damaged, lost: -totals.lost, adjustments: totals.adjustments, corrections: totals.corrections, net: KEYS.reduce((a, k) => a + totals[k], 0), closing }),
  ];
  if (req.detail) {
    const tx = await prisma.$queryRaw<{ d: Date; type: string; q: number; reason: string | null; by: string | null; review: boolean }[]>`
      SELECT ("occurredAt" AT TIME ZONE ${tz})::date AS d, "type"::text AS type, "quantityEggs" AS q, "reason", "createdById" AS by, "needsReview" AS review FROM "InventoryTransaction"
      WHERE "farmId" = ${farmId}::uuid AND "type" NOT IN ('PRODUCTION', 'SALE') AND ("occurredAt" AT TIME ZONE ${tz})::date BETWEEN ${from}::date AND ${to}::date ORDER BY "occurredAt", "createdAt"`;
    const names = await loadUserNames(prisma, tx.map((t) => t.by));
    tables.push(table('adjustments', 'Adjustments, losses, own use and corrections', [col('date', 'Date', 'date'), col('type', 'Type'), col('eggs', 'Eggs (signed)', 'int'), col('reason', 'Reason'), col('by', 'Recorded by'), col('review', 'Needs review')],
      tx.map((t) => ({ date: fromDbDate(t.d), type: t.type, eggs: t.q, reason: t.reason ?? '', by: names.get(t.by ?? '') ?? '', review: t.review ? 'yes' : '' }))));
  }
  const notes: string[] = ['Movements come from the append-only stock ledger; the balance is never typed by hand.'];
  if (negativePeriod) notes.push(`Recorded sales exceed recorded stock by ${negativePeriod}: an opening stock is missing from the records (see the Excel migration report). Confirm it with a physical count.`);
  const consistent = to >= fromDbDate(new Date()) ? closing === Number(live) : null;
  return {
    meta: c.meta('inventory', 'Inventory report', {}, notes),
    summary: {
      openingEggs: Number(open), producedEggs: totals.production, soldEggs: -totals.sold, ownUseEggs: -totals.usage, damagedEggs: -totals.damaged, lostEggs: -totals.lost,
      adjustmentEggs: totals.adjustments, correctionEggs: totals.corrections, openingStockEnteredEggs: totals.openingStock, closingEggs: closing, currentBalanceEggs: Number(live), closingMatchesCurrentBalance: consistent,
    },
    tables,
  };
}
