import { Prisma } from '@prisma/client';
import { fromDbDate, toDbDate } from '../common/dates';
import { bucketLabel, bucketStart, bucketsBetween } from './period';
import { D0, col, money, pct, table } from './common';
import { loadUserNames, type ReportContext } from './context';
import type { ReportResult } from './report.types';

export async function expensesReport(c: ReportContext): Promise<ReportResult> {
  const { prisma, farmId, req } = c;
  const f = req.filters as { categoryCode?: string; supplierId?: string; recordedById?: string; needsReview?: boolean };
  const rows = await prisma.expense.findMany({
    where: {
      farmId, status: 'ACTIVE', expenseDate: { gte: toDbDate(req.from), lte: toDbDate(req.to) },
      ...(f.categoryCode ? { category: { code: f.categoryCode } } : {}), ...(f.supplierId ? { supplierId: f.supplierId } : {}),
      ...(f.recordedById ? { recordedById: f.recordedById } : {}), ...(f.needsReview ? { needsReview: true } : {}),
    },
    include: { category: { select: { name: true, sortOrder: true } }, supplier: { select: { name: true } } },
    orderBy: [{ expenseDate: 'asc' }, { createdAt: 'asc' }],
  });
  const undated = await prisma.expense.count({ where: { farmId, status: 'ACTIVE', expenseDate: null } });
  let total = D0;
  const trend = new Map<string, { count: number; total: Prisma.Decimal }>();
  const byCat = new Map<string, { sort: number; count: number; total: Prisma.Decimal }>();
  const bySup = new Map<string, { count: number; total: Prisma.Decimal }>();
  for (const e of rows) {
    total = total.plus(e.total);
    const b = bucketStart(fromDbDate(e.expenseDate as Date), req.groupBy);
    const t = trend.get(b) ?? { count: 0, total: D0 };
    trend.set(b, { count: t.count + 1, total: t.total.plus(e.total) });
    const k = byCat.get(e.category.name) ?? { sort: e.category.sortOrder, count: 0, total: D0 };
    byCat.set(e.category.name, { ...k, count: k.count + 1, total: k.total.plus(e.total) });
    const sname = e.supplier?.name ?? '(no supplier recorded)';
    const s = bySup.get(sname) ?? { count: 0, total: D0 };
    bySup.set(sname, { count: s.count + 1, total: s.total.plus(e.total) });
  }
  const top = [...byCat.entries()].sort((a, b) => b[1].total.comparedTo(a[1].total))[0];
  const tables = [
    table('trend', `Expenses by ${req.groupBy}`, [col('period', 'Period'), col('count', 'Items', 'int'), col('total', `Total (${c.currency})`, 'money')],
      bucketsBetween(req.from, req.to, req.groupBy).map((b) => ({ period: bucketLabel(b, req.groupBy), count: trend.get(b)?.count ?? 0, total: money(trend.get(b)?.total) })), { period: 'Total', count: rows.length, total: money(total) }),
    table('byCategory', 'By category', [col('category', 'Category'), col('count', 'Items', 'int'), col('total', `Total (${c.currency})`, 'money'), col('share', 'Share %', 'percent')],
      [...byCat.entries()].sort((a, b) => a[1].sort - b[1].sort).map(([category, x]) => ({ category, count: x.count, total: money(x.total), share: pct(x.total, total) })), { category: 'Total', count: rows.length, total: money(total), share: rows.length ? '100.0' : '0.0' }),
    table('bySupplier', 'By supplier', [col('supplier', 'Supplier'), col('count', 'Items', 'int'), col('total', `Total (${c.currency})`, 'money')],
      [...bySup.entries()].sort((a, b) => b[1].total.comparedTo(a[1].total)).map(([supplier, x]) => ({ supplier, count: x.count, total: money(x.total) }))),
  ];
  if (req.detail) {
    const names = await loadUserNames(prisma, rows.map((r) => r.recordedById));
    tables.push(table('details', 'Expenses', [col('date', 'Date', 'date'), col('category', 'Category'), col('description', 'Description'), col('quantity', 'Quantity'), col('unitCost', `Unit cost (${c.currency})`, 'money'), col('total', `Total (${c.currency})`, 'money'), col('supplier', 'Supplier'), col('method', 'Payment'), col('recordedBy', 'Recorded by'), col('review', 'Needs review')],
      rows.map((e) => ({
        date: fromDbDate(e.expenseDate as Date), category: e.category.name, description: e.description, quantity: e.quantity?.toString() ?? '', unitCost: e.unitCost ? money(e.unitCost) : '',
        total: money(e.total), supplier: e.supplier?.name ?? '', method: e.paymentMethod, recordedBy: names.get(e.recordedById ?? '') ?? '', review: e.needsReview ? 'yes' : '',
      }))));
  }
  const notes: string[] = [];
  const flagged = rows.filter((r) => r.needsReview).length;
  if (flagged) notes.push(`${flagged} expense(s) are flagged for review (e.g. imported lines whose category — Misc or Loan — still needs confirmation).`);
  if (undated) notes.push(`${undated} imported expense(s) have no date and cannot appear in any period; they are listed under "needs review".`);
  return {
    meta: c.meta('expenses', 'Expenses report', Object.fromEntries(Object.entries(f).filter(([, v]) => v).map(([k, v]) => [k, String(v)])), notes),
    summary: {
      total: money(total), itemCount: rows.length, averageItem: rows.length ? total.dividedBy(rows.length).toFixed(2) : '0.00',
      largestCategory: top ? top[0] : null, largestCategoryTotal: top ? money(top[1].total) : '0.00', itemsNeedingReview: flagged, undatedExpensesExcluded: undated,
    },
    tables,
  };
}
