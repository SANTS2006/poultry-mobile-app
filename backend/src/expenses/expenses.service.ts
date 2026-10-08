import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Matches, MaxLength, Min } from 'class-validator';
import { AuditService } from '../audit/audit.service';
import type { AuthUser, RequestMeta } from '../auth/auth.types';
import { daysBetween, fromDbDate, isValidDate, toDbDate } from '../common/dates';
import { Page, PageQuery, paging } from '../common/pagination';
import { DomainEvents } from '../domain/events.service';
import { FarmService } from '../domain/farm.service';
import { SettingsService } from '../domain/settings.service';
import { PrismaService } from '../prisma/prisma.service';
import { METHODS, MONEY } from '../sales/sales.dto';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const QTY = /^\d{1,9}(\.\d{1,3})?$/;
const BACKDATE_DAYS = 92; // older than this needs expenses.update

export class CreateExpenseDto {
  @IsString() @Length(2, 40) categoryCode!: string;
  @Transform(trim) @IsString() @Length(2, 300) description!: string;
  @IsOptional() @Matches(QTY, { message: 'quantity must be a decimal with at most 3 decimal places' }) quantity?: string;
  @IsOptional() @Matches(MONEY, { message: 'unitCost must be a decimal with at most 2 decimal places' }) unitCost?: string;
  /** required unless quantity × unitCost is given; when both are given they must agree */
  @IsOptional() @Matches(MONEY, { message: 'total must be a decimal with at most 2 decimal places' }) total?: string;
  @IsOptional() @Matches(DATE, { message: 'expenseDate must be YYYY-MM-DD' }) expenseDate?: string;
  @IsOptional() @IsUUID() supplierId?: string;
  @IsOptional() @IsIn(METHODS) paymentMethod?: (typeof METHODS)[number];
  @IsOptional() @Transform(trim) @IsString() @MaxLength(500) notes?: string;
  @IsOptional() @IsUUID() clientId?: string;
  @IsOptional() @IsUUID() farmId?: string;
}

export class UpdateExpenseDto {
  @IsInt() @Min(1) version!: number;
  @Transform(trim) @IsString() @Length(5, 300) reason!: string;
  @IsOptional() @IsString() @Length(2, 40) categoryCode?: string;
  @IsOptional() @Transform(trim) @IsString() @Length(2, 300) description?: string;
  @IsOptional() @Matches(QTY) quantity?: string;
  @IsOptional() @Matches(MONEY) unitCost?: string;
  @IsOptional() @Matches(MONEY) total?: string;
  @IsOptional() @Matches(DATE) expenseDate?: string;
  @IsOptional() @IsUUID() supplierId?: string;
  @IsOptional() @IsIn(METHODS) paymentMethod?: (typeof METHODS)[number];
  @IsOptional() @Transform(trim) @IsString() @MaxLength(500) notes?: string;
}

export class VoidExpenseDto { @Transform(trim) @IsString() @Length(5, 300) reason!: string; }

export class ListExpensesQuery extends PageQuery {
  @IsOptional() @Matches(DATE) from?: string;
  @IsOptional() @Matches(DATE) to?: string;
  @IsOptional() @IsString() @Length(2, 40) categoryCode?: string;
  @IsOptional() @IsUUID() supplierId?: string;
  @IsOptional() @IsUUID() recordedById?: string;
  @IsOptional() @IsIn(['true', 'false']) needsReview?: 'true' | 'false';
  @IsOptional() @IsIn(['ACTIVE', 'VOIDED']) status?: 'ACTIVE' | 'VOIDED';
  @IsOptional() @Transform(trim) @IsString() @MaxLength(100) q?: string;
}

const include = { category: { select: { code: true, name: true } }, supplier: { select: { id: true, name: true } } } satisfies Prisma.ExpenseInclude;
type Row = Prisma.ExpenseGetPayload<{ include: typeof include }>;

export const presentExpense = (e: Row) => ({
  id: e.id, category: e.category, description: e.description, quantity: e.quantity?.toString() ?? null, unitCost: e.unitCost?.toString() ?? null,
  total: e.total.toString(), expenseDate: e.expenseDate ? fromDbDate(e.expenseDate) : null, supplier: e.supplier, paymentMethod: e.paymentMethod,
  notes: e.notes, originalText: e.originalText, status: e.status, needsReview: e.needsReview, version: e.version, recordedById: e.recordedById, createdAt: e.createdAt,
});

