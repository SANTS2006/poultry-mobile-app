import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';
import { DomainEvent, DomainEvents } from '../domain/events.service';
import { FarmService } from '../domain/farm.service';
import { SettingsService } from '../domain/settings.service';
import { InventoryService } from '../inventory/inventory.service';
import { PrismaService } from '../prisma/prisma.service';
import { fmtEggs, fmtMoney, shiftLabel } from './format';
import { NotificationsService } from './notifications.service';
import { RecipientsService } from './recipients.service';

const BUSINESS_ROLES = { managers: ['FARM_MANAGER'], owners: ['OWNER'], ownerAndManager: ['OWNER', 'FARM_MANAGER'], finance: ['OWNER', 'ACCOUNTANT'], admins: ['SUPER_ADMIN', 'OWNER'], superAdmins: ['SUPER_ADMIN'] };

const SECURITY_TEXT: Record<string, { title: string; body: (d: Record<string, unknown>) => string; push: string; inactiveOk?: boolean }> = {
  new_device: { title: 'New device signed in', body: (d) => `Your account was signed in on ${String(d.device ?? 'a new device')}. If this was not you, change your password and sign out all devices.`, push: 'A new device signed into your account.' },
  password_changed: { title: 'Password changed', body: () => 'Your password was changed and your other devices were signed out. If this was not you, contact an administrator immediately.', push: 'Your password was changed.' },
  mfa_enabled: { title: 'Two-factor authentication turned on', body: () => 'Two-factor authentication is now enabled on your account.', push: 'Your security settings changed.' },
  mfa_disabled: { title: 'Two-factor authentication turned off', body: () => 'Two-factor authentication was turned off on your account. If this was not you, contact an administrator.', push: 'Your security settings changed.' },
  mfa_reset: { title: 'Two-factor authentication reset', body: () => 'An administrator reset your two-factor authentication. You were signed out everywhere and must set it up again.', push: 'Your security settings changed.' },
  account_locked: { title: 'Multiple failed login attempts', body: (d) => `Several failed sign-in attempts were detected. Your account is locked for ${String(d.minutes ?? 'a few')} minute(s). If this was not you, tell an administrator.`, push: 'Multiple failed login attempts were detected.' },
  refresh_reuse: { title: 'Suspicious activity', body: () => 'A sign-in session was used in an unexpected way and was signed out for your protection. Sign in again and change your password if you are worried.', push: 'Suspicious activity on your account.' },
  role_changed: { title: 'Your role was changed', body: () => 'An administrator changed your role. What you can see and do in the app may have changed.', push: 'Your access was updated.' },
  account_disabled: { title: 'Your account has been disabled', body: () => 'An administrator disabled your account. Contact them if you think this is a mistake.', push: 'Your account has been disabled.', inactiveOk: true },
  account_reactivated: { title: 'Your account was reactivated', body: () => 'An administrator reactivated your account. You can sign in again.', push: 'Your account was reactivated.' },
};

/**
 * Business event → notification rule → authorised recipients → notification record → push.
 * Recipients are chosen here on the server by role, permission, status and preferences (see NotificationsService.notify); push text
 * is deliberately generic (no amounts, names or balances) because it appears on lock screens.
 */
@Injectable()
export class NotificationRules implements OnModuleInit, OnModuleDestroy {
  private off?: () => void;

  constructor(
    private readonly events: DomainEvents, private readonly notifications: NotificationsService, private readonly recipients: RecipientsService,
    private readonly prisma: PrismaService, private readonly settings: SettingsService, private readonly inventory: InventoryService,
    private readonly farms: FarmService, private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(NotificationRules.name);
  }

  onModuleInit(): void {
    this.off = this.events.on('*', (e) => {
      // fire-and-forget: notification problems must never affect the business operation that raised the event
      void this.notifications.track(this.handle(e).catch((err: unknown) => this.logger.error({ err, event: e.name }, 'Notification rule failed')));
    });
  }
  onModuleDestroy(): void { this.off?.(); }

  async handle(e: DomainEvent): Promise<void> {
    switch (e.name) {
      case 'production.created': return this.onProduction(e);
      case 'sale.created': return this.onSale(e);
      case 'payment.created': return this.onPayment(e);
      case 'expense.created': return this.onExpense(e);
      case 'inventory.updated': return this.onInventory(e);
      case 'sync.completed': return this.onSync(e);
      case 'security.event': return this.onSecurity(e);
      case 'admin.event': return this.onAdmin(e);
      default: return;
    }
  }

  private async currency(): Promise<string> { return this.settings.get<string>('business.currency'); }

