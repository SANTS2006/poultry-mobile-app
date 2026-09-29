import { ConflictException, Injectable } from '@nestjs/common';
import { InventoryTxType, Prisma } from '@prisma/client';
import { PricingService } from '../domain/pricing.service';
import { SettingsService } from '../domain/settings.service';
import { PrismaService } from '../prisma/prisma.service';

export interface LedgerEntry {
  farmId: string;
  productId: string;
  type: InventoryTxType;
  /** signed: positive adds stock, negative removes it */
  quantityEggs: number;
  occurredAt: Date;
  sourceType?: string;
  sourceId?: string;
  reason?: string;
  createdById?: string;
  clientId?: string;
}

/**
 * The ONLY writer of stock. Every change is an append-only ledger row plus an atomic update of the cached balance, inside the
 * caller's transaction. The balance row is locked (SELECT … FOR UPDATE) so concurrent sales cannot both spend the last eggs.
 * Negative stock is impossible: it is checked here and enforced again by a database CHECK constraint.
 */
@Injectable()
export class InventoryService {
  constructor(private readonly prisma: PrismaService, private readonly pricing: PricingService, private readonly settings: SettingsService) {}

  async post(tx: Prisma.TransactionClient, e: LedgerEntry): Promise<{ balance: number; transactionId: string }> {
    await tx.$executeRaw`
      INSERT INTO "InventoryBalance" ("farmId", "productId", "quantityEggs", "updatedAt")
      VALUES (${e.farmId}::uuid, ${e.productId}::uuid, 0, now()) ON CONFLICT DO NOTHING`;
    const rows = await tx.$queryRaw<{ quantityEggs: number }[]>`
      SELECT "quantityEggs" FROM "InventoryBalance" WHERE "farmId" = ${e.farmId}::uuid AND "productId" = ${e.productId}::uuid FOR UPDATE`;
    const current = rows[0].quantityEggs;
    const next = current + e.quantityEggs;
    if (next < 0) {
      throw new ConflictException(`Insufficient stock: ${current} eggs available, ${-e.quantityEggs} requested.`);
    }
    const t = await tx.inventoryTransaction.create({
      data: {
        farmId: e.farmId, productId: e.productId, type: e.type, quantityEggs: e.quantityEggs, occurredAt: e.occurredAt,
        sourceType: e.sourceType, sourceId: e.sourceId, reason: e.reason, createdById: e.createdById, clientId: e.clientId,
      },
    });
    await tx.inventoryBalance.update({
      where: { farmId_productId: { farmId: e.farmId, productId: e.productId } }, data: { quantityEggs: next },
    });
    return { balance: next, transactionId: t.id };
  }

  async balance(farmId: string, productId: string): Promise<number> {
    const b = await this.prisma.inventoryBalance.findUnique({ where: { farmId_productId: { farmId, productId } } });
    return b?.quantityEggs ?? 0;
  }

  /** Current stock with a carton/crate/egg breakdown (conversion factors come from the unit table) and the low-stock flag. */
  async snapshot(farmId: string) {
    const units = await this.pricing.unitsFor();
    const productId = units.get('EGG')!.productId;
    const eggs = await this.balance(farmId, productId);
    const carton = units.get('CARTON')?.eggsPerUnit ?? 360;
    const crate = units.get('CRATE')?.eggsPerUnit ?? 30;
    const threshold = await this.settings.get<number>('inventory.lowStockThresholdEggs');
    return {
      farmId, productId, quantityEggs: eggs,
      breakdown: { cartons: Math.floor(eggs / carton), crates: Math.floor((eggs % carton) / crate), eggs: eggs % crate },
      lowStock: typeof threshold === 'number' && eggs < threshold, lowStockThresholdEggs: threshold,
    };
  }
}