/** total = quantity × unit cost, computed exactly on the server; a supplied total must agree. */
export function resolveTotal(q?: string | null, u?: string | null, t?: string | null): { quantity: Prisma.Decimal | null; unitCost: Prisma.Decimal | null; total: Prisma.Decimal } {
  const quantity = q ? new Prisma.Decimal(q) : null;
  const unitCost = u ? new Prisma.Decimal(u) : null;
  if ((quantity && !unitCost) || (!quantity && unitCost)) throw new BadRequestException('Give both quantity and unitCost, or neither.');
  let total: Prisma.Decimal;
  if (quantity && unitCost) {
    total = quantity.times(unitCost).toDecimalPlaces(2);
    if (t && !new Prisma.Decimal(t).equals(total)) throw new BadRequestException(`The total (${t}) does not equal quantity × unit cost (${total.toString()}).`);
  } else if (t) total = new Prisma.Decimal(t);
  else throw new BadRequestException('Provide a total, or a quantity and unit cost.');
  if (total.lte(0)) throw new BadRequestException('The total must be greater than zero.');
  return { quantity, unitCost, total };
}

@Injectable()
export class ExpensesService {
  constructor(
    private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly events: DomainEvents,
    private readonly settings: SettingsService, private readonly farms: FarmService,
  ) {}

