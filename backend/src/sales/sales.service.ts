import { randomBytes, randomUUID } from 'crypto';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import type { AuthUser, RequestMeta } from '../auth/auth.types';
import { deriveUuid } from '../common/derive-uuid';
import { daysBetween, fromDbDate, isValidDate, toDbDate } from '../common/dates';
import { Page, paging } from '../common/pagination';
import { CustomersService } from '../customers/customers.service';
import { DomainEvents } from '../domain/events.service';
import { FarmService } from '../domain/farm.service';
import { PricingService } from '../domain/pricing.service';
import { SettingsService } from '../domain/settings.service';
import { InventoryService } from '../inventory/inventory.service';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateSaleDto, ListSalesQuery } from './sales.dto';

const include = {
  items: { include: { productUnit: { select: { code: true } } } },
  payments: true,
  customer: { select: { id: true, name: true } },
} satisfies Prisma.SaleInclude;

type Row = Prisma.SaleGetPayload<{ include: typeof include }>;

export const presentSale = (s: Row) => ({
  id: s.id, number: s.number, saleDate: fromDbDate(s.saleDate), customer: s.customer, // null = walk-in
  items: s.items.map((i) => ({ unit: i.productUnit.code, quantity: i.quantity, baseEggs: i.baseEggs, unitPrice: i.unitPrice.toString(), lineTotal: i.lineTotal.toString() })),
  subtotal: s.subtotal.toString(), discount: s.discount.toString(), total: s.total.toString(), paidAmount: s.paidAmount.toString(),
  outstanding: s.total.minus(s.paidAmount).toString(), paymentStatus: s.paymentStatus, status: s.status,
  payments: s.payments.map((p) => ({ id: p.id, amount: p.amount.toString(), method: p.method, paidAt: p.paidAt, status: p.status })),
  notes: s.notes, needsReview: s.needsReview, createdById: s.createdById, createdAt: s.createdAt, voidedAt: s.voidedAt, voidReason: s.voidReason,
});

const newNumber = (date: string) => `S-${date.replace(/-/g, '')}-${randomBytes(4).toString('hex').toUpperCase()}`;

@Injectable()
export class SalesService {
  constructor(
    private readonly prisma: PrismaService, private readonly pricing: PricingService, private readonly inventory: InventoryService,
    private readonly audit: AuditService, private readonly events: DomainEvents, private readonly settings: SettingsService,
    private readonly farms: FarmService, private readonly customers: CustomersService,
  ) {}

