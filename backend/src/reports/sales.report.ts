import { Prisma } from '@prisma/client';
import { fromDbDate, toDbDate } from '../common/dates';
import { bucketLabel, bucketStart, bucketsBetween } from './period';
import { D0, col, money, table } from './common';
import { has, loadUserNames, type ReportContext } from './context';
import type { ReportResult } from './report.types';

export async function salesReport(c: ReportContext): Promise<ReportResult> {
  const { prisma, farmId, req } = c;
  const f = req.filters as { customerId?: string; paymentStatus?: string; unit?: string; createdById?: string; walkIn?: boolean };
  const financial = has(c, 'customers.financial'); // customer-level balances are financial customer data
  const sales = await prisma.sale.findMany({
    where: {
      farmId, status: 'ACTIVE', saleDate: { gte: toDbDate(req.from), lte: toDbDate(req.to) },
      ...(f.customerId ? { customerId: f.customerId } : {}), ...(f.walkIn ? { customerId: null } : {}),
      ...(f.paymentStatus ? { paymentStatus: f.paymentStatus as never } : {}), ...(f.createdById ? { createdById: f.createdById } : {}),
      ...(f.unit ? { items: { some: { productUnit: { code: f.unit } } } } : {}),
    },
    select: {
      saleDate: true, number: true, total: true, discount: true, paidAmount: true, paymentStatus: true, needsReview: true, createdById: true,
      items: { select: { quantity: true, baseEggs: true, lineTotal: true, productUnit: { select: { code: true } } } },
      customer: { select: { id: true, name: true } },
    },
    orderBy: [{ saleDate: 'asc' }, { createdAt: 'asc' }],
  });

  let revenue = D0, paid = D0, discount = D0, eggs = 0;
  const trend = new Map<string, { count: number; revenue: Prisma.Decimal; eggs: number }>();
  const byCustomer = new Map<string, { name: string; count: number; revenue: Prisma.Decimal; paid: Prisma.Decimal }>();
  const byUnit = new Map<string, { quantity: number; eggs: number; revenue: Prisma.Decimal }>();
  const byStatus = new Map<string, { count: number; revenue: Prisma.Decimal }>();
  for (const s of sales) {
    const e = s.items.reduce((a, i) => a + i.baseEggs, 0);
    revenue = revenue.plus(s.total); paid = paid.plus(s.paidAmount); discount = discount.plus(s.discount); eggs += e;
    const b = bucketStart(fromDbDate(s.saleDate), req.groupBy);
    const t = trend.get(b) ?? { count: 0, revenue: D0, eggs: 0 };
    trend.set(b, { count: t.count + 1, revenue: t.revenue.plus(s.total), eggs: t.eggs + e });
    const ck = s.customer?.id ?? 'walk-in';
    const cu = byCustomer.get(ck) ?? { name: s.customer?.name ?? 'Walk-in customers', count: 0, revenue: D0, paid: D0 };
    byCustomer.set(ck, { ...cu, count: cu.count + 1, revenue: cu.revenue.plus(s.total), paid: cu.paid.plus(s.paidAmount) });
    const st = byStatus.get(s.paymentStatus) ?? { count: 0, revenue: D0 };
    byStatus.set(s.paymentStatus, { count: st.count + 1, revenue: st.revenue.plus(s.total) });
    for (const i of s.items) {
      const u = byUnit.get(i.productUnit.code) ?? { quantity: 0, eggs: 0, revenue: D0 };
      byUnit.set(i.productUnit.code, { quantity: u.quantity + i.quantity, eggs: u.eggs + i.baseEggs, revenue: u.revenue.plus(i.lineTotal) });
    }
  }
  const outstanding = revenue.minus(paid);
  const tables = [
    table('trend', `Sales by ${req.groupBy}`, [col('period', 'Period'), col('count', 'Sales', 'int'), col('eggs', 'Eggs sold', 'int'), col('revenue', `Revenue (${c.currency})`, 'money')],
      bucketsBetween(req.from, req.to, req.groupBy).map((b) => { const t = trend.get(b); return { period: bucketLabel(b, req.groupBy), count: t?.count ?? 0, eggs: t?.eggs ?? 0, revenue: money(t?.revenue) }; }),
      { period: 'Total', count: sales.length, eggs, revenue: money(revenue) }),
    table('byCustomer', 'By customer',
      [col('customer', 'Customer'), col('count', 'Sales', 'int'), col('revenue', `Revenue (${c.currency})`, 'money'), ...(financial ? [col('paid', `Paid (${c.currency})`, 'money'), col('outstanding', `Outstanding (${c.currency})`, 'money')] : [])],
      [...byCustomer.values()].sort((a, b) => b.revenue.comparedTo(a.revenue)).map((x) => ({ customer: x.name, count: x.count, revenue: money(x.revenue), ...(financial ? { paid: money(x.paid), outstanding: money(x.revenue.minus(x.paid)) } : {}) }))),
    table('byUnit', 'By unit', [col('unit', 'Unit'), col('quantity', 'Quantity', 'int'), col('eggs', 'Eggs', 'int'), col('revenue', `Revenue (${c.currency})`, 'money')],
      [...byUnit.entries()].map(([unit, x]) => ({ unit, quantity: x.quantity, eggs: x.eggs, revenue: money(x.revenue) }))),
    table('byPaymentStatus', 'By payment status', [col('status', 'Status'), col('count', 'Sales', 'int'), col('revenue', `Sales value (${c.currency})`, 'money')],
      [...byStatus.entries()].map(([status, x]) => ({ status, count: x.count, revenue: money(x.revenue) }))),
  ];
  if (req.detail) {
    const names = await loadUserNames(prisma, sales.map((s) => s.createdById));
    tables.push(table('details', 'Sales', [col('date', 'Date', 'date'), col('number', 'Sale no.'), col('customer', 'Customer'), col('items', 'Items'), col('total', `Total (${c.currency})`, 'money'), col('discount', `Discount (${c.currency})`, 'money'), col('paid', `Paid (${c.currency})`, 'money'), col('outstanding', `Outstanding (${c.currency})`, 'money'), col('status', 'Payment'), col('createdBy', 'Recorded by'), col('review', 'Needs review')],
      sales.map((s) => ({
        date: fromDbDate(s.saleDate), number: s.number, customer: s.customer?.name ?? 'Walk-in', items: s.items.map((i) => `${i.quantity} ${i.productUnit.code.toLowerCase()}`).join(', '),
        total: money(s.total), discount: money(s.discount), paid: money(s.paidAmount), outstanding: money(s.total.minus(s.paidAmount)), status: s.paymentStatus,
        createdBy: names.get(s.createdById ?? '') ?? '', review: s.needsReview ? 'yes' : '',
      }))));
  }
  const notes: string[] = [];
  const flagged = sales.filter((s) => s.needsReview).length;
  if (flagged) notes.push(`${flagged} sale(s) are flagged for review (e.g. imported records whose source sheets disagreed).`);
  return {
    meta: c.meta('sales', 'Sales report', Object.fromEntries(Object.entries(f).filter(([, v]) => v).map(([k, v]) => [k, String(v)])), notes),
    summary: {
      revenue: money(revenue), salesCount: sales.length, eggsSold: eggs, averageSale: sales.length ? revenue.dividedBy(sales.length).toFixed(2) : '0.00',
      discounts: money(discount), paid: money(paid), outstanding: money(outstanding), salesNeedingReview: flagged,
    },
    tables,
  };
}
