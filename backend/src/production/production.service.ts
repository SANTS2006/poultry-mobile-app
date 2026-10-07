import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import type { AuthUser, RequestMeta } from '../auth/auth.types';
import { daysBetween, eventTime, fromDbDate, isValidDate, toDbDate } from '../common/dates';
import { Page, paging } from '../common/pagination';
import { DomainEvents } from '../domain/events.service';
import { FarmService } from '../domain/farm.service';
import { PricingService } from '../domain/pricing.service';
import { SettingsService } from '../domain/settings.service';
import { InventoryService } from '../inventory/inventory.service';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateProductionDto, ListProductionQuery, ProductionEntryDto, UpdateProductionDto } from './production.dto';

const include = {
  entries: { include: { productUnit: { select: { code: true } } } },
  coop: { select: { id: true, name: true } },
  shift: { select: { code: true } },
} satisfies Prisma.ProductionRecordInclude;

type Row = Prisma.ProductionRecordGetPayload<{ include: typeof include }>;

export const presentProduction = (r: Row) => ({
  id: r.id, farmId: r.farmId, coop: r.coop, shift: r.shift.code, productionDate: fromDbDate(r.productionDate),
  totalEggs: r.totalEggs, entries: r.entries.map((e) => ({ unit: e.productUnit.code, quantity: e.quantity, baseEggs: e.baseEggs })),
  status: r.status, version: r.version, notes: r.notes, needsReview: r.needsReview, recordedById: r.recordedById,
  createdAt: r.createdAt, updatedAt: r.updatedAt,
});

@Injectable()
export class ProductionService {
  constructor(
    private readonly prisma: PrismaService, private readonly pricing: PricingService, private readonly inventory: InventoryService,
    private readonly audit: AuditService, private readonly events: DomainEvents, private readonly settings: SettingsService,
    private readonly farms: FarmService,
  ) {}