  private async onProduction(e: DomainEvent): Promise<void> {
    const r = await this.prisma.productionRecord.findUnique({ where: { id: e.entityId }, include: { coop: true, shift: true } });
    if (!r) return;
    await this.notifications.notify({
      category: 'PRODUCTION', type: 'production.recorded', entityType: 'production_record', entityId: r.id,
      recipients: await this.recipients.byRoles({ roles: BUSINESS_ROLES.managers, permission: 'production.read', excludeUserId: e.actorId }),
      title: 'Production recorded', body: `${r.coop.name} ${shiftLabel(r.shift.code).toLowerCase()}: ${fmtEggs(r.totalEggs)}.`,
      push: { title: 'Production recorded', body: 'New production was recorded.' },
    });
  }

  private async onSale(e: DomainEvent): Promise<void> {
    const s = await this.prisma.sale.findUnique({ where: { id: e.entityId } });
    if (!s) return;
    const cur = await this.currency();
    await this.notifications.notify({
      category: 'SALES', type: 'sale.created', entityType: 'sale', entityId: s.id,
      recipients: await this.recipients.byRoles({ roles: BUSINESS_ROLES.ownerAndManager, permission: 'sales.read', excludeUserId: e.actorId }),
      title: 'New sale recorded', body: `${s.number}: ${fmtMoney(cur, s.total.toString())}.`,
      push: { title: 'New sale recorded', body: 'A new sale was recorded.' },
    });
    const threshold = await this.settings.get<string | null>('notifications.largeSaleThreshold');
    if (threshold && s.total.gte(new Prisma.Decimal(threshold))) {
      await this.notifications.notify({
        category: 'SALES', type: 'sale.large', entityType: 'sale', entityId: s.id,
        recipients: await this.recipients.byRoles({ roles: BUSINESS_ROLES.owners, permission: 'sales.read', excludeUserId: e.actorId }),
        title: 'Large sale recorded', body: `${s.number}: ${fmtMoney(cur, s.total.toString())}.`, push: { title: 'Large sale recorded', body: 'A large sale was recorded.' },
      });
    }
  }

  private async onPayment(e: DomainEvent): Promise<void> {
    if (e.data?.initial === true) return; // the payment taken at the till is already covered by the "new sale" alert
    const p = await this.prisma.payment.findUnique({ where: { id: e.entityId }, include: { sale: { select: { number: true } } } });
    if (!p) return;
    await this.notifications.notify({
      category: 'PAYMENTS', type: 'payment.received', entityType: 'payment', entityId: p.id,
      recipients: await this.recipients.byRoles({ roles: BUSINESS_ROLES.finance, permission: 'payments.read', excludeUserId: e.actorId }),
      title: 'Customer payment received', body: `${fmtMoney(await this.currency(), p.amount.toString())}${p.sale ? ` on ${p.sale.number}` : ''}.`,
      push: { title: 'Payment received', body: 'A customer payment was recorded.' },
    });
  }

  private async onExpense(e: DomainEvent): Promise<void> {
    const x = await this.prisma.expense.findUnique({ where: { id: e.entityId }, include: { category: true } });
    if (!x) return;
    const cur = await this.currency();
    await this.notifications.notify({
      category: 'EXPENSES', type: 'expense.recorded', entityType: 'expense', entityId: x.id,
      recipients: await this.recipients.byRoles({ roles: BUSINESS_ROLES.ownerAndManager, permission: 'expenses.read', excludeUserId: e.actorId }),
      title: 'New expense recorded', body: `${x.category.name}: ${fmtMoney(cur, x.total.toString())} — ${x.description}`.slice(0, 200),
      push: { title: 'New expense recorded', body: 'A new expense was recorded.' },
    });
    const limit = await this.settings.get<string | null>('notifications.monthlyExpenseThreshold');
    if (limit && x.expenseDate) {
      const month = x.expenseDate.toISOString().slice(0, 7);
      const sum = await this.prisma.expense.aggregate({
        where: { farmId: x.farmId, status: 'ACTIVE', expenseDate: { gte: new Date(`${month}-01T00:00:00Z`), lt: new Date(new Date(`${month}-01T00:00:00Z`).setUTCMonth(new Date(`${month}-01T00:00:00Z`).getUTCMonth() + 1)) } }, _sum: { total: true },
      });
      if ((sum._sum.total ?? new Prisma.Decimal(0)).gt(new Prisma.Decimal(limit))) {
        await this.notifications.notify({
          category: 'EXPENSES', type: `expense.threshold.${month}`, dedupeHours: 24 * 31,
          recipients: await this.recipients.byRoles({ roles: BUSINESS_ROLES.owners, permission: 'expenses.read' }),
          title: 'Monthly expense threshold exceeded', body: `Expenses for ${month} are ${fmtMoney(cur, (sum._sum.total as Prisma.Decimal).toString())}, above the ${fmtMoney(cur, limit)} threshold.`,
          push: { title: 'Expense threshold exceeded', body: 'Monthly expenses passed the configured threshold.' },
        });
      }
    }
  }

