import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TtlCache } from '../common/cache';
import { PrismaService } from '../prisma/prisma.service';

export type UnitCode = 'EGG' | 'CRATE' | 'CARTON';

export interface UnitInfo { id: string; code: UnitCode; eggsPerUnit: number; productId: string }

@Injectable()
export class PricingService {
  /** The unit table (egg / crate / carton) is configuration: read once a minute instead of on every record. */
  private readonly units = new TtlCache<Map<UnitCode, UnitInfo>>(60_000);

  constructor(private readonly prisma: PrismaService) {}

  /** The unit table is the single source of truth for egg conversion (never hard-coded in business logic). */
  async unitsFor(client: Prisma.TransactionClient | PrismaService = this.prisma, productCode = 'TABLE_EGG'): Promise<Map<UnitCode, UnitInfo>> {
    return this.units.get(productCode, async () => {
      const product = await client.product.findUnique({ where: { code: productCode }, include: { units: true } });
      if (!product || product.deletedAt || !product.active) throw new UnprocessableEntityException('The egg product is not configured.');
      return new Map(product.units.map((u) => [u.code as UnitCode, { id: u.id, code: u.code as UnitCode, eggsPerUnit: u.eggsPerUnit, productId: product.id }]));
    });
  }

  /** Authoritative price at a point in time; sales never trust a client-supplied price. */
  async priceAt(client: Prisma.TransactionClient | PrismaService, unit: UnitInfo, at: Date): Promise<Prisma.Decimal> {
    const price = await client.price.findFirst({
      where: { productUnitId: unit.id, effectiveFrom: { lte: at }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }] },
      orderBy: { effectiveFrom: 'desc' },
    });
    if (!price) throw new UnprocessableEntityException(`No price is configured for ${unit.code.toLowerCase()}. Ask an administrator to set one.`);
    return price.amount;
  }
}
