import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { NotificationCategory, Prisma } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';
import { DomainEvents } from '../domain/events.service';
import { Page, PageQuery, paging } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';
import { ALL_CATEGORIES, ALWAYS_ON_CATEGORIES, CHANNEL, MUTABLE_CATEGORIES, NotifySpec } from './notification.types';
import { EXPO_TOKEN_RE, PUSH_PROVIDER, PushMessage, PushProvider, PushTransportError } from './push/push.provider';

const STALE_DEVICE_DAYS = 90;
const DELIVERY_RETENTION_DAYS = 90;
const NOTIFICATION_RETENTION_DAYS = 365;
const RECEIPT_MIN_AGE_MS = 15 * 60_000; // Expo receipts are available roughly 15 minutes after sending

const present = (n: Prisma.NotificationGetPayload<object>) => ({
  id: n.id, category: n.category, type: n.type, title: n.title, body: n.body, entityType: n.entityType, entityId: n.entityId,
  read: n.readAt !== null, readAt: n.readAt, createdAt: n.createdAt,
});

export class ListNotificationsQuery extends PageQuery {
  status?: 'unread' | 'read' | 'all';
  category?: NotificationCategory;
}

/**
 * Creates notifications and delivers them. A notification is written to PostgreSQL first (the in-app notification center is the
 * source of truth); push is best-effort on top of it and its outcome is tracked per device.
 */
@Injectable()
export class NotificationsService {
  private readonly inflight = new Set<Promise<unknown>>();

  constructor(
    private readonly prisma: PrismaService, private readonly events: DomainEvents, private readonly logger: PinoLogger,
    @Inject(PUSH_PROVIDER) private readonly push: PushProvider,
  ) {
    this.logger.setContext(NotificationsService.name);
  }

  /** Run background work while keeping track of it (lets shutdown and tests wait for it). */
  track<T>(p: Promise<T>): Promise<T> {
    this.inflight.add(p);
    void p.finally(() => this.inflight.delete(p)).catch(() => undefined);
    return p;
  }
  async drain(): Promise<void> { while (this.inflight.size) await Promise.allSettled([...this.inflight]); }

  // ───────────── creating & delivering ─────────────

  /** Applies account status, preferences and de-duplication per recipient, stores the notification, then pushes. Returns created ids. */
  async notify(spec: NotifySpec): Promise<string[]> {
    const created: string[] = [];
    const recipients = [...new Set(spec.recipients)];
    if (recipients.length === 0) return created;
    const users = await this.prisma.user.findMany({ where: { id: { in: recipients }, deletedAt: null }, select: { id: true, status: true } });
    const muted = ALWAYS_ON_CATEGORIES.includes(spec.category) ? [] : await this.prisma.notificationPreference.findMany({ where: { userId: { in: recipients }, category: spec.category, enabled: false }, select: { userId: true } });
    const mutedIds = new Set(muted.map((m) => m.userId));

    for (const u of users) {
      if (u.status !== 'ACTIVE' && !spec.allowInactive) continue; // a disabled user receives no business notifications
      if (mutedIds.has(u.id)) continue;
      if (spec.dedupeHours) {
        const since = new Date(Date.now() - spec.dedupeHours * 3600_000);
        if (await this.prisma.notification.count({ where: { userId: u.id, type: spec.type, createdAt: { gt: since } } })) continue;
      }
      const n = await this.prisma.notification.create({
        data: { userId: u.id, category: spec.category, type: spec.type, title: spec.title, body: spec.body, entityType: spec.entityType, entityId: spec.entityId },
      });
      created.push(n.id);
      this.events.emit({ name: 'notification.created', entityId: n.id, data: { userId: u.id, category: spec.category } }); // realtime: only the recipient's sockets
      if (spec.push !== false) await this.dispatchPush(n.id, u.id, spec);
    }
    return created;
  }