  private async onInventory(e: DomainEvent): Promise<void> {
    const farmId = e.farmId ?? (await this.farms.resolve().catch(() => undefined));
    if (!farmId) return;
    if (e.data?.reason === 'adjustment') {
      await this.notifications.notify({
        category: 'INVENTORY', type: 'inventory.adjusted',
        recipients: await this.recipients.byRoles({ roles: ['OWNER', 'SUPER_ADMIN'], permission: 'inventory.read', excludeUserId: e.actorId }),
        title: 'Inventory adjustment recorded', body: 'An inventory adjustment (damage, loss, own use or recount) was recorded. Open Inventory to review it.',
        push: { title: 'Inventory adjustment recorded', body: 'An inventory adjustment was recorded.' },
      });
    }
    const snap = await this.inventory.snapshot(farmId);
    if (snap.lowStock) {
      await this.notifications.notify({
        category: 'INVENTORY', type: 'inventory.low', dedupeHours: 24,
        recipients: await this.recipients.byRoles({ roles: [...BUSINESS_ROLES.ownerAndManager, 'SALES_STAFF'], permission: 'inventory.read' }),
        title: 'Egg inventory is low', body: `Stock is ${fmtEggs(snap.quantityEggs)}, below the configured threshold of ${fmtEggs(snap.lowStockThresholdEggs ?? 0)}.`,
        push: { title: 'Low egg inventory', body: 'Egg inventory is below the configured threshold.' },
      });
    }
  }

  private async onSync(e: DomainEvent): Promise<void> {
    if (!e.actorId) return;
    const d = e.data ?? {};
    const attention = Number(d.conflict ?? 0) + Number(d.rejected ?? 0);
    if (attention > 0) {
      await this.notifications.notify({
        category: 'SYNC', type: 'sync.attention', recipients: [e.actorId],
        title: 'Some records could not be synchronized', body: `${attention} record(s) need your attention. Open Sync status to fix, retry or discard them.`,
        push: { title: 'Sync needs attention', body: 'Some records could not be synchronized.' },
      });
    } else if (Number(d.accepted ?? 0) > 0) {
      await this.notifications.notify({
        category: 'SYNC', type: 'sync.done', recipients: [e.actorId], title: 'Offline records synchronized',
        body: `${d.accepted} record(s) were synchronized.`, push: false, // good news does not need to buzz a phone
      });
    }
  }

  private async onSecurity(e: DomainEvent): Promise<void> {
    const kind = String(e.data?.kind ?? '');
    const t = SECURITY_TEXT[kind];
    if (!t) return;
    await this.notifications.notify({
      category: 'SECURITY', type: `security.${kind}`, recipients: [e.entityId], allowInactive: t.inactiveOk === true,
      title: t.title, body: t.body(e.data ?? {}), push: { title: 'Security alert', body: t.push }, entityType: 'user', entityId: e.entityId,
    });
  }

  private async onAdmin(e: DomainEvent): Promise<void> {
    const kind = String(e.data?.kind ?? '');
    const target = await this.prisma.user.findUnique({ where: { id: e.entityId }, include: { profile: true } });
    const who = target?.profile?.fullName ?? target?.email ?? 'A user';
    const map: Record<string, { category: 'ADMIN' | 'SECURITY'; roles: string[]; title: string; body: string; push: string }> = {
      user_created: { category: 'ADMIN', roles: BUSINESS_ROLES.admins, title: 'New user account created', body: `An account was created for ${who}.`, push: 'A new user account was created.' },
      role_changed: { category: 'ADMIN', roles: BUSINESS_ROLES.admins, title: 'User role changed', body: `The role of ${who} was changed.`, push: 'A user role was changed.' },
      user_disabled: { category: 'ADMIN', roles: BUSINESS_ROLES.admins, title: 'User account disabled', body: `The account of ${who} was disabled.`, push: 'A user account was disabled.' },
      account_locked: { category: 'SECURITY', roles: BUSINESS_ROLES.superAdmins, title: 'Multiple failed login attempts', body: `${who} was locked out after repeated failed sign-in attempts.`, push: 'Multiple failed login attempts were detected.' },
    };
    const m = map[kind];
    if (!m) return;
    await this.notifications.notify({
      category: m.category, type: `admin.${kind}`, entityType: 'user', entityId: e.entityId,
      recipients: await this.recipients.byRoles({ roles: m.roles, permission: 'users.manage', excludeUserId: e.actorId }), // never the person who did it
      title: m.title, body: m.body, push: { title: m.category === 'SECURITY' ? 'Security alert' : 'Administration', body: m.push },
    });
  }
}
