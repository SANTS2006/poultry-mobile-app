import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AuthUser } from '../auth/auth.types';
import { fromDbDate, toDbDate } from '../common/dates';
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
    private readonly inventory: InventoryService,
  ) {}

  async build(user: AuthUser, farmIdIn?: string) {
    const has = (p: string) => user.permissions.includes(p);
    const farmId = await this.farms.resolve(farmIdIn);
    const today = await this.settings.today();
    const tz = await this.settings.get<string>('business.timezone');
    const start = addDays(today, -13); // 14-day window incl. today
    const monthStart = `${today.slice(0, 7)}-01`;
    const out: Record<string, unknown> = { businessDate: today, farmId, generatedAt: new Date().toISOString(), currency: await this.settings.get<string>('business.currency') };

    if (has('production.read')) out.production = await this.production(farmId, today, start);
    if (has('inventory.read')) out.inventory = await this.inventory.snapshot(farmId);
    if (has('sales.read')) out.sales = await this.sales(farmId, today, start);
    if (has('expenses.read')) out.expenses = await this.expenses(farmId, today, start, monthStart);
    if (has('payments.read') && has('expenses.read')) out.cash = await this.cash(farmId, today, tz);
    if (has('customers.financial')) out.receivables = await this.receivables(farmId);
    out.needsReview = {
      ...(has('production.read') ? { production: await this.prisma.productionRecord.count({ where: { farmId, status: 'ACTIVE', needsReview: true } }) } : {}),
      ...(has('sales.read') ? { sales: await this.prisma.sale.count({ where: { farmId, status: 'ACTIVE', needsReview: true } }) } : {}),
      ...(has('expenses.read') ? { expenses: await this.prisma.expense.count({ where: { farmId, status: 'ACTIVE', needsReview: true } }) } : {}),
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
    const recorded = await this.prisma.productionRecord.findMany({ where: { farmId, status: 'ACTIVE', productionDate: toDbDate(today) }, select: { coopId: true, shiftId: true } });
    const done = new Set(recorded.map((r) => `${r.coopId}:${r.shiftId}`));
    const trendMap = new Map(trend.map((t) => [fromDbDate(t.productionDate), t._sum.totalEggs ?? 0]));
    return {
      todayEggs: byCoop.reduce((a, c) => a + (c._sum.totalEggs ?? 0), 0),
      byCoop: coops.map((c) => ({ coopId: c.id, name: c.name, eggs: byCoop.find((x) => x.coopId === c.id)?._sum.totalEggs ?? 0 })),
      byShift: shifts.map((s) => ({ shift: s.code, eggs: byShift.find((x) => x.shiftId === s.id)?._sum.totalEggs ?? 0 })),
      notRecordedToday: coops.flatMap((c) => shifts.filter((s) => !done.has(`${c.id}:${s.id}`)).map((s) => ({ coopId: c.id, coop: c.name, shift: s.code }))),
      last14Days: days(start, today).map((date) => ({ date, eggs: trendMap.get(date) ?? 0 })),
    };
  }

  private async sales(farmId: string, today: string, start: string) {
    const where = (extra: Prisma.SaleWhereInput = {}): Prisma.SaleWhereInput => ({ farmId, status: 'ACTIVE', ...extra });
    const [t, eggs, trend] = await Promise.all([
      this.prisma.sale.aggregate({ where: where({ saleDate: toDbDate(today) }), _sum: { total: true }, _count: true }),
      this.prisma.saleItem.aggregate({ where: { sale: where({ saleDate: toDbDate(today) }) }, _sum: { baseEggs: true } }),
      this.prisma.sale.groupBy({ by: ['saleDate'], where: where({ saleDate: { gte: toDbDate(start), lte: toDbDate(today) } }), _sum: { total: true } }),
    ]);
    const m = new Map(trend.map((x) => [fromDbDate(x.saleDate), x._sum.total ?? D0]));
    return {
      todayRevenue: (t._sum.total ?? D0).toString(), todayCount: t._count, todayEggsSold: eggs._sum.baseEggs ?? 0,
      last14Days: days(start, today).map((date) => ({ date, revenue: (m.get(date) ?? D0).toString() })),
    };
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
