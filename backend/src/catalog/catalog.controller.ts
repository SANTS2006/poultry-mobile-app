import { BadRequestException, Body, ConflictException, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Length, Matches, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import type { AuthUser, RequestMeta } from '../auth/auth.types';
import { CurrentUser, Meta } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { FarmService } from '../domain/farm.service';
import { PricingService } from '../domain/pricing.service';
import { PrismaService } from '../prisma/prisma.service';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

class CreateCoopDto {
  @Transform(trim) @IsString() @Length(1, 60) name!: string;
  /** birds the house is built for; a planning figure, not a stock count */
  @IsOptional() @IsInt() @Min(1) @Max(1_000_000) capacity?: number;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(300) notes?: string;
}
class UpdateCoopDto {
  @IsOptional() @Transform(trim) @IsString() @Length(1, 60) name?: string;
  @IsOptional() @IsBoolean() active?: boolean;
  /** null clears it */
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsInt() @Min(1) @Max(1_000_000) capacity?: number | null;
  @IsOptional() @ValidateIf((_o, v) => v !== null) @Transform(trim) @IsString() @MaxLength(300) notes?: string | null;
}
class SetPriceDto {
  @IsIn(['EGG', 'CRATE', 'CARTON']) unit!: 'EGG' | 'CRATE' | 'CARTON';
  /** decimal string, max 2 dp — never a JS float */
  @Matches(/^\d{1,12}(\.\d{1,2})?$/, { message: 'amount must be a decimal with at most 2 decimal places' }) amount!: string;
  @Transform(trim) @IsString() @Length(5, 300) reason!: string;
}
class PriceHistoryQuery { @IsOptional() @IsIn(['EGG', 'CRATE', 'CARTON']) unit?: 'EGG' | 'CRATE' | 'CARTON'; }

const COOP_SELECT = { id: true, name: true, active: true, capacity: true, notes: true } as const;

@Controller()
export class CatalogController {
  constructor(
    private readonly prisma: PrismaService, private readonly farms: FarmService,
    private readonly pricing: PricingService, private readonly audit: AuditService,
  ) {}

  @RequirePermissions('production.read') @Get('coops')
  async coops() {
    const farmId = await this.farms.resolve();
    return this.prisma.coop.findMany({ where: { farmId, deletedAt: null }, orderBy: { name: 'asc' }, select: COOP_SELECT });
  }

  @RequirePermissions('farms.manage') @Post('coops')
  async createCoop(@CurrentUser() user: AuthUser, @Body() dto: CreateCoopDto, @Meta() meta: RequestMeta) {
    const farmId = await this.farms.resolve();
    const taken = await this.prisma.coop.findFirst({ where: { farmId, name: { equals: dto.name, mode: 'insensitive' }, deletedAt: null }, select: { id: true } });
    if (taken) throw new ConflictException('A coop with that name already exists.');
    const coop = await this.prisma.coop.create({ data: { farmId, name: dto.name, capacity: dto.capacity, notes: dto.notes || undefined }, select: COOP_SELECT });
    await this.audit.record({ action: 'coop.created', userId: user.id, userName: user.fullName, entityType: 'coop', entityId: coop.id, after: coop, ip: meta.ip, requestId: meta.requestId });
    return coop;
  }

  @RequirePermissions('farms.manage') @Patch('coops/:id')
  async updateCoop(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCoopDto, @Meta() meta: RequestMeta) {
    const before = await this.prisma.coop.findFirst({ where: { id, deletedAt: null }, select: COOP_SELECT });
    if (!before) throw new NotFoundException('Coop not found.');
    if (dto.name && dto.name.toLowerCase() !== before.name.toLowerCase()) {
      const taken = await this.prisma.coop.findFirst({ where: { farmId: (await this.farms.resolve()), id: { not: id }, name: { equals: dto.name, mode: 'insensitive' }, deletedAt: null }, select: { id: true } });
      if (taken) throw new ConflictException('A coop with that name already exists.');
    }
    const after = await this.prisma.coop.update({ where: { id }, data: { ...dto, ...(dto.notes === '' ? { notes: null } : {}) }, select: COOP_SELECT });
    await this.audit.record({ action: 'coop.updated', userId: user.id, userName: user.fullName, entityType: 'coop', entityId: id, before, after, ip: meta.ip, requestId: meta.requestId });
    return after;
  }

  /** Units with their egg conversion (single source of truth) — no prices, so production staff can use it. */
  @RequirePermissions('production.read') @Get('units')
  async units() {
    return [...(await this.pricing.unitsFor()).values()].map((u) => ({ code: u.code, eggsPerUnit: u.eggsPerUnit }));
  }

  @RequirePermissions('sales.read') @Get('products')
  async products() {
    const products = await this.prisma.product.findMany({ where: { active: true, deletedAt: null }, include: { units: true } });
    const now = new Date();
    return Promise.all(products.map(async (p) => ({
      id: p.id, code: p.code, name: p.name,
      units: await Promise.all(p.units.map(async (u) => {
        const price = await this.prisma.price.findFirst({
          where: { productUnitId: u.id, effectiveFrom: { lte: now }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }] }, orderBy: { effectiveFrom: 'desc' },
        });
        return { code: u.code, name: u.name, eggsPerUnit: u.eggsPerUnit, currentPrice: price?.amount.toString() ?? null };
      })),
    })));
  }

  @RequirePermissions('prices.manage') @Get('prices')
  async priceHistory(@Query() q: PriceHistoryQuery) {
    const rows = await this.prisma.price.findMany({
      where: q.unit ? { productUnit: { code: q.unit } } : {}, include: { productUnit: { select: { code: true } } }, orderBy: { effectiveFrom: 'desc' }, take: 200,
    });
    return rows.map((r) => ({ id: r.id, unit: r.productUnit.code, amount: r.amount.toString(), effectiveFrom: r.effectiveFrom, effectiveTo: r.effectiveTo, reason: r.reason }));
  }

  /** Prices are append-only: setting a new price closes the open one. Historical sales keep the price they were sold at. */
  @RequirePermissions('prices.manage') @Post('prices')
  async setPrice(@CurrentUser() user: AuthUser, @Body() dto: SetPriceDto, @Meta() meta: RequestMeta) {
    const amount = new Prisma.Decimal(dto.amount);
    if (amount.lte(0)) throw new BadRequestException('Price must be greater than zero.');
    return this.prisma.$transaction(async (tx) => {
      const units = await this.pricing.unitsFor(tx);
      const unit = units.get(dto.unit);
      if (!unit) throw new NotFoundException('Unit not found.');
      const now = new Date();
      const open = await tx.price.findFirst({ where: { productUnitId: unit.id, effectiveTo: null } });
      if (open) {
        if (open.amount.equals(amount)) return { unit: dto.unit, amount: amount.toString(), unchanged: true };
        await tx.price.update({ where: { id: open.id }, data: { effectiveTo: now > open.effectiveFrom ? now : new Date(open.effectiveFrom.getTime() + 1) } });
      }
      const created = await tx.price.create({
        data: { productUnitId: unit.id, amount, effectiveFrom: open && open.effectiveFrom >= now ? new Date(open.effectiveFrom.getTime() + 1) : now, changedById: user.id, reason: dto.reason },
      });
      await this.audit.record({
        action: 'price.changed', userId: user.id, userName: user.fullName, entityType: 'price', entityId: created.id,
        before: open ? { unit: dto.unit, amount: open.amount.toString() } : null, after: { unit: dto.unit, amount: amount.toString() },
        reason: dto.reason, ip: meta.ip, requestId: meta.requestId,
      }, tx);
      return { unit: dto.unit, amount: amount.toString(), effectiveFrom: created.effectiveFrom, unchanged: false };
    });
  }
}
