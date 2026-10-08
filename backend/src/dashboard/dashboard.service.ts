import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AuthUser } from '../auth/auth.types';
import { fromDbDate, toDbDate } from '../common/dates';
import { TtlCache } from '../common/cache';
import { DomainEvents } from '../domain/events.service';
import { FarmService } from '../domain/farm.service';
import { SettingsService } from '../domain/settings.service';
import { InventoryService } from '../inventory/inventory.service';
import { PrismaService } from '../prisma/prisma.service';

const D0 = new Prisma.Decimal(0);
const addDays = (date: string, n: number): string => fromDbDate(new Date(toDbDate(date).getTime() + n * 86_400_000));
const days = (from: string, to: string): string[] => { const out: string[] = []; for (let d = from; d <= to; d = addDays(d, 1)) out.push(d); return out; };

/**
 * Live dashboard, computed from the database on every request (no cached or invented numbers). A section is included ONLY if the
 * caller holds the permission for the data in it; the realtime layer just tells clients when to refetch.
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService, private readonly farms: FarmService, private readonly settings: SettingsService,
    private readonly inventory: InventoryService, events: DomainEvents,
  ) {
    // Any business change empties the cache, so figures are never older than the last change (or 15 s, whichever is shorter).
    events.on('*', (e) => { if (/^(production|sale|payment|expense|customer|inventory)\./.test(e.name)) this.cache.clear(); });
  }

  /** Each dashboard section, computed once and shared by everybody who may see it. Dashboards are the most expensive read in the app (many queries). */
  private readonly cache = new TtlCache<unknown>(15_000);
  private section<T>(farmId: string, name: string, today: string, load: () => Promise<T>): Promise<T> {
    return this.cache.get(`${farmId}:${name}:${today}`, load) as Promise<T>;
  }

  async build(user: AuthUser, farmIdIn?: string) {
    const has = (p: string) => user.permissions.includes(p);
    const farmId = await this.farms.resolve(farmIdIn);
    const today = await this.settings.today();
    const tz = await this.settings.get<string>('business.timezone');
    const start = addDays(today, -13); // 14-day window incl. today
    const monthStart = `${today.slice(0, 7)}-01`;
    const out: Record<string, unknown> = { businessDate: today, farmId, generatedAt: new Date().toISOString(), currency: await this.settings.get<string>('business.currency') };

    // Sections are independent: ask for all of them at once instead of one after the other.
    const [production, inventory, sales, customers, expenses, cash, receivables, reviewProduction, reviewSales, reviewExpenses] = await Promise.all([
      has('production.read') ? this.section(farmId, 'production', today, () => this.production(farmId, today, start)) : undefined,
      has('inventory.read') ? this.section(farmId, 'inventory', today, () => this.inventory.snapshot(farmId)) : undefined,
      has('sales.read') ? this.section(farmId, `sales:${has('customers.read')}`, today, () => this.sales(farmId, today, start, monthStart, has('customers.read'))) : undefined,
      has('customers.read') ? this.section(farmId, 'customers', today, () => this.customers(monthStart)) : undefined,
      has('expenses.read') ? this.section(farmId, 'expenses', today, () => this.expenses(farmId, today, start, monthStart)) : undefined,
      has('payments.read') && has('expenses.read') ? this.section(farmId, 'cash', today, () => this.cash(farmId, today, tz)) : undefined,
      has('customers.financial') ? this.section(farmId, 'receivables', today, () => this.receivables(farmId)) : undefined,
      has('production.read') ? this.section(farmId, 'review:production', today, () => this.prisma.productionRecord.count({ where: { farmId, status: 'ACTIVE', needsReview: true } })) : undefined,
      has('sales.read') ? this.section(farmId, 'review:sales', today, () => this.prisma.sale.count({ where: { farmId, status: 'ACTIVE', needsReview: true } })) : undefined,
      has('expenses.read') ? this.section(farmId, 'review:expenses', today, () => this.prisma.expense.count({ where: { farmId, status: 'ACTIVE', needsReview: true } })) : undefined,
    ]);
    if (production) out.production = production;
    if (inventory) out.inventory = inventory;
    if (sales) out.sales = sales;
    if (customers) out.customers = customers;
    if (expenses) out.expenses = expenses;
    if (cash) out.cash = cash;
    if (receivables) out.receivables = receivables;
    out.needsReview = {
      ...(reviewProduction !== undefined ? { production: reviewProduction } : {}), ...(reviewSales !== undefined ? { sales: reviewSales } : {}), ...(reviewExpenses !== undefined ? { expenses: reviewExpenses } : {}),
    };
    return out;
  }

  private async production(farmId: string, today: string, start: string) {
    const [coops, shifts, byCoop, byShift, trend] = await Promise.all([
      this.prisma.coop.findMany({ where: { farmId, active: true, deletedAt: null }, orderBy: { name: 'asc' } }),
      this.prisma.shift.findMany({ where: { active: true }, orderBy: { sortOrder: 'asc' } }),
      this.prisma.productionRecord.groupBy({ by: ['coopId'], where: { farmId, status: 'ACTIVE', productionDate: toDbDate(today) }, _sum: { totalEggs: true } }),
      this.prisma.productionRecord.groupBy({ by: ['shiftId'], where: { farmId, status: 'ACTIVE', productionDate: toDbDate(today) }, _sum: { totalEggs: true } }),
      this.prisma.productionRecord.groupBy({ by: ['productionDate'], where: { farmId, status: 'ACTIVE', productionDate: { gte: toDbDate(start), lte: toDbDate(today) } }, _sum: { totalEggs: true } }),
    ]);
    const weekStart = addDays(today, -6);
    const monthStart = `${today.slice(0, 7)}-01`;
    const [week, month, recordsToday, recordsMonth] = await Promise.all([
      this.prisma.productionRecord.aggregate({ where: { farmId, status: 'ACTIVE', productionDate: { gte: toDbDate(weekStart), lte: toDbDate(today) } }, _sum: { totalEggs: true } }),
      this.prisma.productionRecord.aggregate({ where: { farmId, status: 'ACTIVE', productionDate: { gte: toDbDate(monthStart), lte: toDbDate(today) } }, _sum: { totalEggs: true } }),
      this.prisma.productionRecord.count({ where: { farmId, status: 'ACTIVE', productionDate: toDbDate(today) } }),
      this.prisma.productionRecord.count({ where: { farmId, status: 'ACTIVE', productionDate: { gte: toDbDate(monthStart), lte: toDbDate(today) } } }),
    ]);
    const recorded = await this.prisma.productionRecord.findMany({ where: { farmId, status: 'ACTIVE', productionDate: toDbDate(today) }, select: { coopId: true, shiftId: true } });
    const done = new Set(recorded.map((r) => `${r.coopId}:${r.shiftId}`));
    const trendMap = new Map(trend.map((t) => [fromDbDate(t.productionDate), t._sum.totalEggs ?? 0]));
    const series = days(start, today).map((date) => ({ date, eggs: trendMap.get(date) ?? 0 }));
    const best = series.reduce((a, b) => (b.eggs > a.eggs ? b : a), series[0]!);
    const weekEggs = week._sum.totalEggs ?? 0;
    return {
      yesterdayEggs: trendMap.get(addDays(today, -1)) ?? 0,
      weekEggs, averagePerDay7: Math.round(weekEggs / 7), monthEggs: month._sum.totalEggs ?? 0,
      recordsToday, recordsMonth, activeCoops: coops.length,
      bestDay14: best && best.eggs > 0 ? best : null,
      todayEggs: byCoop.reduce((a, c) => a + (c._sum.totalEggs ?? 0), 0),
      byCoop: coops.map((c) => ({ coopId: c.id, name: c.name, eggs: byCoop.find((x) => x.coopId === c.id)?._sum.totalEggs ?? 0 })),
      byShift: shifts.map((s) => ({ shift: s.code, eggs: byShift.find((x) => x.shiftId === s.id)?._sum.totalEggs ?? 0 })),
      notRecordedToday: coops.flatMap((c) => shifts.filter((s) => !done.has(`${c.id}:${s.id}`)).map((s) => ({ coopId: c.id, coop: c.name, shift: s.code }))),
      last14Days: days(start, today).map((date) => ({ date, eggs: trendMap.get(date) ?? 0 })),
    };
  }

  private async sales(farmId: string, today: string, start: string, monthStart: string, withCustomers: boolean) {
    const where = (extra: Prisma.SaleWhereInput = {}): Prisma.SaleWhereInput => ({ farmId, status: 'ACTIVE', ...extra });
    const weekStart = addDays(today, -6);
    const [t, eggs, trend, week, month, monthEggs, unpaid, top] = await Promise.all([
      this.prisma.sale.aggregate({ where: where({ saleDate: toDbDate(today) }), _sum: { total: true }, _count: true }),
      this.prisma.saleItem.aggregate({ where: { sale: where({ saleDate: toDbDate(today) }) }, _sum: { baseEggs: true } }),
      this.prisma.sale.groupBy({ by: ['saleDate'], where: where({ saleDate: { gte: toDbDate(start), lte: toDbDate(today) } }), _sum: { total: true } }),
      this.prisma.sale.aggregate({ where: where({ saleDate: { gte: toDbDate(weekStart), lte: toDbDate(today) } }), _sum: { total: true }, _count: true }),
      this.prisma.sale.aggregate({ where: where({ saleDate: { gte: toDbDate(monthStart), lte: toDbDate(today) } }), _sum: { total: true }, _count: true }),
      this.prisma.saleItem.aggregate({ where: { sale: where({ saleDate: { gte: toDbDate(monthStart), lte: toDbDate(today) } }) }, _sum: { baseEggs: true } }),
      this.prisma.sale.count({ where: where({ paymentStatus: { not: 'PAID' } }) }),
      withCustomers
        ? this.prisma.sale.groupBy({ by: ['customerId'], where: where({ customerId: { not: null }, saleDate: { gte: toDbDate(monthStart), lte: toDbDate(today) } }), _sum: { total: true }, orderBy: { _sum: { total: 'desc' } }, take: 3 })
        : Promise.resolve([]),
    ]);
    const names = top.length ? await this.prisma.customer.findMany({ where: { id: { in: top.map((x) => x.customerId!).filter(Boolean) } }, select: { id: true, name: true } }) : [];
    const m = new Map(trend.map((x) => [fromDbDate(x.saleDate), x._sum.total ?? D0]));
    const monthCount = month._count;
    return {
      todayRevenue: (t._sum.total ?? D0).toString(), todayCount: t._count, todayEggsSold: eggs._sum.baseEggs ?? 0,
      weekRevenue: (week._sum.total ?? D0).toString(), weekCount: week._count,
      monthRevenue: (month._sum.total ?? D0).toString(), monthCount, monthEggsSold: monthEggs._sum.baseEggs ?? 0,
      averageSaleMonth: monthCount ? (month._sum.total ?? D0).div(monthCount).toDecimalPlaces(2).toString() : '0',
      unpaidSales: unpaid,
      topCustomersMonth: top.map((x) => ({ name: names.find((n) => n.id === x.customerId)?.name ?? 'Customer', total: (x._sum.total ?? D0).toString() })),
      last14Days: days(start, today).map((date) => ({ date, revenue: (m.get(date) ?? D0).toString() })),
    };
  }

  /** Counts only: money owed by customers stays behind `customers.financial`. */
  private async customers(monthStart: string) {
    const [total, regular, wholesale, added] = await Promise.all([
      this.prisma.customer.count({ where: { deletedAt: null } }),
      this.prisma.customer.count({ where: { deletedAt: null, type: 'REGULAR' } }),
      this.prisma.customer.count({ where: { deletedAt: null, type: 'WHOLESALE' } }),
      this.prisma.customer.count({ where: { deletedAt: null, createdAt: { gte: toDbDate(monthStart) } } }),
    ]);
    return { total, regular, wholesale, addedThisMonth: added };
  }

  private async expenses(farmId: string, today: string, start: string, monthStart: string) {
    const where = (extra: Prisma.ExpenseWhereInput = {}): Prisma.ExpenseWhereInput => ({ farmId, status: 'ACTIVE', ...extra });
    const [t, month, byCat, trend, cats] = await Promise.all([
      this.prisma.expense.aggregate({ where: where({ expenseDate: toDbDate(today) }), _sum: { total: true }, _count: true }),
      this.prisma.expense.aggregate({ where: where({ expenseDate: { gte: toDbDate(monthStart), lte: toDbDate(today) } }), _sum: { total: true } }),
      this.prisma.expense.groupBy({ by: ['categoryId'], where: where({ expenseDate: toDbDate(today) }), _sum: { total: true } }),
      this.prisma.expense.groupBy({ by: ['expenseDate'], where: where({ expenseDate: { gte: toDbDate(start), lte: toDbDate(today) } }), _sum: { total: true } }),
      this.prisma.expenseCategory.findMany(),
    ]);
    const m = new Map(trend.map((x) => [x.expenseDate ? fromDbDate(x.expenseDate) : '', x._sum.total ?? D0]));
    return {
      todayTotal: (t._sum.total ?? D0).toString(), todayCount: t._count, monthToDateTotal: (month._sum.total ?? D0).toString(),
      byCategoryToday: byCat.map((c) => ({ category: cats.find((k) => k.id === c.categoryId)?.name ?? 'Unknown', total: (c._sum.total ?? D0).toString() })),
      last14Days: days(start, today).map((date) => ({ date, total: (m.get(date) ?? D0).toString() })),
    };
  }

  /** Cash basis: money actually received today minus expenses recorded today. This is a cash-flow indication, NOT profit. */
  private async cash(farmId: string, today: string, tz: string) {
    const rows = await this.prisma.$queryRaw<{ s: Prisma.Decimal | null }[]>`
      SELECT SUM(p.amount) AS s FROM "Payment" p JOIN "Sale" s ON s.id = p."saleId"
      WHERE s."farmId" = ${farmId}::uuid AND p.status = 'ACTIVE' AND s.status = 'ACTIVE'
        AND (p."paidAt" AT TIME ZONE ${tz})::date = ${today}::date`;
    const received = rows[0]?.s ?? D0;
    const exp = await this.prisma.expense.aggregate({ where: { farmId, status: 'ACTIVE', expenseDate: toDbDate(today) }, _sum: { total: true } });
    const spent = exp._sum.total ?? D0;
    return { receivedToday: received.toString(), expensesToday: spent.toString(), netCashFlowToday: received.minus(spent).toString(), basis: 'cash received minus expenses recorded today (not profit)' };
  }

  private async receivables(farmId: string) {
    const rows = await this.prisma.$queryRaw<{ owed: Prisma.Decimal | null; customers: bigint }[]>`
      SELECT SUM(total - "paidAmount") AS owed, COUNT(DISTINCT "customerId") AS customers
      FROM "Sale" WHERE "farmId" = ${farmId}::uuid AND status = 'ACTIVE' AND "customerId" IS NOT NULL AND "paidAmount" < total`;
    return { outstandingTotal: (rows[0]?.owed ?? D0).toString(), customersWithBalance: Number(rows[0]?.customers ?? 0) };
  }
}
