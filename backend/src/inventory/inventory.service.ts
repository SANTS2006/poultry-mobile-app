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
    // ONE statement changes the balance: it locks the row, refuses to go below zero, and returns the new level. (It used to be four
    // statements — create row, lock, read, update — and every statement is a network round trip to the database.)
    let next: number | null;
    if (e.quantityEggs >= 0) {
      const rows = await tx.$queryRaw<{ quantityEggs: number }[]>`
        INSERT INTO "InventoryBalance" ("farmId", "productId", "quantityEggs", "updatedAt")
        VALUES (${e.farmId}::uuid, ${e.productId}::uuid, ${e.quantityEggs}, now())
        ON CONFLICT ("farmId", "productId") DO UPDATE SET "quantityEggs" = "InventoryBalance"."quantityEggs" + EXCLUDED."quantityEggs", "updatedAt" = now()
        RETURNING "quantityEggs"`;
      next = rows[0]?.quantityEggs ?? null;
    } else {
      const rows = await tx.$queryRaw<{ quantityEggs: number }[]>`
        UPDATE "InventoryBalance" SET "quantityEggs" = "quantityEggs" + ${e.quantityEggs}, "updatedAt" = now()
        WHERE "farmId" = ${e.farmId}::uuid AND "productId" = ${e.productId}::uuid AND "quantityEggs" + ${e.quantityEggs} >= 0
        RETURNING "quantityEggs"`;
      next = rows[0]?.quantityEggs ?? null;
    }
    if (next === null) {
      // Nothing was updated: not enough stock (or no balance row yet, which means zero eggs). Only now do we read the current level, for the message.
      const current = await this.balance(e.farmId, e.productId, tx);
      throw new ConflictException(`Insufficient stock: ${current} eggs available, ${-e.quantityEggs} requested.`);
    }
    const t = await tx.inventoryTransaction.create({
      data: {
        farmId: e.farmId, productId: e.productId, type: e.type, quantityEggs: e.quantityEggs, occurredAt: e.occurredAt,
        sourceType: e.sourceType, sourceId: e.sourceId, reason: e.reason, createdById: e.createdById, clientId: e.clientId,
      },
    });
    return { balance: next, transactionId: t.id };
  }

  async balance(farmId: string, productId: string, client: Prisma.TransactionClient | PrismaService = this.prisma): Promise<number> {
    const b = await client.inventoryBalance.findUnique({ where: { farmId_productId: { farmId, productId } } });
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
