import { BadRequestException, Injectable } from '@nestjs/common';
import type { AuthUser } from '../auth/auth.types';
import { FarmService } from '../domain/farm.service';
import { PricingService } from '../domain/pricing.service';
import { SettingsService } from '../domain/settings.service';
import { InventoryService } from '../inventory/inventory.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Reference data a device needs to work offline (coops, units, prices, customers, current stock, categories…),
 * filtered by the caller's permissions. Customers are incremental (`since` cursor, with tombstones for removed ones).
 */
@Injectable()
export class ReferenceService {
  constructor(
    private readonly prisma: PrismaService, private readonly farms: FarmService, private readonly pricing: PricingService,
    private readonly settings: SettingsService, private readonly inventory: InventoryService,
  ) {}

  async build(user: AuthUser, since?: string) {
    const has = (p: string) => user.permissions.includes(p);
    let sinceDate: Date | undefined;
    if (since) {
      sinceDate = new Date(since);
      if (Number.isNaN(sinceDate.getTime())) throw new BadRequestException('since must be an ISO timestamp.');
    }
    const cursor = new Date(); // taken BEFORE reading so nothing changed during the read is missed next time
    const farmId = await this.farms.resolve();
    const out: Record<string, unknown> = {
      serverTime: cursor.toISOString(), cursor: cursor.toISOString(), incremental: !!sinceDate, farmId,
      businessDate: await this.settings.today(),
      settings: {
        currency: await this.settings.get('business.currency'), timezone: await this.settings.get('business.timezone'),
        maxEggsPerRecord: await this.settings.get('production.maxEggsPerRecord'), productionBackdateDays: await this.settings.get('production.backdateDays'),
        salesBackdateDays: await this.settings.get('sales.backdateDays'), creditEnabled: await this.settings.get('sales.creditEnabled'),
      },
    };
    // Each block is independent, so they all run at the same time (the whole answer then takes about one database round trip, not ten).
    const jobs: Promise<void>[] = [];
    if (has('production.read') || has('production.create')) {
      jobs.push(this.prisma.coop.findMany({ where: { farmId, active: true, deletedAt: null }, orderBy: { name: 'asc' }, select: { id: true, name: true } }).then((v) => { out.coops = v; }));
      jobs.push(this.prisma.shift.findMany({ where: { active: true }, orderBy: { sortOrder: 'asc' }, select: { code: true, name: true } }).then((v) => { out.shifts = v; }));
    }
    if (has('production.create') || has('sales.create') || has('production.read') || has('sales.read')) {
      jobs.push(this.pricing.unitsFor().then((m) => { out.units = [...m.values()].map((u) => ({ code: u.code, eggsPerUnit: u.eggsPerUnit })); }));
    }
    if (has('sales.read') || has('sales.create')) {
      const now = new Date();
      // one query for every unit's current price (it used to be one query per unit)
      jobs.push(this.prisma.price.findMany({
        where: { effectiveFrom: { lte: now }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }] }, orderBy: { effectiveFrom: 'desc' }, include: { productUnit: { select: { code: true } } },
      }).then((rows) => {
        const seen = new Set<string>();
        out.prices = rows.filter((p) => !seen.has(p.productUnitId) && !!seen.add(p.productUnitId)).map((p) => ({ unit: p.productUnit.code, amount: p.amount.toString() })); // display/estimates only: the server always prices the sale itself
      }));
    }
    if (has('inventory.read')) jobs.push(this.inventory.snapshot(farmId).then((v) => { out.inventory = v; }));
    if (has('customers.read') || has('sales.create')) {
      jobs.push(this.prisma.customer.findMany({
        where: sinceDate ? { updatedAt: { gt: sinceDate } } : { deletedAt: null },
        select: { id: true, name: true, phone: true, type: true, version: true, deletedAt: true, clientId: true }, orderBy: { name: 'asc' },
      }).then((rows) => { out.customers = rows.map((c) => (c.deletedAt ? { id: c.id, deleted: true } : { id: c.id, name: c.name, phone: c.phone, type: c.type, version: c.version, clientId: c.clientId })); }));
    }
    if (has('expenses.create') || has('expenses.read')) {
      jobs.push(this.prisma.expenseCategory.findMany({ where: { active: true }, orderBy: { sortOrder: 'asc' }, select: { code: true, name: true } }).then((v) => { out.expenseCategories = v; }));
    }
    if (has('suppliers.read')) {
      jobs.push(this.prisma.supplier.findMany({ where: { active: true, deletedAt: null }, orderBy: { name: 'asc' }, select: { id: true, name: true } }).then((v) => { out.suppliers = v; }));
    }
    await Promise.all(jobs);
    return out;
  }
}
