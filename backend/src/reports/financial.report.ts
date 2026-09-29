import { Prisma } from '@prisma/client';
import { fromDbDate, toDbDate } from '../common/dates';
import { bucketLabel, bucketStart, bucketsBetween } from './period';
import { D0, col, money, table } from './common';
import { has, loadUserNames, type ReportContext } from './context';
import type { ReportResult } from './report.types';

/**
 * Cash-flow view. "Net cash flow" = cash actually received − expenses recorded. It is NOT profit: there is no cost of goods, no stock valuation
 * and no depreciation, so the word "profit" is deliberately never used.
 */
export async function financialReport(c: ReportContext): Promise<ReportResult> {
  const { prisma, farmId, req, tz } = c;
  const financial = has(c, 'customers.financial');
  const from = req.from, to = req.to;

  const sales = await prisma.sale.findMany({ where: { farmId, status: 'ACTIVE', saleDate: { gte: toDbDate(from), lte: toDbDate(to) } }, select: { saleDate: true, total: true, paidAmount: true } });
  const expenses = await prisma.expense.findMany({ where: { farmId, status: 'ACTIVE', expenseDate: { gte: toDbDate(from), lte: toDbDate(to) } }, select: { expenseDate: true, total: true } });
  const pays = await prisma.$queryRaw<{ d: Date; method: string; amount: Prisma.Decimal; n: bigint }[]>`
    SELECT (p."paidAt" AT TIME ZONE ${tz})::date AS d, p."method"::text AS method, SUM(p.amount) AS amount, COUNT(*) AS n
    FROM "Payment" p JOIN "Sale" s ON s.id = p."saleId"
    WHERE s."farmId" = ${farmId}::uuid AND p.status = 'ACTIVE' AND s.status = 'ACTIVE' AND (p."paidAt" AT TIME ZONE ${tz})::date BETWEEN ${from}::date AND ${to}::date
    GROUP BY 1, 2`;

  const revenue = sales.reduce((a, s) => a.plus(s.total), D0);
  const creditSales = sales.reduce((a, s) => a.plus(s.total.minus(s.paidAmount)), D0);
  const spent = expenses.reduce((a, e) => a.plus(e.total), D0);
  const received = pays.reduce((a, p) => a.plus(p.amount), D0);

  const t = new Map<string, { revenue: Prisma.Decimal; cash: Prisma.Decimal; expenses: Prisma.Decimal }>();
  const slot = (b: string) => t.get(b) ?? { revenue: D0, cash: D0, expenses: D0 };
  for (const s of sales) { const b = bucketStart(fromDbDate(s.saleDate), req.groupBy); t.set(b, { ...slot(b), revenue: slot(b).revenue.plus(s.total) }); }
  for (const e of expenses) { const b = bucketStart(fromDbDate(e.expenseDate as Date), req.groupBy); t.set(b, { ...slot(b), expenses: slot(b).expenses.plus(e.total) }); }
  for (const p of pays) { const b = bucketStart(fromDbDate(p.d), req.groupBy); t.set(b, { ...slot(b), cash: slot(b).cash.plus(p.amount) }); }
  const byMethod = new Map<string, { amount: Prisma.Decimal; n: number }>();
  for (const p of pays) { const m = byMethod.get(p.method) ?? { amount: D0, n: 0 }; byMethod.set(p.method, { amount: m.amount.plus(p.amount), n: m.n + Number(p.n) }); }

  const tables = [
    table('trend', `Cash flow by ${req.groupBy}`, [col('period', 'Period'), col('revenue', `Sales (${c.currency})`, 'money'), col('cashReceived', `Cash received (${c.currency})`, 'money'), col('expenses', `Expenses (${c.currency})`, 'money'), col('netCashFlow', `Net cash flow (${c.currency})`, 'money')],
      bucketsBetween(from, to, req.groupBy).map((b) => { const x = slot(b); return { period: bucketLabel(b, req.groupBy), revenue: money(x.revenue), cashReceived: money(x.cash), expenses: money(x.expenses), netCashFlow: money(x.cash.minus(x.expenses)) }; }),
      { period: 'Total', revenue: money(revenue), cashReceived: money(received), expenses: money(spent), netCashFlow: money(received.minus(spent)) }),
    table('paymentsByMethod', 'Cash received by payment method', [col('method', 'Method'), col('payments', 'Payments', 'int'), col('amount', `Amount (${c.currency})`, 'money')],
      [...byMethod.entries()].map(([method, x]) => ({ method, payments: x.n, amount: money(x.amount) })), { method: 'Total', payments: [...byMethod.values()].reduce((a, x) => a + x.n, 0), amount: money(received) }),
  ];

  let receivablesNow: { outstandingTotal: string; customers: number } | null = null;
  if (financial) {
    const rec = await prisma.$queryRaw<{ id: string; name: string; owed: Prisma.Decimal; n: bigint; oldest: Date }[]>`
      SELECT c.id, c.name, SUM(s.total - s."paidAmount") AS owed, COUNT(*) AS n, MIN(s."saleDate") AS oldest
      FROM "Sale" s JOIN "Customer" c ON c.id = s."customerId"
      WHERE s."farmId" = ${farmId}::uuid AND s.status = 'ACTIVE' AND s."paidAmount" < s.total GROUP BY c.id, c.name ORDER BY owed DESC`;
    const total = rec.reduce((a, r) => a.plus(r.owed), D0);
    receivablesNow = { outstandingTotal: money(total), customers: rec.length };
    tables.push(table('receivables', 'Outstanding customer balances (as of today)', [col('customer', 'Customer'), col('unpaidSales', 'Unpaid sales', 'int'), col('oldest', 'Oldest unpaid sale', 'date'), col('outstanding', `Outstanding (${c.currency})`, 'money')],
      rec.map((r) => ({ customer: r.name, unpaidSales: Number(r.n), oldest: fromDbDate(r.oldest), outstanding: money(r.owed) })), { customer: 'Total', unpaidSales: rec.reduce((a, r) => a + Number(r.n), 0), oldest: null, outstanding: money(total) }));
  }
  if (req.detail) {
    const det = await prisma.$queryRaw<{ d: Date; method: string; amount: Prisma.Decimal; number: string; customer: string | null; by: string | null }[]>`
      SELECT (p."paidAt" AT TIME ZONE ${tz})::date AS d, p."method"::text AS method, p.amount, s.number, cu.name AS customer, p."receivedById" AS by
      FROM "Payment" p JOIN "Sale" s ON s.id = p."saleId" LEFT JOIN "Customer" cu ON cu.id = s."customerId"
      WHERE s."farmId" = ${farmId}::uuid AND p.status = 'ACTIVE' AND s.status = 'ACTIVE' AND (p."paidAt" AT TIME ZONE ${tz})::date BETWEEN ${from}::date AND ${to}::date ORDER BY p."paidAt"`;
    const names = await loadUserNames(prisma, det.map((x) => x.by));
    tables.push(table('paymentHistory', 'Payment history', [col('date', 'Date', 'date'), col('sale', 'Sale no.'), col('customer', 'Customer'), col('method', 'Method'), col('amount', `Amount (${c.currency})`, 'money'), col('receivedBy', 'Received by')],
      det.map((x) => ({ date: fromDbDate(x.d), sale: x.number, customer: x.customer ?? 'Walk-in', method: x.method, amount: money(x.amount), receivedBy: names.get(x.by ?? '') ?? '' }))));
  }
  return {
    meta: c.meta('financial', 'Financial report (cash flow)', {}, [
      'Net cash flow = cash actually received − expenses recorded in the period. This is NOT profit: it excludes cost of goods, stock valuation and depreciation.',
      'Sales are counted on the sale date; cash received is counted on the day the payment was recorded (so it includes collections on earlier credit sales).',
    ]),
    summary: {
      salesValue: money(revenue), cashReceived: money(received), expenses: money(spent), netCashFlow: money(received.minus(spent)), salesMinusExpenses: money(revenue.minus(spent)),
      creditSalesOutstandingFromPeriod: money(creditSales), ...(receivablesNow ? { outstandingCustomerBalancesToday: receivablesNow.outstandingTotal, customersWithBalance: receivablesNow.customers } : {}),
    },
    tables,
  };
}
