import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, IsUUID, Length, Matches, MaxLength } from 'class-validator';
import { AuditService } from '../audit/audit.service';
import type { AuthUser, RequestMeta } from '../auth/auth.types';
import { deriveUuid } from '../common/derive-uuid';
import { toDbDate } from '../common/dates';
import { Page, PageQuery, paging } from '../common/pagination';
import { DomainEvents } from '../domain/events.service';
import { PrismaService } from '../prisma/prisma.service';
import { METHODS, MONEY } from '../sales/sales.dto';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export class CreatePaymentDto {
  /** exactly one of saleId / customerId */
  @IsOptional() @IsUUID() saleId?: string;
  @IsOptional() @IsUUID() customerId?: string;
  @Matches(MONEY, { message: 'amount must be a decimal with at most 2 decimal places' }) amount!: string;
  @IsOptional() @IsIn(METHODS) method?: (typeof METHODS)[number];
  @IsOptional() @Transform(trim) @IsString() @MaxLength(100) reference?: string;
  @IsOptional() @IsUUID() clientId?: string;
}

export class VoidPaymentDto { @Transform(trim) @IsString() @Length(5, 300) reason!: string; }

export class ListPaymentsQuery extends PageQuery {
  @IsOptional() @IsUUID() saleId?: string;
  @IsOptional() @IsUUID() customerId?: string;
  @IsOptional() @Matches(DATE) from?: string;
  @IsOptional() @Matches(DATE) to?: string;
  @IsOptional() @IsIn(METHODS) method?: string;
  @IsOptional() @IsIn(['ACTIVE', 'VOIDED']) status?: 'ACTIVE' | 'VOIDED';
}

const present = (p: Prisma.PaymentGetPayload<object>) => ({
  id: p.id, saleId: p.saleId, customerId: p.customerId, amount: p.amount.toString(), method: p.method, paidAt: p.paidAt,
  receivedById: p.receivedById, reference: p.reference, status: p.status,
});

