import { HttpException, Injectable } from '@nestjs/common';
import { Prisma, SyncStatus } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate, ValidationError } from 'class-validator';
import { PinoLogger } from 'nestjs-pino';
import { AuditService } from '../audit/audit.service';
import { DomainEvents } from '../domain/events.service';
import type { AuthUser, RequestMeta } from '../auth/auth.types';
import { CustomersService, CreateCustomerDto } from '../customers/customers.service';
import { CreateExpenseDto, ExpensesService } from '../expenses/expenses.service';
import { CreatePaymentDto, PaymentsService } from '../payments/payments.service';
import { CreateProductionDto } from '../production/production.dto';
import { ProductionService } from '../production/production.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateSaleDto } from '../sales/sales.dto';
import { SalesService } from '../sales/sales.service';
import type { OfflineOperation, OperationResult, SyncOperationDto } from './sync.dto';

const REQUIRED_PERMISSION: Record<OfflineOperation, string> = {
  'production.create': 'production.create',
  'sale.create': 'sales.create',
  'expense.create': 'expenses.create',
  'customer.create': 'customers.create',
  'payment.create': 'payments.create',
};

const ENTITY: Record<OfflineOperation, string> = {
  'production.create': 'production_record', 'sale.create': 'sale', 'expense.create': 'expense', 'customer.create': 'customer', 'payment.create': 'payment',
};

const DTO = { 'production.create': CreateProductionDto, 'sale.create': CreateSaleDto, 'expense.create': CreateExpenseDto, 'customer.create': CreateCustomerDto, 'payment.create': CreatePaymentDto } as const;

const STATUS_TO_DB: Record<OperationResult['status'], SyncStatus | null> = {
  accepted: 'ACCEPTED', duplicate: 'DUPLICATE', rejected: 'REJECTED', conflict: 'CONFLICT', error: null, // transient errors are never recorded as an outcome
};

/**
 * Applies operations queued on a device. Each operation goes through exactly the same services (and therefore the same validation,
 * server-side pricing, stock checks, audit and events) as the online API, one at a time and in the order sent. One bad operation
 * never fails the batch, and nothing is ever dropped: every operation gets an explicit result the device must act on.
 */
@Injectable()
export class SyncService {
  constructor(
    private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly logger: PinoLogger, private readonly events: DomainEvents,
    private readonly production: ProductionService, private readonly sales: SalesService, private readonly expenses: ExpensesService,
    private readonly customers: CustomersService, private readonly payments: PaymentsService,
  ) {
    this.logger.setContext(SyncService.name);
  }

  async push(user: AuthUser, deviceId: string | undefined, ops: SyncOperationDto[], meta: RequestMeta): Promise<OperationResult[]> {
    const results: OperationResult[] = [];
    for (const op of ops) results.push(await this.applyOne(user, deviceId, op, meta));
    const count = (s: string) => results.filter((r) => r.status === s).length;
    await this.audit.record({
      action: 'sync.push', userId: user.id, userName: user.fullName, entityType: 'device', entityId: deviceId,
      after: { operations: ops.length, accepted: count('accepted'), duplicate: count('duplicate'), rejected: count('rejected'), conflict: count('conflict'), error: count('error') },
      ip: meta.ip, requestId: meta.requestId,
    });
    this.events.emit({
      name: 'sync.completed', entityId: user.id, actorId: user.id,
      data: { accepted: count('accepted'), duplicate: count('duplicate'), rejected: count('rejected'), conflict: count('conflict'), error: count('error') },
    });
    return results;
  }

  private async applyOne(user: AuthUser, deviceId: string | undefined, op: SyncOperationDto, meta: RequestMeta): Promise<OperationResult> {
    const base = { clientId: op.clientId, entityType: ENTITY[op.type] };
    const done = (r: Omit<OperationResult, 'clientId' | 'entityType'>): Promise<OperationResult> => this.finish(user, deviceId, op, { ...base, ...r });

    const prior = await this.prisma.syncOperation.findUnique({ where: { clientId: op.clientId } });
    if (prior && prior.userId !== user.id) {
      return { ...base, status: 'rejected', code: 'CLIENT_ID_IN_USE', message: 'This operation id belongs to another user.', retryable: false };
    }
    if (prior && (prior.status === 'ACCEPTED' || prior.status === 'DUPLICATE')) {
      const stored = (prior.result ?? {}) as { entityId?: string };
      return { ...base, status: 'duplicate', entityId: stored.entityId, retryable: false }; // already applied: safe to mark synced on the device
    }
    if (!user.permissions.includes(REQUIRED_PERMISSION[op.type])) {
      return done({ status: 'rejected', code: 'FORBIDDEN', message: 'You do not have permission to record this.', retryable: false });
    }

    // Dependencies on records created earlier in the same offline session are expressed by client id.
    const payload: Record<string, unknown> = { ...op.payload, clientId: op.clientId };
    const dep = await this.resolveDependencies(op, payload);
    if (dep) return done(dep);

    const dto = plainToInstance(DTO[op.type] as new () => object, payload);
    const problems = await validate(dto, { whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true });
    if (problems.length > 0) {
      const messages = flattenValidation(problems).slice(0, 5);
      return done({ status: 'rejected', code: 'VALIDATION', message: messages.join('; ') || 'The record is not valid.', retryable: false });
    }

    try {
      const out = await this.execute(user, op.type, dto, meta);
      return done({ status: out.created ? 'accepted' : 'duplicate', entityId: out.id, retryable: false });
    } catch (e) {
      if (e instanceof HttpException) return done(this.fromHttp(e));
      // Unknown failure (database down, bug, timeout): NOT an outcome. The device keeps the operation and retries.
      this.logger.error({ err: e, type: op.type }, 'Sync operation failed unexpectedly');
      return { ...base, status: 'error', code: 'SERVER_ERROR', message: 'The server could not process this yet. It will be retried.', retryable: true };
    }
  }