  async create(user: AuthUser, dto: CreateExpenseDto, meta: RequestMeta) {
    const today = await this.settings.today();
    const date = dto.expenseDate ?? today;
    if (!isValidDate(date)) throw new BadRequestException('expenseDate is not a valid date.');
    if (date > today) throw new BadRequestException('An expense cannot be dated in the future.');
    if (daysBetween(date, today) > BACKDATE_DAYS && !user.permissions.includes('expenses.update')) throw new ForbiddenException('Expenses that old need a manager.');
    const amounts = resolveTotal(dto.quantity, dto.unitCost, dto.total);
    const farmId = await this.farms.resolve(dto.farmId);

    if (dto.clientId) {
      const prior = await this.prisma.expense.findUnique({ where: { clientId: dto.clientId }, include });
      if (prior) {
        if (prior.recordedById !== user.id) throw new ConflictException('This client id is already used.');
        return { expense: presentExpense(prior), created: false };
      }
    }
    // Read-only lookups happen before the transaction, side by side (each statement inside a transaction is a database round trip).
    const [category, supplier] = await Promise.all([
      this.prisma.expenseCategory.findFirst({ where: { code: dto.categoryCode, active: true } }),
      dto.supplierId ? this.prisma.supplier.findFirst({ where: { id: dto.supplierId, active: true, deletedAt: null } }) : Promise.resolve(true),
    ]);
    if (!category) throw new BadRequestException('Unknown or inactive expense category.');
    if (!supplier) throw new BadRequestException('Unknown supplier.');
    let row: Row;
    try {
      row = await this.prisma.$transaction(async (tx) => {
        const created = await tx.expense.create({
          data: {
            farmId, categoryId: category.id, supplierId: dto.supplierId, description: dto.description, quantity: amounts.quantity, unitCost: amounts.unitCost,
            total: amounts.total, expenseDate: toDbDate(date), paymentMethod: dto.paymentMethod ?? 'CASH', notes: dto.notes, recordedById: user.id, clientId: dto.clientId,
          },
          include,
        });
        await this.audit.record({
          action: 'expense.created', userId: user.id, userName: user.fullName, entityType: 'expense', entityId: created.id,
          after: { category: category.code, total: amounts.total.toString(), date }, ip: meta.ip, requestId: meta.requestId,
        }, tx);
        return created;
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002' && dto.clientId) {
        const prior = await this.prisma.expense.findUnique({ where: { clientId: dto.clientId }, include });
        if (prior && prior.recordedById === user.id) return { expense: presentExpense(prior), created: false };
      }
      throw e;
    }
    this.events.emit({ name: 'expense.created', entityId: row.id, farmId, actorId: user.id, data: { category: row.category.code } });
    return { expense: presentExpense(row), created: true };
  }

  async list(q: ListExpensesQuery): Promise<Page<ReturnType<typeof presentExpense>> & { totalAmount: string }> {
    const { page, limit, skip, take } = paging(q);
    const where: Prisma.ExpenseWhereInput = {
      status: q.status ?? 'ACTIVE',
      ...(q.categoryCode ? { category: { code: q.categoryCode } } : {}), ...(q.supplierId ? { supplierId: q.supplierId } : {}),
      ...(q.recordedById ? { recordedById: q.recordedById } : {}), ...(q.needsReview ? { needsReview: q.needsReview === 'true' } : {}),
      ...(q.q ? { description: { contains: q.q, mode: 'insensitive' as const } } : {}),
      ...(q.from || q.to ? { expenseDate: { ...(q.from ? { gte: toDbDate(q.from) } : {}), ...(q.to ? { lte: toDbDate(q.to) } : {}) } } : {}),
    };
    const [rows, total, sum] = await Promise.all([
      this.prisma.expense.findMany({ where, include, orderBy: [{ expenseDate: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }], skip, take }),
      this.prisma.expense.count({ where }), this.prisma.expense.aggregate({ where, _sum: { total: true } }),
    ]);
    return { items: rows.map(presentExpense), page, limit, total, totalAmount: (sum._sum.total ?? new Prisma.Decimal(0)).toString() };
  }

  async get(id: string) {
    const e = await this.prisma.expense.findUnique({ where: { id }, include });
    if (!e) throw new NotFoundException('Expense not found.');
    return presentExpense(e);
  }

  async update(user: AuthUser, id: string, dto: UpdateExpenseDto, meta: RequestMeta) {
    const today = await this.settings.today();
    if (dto.expenseDate && (!isValidDate(dto.expenseDate) || dto.expenseDate > today)) throw new BadRequestException('expenseDate must be a valid date that is not in the future.');
    const row = await this.prisma.$transaction(async (tx) => {
      const cur = await tx.expense.findUnique({ where: { id }, include });
      if (!cur) throw new NotFoundException('Expense not found.');
      if (cur.status !== 'ACTIVE') throw new ConflictException('A voided expense cannot be edited.');
      if (cur.version !== dto.version) throw new ConflictException(`This expense was changed by someone else (now version ${cur.version}). Reload and try again.`);
      const touchesAmount = dto.quantity !== undefined || dto.unitCost !== undefined || dto.total !== undefined;
      const amounts = touchesAmount
        ? resolveTotal(dto.quantity ?? cur.quantity?.toString(), dto.unitCost ?? cur.unitCost?.toString(), dto.total ?? (dto.quantity !== undefined || dto.unitCost !== undefined ? undefined : cur.total.toString()))
        : null;
      const category = dto.categoryCode ? await tx.expenseCategory.findFirst({ where: { code: dto.categoryCode, active: true } }) : null;
      if (dto.categoryCode && !category) throw new BadRequestException('Unknown or inactive expense category.');
      if (dto.supplierId && !(await tx.supplier.findFirst({ where: { id: dto.supplierId, active: true, deletedAt: null } }))) throw new BadRequestException('Unknown supplier.');
      const won = await tx.expense.updateMany({
        where: { id, version: dto.version },
        data: {
          version: { increment: 1 }, needsReview: false, // a person has now looked at it
          ...(category ? { categoryId: category.id } : {}), ...(dto.description !== undefined ? { description: dto.description } : {}),
          ...(amounts ? { quantity: amounts.quantity, unitCost: amounts.unitCost, total: amounts.total } : {}),
          ...(dto.expenseDate ? { expenseDate: toDbDate(dto.expenseDate) } : {}), ...(dto.supplierId ? { supplierId: dto.supplierId } : {}),
          ...(dto.paymentMethod ? { paymentMethod: dto.paymentMethod } : {}), ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
        },
      });
      if (won.count !== 1) throw new ConflictException('This expense was changed by someone else. Reload and try again.');
      const after = await tx.expense.findUniqueOrThrow({ where: { id }, include });
      await this.audit.record({
        action: 'expense.updated', userId: user.id, userName: user.fullName, entityType: 'expense', entityId: id,
        before: { category: cur.category.code, description: cur.description, total: cur.total.toString(), date: cur.expenseDate ? fromDbDate(cur.expenseDate) : null },
        after: { category: after.category.code, description: after.description, total: after.total.toString(), date: after.expenseDate ? fromDbDate(after.expenseDate) : null },
        reason: dto.reason, ip: meta.ip, requestId: meta.requestId,
      }, tx);
      return after;
    });
    this.events.emit({ name: 'expense.updated', entityId: id, farmId: row.farmId, actorId: user.id });
    return presentExpense(row);
  }

  /** Financial records are never physically deleted: voiding keeps the row and the audit trail. */
  async voidExpense(user: AuthUser, id: string, reason: string, meta: RequestMeta) {
    const row = await this.prisma.$transaction(async (tx) => {
      const cur = await tx.expense.findUnique({ where: { id } });
      if (!cur) throw new NotFoundException('Expense not found.');
      if (cur.status !== 'ACTIVE') throw new ConflictException('This expense is already voided.');
      const out = await tx.expense.update({ where: { id }, data: { status: 'VOIDED', version: { increment: 1 } }, include });
      await this.audit.record({ action: 'expense.voided', userId: user.id, userName: user.fullName, entityType: 'expense', entityId: id, before: { status: 'ACTIVE', total: cur.total.toString() }, after: { status: 'VOIDED' }, reason, ip: meta.ip, requestId: meta.requestId }, tx);
      return out;
    });
    this.events.emit({ name: 'expense.updated', entityId: id, farmId: row.farmId, actorId: user.id, data: { status: 'VOIDED' } });
    return presentExpense(row);
  }
}
