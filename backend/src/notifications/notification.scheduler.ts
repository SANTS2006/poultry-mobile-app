import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import type { Env } from '../config/env';
import { SettingsService } from '../domain/settings.service';
import { MailComposer } from '../mail/mail-composer.service';
import { PrismaService } from '../prisma/prisma.service';
import { localParts, shiftLabel } from './format';
import { NotificationsService } from './notifications.service';
import { RecipientsService } from './recipients.service';
import { SummaryService } from './summary.service';

const TICK_MS = 60_000;
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Time-based notifications. `tick()` is idempotent: it is safe to run every minute, on several instances, or after a restart,
 * because each notification type is de-duplicated per user per day in the database.
 */
@Injectable()
export class NotificationScheduler implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private lastMaintenanceDate = '';

  constructor(
    private readonly settings: SettingsService, private readonly recipients: RecipientsService, private readonly notifications: NotificationsService,
    private readonly summary: SummaryService, private readonly prisma: PrismaService, private readonly mail: MailComposer,
    private readonly logger: PinoLogger, @Inject(ConfigService) private readonly config: ConfigService<Env, true>,
  ) {
    this.logger.setContext(NotificationScheduler.name);
  }

  onModuleInit(): void {
    if (this.config.get('APP_ENV', { infer: true }) === 'test') return; // tests drive tick() explicitly
    this.timer = setInterval(() => { void this.notifications.track(this.tick().catch((e) => this.logger.error({ err: e }, 'Scheduler tick failed'))); }, TICK_MS);
    this.timer.unref();
  }
  onModuleDestroy(): void { if (this.timer) clearInterval(this.timer); }

  async tick(now = new Date()): Promise<void> {
    const steps: [string, () => Promise<unknown>][] = [
      ['dailySummary', () => this.dailySummary(now)], ['productionReminders', () => this.productionReminders(now)],
      ['receipts', () => this.notifications.pollReceipts(now)], ['maintenance', () => this.maintenance(now)],
    ];
    for (const [name, fn] of steps) {
      try { await fn(); } catch (e) { this.logger.error({ err: e, step: name }, 'Scheduled notification step failed'); }
    }
  }

  private async due(now: Date, time: string): Promise<{ due: boolean; date: string }> {
    const tz = await this.settings.get<string>('business.timezone');
    const p = localParts(now, tz);
    return { due: HM.test(time) && p.hm >= time, date: p.date };
  }

  async dailySummary(now: Date): Promise<number> {
    if (!(await this.settings.get<boolean>('notifications.dailySummaryEnabled'))) return 0;
    const { due } = await this.due(now, await this.settings.get<string>('notifications.dailySummaryTime'));
    if (!due) return 0;
    const emailOn = await this.settings.get<boolean>('notifications.dailySummaryEmail');
    let sent = 0;
    for (const userId of await this.recipients.withPermission('dashboard.read')) {
      const s = await this.summary.compose(userId);
      if (!s) continue;
      const ids = await this.notifications.notify({
        category: 'DAILY_SUMMARY', type: 'daily.summary', recipients: [userId], dedupeHours: 20, title: s.title, body: s.body,
        push: { title: 'Daily summary ready', body: 'Your daily poultry summary is ready.' }, // figures stay inside the app
      });
      if (ids.length === 0) continue;
      sent++;
      if (emailOn) {
        const u = await this.prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
        if (u) await this.mail.send(u.email, s.title, { preheader: s.body.slice(0, 90), heading: s.title, paragraphs: s.body.split('\n').filter(Boolean), note: 'You receive this because the daily summary e-mail is on for your account.' });
      }
    }
    return sent;
  }

  async productionReminders(now: Date): Promise<number> {
    const reminders = await this.settings.get<{ shift: string; time: string }[]>('notifications.productionReminders');
    if (!Array.isArray(reminders)) return 0;
    const farm = await this.prisma.farm.findFirst({ where: { deletedAt: null }, select: { id: true } });
    if (!farm) return 0;
    let sent = 0;
    for (const r of reminders) {
      const { due, date } = await this.due(now, r.time);
      if (!due) continue;
      const shift = await this.prisma.shift.findUnique({ where: { code: r.shift } });
      if (!shift) continue;
      const coops = await this.prisma.coop.findMany({ where: { farmId: farm.id, active: true, deletedAt: null }, select: { id: true, name: true } });
      const done = await this.prisma.productionRecord.findMany({ where: { farmId: farm.id, shiftId: shift.id, status: 'ACTIVE', productionDate: new Date(`${date}T00:00:00Z`) }, select: { coopId: true } });
      const missing = coops.filter((c) => !done.some((d) => d.coopId === c.id));
      if (missing.length === 0) continue;
      const to = await this.recipients.byRoles({ roles: ['PRODUCTION_STAFF', 'FARM_MANAGER'], permission: 'production.create' });
      const ids = await this.notifications.notify({
        category: 'PRODUCTION', type: `production.reminder.${r.shift}`, recipients: to, dedupeHours: 20,
        title: `${shiftLabel(r.shift)} production has not been recorded`, body: `${missing.map((c) => c.name).join(', ')} still need ${shiftLabel(r.shift).toLowerCase()} production for today.`,
        push: { title: 'Production reminder', body: `${shiftLabel(r.shift)} production has not been recorded.` },
      });
      sent += ids.length;
    }
    return sent;
  }

  private async maintenance(now: Date): Promise<void> {
    const { date } = await this.due(now, '00:00');
    if (this.lastMaintenanceDate === date) return;
    this.lastMaintenanceDate = date;
    const r = await this.notifications.purge(now);
    if (r.devices || r.deliveries || r.notifications) this.logger.info(r, 'Purged old notification data');
  }
}
