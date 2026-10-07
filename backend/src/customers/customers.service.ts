import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEmail, IsIn, IsInt, IsBoolean, IsOptional, IsString, IsUUID, Length, Matches, MaxLength, Min } from 'class-validator';
import { AuditService } from '../audit/audit.service';
import type { AuthUser, RequestMeta } from '../auth/auth.types';
import { Page, PageQuery, paging } from '../common/pagination';
import { DomainEvents } from '../domain/events.service';
import { PrismaService } from '../prisma/prisma.service';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const MONEY = /^\d{1,12}(\.\d{1,2})?$/;

export class CreateCustomerDto {
  @Transform(trim) @IsString() @Length(2, 100) name!: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(30) phone?: string;
  @IsOptional() @Transform(trim) @IsEmail() @MaxLength(254) email?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(300) address?: string;
  @IsOptional() @IsIn(['REGULAR', 'WHOLESALE']) type?: 'REGULAR' | 'WHOLESALE';
  @IsOptional() @Transform(trim) @IsString() @MaxLength(500) notes?: string;
  /** credit terms need the customers.financial permission */
  @IsOptional() @IsBoolean() creditAllowed?: boolean;
  @IsOptional() @Matches(MONEY, { message: 'creditLimit must be a decimal with at most 2 decimal places' }) creditLimit?: string;
  @IsOptional() @IsUUID() clientId?: string;
}

export class UpdateCustomerDto {
  @IsInt() @Min(1) version!: number;
  @IsOptional() @Transform(trim) @IsString() @Length(2, 100) name?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(30) phone?: string;
  @IsOptional() @Transform(trim) @IsEmail() @MaxLength(254) email?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(300) address?: string;
  @IsOptional() @IsIn(['REGULAR', 'WHOLESALE']) type?: 'REGULAR' | 'WHOLESALE';
  @IsOptional() @Transform(trim) @IsString() @MaxLength(500) notes?: string;
  @IsOptional() @IsBoolean() creditAllowed?: boolean;
  @IsOptional() @Matches(MONEY) creditLimit?: string;
}

export class ListCustomersQuery extends PageQuery {
  @IsOptional() @Transform(trim) @IsString() @MaxLength(100) q?: string;
  @IsOptional() @IsIn(['REGULAR', 'WHOLESALE']) type?: string;
}

const can = (u: AuthUser) => u.permissions.includes('customers.financial');