  /**
   * Authenticate → permission → validate → customer → product → authoritative price → stock → server-side totals → sale, items,
   * payment → ledger → audit → COMMIT → events. Any failure rolls the whole thing back (no partial sales, no stock drift).
   */
  async create(user: AuthUser, dto: CreateSaleDto, meta: RequestMeta): Promise<{ sale: ReturnType<typeof presentSale>; created: boolean }> {
    const today = await this.settings.today();
    const date = dto.saleDate ?? today;
    if (!isValidDate(date)) throw new BadRequestException('saleDate is not a valid date.');
    if (date > today) throw new BadRequestException('A sale cannot be dated in the future.');
    const backdate = await this.settings.get<number>('sales.backdateDays');
    if (daysBetween(date, today) > backdate && !user.permissions.includes('sales.update')) {
      throw new ForbiddenException(`Sales older than ${backdate} days need a manager.`);
    }
    const discountIn = new Prisma.Decimal(dto.discount ?? 0);
    if (discountIn.gt(0) && !user.permissions.includes('sales.update')) throw new ForbiddenException('Discounts need manager approval.');
    const units = new Set<string>();
    for (const i of dto.items) {
      if (units.has(i.unit)) throw new BadRequestException(`Unit ${i.unit} appears more than once; combine the quantities.`);
      units.add(i.unit);
    }
    const farmId = await this.farms.resolve(dto.farmId);

    if (dto.clientId) {
      const prior = await this.prisma.sale.findUnique({ where: { clientId: dto.clientId }, include });
      if (prior) {
        if (prior.createdById !== user.id) throw new ConflictException('This client id is already used.');
        return { sale: presentSale(prior), created: false };
      }
    }

    let sale: Row;
    let eggs = 0;
    const saleId = randomUUID(); // known up-front so the ledger row can reference the sale it belongs to
    try {
      sale = await this.prisma.$transaction(async (tx) => {
        const unitMap = await this.pricing.unitsFor(tx);
        const at = date === today ? new Date() : new Date(`${date}T23:59:59.999Z`); // price in force on the sale date

        // customer (null = walk-in)
        const customer = dto.customerId ? await tx.customer.findFirst({ where: { id: dto.customerId, deletedAt: null } }) : null;
        if (dto.customerId && !customer) throw new BadRequestException('Unknown customer.');

        // authoritative prices + server-side arithmetic (exact decimals, never floats)
        const lines = [];
        for (const item of dto.items) {
          const unit = unitMap.get(item.unit);
          if (!unit) throw new BadRequestException(`Unit ${item.unit} is not configured.`);
          const price = await this.pricing.priceAt(tx, unit, at);
          lines.push({ unit, quantity: item.quantity, baseEggs: item.quantity * unit.eggsPerUnit, unitPrice: price, lineTotal: price.times(item.quantity) });
        }
        eggs = lines.reduce((a, l) => a + l.baseEggs, 0);
        const subtotal = lines.reduce((a, l) => a.plus(l.lineTotal), new Prisma.Decimal(0));
        if (discountIn.gt(subtotal)) throw new BadRequestException('The discount cannot exceed the subtotal.');
        const total = subtotal.minus(discountIn);
        if (total.lte(0)) throw new BadRequestException('The sale total must be greater than zero.');

        // payment / credit rules
        const paid = dto.amountPaid === undefined ? total : new Prisma.Decimal(dto.amountPaid);
        if (paid.gt(total)) throw new BadRequestException('The amount paid cannot exceed the sale total.');
        if (paid.lt(total)) {
          const creditOn = await this.settings.get<boolean>('sales.creditEnabled');
          if (!creditOn) throw new UnprocessableEntityException('Credit sales are not enabled. The sale must be paid in full.');
          if (!customer) throw new UnprocessableEntityException('Credit and part-payment sales need a registered customer.');
          if (!customer.creditAllowed) throw new UnprocessableEntityException('This customer is not approved for credit.');
          const exposure = (await this.customers.outstanding(customer.id, tx)).plus(total.minus(paid));
          if (exposure.gt(customer.creditLimit)) throw new UnprocessableEntityException('This sale would exceed the customer’s credit limit.');
        }
        const status = paid.equals(total) ? 'PAID' : paid.isZero() ? 'UNPAID' : 'PARTIAL';

        // stock (row-locked) — fails with 409 if not enough eggs
        await this.inventory.post(tx, {
          farmId, productId: unitMap.get('EGG')!.productId, type: 'SALE', quantityEggs: -eggs, occurredAt: new Date(),
          sourceType: 'sale', sourceId: saleId, createdById: user.id,
        });

        const created = await tx.sale.create({
          data: {
            id: saleId, farmId, number: newNumber(date), customerId: customer?.id ?? null, saleDate: toDbDate(date), subtotal, discount: discountIn, total,
            paidAmount: paid, paymentStatus: status, notes: dto.notes, createdById: user.id, clientId: dto.clientId,
            items: { create: lines.map((l) => ({ productId: l.unit.productId, productUnitId: l.unit.id, quantity: l.quantity, baseEggs: l.baseEggs, unitPrice: l.unitPrice, lineTotal: l.lineTotal })) },
            ...(paid.gt(0) ? { payments: { create: [{ amount: paid, method: dto.paymentMethod ?? 'CASH', paidAt: new Date(), receivedById: user.id, customerId: customer?.id ?? null, clientId: dto.clientId ? deriveUuid(dto.clientId, 0) : null }] } } : {}),
          },
          include,
        });
        await this.audit.record({
          action: 'sale.created', userId: user.id, userName: user.fullName, entityType: 'sale', entityId: created.id,
          after: { number: created.number, total: total.toString(), paid: paid.toString(), status, eggs, customerId: customer?.id ?? null }, ip: meta.ip, requestId: meta.requestId,
        }, tx);
        return created;
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002' && dto.clientId) {
        const prior = await this.prisma.sale.findUnique({ where: { clientId: dto.clientId }, include });
        if (prior && prior.createdById === user.id) return { sale: presentSale(prior), created: false };
      }
      throw e;
    }
    this.events.emit({ name: 'sale.created', entityId: sale.id, farmId, actorId: user.id, data: { paymentStatus: sale.paymentStatus, eggs } });
    this.events.emit({ name: 'inventory.updated', entityId: farmId, farmId, actorId: user.id, data: { reason: 'sale' } });
    if (sale.paidAmount.gt(0)) this.events.emit({ name: 'payment.created', entityId: sale.payments[0].id, farmId, actorId: user.id, data: { saleId: sale.id, initial: true } });
    return { sale: presentSale(sale), created: true };
  }

  async list(q: ListSalesQuery): Promise<Page<ReturnType<typeof presentSale>>> {
    const { page, limit, skip, take } = paging(q);
    const where: Prisma.SaleWhereInput = {
      status: q.status ?? 'ACTIVE',
      ...(q.customerId ? { customerId: q.customerId } : {}), ...(q.walkIn ? { customerId: null } : {}),
      ...(q.paymentStatus ? { paymentStatus: q.paymentStatus as never } : {}), ...(q.createdById ? { createdById: q.createdById } : {}),
      ...(q.needsReview ? { needsReview: q.needsReview === 'true' } : {}),
      ...(q.from || q.to ? { saleDate: { ...(q.from ? { gte: toDbDate(q.from) } : {}), ...(q.to ? { lte: toDbDate(q.to) } : {}) } } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.sale.findMany({ where, include, orderBy: [{ saleDate: 'desc' }, { createdAt: 'desc' }], skip, take }), this.prisma.sale.count({ where }),
    ]);
    return { items: rows.map(presentSale), page, limit, total };
  }

  async get(id: string) {
    const s = await this.prisma.sale.findUnique({ where: { id }, include });
    if (!s) throw new NotFoundException('Sale not found.');
    return presentSale(s);
  }

  /** Sales are immutable financial documents. A mistake is corrected by voiding (reason required) and re-entering. */
  async voidSale(user: AuthUser, id: string, reason: string, meta: RequestMeta) {
    const { sale, farmId } = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Sale" WHERE id = ${id}::uuid FOR UPDATE`;
      const cur = await tx.sale.findUnique({ where: { id }, include });
      if (!cur) throw new NotFoundException('Sale not found.');
      if (cur.status !== 'ACTIVE') throw new ConflictException('This sale is already voided.');
      const units = await this.pricing.unitsFor(tx);
      const eggs = cur.items.reduce((a, i) => a + i.baseEggs, 0);
      await this.inventory.post(tx, {
        farmId: cur.farmId, productId: units.get('EGG')!.productId, type: 'CORRECTION', quantityEggs: eggs, occurredAt: new Date(),
        sourceType: 'sale', sourceId: id, reason, createdById: user.id,
      });
      await tx.payment.updateMany({ where: { saleId: id, status: 'ACTIVE' }, data: { status: 'VOIDED' } });
      await tx.sale.update({ where: { id }, data: { status: 'VOIDED', voidedAt: new Date(), voidReason: reason } });
      await this.audit.record({
        action: 'sale.voided', userId: user.id, userName: user.fullName, entityType: 'sale', entityId: id,
        before: { status: 'ACTIVE', total: cur.total.toString(), paid: cur.paidAmount.toString() }, after: { status: 'VOIDED', eggsReturned: eggs }, reason, ip: meta.ip, requestId: meta.requestId,
      }, tx);
      return { sale: await tx.sale.findUniqueOrThrow({ where: { id }, include }), farmId: cur.farmId };
    });
    this.events.emit({ name: 'sale.updated', entityId: id, farmId, actorId: user.id, data: { status: 'VOIDED' } });
    this.events.emit({ name: 'inventory.updated', entityId: farmId, farmId, actorId: user.id, data: { reason: 'sale_void' } });
    return presentSale(sale);
  }
}