  private async dispatchPush(notificationId: string, userId: string, spec: NotifySpec): Promise<void> {
    if (!this.push.enabled) return;
    const devices = await this.prisma.notificationDevice.findMany({ where: { userId } });
    if (devices.length === 0) return;
    const text = spec.push === undefined || spec.push === false ? { title: 'Makarifor', body: 'You have a new notification.' } : spec.push;
    const deliveries = await Promise.all(devices.map((d) => this.prisma.notificationDelivery.create({ data: { notificationId, deviceId: d.id, status: 'PENDING' } })));
    const messages: PushMessage[] = devices.map((d) => ({
      to: d.pushToken, title: text.title, body: text.body, channelId: CHANNEL[spec.category], priority: spec.category === 'SECURITY' ? 'high' : 'default',
      data: { notificationId, type: spec.type, ...(spec.entityType ? { entityType: spec.entityType } : {}), ...(spec.entityId ? { entityId: spec.entityId } : {}) },
    }));
    try {
      const tickets = await this.push.send(messages);
      for (let i = 0; i < deliveries.length; i++) {
        const t = tickets[i];
        if (t?.status === 'ok') {
          await this.prisma.notificationDelivery.update({ where: { id: deliveries[i].id }, data: { status: 'SENT', ticketId: t.id, sentAt: new Date() } });
        } else {
          await this.prisma.notificationDelivery.update({ where: { id: deliveries[i].id }, data: { status: 'FAILED', error: t ? t.error : 'NoTicket' } });
          if (t?.status === 'error' && t.error === 'DeviceNotRegistered') await this.prisma.notificationDevice.deleteMany({ where: { id: devices[i].id } });
        }
      }
    } catch (e) {
      this.logger.warn({ err: e instanceof PushTransportError ? e.message : 'push failed' }, 'Push delivery failed (in-app notification kept)');
      await this.prisma.notificationDelivery.updateMany({ where: { id: { in: deliveries.map((d) => d.id) } }, data: { status: 'FAILED', error: 'TransportError' } });
    }
  }

  /** Reads Expo receipts for pushes sent ≥15 min ago: marks DELIVERED / FAILED and removes devices Expo says are gone. */
  async pollReceipts(now = new Date()): Promise<{ checked: number; delivered: number; failed: number }> {
    if (!this.push.enabled) return { checked: 0, delivered: 0, failed: 0 };
    const due = await this.prisma.notificationDelivery.findMany({
      where: { status: 'SENT', ticketId: { not: null }, sentAt: { lt: new Date(now.getTime() - RECEIPT_MIN_AGE_MS), gt: new Date(now.getTime() - 24 * 3600_000) } }, take: 1000,
    });
    if (due.length === 0) return { checked: 0, delivered: 0, failed: 0 };
    let delivered = 0, failed = 0;
    try {
      const receipts = await this.push.receipts(due.map((d) => d.ticketId as string));
      for (const d of due) {
        const r = receipts[d.ticketId as string];
        if (!r) continue; // not ready yet: check again next time
        if (r.status === 'ok') { delivered++; await this.prisma.notificationDelivery.update({ where: { id: d.id }, data: { status: 'DELIVERED', deliveredAt: now } }); }
        else {
          failed++;
          await this.prisma.notificationDelivery.update({ where: { id: d.id }, data: { status: 'FAILED', error: r.error } });
          if (r.error === 'DeviceNotRegistered' && d.deviceId) await this.prisma.notificationDevice.deleteMany({ where: { id: d.deviceId } });
        }
      }
    } catch (e) {
      this.logger.warn({ err: e instanceof PushTransportError ? e.message : 'receipt check failed' }, 'Could not read push receipts');
    }
    return { checked: due.length, delivered, failed };
  }

  // ───────────── notification center (own notifications only) ─────────────