@Injectable()
export class CustomersService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly events: DomainEvents) {}

  /** Outstanding = Σ(total − paid) over the customer's ACTIVE sales. Derived, never typed. */
  async outstanding(customerId: string, db: Prisma.TransactionClient | PrismaService = this.prisma): Promise<Prisma.Decimal> {
    const r = await db.sale.aggregate({ where: { customerId, status: 'ACTIVE' }, _sum: { total: true, paidAmount: true } });
    return (r._sum.total ?? new Prisma.Decimal(0)).minus(r._sum.paidAmount ?? new Prisma.Decimal(0));
  }

  private async present(c: Prisma.CustomerGetPayload<object>, viewer: AuthUser) {
    const base = { id: c.id, name: c.name, phone: c.phone, email: c.email, address: c.address, type: c.type, notes: c.notes, version: c.version, createdAt: c.createdAt };
    if (!can(viewer)) return base; // financial data is permission-controlled
    return { ...base, creditAllowed: c.creditAllowed, creditLimit: c.creditLimit.toString(), outstandingBalance: (await this.outstanding(c.id)).toString() };
  }

  async create(user: AuthUser, dto: CreateCustomerDto, meta: RequestMeta) {
    if ((dto.creditAllowed !== undefined || dto.creditLimit !== undefined) && !can(user)) {
      throw new ForbiddenException('You do not have permission to set credit terms.');
    }
    if (dto.clientId) {
      const prior = await this.prisma.customer.findUnique({ where: { clientId: dto.clientId } });
      if (prior) return { customer: await this.present(prior, user), created: false };
    }
    const c = await this.prisma.$transaction(async (tx) => {
      const row = await tx.customer.create({
        data: {
          name: dto.name, phone: dto.phone, email: dto.email?.toLowerCase(), address: dto.address, notes: dto.notes, type: dto.type ?? 'REGULAR',
          creditAllowed: dto.creditAllowed ?? false, creditLimit: new Prisma.Decimal(dto.creditLimit ?? 0), clientId: dto.clientId,
        },
      });
      await this.audit.record({ action: 'customer.created', userId: user.id, userName: user.fullName, entityType: 'customer', entityId: row.id, after: { name: row.name, type: row.type }, ip: meta.ip, requestId: meta.requestId }, tx);
      return row;
    });
    this.events.emit({ name: 'customer.created', entityId: c.id, actorId: user.id });
    return { customer: await this.present(c, user), created: true };
  }

  async list(user: AuthUser, q: ListCustomersQuery): Promise<Page<unknown>> {
    const { page, limit, skip, take } = paging(q);
    const where: Prisma.CustomerWhereInput = {
      deletedAt: null, ...(q.type ? { type: q.type as never } : {}),
      ...(q.q ? { OR: [{ name: { contains: q.q, mode: 'insensitive' } }, { phone: { contains: q.q } }] } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.customer.findMany({ where, orderBy: { name: 'asc' }, skip, take }), this.prisma.customer.count({ where }),
    ]);
    return { items: await Promise.all(rows.map((r) => this.present(r, user))), page, limit, total };
  }

  async get(user: AuthUser, id: string) {
    const c = await this.prisma.customer.findFirst({ where: { id, deletedAt: null } });
    if (!c) throw new NotFoundException('Customer not found.');
    return this.present(c, user);
  }

  /** Sales + payment history (financial permission required). */
  async statement(id: string) {
    const c = await this.prisma.customer.findFirst({ where: { id, deletedAt: null } });
    if (!c) throw new NotFoundException('Customer not found.');
    const [sales, payments] = await Promise.all([
      this.prisma.sale.findMany({ where: { customerId: id }, orderBy: { saleDate: 'desc' }, take: 200, select: { id: true, number: true, saleDate: true, total: true, paidAmount: true, paymentStatus: true, status: true } }),
      this.prisma.payment.findMany({ where: { customerId: id }, orderBy: { paidAt: 'desc' }, take: 200, select: { id: true, saleId: true, amount: true, method: true, paidAt: true, status: true } }),
    ]);
    return {
      customerId: id, outstandingBalance: (await this.outstanding(id)).toString(),
      sales: sales.map((s) => ({ ...s, saleDate: s.saleDate.toISOString().slice(0, 10), total: s.total.toString(), paidAmount: s.paidAmount.toString() })),
      payments: payments.map((p) => ({ ...p, amount: p.amount.toString() })),
    };
  }

  async update(user: AuthUser, id: string, dto: UpdateCustomerDto, meta: RequestMeta) {
    if ((dto.creditAllowed !== undefined || dto.creditLimit !== undefined) && !can(user)) throw new ForbiddenException('You do not have permission to change credit terms.');
    const { version, ...fields } = dto;
    const out = await this.prisma.$transaction(async (tx) => {
      const cur = await tx.customer.findFirst({ where: { id, deletedAt: null } });
      if (!cur) throw new NotFoundException('Customer not found.');
      if (cur.version !== version) throw new ConflictException(`This customer was changed by someone else (now version ${cur.version}). Reload and try again.`);
      const data: Prisma.CustomerUpdateManyMutationInput = {
        ...(fields.name !== undefined ? { name: fields.name } : {}), ...(fields.phone !== undefined ? { phone: fields.phone } : {}),
        ...(fields.email !== undefined ? { email: fields.email.toLowerCase() } : {}), ...(fields.address !== undefined ? { address: fields.address } : {}),
        ...(fields.type !== undefined ? { type: fields.type } : {}), ...(fields.notes !== undefined ? { notes: fields.notes } : {}),
        ...(fields.creditAllowed !== undefined ? { creditAllowed: fields.creditAllowed } : {}),
        ...(fields.creditLimit !== undefined ? { creditLimit: new Prisma.Decimal(fields.creditLimit) } : {}),
        version: { increment: 1 },
      };
      const won = await tx.customer.updateMany({ where: { id, version }, data });
      if (won.count !== 1) throw new ConflictException('This customer was changed by someone else. Reload and try again.');
      const row = await tx.customer.findUniqueOrThrow({ where: { id } });
      await this.audit.record({
        action: 'customer.updated', userId: user.id, userName: user.fullName, entityType: 'customer', entityId: id,
        before: { name: cur.name, phone: cur.phone, type: cur.type, creditAllowed: cur.creditAllowed, creditLimit: cur.creditLimit.toString() },
        after: { name: row.name, phone: row.phone, type: row.type, creditAllowed: row.creditAllowed, creditLimit: row.creditLimit.toString() }, ip: meta.ip, requestId: meta.requestId,
      }, tx);
      return row;
    });
    this.events.emit({ name: 'customer.updated', entityId: id, actorId: user.id });
    return this.present(out, user);
  }
}

