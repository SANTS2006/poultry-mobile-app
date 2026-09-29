import { BadRequestException, Body, ConflictException, Controller, Get, Post, Query, Res } from '@nestjs/common';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, Min } from 'class-validator';
import { Prisma } from '@prisma/client';
import type { Response } from 'express';
import { AuditService } from '../audit/audit.service';
import type { AuthUser, RequestMeta } from '../auth/auth.types';
import { CurrentUser, Meta } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { Page, PageQuery, paging } from '../common/pagination';
import { DomainEvents } from '../domain/events.service';
import { FarmService } from '../domain/farm.service';
import { PricingService } from '../domain/pricing.service';
import { SettingsService } from '../domain/settings.service';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryService } from './inventory.service';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

class AdjustmentDto {
  /** ADJUSTMENT can go either way (see `direction`); DAMAGE / LOSS / USAGE always remove stock. */
  @IsIn(['ADJUSTMENT', 'DAMAGE', 'LOSS', 'USAGE']) type!: 'ADJUSTMENT' | 'DAMAGE' | 'LOSS' | 'USAGE';
  @IsOptional() @IsIn(['INCREASE', 'DECREASE']) direction?: 'INCREASE' | 'DECREASE';
  @IsIn(['EGG', 'CRATE', 'CARTON']) unit!: 'EGG' | 'CRATE' | 'CARTON';
  @IsInt() @Min(1) @Max(10_000_000) quantity!: number;
  @Transform(trim) @IsString() @Length(5, 300) reason!: string;
  @IsOptional() @IsUUID() clientId?: string;
}

class TxQuery extends PageQuery {
  @IsOptional() @IsIn(['OPENING', 'PRODUCTION', 'SALE', 'USAGE', 'DAMAGE', 'LOSS', 'ADJUSTMENT', 'TRANSFER', 'CORRECTION']) type?: string;
  @IsOptional() @Matches(DATE) from?: string;
  @IsOptional() @Matches(DATE) to?: string;
  @IsOptional() @IsIn(['production_record', 'sale', 'adjustment']) sourceType?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) minAbs?: number;
}

@Controller('inventory')
export class InventoryController {
  constructor(
    private readonly prisma: PrismaService, private readonly inventory: InventoryService, private readonly farms: FarmService,
    private readonly pricing: PricingService, private readonly settings: SettingsService, private readonly audit: AuditService,
    private readonly events: DomainEvents,
  ) {}

  @RequirePermissions('inventory.read') @Get()
  async current() {
    return this.inventory.snapshot(await this.farms.resolve());
  }

  @RequirePermissions('inventory.read') @Get('transactions')
  async transactions(@Query() q: TxQuery): Promise<Page<unknown>> {
    const farmId = await this.farms.resolve();
    const { page, limit, skip, take } = paging(q);
    const where: Prisma.InventoryTransactionWhereInput = {
      farmId,
      ...(q.type ? { type: q.type as never } : {}),
      ...(q.sourceType ? { sourceType: q.sourceType } : {}),
      ...(q.from || q.to ? { occurredAt: { ...(q.from ? { gte: new Date(`${q.from}T00:00:00Z`) } : {}), ...(q.to ? { lt: new Date(new Date(`${q.to}T00:00:00Z`).getTime() + 86_400_000) } : {}) } } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.inventoryTransaction.findMany({ where, orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }], skip, take }),
      this.prisma.inventoryTransaction.count({ where }),
    ]);
    return {
      page, limit, total,
      items: rows.map((r) => ({ id: r.id, type: r.type, quantityEggs: r.quantityEggs, occurredAt: r.occurredAt, sourceType: r.sourceType, sourceId: r.sourceId, reason: r.reason, createdById: r.createdById, needsReview: r.needsReview })),
    };
  }

  /** The cached balance must always equal the ledger sum; this endpoint proves it. */
  @RequirePermissions('inventory.read') @Get('reconciliation')
  async reconciliation() {
    const farmId = await this.farms.resolve();
    const productId = (await this.pricing.unitsFor()).get('EGG')!.productId;
    const [{ sum }] = await this.prisma.$queryRaw<{ sum: bigint | null }[]>`
      SELECT COALESCE(SUM("quantityEggs"), 0)::bigint AS sum FROM "InventoryTransaction" WHERE "farmId" = ${farmId}::uuid AND "productId" = ${productId}::uuid`;
    const balance = await this.inventory.balance(farmId, productId);
    return { balanceEggs: balance, ledgerSumEggs: Number(sum), consistent: balance === Number(sum) };
  }

  @RequirePermissions('inventory.adjust') @Post('adjustments')
  async adjust(@CurrentUser() user: AuthUser, @Body() dto: AdjustmentDto, @Meta() meta: RequestMeta, @Res({ passthrough: true }) res: Response) {
    if (dto.type === 'ADJUSTMENT' && !dto.direction) throw new BadRequestException('direction (INCREASE or DECREASE) is required for an ADJUSTMENT.');
    if (dto.type !== 'ADJUSTMENT' && dto.direction) throw new BadRequestException('direction only applies to an ADJUSTMENT.');
    const farmId = await this.farms.resolve();
    if (dto.clientId) {
      const prior = await this.prisma.inventoryTransaction.findUnique({ where: { clientId: dto.clientId } });
      if (prior) {
        if (prior.createdById !== user.id) throw new ConflictException('This client id is already used.');
        res.status(200);
        return { id: prior.id, type: prior.type, quantityEggs: prior.quantityEggs, duplicate: true };
      }
    }
    const result = await this.prisma.$transaction(async (tx) => {
      const units = await this.pricing.unitsFor(tx);
      const unit = units.get(dto.unit)!;
      const eggs = dto.quantity * unit.eggsPerUnit;
      const signed = dto.type === 'ADJUSTMENT' && dto.direction === 'INCREASE' ? eggs : -eggs;
      const r = await this.inventory.post(tx, {
        farmId, productId: unit.productId, type: dto.type, quantityEggs: signed, occurredAt: new Date(), sourceType: 'adjustment',
        reason: dto.reason, createdById: user.id, clientId: dto.clientId,
      });
      await this.audit.record({
        action: `inventory.${dto.type.toLowerCase()}`, userId: user.id, userName: user.fullName, entityType: 'inventory_transaction', entityId: r.transactionId,
        after: { quantityEggs: signed, balanceEggs: r.balance }, reason: dto.reason, ip: meta.ip, requestId: meta.requestId,
      }, tx);
      return { id: r.transactionId, type: dto.type, quantityEggs: signed, balanceEggs: r.balance };
    });
    this.events.emit({ name: 'inventory.updated', entityId: farmId, farmId, actorId: user.id, data: { reason: 'adjustment' } });
    res.status(201);
    return result;
  }
}
