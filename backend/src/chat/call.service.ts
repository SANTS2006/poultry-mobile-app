import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, OnModuleDestroy } from '@nestjs/common';
import { CallEndReason, CallKind, CallSession, CallStatus, Prisma } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';
import type { AuthUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeEmitter } from '../realtime/realtime-emitter.service';
import { MAX_CALL_AGE_MS, MAX_SIGNAL_BYTES, RING_TIMEOUT_MS } from './chat.constants';
import { ChatPush } from './chat-push.service';
import { ChatService } from './chat.service';
import { CallAction, transition } from './call-state';
import { IceService } from './ice.service';

const OFFLINE_GRACE_MS = process.env.JEST_WORKER_ID !== undefined ? 300 : 30_000;

type CallRow = CallSession & { caller: { profile: { fullName: string } | null }; callee: { profile: { fullName: string } | null } };
const withNames = { caller: { select: { profile: { select: { fullName: true } } } }, callee: { select: { profile: { select: { fullName: true } } } } } as const;

export interface CallView {
  id: string; conversationId: string; kind: CallKind; status: CallStatus; endReason: CallEndReason | null; callerId: string; calleeId: string;
  peerId: string; peerName: string; direction: 'outgoing' | 'incoming'; createdAt: string; answeredAt: string | null; endedAt: string | null; durationSeconds: number;
}