  async create(user: AuthUser, dto: CreateProductionDto, meta: RequestMeta): Promise<{ record: ReturnType<typeof presentProduction>; created: boolean }> {
    const today = await this.settings.today();
    const date = dto.productionDate ?? today;
    if (!isValidDate(date)) throw new BadRequestException('productionDate is not a valid date.');
    if (date > today) throw new BadRequestException('Production cannot be recorded for a future date.');
    const backdate = await this.settings.get<number>('production.backdateDays');
    if (daysBetween(date, today) > backdate && !user.permissions.includes('production.update')) {
      throw new ForbiddenException(`Entries older than ${backdate} days need a manager. Ask someone with correction rights.`);
    }
    const farmId = await this.farms.resolve(dto.farmId);
    const max = await this.settings.get<number>('production.maxEggsPerRecord');

    // Idempotent replay (offline re-send): same client id from the same user returns the original record.
    if (dto.clientId) {
      const prior = await this.prisma.productionRecord.findUnique({ where: { clientId: dto.clientId }, include });
      if (prior) {
        if (prior.recordedById !== user.id) throw new ConflictException('This client id is already used.');
        return { record: presentProduction(prior), created: false };
      }
    }

    let result: Row;
    try {
      result = await this.prisma.$transaction(async (tx) => {
        const units = await this.pricing.unitsFor(tx);
        const coop = await tx.coop.findFirst({ where: { id: dto.coopId, farmId, active: true, deletedAt: null } });
        if (!coop) throw new BadRequestException('Unknown or inactive coop.');
        const shift = await tx.shift.findUnique({ where: { code: dto.shift } });
        if (!shift || !shift.active) throw new BadRequestException('Unknown shift.');
        const { entries, total } = this.convert(dto.entries, units, max);

        const dup = await tx.productionRecord.findFirst({ where: { coopId: coop.id, shiftId: shift.id, productionDate: toDbDate(date), status: 'ACTIVE' } });
        if (dup) throw new ConflictException('Production for this coop, date and shift is already recorded. Use a correction instead.');

        const record = await tx.productionRecord.create({
          data: {
            farmId, coopId: coop.id, shiftId: shift.id, productionDate: toDbDate(date), totalEggs: total, notes: dto.notes,
            recordedById: user.id, clientId: dto.clientId,
            entries: { create: entries.map((e) => ({ productUnitId: e.unitId, quantity: e.quantity, baseEggs: e.baseEggs })) },
          },
          include,
        });
        if (total > 0) {
          await this.inventory.post(tx, {
            farmId, productId: units.get('EGG')!.productId, type: 'PRODUCTION', quantityEggs: total, occurredAt: eventTime(date, today),
            sourceType: 'production_record', sourceId: record.id, createdById: user.id,
          });
        }
        await this.audit.record({
          action: 'production.created', userId: user.id, userName: user.fullName, entityType: 'production_record', entityId: record.id,
          after: { coop: coop.name, shift: dto.shift, date, totalEggs: total }, ip: meta.ip, requestId: meta.requestId,
        }, tx);
        return record;
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        // lost a race with an identical concurrent request
        if (dto.clientId) {
          const prior = await this.prisma.productionRecord.findUnique({ where: { clientId: dto.clientId }, include });
          if (prior && prior.recordedById === user.id) return { record: presentProduction(prior), created: false };
        }
        throw new ConflictException('Production for this coop, date and shift is already recorded. Use a correction instead.');
      }
      throw e;
    }
    this.events.emit({ name: 'production.created', entityId: result.id, farmId, actorId: user.id, data: { coopId: result.coopId, shift: dto.shift, totalEggs: result.totalEggs } });
    if (result.totalEggs > 0) this.events.emit({ name: 'inventory.updated', entityId: farmId, farmId, actorId: user.id, data: { reason: 'production' } });
    return { record: presentProduction(result), created: true };
  }

  async list(q: ListProductionQuery): Promise<Page<ReturnType<typeof presentProduction>>> {
    const { page, limit, skip, take } = paging(q);
    const where: Prisma.ProductionRecordWhereInput = {
      status: q.status ?? 'ACTIVE',
      ...(q.coopId ? { coopId: q.coopId } : {}),
      ...(q.shift ? { shift: { code: q.shift } } : {}),
      ...(q.recordedById ? { recordedById: q.recordedById } : {}),
      ...(q.needsReview ? { needsReview: q.needsReview === 'true' } : {}),
      ...(q.from || q.to ? { productionDate: { ...(q.from ? { gte: toDbDate(q.from) } : {}), ...(q.to ? { lte: toDbDate(q.to) } : {}) } } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.productionRecord.findMany({ where, include, orderBy: [{ productionDate: 'desc' }, { createdAt: 'desc' }], skip, take }),
      this.prisma.productionRecord.count({ where }),
    ]);
    return { items: rows.map(presentProduction), page, limit, total };
  }

  async get(id: string) {
    const r = await this.prisma.productionRecord.findUnique({ where: { id }, include });
    if (!r) throw new NotFoundException('Production record not found.');
    return presentProduction(r);
  }

  /** Correction with optimistic locking: refuses stale edits and posts only the difference to the ledger. */
  async update(user: AuthUser, id: string, dto: UpdateProductionDto, meta: RequestMeta) {
    const max = await this.settings.get<number>('production.maxEggsPerRecord');
    const updated = await this.prisma.$transaction(async (tx) => {
      const cur = await tx.productionRecord.findUnique({ where: { id }, include });
      if (!cur) throw new NotFoundException('Production record not found.');
      if (cur.status !== 'ACTIVE') throw new ConflictException('A voided record cannot be corrected.');
      if (cur.version !== dto.version) throw new ConflictException(`This record was changed by someone else (now version ${cur.version}). Reload and try again.`);
      const units = await this.pricing.unitsFor(tx);
      const { entries, total } = this.convert(dto.entries, units, max);
      const delta = total - cur.totalEggs;

      await tx.productionEntry.deleteMany({ where: { recordId: id } });
      // compare-and-set on version guards against a concurrent correction slipping between read and write
      const won = await tx.productionRecord.updateMany({
        where: { id, version: dto.version },
        data: { totalEggs: total, version: { increment: 1 }, needsReview: false, ...(dto.notes !== undefined ? { notes: dto.notes } : {}) },
      });
      if (won.count !== 1) throw new ConflictException('This record was changed by someone else. Reload and try again.');
      await tx.productionEntry.createMany({ data: entries.map((e) => ({ recordId: id, productUnitId: e.unitId, quantity: e.quantity, baseEggs: e.baseEggs })) });
      if (delta !== 0) {
        await this.inventory.post(tx, {
          farmId: cur.farmId, productId: units.get('EGG')!.productId, type: 'CORRECTION', quantityEggs: delta, occurredAt: new Date(),
          sourceType: 'production_record', sourceId: id, reason: dto.reason, createdById: user.id,
        });
      }
      await this.audit.record({
        action: 'production.corrected', userId: user.id, userName: user.fullName, entityType: 'production_record', entityId: id,
        before: { totalEggs: cur.totalEggs, entries: cur.entries.map((e) => ({ unit: e.productUnit.code, quantity: e.quantity })) },
        after: { totalEggs: total, entries: dto.entries }, reason: dto.reason, ip: meta.ip, requestId: meta.requestId,
      }, tx);
      return tx.productionRecord.findUniqueOrThrow({ where: { id }, include });
    });
    this.events.emit({ name: 'production.updated', entityId: id, farmId: updated.farmId, actorId: user.id, data: { totalEggs: updated.totalEggs } });
    this.events.emit({ name: 'inventory.updated', entityId: updated.farmId, farmId: updated.farmId, actorId: user.id, data: { reason: 'production_correction' } });
    return presentProduction(updated);
  }

  async voidRecord(user: AuthUser, id: string, reason: string, meta: RequestMeta) {
    const voided = await this.prisma.$transaction(async (tx) => {
      const cur = await tx.productionRecord.findUnique({ where: { id }, include });
      if (!cur) throw new NotFoundException('Production record not found.');
      if (cur.status !== 'ACTIVE') throw new ConflictException('This record is already voided.');
      const units = await this.pricing.unitsFor(tx);
      await tx.productionRecord.update({ where: { id }, data: { status: 'VOIDED', version: { increment: 1 } } });
      if (cur.totalEggs > 0) {
        await this.inventory.post(tx, {
          farmId: cur.farmId, productId: units.get('EGG')!.productId, type: 'CORRECTION', quantityEggs: -cur.totalEggs, occurredAt: new Date(),
          sourceType: 'production_record', sourceId: id, reason, createdById: user.id,
        });
      }
      await this.audit.record({
        action: 'production.voided', userId: user.id, userName: user.fullName, entityType: 'production_record', entityId: id,
        before: { totalEggs: cur.totalEggs, status: 'ACTIVE' }, after: { status: 'VOIDED' }, reason, ip: meta.ip, requestId: meta.requestId,
      }, tx);
      return tx.productionRecord.findUniqueOrThrow({ where: { id }, include });
    });
    this.events.emit({ name: 'production.updated', entityId: id, farmId: voided.farmId, actorId: user.id, data: { status: 'VOIDED' } });
    this.events.emit({ name: 'inventory.updated', entityId: voided.farmId, farmId: voided.farmId, actorId: user.id, data: { reason: 'production_void' } });
    return presentProduction(voided);
  }

  private convert(input: ProductionEntryDto[], units: Awaited<ReturnType<PricingService['unitsFor']>>, max: number) {
    const seen = new Set<string>();
    const entries = input.map((e) => {
      if (seen.has(e.unit)) throw new BadRequestException(`Unit ${e.unit} appears more than once.`);
      seen.add(e.unit);
      const u = units.get(e.unit);
      if (!u) throw new BadRequestException(`Unit ${e.unit} is not configured.`);
      return { unitId: u.id, quantity: e.quantity, baseEggs: e.quantity * u.eggsPerUnit };
    });
    const total = entries.reduce((a, e) => a + e.baseEggs, 0);
    if (total > max) throw new BadRequestException(`That is more than ${max} eggs for one shift. Please check the numbers.`);
    return { entries, total };
  }
}
