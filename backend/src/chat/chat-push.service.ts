import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service';
import { PUSH_PROVIDER, PushMessage, PushProvider } from '../notifications/push/push.provider';

/** How long a phone has to acknowledge a message over the live connection before we also send a push (so foreground users never get a banner). */
const PUSH_DELAY_MS = process.env.JEST_WORKER_ID !== undefined ? 30 : 4_000;

export interface NewMessagePush {
  conversationId: string; messageId: string; seq: bigint; senderId: string; senderName: string; groupTitle: string | null; preview: string; recipients: string[];
}

/**
 * Push for chat. Lock-screen privacy: unless the recipient turned previews on, the notification only says "New message" — no sender, no text.
 * Message text is never logged. Pushes for chat do not create in-app notification rows (the conversation list is the inbox).
 */
@Injectable()
export class ChatPush {
  private readonly inflight = new Set<Promise<unknown>>();

  constructor(private readonly prisma: PrismaService, @Inject(PUSH_PROVIDER) private readonly provider: PushProvider, private readonly logger: PinoLogger) {
    this.logger.setContext(ChatPush.name);
  }

  private track(p: Promise<unknown>): void { this.inflight.add(p); void p.finally(() => this.inflight.delete(p)); }
  async drain(): Promise<void> { while (this.inflight.size) await Promise.allSettled([...this.inflight]); }

  notifyNewMessage(n: NewMessagePush): void {
    if (!this.provider.enabled || n.recipients.length === 0) return;
    const t = setTimeout(() => this.track(this.sendMessagePush(n).catch((e) => this.logger.warn({ err: e instanceof Error ? e.message : 'push failed' }, 'Chat push failed'))), PUSH_DELAY_MS);
    t.unref();
  }

  private async sendMessagePush(n: NewMessagePush): Promise<void> {
    const now = new Date();
    const members = await this.prisma.conversationMember.findMany({
      where: { conversationId: n.conversationId, userId: { in: n.recipients }, leftAt: null, lastDeliveredSeq: { lt: n.seq }, muted: false, OR: [{ mutedUntil: null }, { mutedUntil: { lt: now } }] },
      select: { userId: true },
    });
    if (!members.length) return; // everyone already received it over the live connection (or muted it)
    const ids = members.map((m) => m.userId);
    const [settings, devices] = await Promise.all([
      this.prisma.chatSetting.findMany({ where: { userId: { in: ids } } }),
      this.prisma.notificationDevice.findMany({ where: { userId: { in: ids } } }),
    ]);
    const cfg = new Map(settings.map((s) => [s.userId, s]));
    const messages: PushMessage[] = [];
    for (const d of devices) {
      const s = cfg.get(d.userId);
      if (s && !s.pushMessages) continue;
      const preview = s?.showPreviews === true;
      messages.push({
        to: d.pushToken, channelId: 'chat', priority: 'high',
        title: preview ? (n.groupTitle ?? n.senderName) : 'Makarifor', body: preview ? (n.groupTitle ? `${n.senderName}: ${n.preview}` : n.preview) : 'New message',
        data: { type: 'chat', conversationId: n.conversationId },
      });
    }
    if (messages.length) await this.provider.send(messages);
  }

  /** Incoming call: sent immediately (a call cannot wait), high priority, to every device of the callee. */
  async notifyIncomingCall(o: { callId: string; kind: 'AUDIO' | 'VIDEO'; calleeId: string; callerName: string }): Promise<void> {
    if (!this.provider.enabled) return;
    try {
      const [s, devices] = await Promise.all([this.prisma.chatSetting.findUnique({ where: { userId: o.calleeId } }), this.prisma.notificationDevice.findMany({ where: { userId: o.calleeId } })]);
      if (s && !s.pushCalls) return;
      const preview = s?.showPreviews === true;
      const label = o.kind === 'VIDEO' ? 'video call' : 'voice call';
      const msgs: PushMessage[] = devices.map((d) => ({ to: d.pushToken, channelId: 'calls', priority: 'high', title: preview ? o.callerName : 'Makarifor', body: `Incoming ${label}`, data: { type: 'call', callId: o.callId, kind: o.kind } }));
      if (msgs.length) await this.provider.send(msgs);
    } catch (e) { this.logger.warn({ err: e instanceof Error ? e.message : 'push failed' }, 'Call push failed'); }
  }

  async notifyMissedCall(o: { callId: string; kind: 'AUDIO' | 'VIDEO'; calleeId: string; callerName: string }): Promise<void> {
    if (!this.provider.enabled) return;
    try {
      const [s, devices] = await Promise.all([this.prisma.chatSetting.findUnique({ where: { userId: o.calleeId } }), this.prisma.notificationDevice.findMany({ where: { userId: o.calleeId } })]);
      if (s && !s.pushCalls) return;
      const preview = s?.showPreviews === true;
      const msgs: PushMessage[] = devices.map((d) => ({ to: d.pushToken, channelId: 'chat', priority: 'default', title: preview ? o.callerName : 'Makarifor', body: 'Missed call', data: { type: 'missed_call', callId: o.callId } }));
      if (msgs.length) await this.provider.send(msgs);
    } catch (e) { this.logger.warn({ err: e instanceof Error ? e.message : 'push failed' }, 'Missed-call push failed'); }
  }
}
