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
    if (has('production.read') || has('production.create')) {
      out.coops = await this.prisma.coop.findMany({ where: { farmId, active: true, deletedAt: null }, orderBy: { name: 'asc' }, select: { id: true, name: true } });
      out.shifts = (await this.prisma.shift.findMany({ where: { active: true }, orderBy: { sortOrder: 'asc' }, select: { code: true, name: true } }));
    }
    if (has('production.create') || has('sales.create') || has('production.read') || has('sales.read')) {
      out.units = [...(await this.pricing.unitsFor()).values()].map((u) => ({ code: u.code, eggsPerUnit: u.eggsPerUnit }));
    }
    if (has('sales.read') || has('sales.create')) {
      const now = new Date();
      const units = await this.prisma.productUnit.findMany();
      out.prices = (await Promise.all(units.map(async (u) => {
        const p = await this.prisma.price.findFirst({ where: { productUnitId: u.id, effectiveFrom: { lte: now }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }] }, orderBy: { effectiveFrom: 'desc' } });
        return p ? { unit: u.code, amount: p.amount.toString() } : null;
      }))).filter(Boolean); // for display/estimates only: the server always prices the sale itself
    }
    if (has('inventory.read')) out.inventory = await this.inventory.snapshot(farmId);
    if (has('customers.read') || has('sales.create')) {
      const rows = await this.prisma.customer.findMany({
        where: sinceDate ? { updatedAt: { gt: sinceDate } } : { deletedAt: null },
        select: { id: true, name: true, phone: true, type: true, version: true, deletedAt: true, clientId: true }, orderBy: { name: 'asc' },
      });
      out.customers = rows.map((c) => (c.deletedAt ? { id: c.id, deleted: true } : { id: c.id, name: c.name, phone: c.phone, type: c.type, version: c.version, clientId: c.clientId }));
    }
    if (has('expenses.create') || has('expenses.read')) {
      out.expenseCategories = await this.prisma.expenseCategory.findMany({ where: { active: true }, orderBy: { sortOrder: 'asc' }, select: { code: true, name: true } });
    }
    if (has('suppliers.read')) {
      out.suppliers = await this.prisma.supplier.findMany({ where: { active: true, deletedAt: null }, orderBy: { name: 'asc' }, select: { id: true, name: true } });
    }
    return out;
  }
}