  private async resolveDependencies(op: SyncOperationDto, payload: Record<string, unknown>): Promise<Omit<OperationResult, 'clientId' | 'entityType'> | null> {
    const missing = (what: string) => ({ status: 'rejected' as const, code: 'DEPENDENCY_MISSING', message: `The ${what} this record refers to was never synced.`, retryable: false });
    if (op.type === 'sale.create' && payload.customerClientId !== undefined) {
      if (payload.customerId !== undefined) return { status: 'rejected', code: 'VALIDATION', message: 'Give customerId or customerClientId, not both.', retryable: false };
      const c = typeof payload.customerClientId === 'string' ? await this.prisma.customer.findUnique({ where: { clientId: payload.customerClientId }, select: { id: true } }) : null;
      if (!c) return missing('customer');
      payload.customerId = c.id;
      delete payload.customerClientId;
    }
    if (op.type === 'payment.create' && payload.saleClientId !== undefined) {
      if (payload.saleId !== undefined) return { status: 'rejected', code: 'VALIDATION', message: 'Give saleId or saleClientId, not both.', retryable: false };
      const s = typeof payload.saleClientId === 'string' ? await this.prisma.sale.findUnique({ where: { clientId: payload.saleClientId }, select: { id: true } }) : null;
      if (!s) return missing('sale');
      payload.saleId = s.id;
      delete payload.saleClientId;
    }
    return null;
  }

  private async execute(user: AuthUser, type: OfflineOperation, dto: object, meta: RequestMeta): Promise<{ created: boolean; id: string }> {
    switch (type) {
      case 'production.create': { const r = await this.production.create(user, dto as CreateProductionDto, meta); return { created: r.created, id: r.record.id }; }
      case 'sale.create': { const r = await this.sales.create(user, dto as CreateSaleDto, meta); return { created: r.created, id: r.sale.id }; }
      case 'expense.create': { const r = await this.expenses.create(user, dto as CreateExpenseDto, meta); return { created: r.created, id: r.expense.id }; }
      case 'customer.create': { const r = await this.customers.create(user, dto as CreateCustomerDto, meta); return { created: r.created, id: r.customer.id }; }
      case 'payment.create': { const r = await this.payments.create(user, dto as CreatePaymentDto, meta); return { created: r.created, id: r.payments[0]?.id ?? '' }; }
    }
  }

  /** Maps an HTTP-style business error to a device-actionable outcome. */
  private fromHttp(e: HttpException): Omit<OperationResult, 'clientId' | 'entityType'> {
    const status = e.getStatus();
    const raw = e.getResponse();
    const message = typeof raw === 'object' && raw && 'message' in raw ? String((raw as { message: unknown }).message) : e.message;
    if (status >= 500) return { status: 'error', code: 'SERVER_ERROR', message: 'The server could not process this yet. It will be retried.', retryable: true };
    if (status === 409) {
      if (/Insufficient stock/i.test(message)) {
        const m = message.match(/(\d+) eggs available, (\d+) requested/);
        return { status: 'conflict', code: 'INSUFFICIENT_STOCK', message: 'There was not enough stock when this synced. Record the missing production or stock first, then retry, or discard the sale.', retryable: false, detail: m ? { availableEggs: Number(m[1]), requestedEggs: Number(m[2]) } : undefined };
      }
      if (/already recorded/i.test(message)) return { status: 'conflict', code: 'ALREADY_RECORDED', message: 'Someone else already recorded this coop, date and shift. Review it and correct it online if needed.', retryable: false };
      return { status: 'conflict', code: 'CONFLICT', message, retryable: false };
    }
    if (status === 403) return { status: 'rejected', code: 'FORBIDDEN', message, retryable: false };
    if (status === 422) return { status: 'rejected', code: 'BUSINESS_RULE', message, retryable: false };
    return { status: 'rejected', code: 'REJECTED', message, retryable: false };
  }

  /** Records the outcome in the ledger (except transient errors) and returns it. */
  private async finish(user: AuthUser, deviceId: string | undefined, op: SyncOperationDto, r: OperationResult): Promise<OperationResult> {
    const dbStatus = STATUS_TO_DB[r.status];
    if (dbStatus) {
      const result = { entityId: r.entityId ?? null, code: r.code ?? null, message: r.message ?? null } satisfies Prisma.InputJsonValue;
      await this.prisma.syncOperation.upsert({
        where: { clientId: op.clientId },
        create: { clientId: op.clientId, userId: user.id, deviceId, entityType: r.entityType, status: dbStatus, result },
        update: { status: dbStatus, result, attempts: { increment: 1 }, deviceId },
      });
    }
    return r;
  }
}

/** Collects messages from nested validation errors (e.g. inside `entries[0].quantity`). */
export function flattenValidation(errors: ValidationError[]): string[] {
  return errors.flatMap((e) => [...Object.values(e.constraints ?? {}), ...flattenValidation(e.children ?? [])]);
}