@Injectable()
export class PaymentsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly events: DomainEvents) {}

  /**
   * Records money received. Against a sale: at most its outstanding amount. Against a customer: allocated oldest-sale-first.
   * Overpayment is refused (no unallocated "credit balances"), and sale rows are locked so two cashiers cannot overpay one sale.
   */
  async create(user: AuthUser, dto: CreatePaymentDto, meta: RequestMeta): Promise<{ payments: ReturnType<typeof present>[]; allocations: { saleId: string; number: string; amount: string }[]; created: boolean }> {
    if (!!dto.saleId === !!dto.customerId) throw new BadRequestException('Provide exactly one of saleId or customerId.');
    const amount = new Prisma.Decimal(dto.amount);
    if (amount.lte(0)) throw new BadRequestException('The amount must be greater than zero.');

    if (dto.clientId) {
      const prior = await this.prisma.payment.findMany({ where: { clientId: { in: Array.from({ length: 50 }, (_, i) => deriveUuid(dto.clientId as string, i)) } }, orderBy: { paidAt: 'asc' } });
      if (prior.length) {
        if (prior.some((p) => p.receivedById !== user.id)) throw new ConflictException('This client id is already used.');
        const sales = await this.prisma.sale.findMany({ where: { id: { in: prior.map((p) => p.saleId as string) } }, select: { id: true, number: true } });
        return { payments: prior.map(present), allocations: prior.map((p) => ({ saleId: p.saleId as string, number: sales.find((s) => s.id === p.saleId)?.number ?? '', amount: p.amount.toString() })), created: false };
      }
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const targets = dto.saleId
        ? await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Sale" WHERE id = ${dto.saleId}::uuid AND status = 'ACTIVE' FOR UPDATE`
        : await tx.$queryRaw<{ id: string }[]>`
            SELECT id FROM "Sale" WHERE "customerId" = ${dto.customerId}::uuid AND status = 'ACTIVE' AND "paidAmount" < total
            ORDER BY "saleDate" ASC, "createdAt" ASC FOR UPDATE`;
      if (dto.saleId && targets.length === 0) throw new NotFoundException('Sale not found or not active.');
      if (dto.customerId) {
        const c = await tx.customer.findFirst({ where: { id: dto.customerId, deletedAt: null }, select: { id: true } });
        if (!c) throw new NotFoundException('Customer not found.');
      }
      const sales = await tx.sale.findMany({ where: { id: { in: targets.map((t) => t.id) } }, orderBy: [{ saleDate: 'asc' }, { createdAt: 'asc' }] });
      const outstanding = sales.reduce((a, s) => a.plus(s.total.minus(s.paidAmount)), new Prisma.Decimal(0));
      if (amount.gt(outstanding)) {
        throw new BadRequestException(`The payment (${amount}) is more than the amount outstanding (${outstanding}).`);
      }
      let left = amount;
      const payments = [];
      const allocations = [];
      let i = 0;
      for (const s of sales) {
        if (left.lte(0)) break;
        const due = s.total.minus(s.paidAmount);
        const slice = Prisma.Decimal.min(due, left);
        if (slice.lte(0)) continue;
        left = left.minus(slice);
        const newPaid = s.paidAmount.plus(slice);
        await tx.sale.update({ where: { id: s.id }, data: { paidAmount: newPaid, paymentStatus: newPaid.equals(s.total) ? 'PAID' : 'PARTIAL' } });
        const p = await tx.payment.create({
          data: { saleId: s.id, customerId: s.customerId, amount: slice, method: dto.method ?? 'CASH', paidAt: new Date(), receivedById: user.id, reference: dto.reference, clientId: dto.clientId ? deriveUuid(dto.clientId, i) : null },
        });
        i++;
        payments.push(p);
        allocations.push({ saleId: s.id, number: s.number, amount: slice.toString() });
      }
      await this.audit.record({
        action: 'payment.created', userId: user.id, userName: user.fullName, entityType: dto.saleId ? 'sale' : 'customer', entityId: (dto.saleId ?? dto.customerId) as string,
        after: { amount: amount.toString(), method: dto.method ?? 'CASH', allocations }, ip: meta.ip, requestId: meta.requestId,
      }, tx);
      return { payments, allocations };
    });
    for (const p of result.payments) {
      this.events.emit({ name: 'payment.created', entityId: p.id, actorId: user.id, data: { saleId: p.saleId } });
      this.events.emit({ name: 'sale.updated', entityId: p.saleId as string, actorId: user.id, data: { reason: 'payment' } });
    }
    return { payments: result.payments.map(present), allocations: result.allocations, created: true };
  }

  async list(q: ListPaymentsQuery): Promise<Page<ReturnType<typeof present>>> {
    const { page, limit, skip, take } = paging(q);
    const where: Prisma.PaymentWhereInput = {
      status: q.status ?? 'ACTIVE', ...(q.saleId ? { saleId: q.saleId } : {}), ...(q.customerId ? { customerId: q.customerId } : {}),
      ...(q.method ? { method: q.method as never } : {}),
      ...(q.from || q.to ? { paidAt: { ...(q.from ? { gte: toDbDate(q.from) } : {}), ...(q.to ? { lt: new Date(toDbDate(q.to).getTime() + 86_400_000) } : {}) } } : {}),
    };
    const [rows, total] = await Promise.all([this.prisma.payment.findMany({ where, orderBy: { paidAt: 'desc' }, skip, take }), this.prisma.payment.count({ where })]);
    return { items: rows.map(present), page, limit, total };
  }

  /** Reverses a payment (reason required); the sale's paid amount and status are recomputed under lock. */
  async voidPayment(user: AuthUser, id: string, reason: string, meta: RequestMeta) {
    const out = await this.prisma.$transaction(async (tx) => {
      const p = await tx.payment.findUnique({ where: { id } });
      if (!p) throw new NotFoundException('Payment not found.');
      if (p.status !== 'ACTIVE') throw new ConflictException('This payment is already voided.');
      if (p.saleId) {
        await tx.$queryRaw`SELECT id FROM "Sale" WHERE id = ${p.saleId}::uuid FOR UPDATE`;
        const sale = await tx.sale.findUniqueOrThrow({ where: { id: p.saleId } });
        const paid = sale.paidAmount.minus(p.amount);
        await tx.sale.update({ where: { id: sale.id }, data: { paidAmount: paid, paymentStatus: paid.isZero() ? 'UNPAID' : paid.equals(sale.total) ? 'PAID' : 'PARTIAL' } });
      }
      await tx.payment.update({ where: { id }, data: { status: 'VOIDED' } });
      await this.audit.record({ action: 'payment.voided', userId: user.id, userName: user.fullName, entityType: 'payment', entityId: id, before: { amount: p.amount.toString(), status: 'ACTIVE' }, after: { status: 'VOIDED' }, reason, ip: meta.ip, requestId: meta.requestId }, tx);
      return tx.payment.findUniqueOrThrow({ where: { id } });
    });
    if (out.saleId) this.events.emit({ name: 'sale.updated', entityId: out.saleId, actorId: user.id, data: { reason: 'payment_void' } });
    return present(out);
  }
}