@Injectable()
export class CallService implements OnModuleDestroy {
  private readonly ringTimers = new Map<string, NodeJS.Timeout>();
  private readonly offlineTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly prisma: PrismaService, private readonly chat: ChatService, private readonly emitter: RealtimeEmitter, private readonly push: ChatPush,
    private readonly ice: IceService, private readonly logger: PinoLogger,
  ) { this.logger.setContext(CallService.name); }

  onModuleDestroy(): void { for (const t of [...this.ringTimers.values(), ...this.offlineTimers.values()]) clearTimeout(t); }

  view(c: CallRow, me: string): CallView {
    const outgoing = c.callerId === me;
    const end = c.endedAt ?? new Date();
    return {
      id: c.id, conversationId: c.conversationId, kind: c.kind, status: c.status, endReason: c.endReason, callerId: c.callerId, calleeId: c.calleeId,
      peerId: outgoing ? c.calleeId : c.callerId, peerName: (outgoing ? c.callee : c.caller).profile?.fullName ?? 'User', direction: outgoing ? 'outgoing' : 'incoming',
      createdAt: c.createdAt.toISOString(), answeredAt: c.answeredAt?.toISOString() ?? null, endedAt: c.endedAt?.toISOString() ?? null,
      durationSeconds: c.answeredAt ? Math.max(0, Math.round((end.getTime() - c.answeredAt.getTime()) / 1000)) : 0,
    };
  }

  private async load(id: string): Promise<CallRow> {
    const c = await this.prisma.callSession.findUnique({ where: { id }, include: withNames });
    if (!c) throw new NotFoundException('Call not found');
    return c;
  }

  /** A call is "live" while ringing (within the ring time) or accepted (within the maximum duration). Stale rows are ignored here and swept up separately. */
  private liveWhere(userId: string, now = new Date()): Prisma.CallSessionWhereInput {
    return { OR: [{ callerId: userId }, { calleeId: userId }], AND: [{ OR: [{ status: 'RINGING', createdAt: { gt: new Date(now.getTime() - RING_TIMEOUT_MS - 15_000) } }, { status: 'ACCEPTED', answeredAt: { gt: new Date(now.getTime() - MAX_CALL_AGE_MS) } }] }] };
  }

  async start(me: AuthUser, conversationId: string, kind: CallKind) {
    const mem = await this.chat.membership(me.id, conversationId);
    if (mem.conversation.type !== 'DIRECT') throw new BadRequestException('Voice and video calls are available in one-to-one conversations.');
    const other = await this.prisma.conversationMember.findFirst({ where: { conversationId, userId: { not: me.id }, leftAt: null }, include: { user: { select: { id: true, status: true, deletedAt: true } } } });
    if (!other || other.user.status !== 'ACTIVE' || other.user.deletedAt) throw new ConflictException('This person is not available.');
    if ((await this.prisma.userBlock.count({ where: { OR: [{ blockerId: me.id, blockedId: other.userId }, { blockerId: other.userId, blockedId: me.id }] } })) > 0) throw new ForbiddenException('You cannot call this person.');

    const { call, busy } = await this.prisma.$transaction(async (tx) => {
      // Serialise call set-up per person (ordered to avoid deadlocks), so two simultaneous calls cannot both ring the same user.
      for (const id of [me.id, other.userId].sort()) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${id}, 748203))`;
      if (await tx.callSession.count({ where: this.liveWhere(me.id) })) throw new ConflictException('You are already in a call.');
      const calleeBusy = (await tx.callSession.count({ where: this.liveWhere(other.userId) })) > 0;
      const row = await tx.callSession.create({
        data: calleeBusy ? { conversationId, callerId: me.id, calleeId: other.userId, kind, status: 'ENDED', endReason: 'BUSY', endedAt: new Date() } : { conversationId, callerId: me.id, calleeId: other.userId, kind },
        include: withNames,
      });
      return { call: row, busy: calleeBusy };
    });

    if (busy) {
      await this.chat.recordCall(conversationId, me.id, kind, 'BUSY', 0).catch(() => undefined);
      return { call: this.view(call, me.id), ...(await this.ice.servers()), busy: true };
    }
    const calleeView = this.view(call, other.userId);
    this.emitter.toUsers([other.userId], 'call.incoming', { ...calleeView, callerName: me.fullName });
    void this.push.notifyIncomingCall({ callId: call.id, kind, calleeId: other.userId, callerName: me.fullName });
    const t = setTimeout(() => { void this.apply(call.id, 'timeout', 'system').catch((e) => this.logger.warn({ err: e }, 'Ring timeout failed')); }, RING_TIMEOUT_MS);
    t.unref();
    this.ringTimers.set(call.id, t);
    return { call: this.view(call, me.id), ...(await this.ice.servers()), busy: false };
  }

  /** The caller or callee acts on a call. Compare-and-set in SQL makes simultaneous actions (accept vs cancel) resolve to exactly one winner. */
  async act(me: AuthUser, id: string, action: Exclude<CallAction, 'timeout'>) {
    const c = await this.load(id);
    const role = c.callerId === me.id ? 'caller' : c.calleeId === me.id ? 'callee' : null;
    if (!role) throw new NotFoundException('Call not found'); // not a participant: indistinguishable from a missing call
    const done = await this.apply(id, action, role);
    if (!done) {
      const fresh = await this.load(id);
      if (fresh.status === 'ENDED' && action !== 'accept') return { call: this.view(fresh, me.id), changed: false }; // already over: ending twice is harmless
      throw new ConflictException(fresh.status === 'ENDED' ? 'This call has already ended.' : 'This call cannot be changed right now.');
    }
    const ice = action === 'accept' ? await this.ice.servers() : {};
    return { call: this.view(done, me.id), ...ice, changed: true };
  }

  private async apply(id: string, action: CallAction, role: 'caller' | 'callee' | 'system'): Promise<CallRow | null> {
    const c = await this.prisma.callSession.findUnique({ where: { id }, include: withNames });
    if (!c) return null;
    const t = transition(c.status, action, role);
    if (!t) return null;
    const now = new Date();
    const claimed = await this.prisma.callSession.updateMany({
      where: { id, status: c.status },
      data: { status: t.to, endReason: t.reason, ...(t.to === 'ACCEPTED' ? { answeredAt: now } : {}), ...(t.to === 'ENDED' ? { endedAt: now } : {}) },
    });
    if (claimed.count !== 1) return null; // someone else changed it first
    const timer = this.ringTimers.get(id);
    if (timer) { clearTimeout(timer); this.ringTimers.delete(id); }
    const fresh = await this.load(id);
    this.emitter.toUsers([fresh.callerId], 'call.updated', this.view(fresh, fresh.callerId));
    this.emitter.toUsers([fresh.calleeId], 'call.updated', this.view(fresh, fresh.calleeId)); // also tells the callee's other phones to stop ringing
    if (t.to === 'ENDED') await this.afterEnd(fresh);
    return fresh;
  }

  private async afterEnd(c: CallRow): Promise<void> {
    const seconds = c.answeredAt && c.endedAt ? Math.max(0, Math.round((c.endedAt.getTime() - c.answeredAt.getTime()) / 1000)) : 0;
    await this.chat.recordCall(c.conversationId, c.callerId, c.kind, c.endReason ?? 'FAILED', seconds).catch((e) => this.logger.warn({ err: e }, 'Could not record the call in the conversation'));
    if (c.endReason === 'MISSED') void this.push.notifyMissedCall({ callId: c.id, kind: c.kind, calleeId: c.calleeId, callerName: c.caller.profile?.fullName ?? 'Someone' });
  }

  /** Relays WebRTC signaling (offer / answer / ICE candidate) between the two participants of a LIVE call, and only them. */
  async relay(me: string, callId: string, data: unknown): Promise<boolean> {
    if (data === null || typeof data !== 'object' || JSON.stringify(data).length > MAX_SIGNAL_BYTES) return false;
    const c = await this.prisma.callSession.findUnique({ where: { id: callId }, select: { callerId: true, calleeId: true, status: true } });
    if (!c || c.status === 'ENDED' || (c.callerId !== me && c.calleeId !== me)) return false;
    if (c.status === 'RINGING' && c.callerId !== me) return false; // the callee may only signal after accepting
    this.emitter.toUsers([c.callerId === me ? c.calleeId : c.callerId], 'call.signal', { callId, data });
    return true;
  }

  async history(me: string, page: number, limit: number) {
    const where: Prisma.CallSessionWhereInput = { OR: [{ callerId: me }, { calleeId: me }] };
    const [rows, total] = await Promise.all([
      this.prisma.callSession.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit, include: withNames }),
      this.prisma.callSession.count({ where }),
    ]);
    return { items: rows.map((r) => this.view(r, me)), page, limit, total };
  }

  async current(me: string) {
    const c = await this.prisma.callSession.findFirst({ where: this.liveWhere(me), orderBy: { createdAt: 'desc' }, include: withNames });
    return { call: c ? this.view(c, me) : null };
  }

  async iceServers() { return this.ice.servers(); }

  // ───────────── housekeeping ─────────────

  /** Ends calls that rang too long (process restarted before the timer fired) or ran absurdly long. Idempotent; safe on several instances. */
  async sweep(now = new Date()): Promise<{ missed: number; failed: number }> {
    const ringing = await this.prisma.callSession.findMany({ where: { status: 'RINGING', createdAt: { lt: new Date(now.getTime() - RING_TIMEOUT_MS) } }, select: { id: true }, take: 100 });
    const stuck = await this.prisma.callSession.findMany({ where: { status: 'ACCEPTED', answeredAt: { lt: new Date(now.getTime() - MAX_CALL_AGE_MS) } }, select: { id: true }, take: 100 });
    let missed = 0; let failed = 0;
    for (const r of ringing) if (await this.apply(r.id, 'timeout', 'system')) missed++;
    for (const r of stuck) if (await this.apply(r.id, 'fail', 'system')) failed++;
    return { missed, failed };
  }

  /** The user's last connection dropped. If they are still gone after a grace period (a tunnel, a lift), their accepted call is ended as failed. */
  onUserOffline(userId: string): void {
    const since = new Date(); // only calls that already existed when they dropped are affected, never one started afterwards
    const t = setTimeout(() => {
      this.offlineTimers.delete(userId);
      if (this.emitter.isOnline(userId)) return;
      void (async () => {
        const live = await this.prisma.callSession.findMany({ where: { OR: [{ callerId: userId }, { calleeId: userId }], status: { in: ['ACCEPTED', 'RINGING'] }, createdAt: { lt: since } }, select: { id: true, status: true, callerId: true } });
        for (const c of live) {
          if (c.status === 'ACCEPTED') await this.apply(c.id, 'fail', 'system');
          else if (c.callerId === userId) await this.apply(c.id, 'cancel', 'caller');
        }
      })().catch((e) => this.logger.warn({ err: e }, 'Offline call cleanup failed'));
    }, OFFLINE_GRACE_MS);
    t.unref();
    const prev = this.offlineTimers.get(userId); if (prev) clearTimeout(prev);
    this.offlineTimers.set(userId, t);
  }
  onUserOnline(userId: string): void { const t = this.offlineTimers.get(userId); if (t) { clearTimeout(t); this.offlineTimers.delete(userId); } }
}