  async list(userId: string, q: ListNotificationsQuery): Promise<Page<ReturnType<typeof present>> & { unread: number }> {
    const { page, limit, skip, take } = paging(q);
    const where: Prisma.NotificationWhereInput = {
      userId, ...(q.category ? { category: q.category } : {}),
      ...(q.status === 'unread' ? { readAt: null } : q.status === 'read' ? { readAt: { not: null } } : {}),
    };
    const [rows, total, unread] = await Promise.all([
      this.prisma.notification.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip, take }),
      this.prisma.notification.count({ where }), this.unreadCount(userId),
    ]);
    return { items: rows.map(present), page, limit, total, unread };
  }

  unreadCount(userId: string): Promise<number> { return this.prisma.notification.count({ where: { userId, readAt: null } }); }

  async get(userId: string, id: string) {
    const n = await this.prisma.notification.findFirst({ where: { id, userId } }); // another user's id is indistinguishable from a missing one
    if (!n) throw new NotFoundException('Notification not found.');
    return present(n);
  }

  async markRead(userId: string, id: string) {
    await this.get(userId, id);
    await this.prisma.notification.updateMany({ where: { id, userId, readAt: null }, data: { readAt: new Date() } });
    return { ...(await this.get(userId, id)), unread: await this.unreadCount(userId) };
  }

  async markAllRead(userId: string, category?: NotificationCategory) {
    const r = await this.prisma.notification.updateMany({ where: { userId, readAt: null, ...(category ? { category } : {}) }, data: { readAt: new Date() } });
    return { updated: r.count, unread: await this.unreadCount(userId) };
  }

  /** The app reports that the user tapped the push: tracks "opened" and marks the notification read. */
  async markOpened(userId: string, id: string) {
    await this.get(userId, id);
    await this.prisma.notificationDelivery.updateMany({ where: { notificationId: id, openedAt: null }, data: { status: 'OPENED', openedAt: new Date() } });
    await this.prisma.notification.updateMany({ where: { id, userId, readAt: null }, data: { readAt: new Date() } });
    return { ok: true };
  }

  // ───────────── preferences ─────────────

  async preferences(userId: string) {
    const rows = await this.prisma.notificationPreference.findMany({ where: { userId } });
    const map = new Map(rows.map((r) => [r.category, r.enabled]));
    return ALL_CATEGORIES.map((category) => ({ category, mutable: MUTABLE_CATEGORIES.includes(category), enabled: MUTABLE_CATEGORIES.includes(category) ? map.get(category) ?? true : true }));
  }

  async setPreferences(userId: string, items: { category: NotificationCategory; enabled: boolean }[]) {
    for (const i of items) {
      if (ALWAYS_ON_CATEGORIES.includes(i.category) && !i.enabled) throw new BadRequestException(`${i.category.toLowerCase()} notifications cannot be turned off.`);
    }
    await this.prisma.$transaction(items.filter((i) => MUTABLE_CATEGORIES.includes(i.category)).map((i) => this.prisma.notificationPreference.upsert({
      where: { userId_category: { userId, category: i.category } }, create: { userId, category: i.category, enabled: i.enabled }, update: { enabled: i.enabled },
    })));
    return this.preferences(userId);
  }

  // ───────────── devices ─────────────

  /** Registers (or moves) a push token to the signed-in user. A token can belong to only one user at a time. */
  async registerDevice(userId: string, pushToken: string, platform: 'ios' | 'android', deviceName?: string) {
    if (!EXPO_TOKEN_RE.test(pushToken)) throw new BadRequestException('That is not a valid push token.');
    const d = await this.prisma.notificationDevice.upsert({
      where: { pushToken }, create: { userId, pushToken, platform, deviceName }, update: { userId, platform, deviceName, lastSeenAt: new Date() },
    });
    return { id: d.id, platform: d.platform, deviceName: d.deviceName };
  }

  async unregisterDevice(userId: string, pushToken: string): Promise<void> {
    await this.prisma.notificationDevice.deleteMany({ where: { userId, pushToken } }); // own tokens only
  }

  /** Removes stale devices, old delivery records and old notifications (no personal/device data is kept indefinitely). */
  async purge(now = new Date()): Promise<{ devices: number; deliveries: number; notifications: number }> {
    const ago = (days: number) => new Date(now.getTime() - days * 86_400_000);
    const [devices, deliveries, notifications] = await Promise.all([
      this.prisma.notificationDevice.deleteMany({ where: { lastSeenAt: { lt: ago(STALE_DEVICE_DAYS) } } }),
      this.prisma.notificationDelivery.deleteMany({ where: { OR: [{ sentAt: { lt: ago(DELIVERY_RETENTION_DAYS) } }, { sentAt: null, status: { in: ['FAILED', 'PENDING'] }, notification: { createdAt: { lt: ago(DELIVERY_RETENTION_DAYS) } } }] } }),
      this.prisma.notification.deleteMany({ where: { createdAt: { lt: ago(NOTIFICATION_RETENTION_DAYS) } } }),
    ]);
    return { devices: devices.count, deliveries: deliveries.count, notifications: notifications.count };
  }

  get pushProvider(): string { return this.push.name; }
}

