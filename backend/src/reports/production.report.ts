import { toDbDate, fromDbDate } from '../common/dates';
import { bucketLabel, bucketStart, bucketsBetween } from './period';
import { col, pct, splitEggs, table } from './common';
import { loadUserNames, type ReportContext } from './context';
import type { ReportResult } from './report.types';

/** Production totals over time and by coop/shift. Voided records are excluded. Everything is derived from base eggs. */
export async function productionReport(c: ReportContext): Promise<ReportResult> {
  const { prisma, farmId, req } = c;
  const f = req.filters as { coopId?: string; shift?: string };
  const rows = await prisma.productionRecord.findMany({
    where: { farmId, status: 'ACTIVE', productionDate: { gte: toDbDate(req.from), lte: toDbDate(req.to) }, ...(f.coopId ? { coopId: f.coopId } : {}), ...(f.shift ? { shift: { code: f.shift } } : {}) },
    select: { id: true, productionDate: true, totalEggs: true, needsReview: true, recordedById: true, coop: { select: { name: true } }, shift: { select: { code: true, sortOrder: true } } },
    orderBy: [{ productionDate: 'asc' }],
  });
  const total = rows.reduce((a, r) => a + r.totalEggs, 0);
  const perDay = new Map<string, number>();
  const coopTotals = new Map<string, number>();
  const shiftTotals = new Map<string, number>();
  for (const r of rows) {
    const d = fromDbDate(r.productionDate);
    perDay.set(d, (perDay.get(d) ?? 0) + r.totalEggs);
    coopTotals.set(r.coop.name, (coopTotals.get(r.coop.name) ?? 0) + r.totalEggs);
    shiftTotals.set(r.shift.code, (shiftTotals.get(r.shift.code) ?? 0) + r.totalEggs);
  }
  const bucketTotals = new Map<string, number>();
  for (const [d, eggs] of perDay) { const b = bucketStart(d, req.groupBy); bucketTotals.set(b, (bucketTotals.get(b) ?? 0) + eggs); }
  const days = perDay.size;
  const best = [...perDay.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  const split = (n: number) => splitEggs(n, c.units.carton, c.units.crate);

  const trendRows = bucketsBetween(req.from, req.to, req.groupBy).map((b) => {
    const eggs = bucketTotals.get(b) ?? 0;
    return { period: bucketLabel(b, req.groupBy), start: b, eggs, ...split(eggs) };
  });
  const tables = [
    table('trend', `Production by ${req.groupBy}`, [col('period', 'Period'), col('eggs', 'Eggs', 'int'), col('cartons', 'Cartons', 'int'), col('crates', 'Crates', 'int'), col('singles', 'Single eggs', 'int')],
      trendRows.map(({ start: _s, ...r }) => r), { period: 'Total', eggs: total, ...split(total) }),
    table('byCoop', 'By coop', [col('coop', 'Coop'), col('eggs', 'Eggs', 'int'), col('share', 'Share %', 'percent')],
      [...coopTotals.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([coop, eggs]) => ({ coop, eggs, share: pct(eggs, total) })), { coop: 'Total', eggs: total, share: total ? '100.0' : '0.0' }),
    table('byShift', 'By shift', [col('shift', 'Shift'), col('eggs', 'Eggs', 'int'), col('share', 'Share %', 'percent')],
      [...shiftTotals.entries()].sort((a, b) => (rows.find((r) => r.shift.code === a[0])?.shift.sortOrder ?? 0) - (rows.find((r) => r.shift.code === b[0])?.shift.sortOrder ?? 0)).map(([shift, eggs]) => ({ shift, eggs, share: pct(eggs, total) })), { shift: 'Total', eggs: total, share: total ? '100.0' : '0.0' }),
  ];
  if (req.detail) {
    const names = await loadUserNames(prisma, rows.map((r) => r.recordedById));
    tables.push(table('details', 'Records', [col('date', 'Date', 'date'), col('coop', 'Coop'), col('shift', 'Shift'), col('eggs', 'Eggs', 'int'), col('cartons', 'Cartons', 'int'), col('crates', 'Crates', 'int'), col('singles', 'Single eggs', 'int'), col('recordedBy', 'Recorded by'), col('review', 'Needs review')],
      rows.map((r) => ({ date: fromDbDate(r.productionDate), coop: r.coop.name, shift: r.shift.code, eggs: r.totalEggs, ...split(r.totalEggs), recordedBy: names.get(r.recordedById ?? '') ?? '', review: r.needsReview ? 'yes' : '' }))));
  }
  const notes: string[] = [];
  const flagged = rows.filter((r) => r.needsReview).length;
  if (flagged) notes.push(`${flagged} record(s) in this period are flagged for review (e.g. imported from the Excel workbook with a data conflict).`);
  return {
    meta: c.meta('production', 'Production report', Object.fromEntries(Object.entries(f).filter(([, v]) => v).map(([k, v]) => [k, String(v)])), notes),
    summary: {
      totalEggs: total, ...split(total), recordCount: rows.length, daysRecorded: days,
      averageEggsPerRecordedDay: days ? (total / days).toFixed(1) : '0.0', bestDay: best ? best[0] : null, bestDayEggs: best ? best[1] : 0, recordsNeedingReview: flagged,
    },
    tables,
  };
}
