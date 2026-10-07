import { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  ConnectedSocket, MessageBody, OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit, SubscribeMessage, WebSocketGateway, WebSocketServer,
} from '@nestjs/websockets';
import { PinoLogger } from 'nestjs-pino';
import type { Server, Socket } from 'socket.io';
import type { AuthUser } from '../auth/auth.types';
import { AuthenticationService } from '../auth/guards/jwt-auth.guard';
import { DomainEvent, DomainEvents } from '../domain/events.service';
import { FarmService } from '../domain/farm.service';
import { allFarmsRoom, DASHBOARD_TRIGGERS, EVENT_TOPIC, farmRoom, isTopic, Topic, TOPIC_PERMISSION, userRoom } from './topics';

const MAX_SOCKETS_PER_USER = 5;
const MAX_TOPICS_PER_REQUEST = 10;
const RATE_WINDOW_MS = 10_000;
const RATE_LIMIT = 20; // control messages per socket per window
const EXPIRY_WARNING_MS = 60_000;
const RECHECK_INTERVAL_MS = 60_000;
const DASHBOARD_DEBOUNCE_MS = 400;

interface SocketData {
  user: AuthUser;
  tv: number;
  expMs: number;
  /** topic → farm ids subscribed (a farm id of '*' = all farms) */
  subs: Map<Topic, Set<string>>;
  rate: { start: number; count: number };
  warnTimer?: NodeJS.Timeout;
  killTimer?: NodeJS.Timeout;
}

type Ack = { ok: true; [k: string]: unknown } | { ok: false; error: string };

const sd = (s: Socket): SocketData => s.data as SocketData;

/**
 * Authenticated realtime channel.
 *  • The handshake must carry a valid access token (`auth: { token }`) — verified exactly like an HTTP request, including live
 *    user/session state.
 *  • Clients never name rooms. They `subscribe` to whitelisted topics; every topic is authorised against the user's permissions.
 *  • Business events are routed only to the rooms of the topic that carries them, and carry ids plus non-sensitive facts only:
 *    clients refetch details through the normal (permission-checked) REST API.
 *  • Connections die when the access token expires, the session/user is revoked or disabled, and permissions are re-checked
 *    on role changes and periodically, so revoked access stops receiving events immediately.
 */
@WebSocketGateway()
export class RealtimeGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleInit, OnModuleDestroy {
  @WebSocketServer() server!: Server;
  private offEvents?: () => void;
  private recheck?: NodeJS.Timeout;
  private readonly dashboardTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly authn: AuthenticationService, private readonly events: DomainEvents,
    private readonly farms: FarmService, private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(RealtimeGateway.name);
  }

  // ───────────── lifecycle ─────────────

  onModuleInit(): void {
    this.offEvents = this.events.on('*', (e) => { void this.route(e); });
    this.recheck = setInterval(() => { void this.recheckAll(); }, RECHECK_INTERVAL_MS);
    this.recheck.unref();
  }

  onModuleDestroy(): void {
    this.offEvents?.();
    if (this.recheck) clearInterval(this.recheck);
    for (const t of this.dashboardTimers.values()) clearTimeout(t);
  }

  afterInit(server: Server): void {
    server.use((socket, next) => {
      this.authenticate(socket).then(() => next()).catch((e: unknown) => {
        // one generic error for every failure: nothing about why (or whether the user exists) is revealed
        this.logger.warn({ reason: e instanceof Error ? e.message : 'unknown' }, 'WebSocket handshake refused');
        next(new Error('unauthorized'));
      });
    });
  }

  private async authenticate(socket: Socket): Promise<void> {
    const auth = socket.handshake.auth as { token?: unknown };
    if (typeof auth?.token !== 'string' || auth.token.length > 4000) throw new Error('missing token');
    const claims = this.authn.verifyAccessClaims(auth.token);
    const user = await this.authn.revalidate(claims.sub, claims.fid as string, claims.tv);
    const existing = (await this.server.fetchSockets()).filter((s) => sd(s as unknown as Socket)?.user?.id === user.id).length;
    if (existing >= MAX_SOCKETS_PER_USER) throw new Error('too many connections');
    socket.data = { user, tv: claims.tv, expMs: (claims.exp as number) * 1000, subs: new Map(), rate: { start: Date.now(), count: 0 } } satisfies SocketData;
  }

  handleConnection(socket: Socket): void {
    const d = sd(socket);
    void socket.join(userRoom(d.user.id));
    this.armExpiry(socket);
    socket.emit('ready', { userId: d.user.id, expiresAt: new Date(d.expMs).toISOString() });
  }

  handleDisconnect(socket: Socket): void {
    const d = socket.data as SocketData | undefined;
    if (d?.warnTimer) clearTimeout(d.warnTimer);
    if (d?.killTimer) clearTimeout(d.killTimer);
  }

  private armExpiry(socket: Socket): void {
    const d = sd(socket);
    if (d.warnTimer) clearTimeout(d.warnTimer);
    if (d.killTimer) clearTimeout(d.killTimer);
    const left = d.expMs - Date.now();
    d.warnTimer = setTimeout(() => socket.emit('auth.expiring', { expiresAt: new Date(d.expMs).toISOString() }), Math.max(0, left - EXPIRY_WARNING_MS));
    d.killTimer = setTimeout(() => this.kick(socket, 'token_expired'), Math.max(0, left));
    d.warnTimer.unref();
    d.killTimer.unref();
  }

  // ───────────── client → server messages ─────────────

  @SubscribeMessage('subscribe')
  async subscribe(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown): Promise<Ack> {
    const limited = this.limit(socket);
    if (limited) return limited;
    const parsed = this.parseTopics(body);
    if (!parsed) return { ok: false, error: 'invalid_request' };
    const d = sd(socket);
    let farmId: string;
    try { farmId = await this.farms.resolve(parsed.farmId); } catch { return { ok: false, error: 'unknown_farm' }; }
    const joined: Topic[] = [];
    const denied: { topic: string; reason: string }[] = [];
    for (const raw of parsed.topics) {
      if (!isTopic(raw)) { denied.push({ topic: String(raw).slice(0, 40), reason: 'unknown_topic' }); continue; }
      if (!d.user.permissions.includes(TOPIC_PERMISSION[raw])) { denied.push({ topic: raw, reason: 'forbidden' }); continue; }
      await socket.join([farmRoom(farmId, raw), allFarmsRoom(raw)]);
      d.subs.set(raw, (d.subs.get(raw) ?? new Set()).add(farmId));
      joined.push(raw);
    }
    return { ok: true, farmId, joined, denied };
  }

  @SubscribeMessage('unsubscribe')
  async unsubscribe(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown): Promise<Ack> {
    const limited = this.limit(socket);
    if (limited) return limited;
    const parsed = this.parseTopics(body);
    if (!parsed) return { ok: false, error: 'invalid_request' };
    const d = sd(socket);
    for (const t of parsed.topics) {
      if (!isTopic(t)) continue;
      for (const f of d.subs.get(t) ?? []) await socket.leave(farmRoom(f, t));
      await socket.leave(allFarmsRoom(t));
      d.subs.delete(t);
    }
    return { ok: true };
  }

  /** The client obtained a fresh access token (refresh flow) and extends the connection. Must be the same user. */
  @SubscribeMessage('reauth')
  async reauth(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown): Promise<Ack> {
    const limited = this.limit(socket);
    if (limited) return limited;
    const token = (body as { accessToken?: unknown } | null)?.accessToken;
    const d = sd(socket);
    try {
      if (typeof token !== 'string' || token.length > 4000) throw new Error('bad token');
      const claims = this.authn.verifyAccessClaims(token);
      if (claims.sub !== d.user.id) throw new Error('different user');
      d.user = await this.authn.revalidate(claims.sub, claims.fid as string, claims.tv);
      d.tv = claims.tv;
      d.expMs = (claims.exp as number) * 1000;
      this.armExpiry(socket);
      await this.syncRooms(socket);
      return { ok: true, expiresAt: new Date(d.expMs).toISOString() };
    } catch {
      // answer first, then drop the connection (closing immediately would swallow the acknowledgement)
      setTimeout(() => this.kick(socket, 'reauth_failed'), 50).unref();
      return { ok: false, error: 'unauthorized' };
    }
  }

  private parseTopics(body: unknown): { topics: unknown[]; farmId?: string } | null {
    const b = body as { topics?: unknown; farmId?: unknown } | null;
    if (!b || !Array.isArray(b.topics) || b.topics.length === 0 || b.topics.length > MAX_TOPICS_PER_REQUEST) return null;
    if (b.farmId !== undefined && (typeof b.farmId !== 'string' || b.farmId.length > 40)) return null;
    return { topics: b.topics, farmId: b.farmId as string | undefined };
  }

  private limit(socket: Socket): Ack | null {
    const r = sd(socket).rate;
    const now = Date.now();
    if (now - r.start > RATE_WINDOW_MS) { r.start = now; r.count = 0; }
    if (++r.count > RATE_LIMIT) {
      if (r.count > RATE_LIMIT * 3) this.kick(socket, 'rate_limited'); // persistent abuse: drop the connection
      return { ok: false, error: 'rate_limited' };
    }
    return null;
  }

  // ───────────── server → client routing ─────────────

  private async route(e: DomainEvent): Promise<void> {
    try {
      switch (e.name) {
        case 'session.revoked': return await this.onSessionRevoked(e);
        case 'user.status_changed': if (e.data?.status !== 'ACTIVE') await this.kickUser(e.entityId, () => true, 'account_disabled'); return;
        case 'access.changed': return await this.recheckAll(e.data?.roleId ? undefined : e.entityId);
        case 'notification.created': {
          const userId = e.data?.userId;
          if (typeof userId === 'string') this.server.to(userRoom(userId)).emit(e.name, this.payload(e)); // only the recipient
          return;
        }
        default: break;
      }
      const topic = EVENT_TOPIC[e.name];
      if (topic) this.server.to(e.farmId ? farmRoom(e.farmId, topic) : allFarmsRoom(topic)).emit(e.name, this.payload(e));
      if (DASHBOARD_TRIGGERS.has(e.name)) this.scheduleDashboardInvalidate(e.farmId);
    } catch (err) {
      this.logger.error({ err, event: e.name }, 'Realtime routing failed'); // never affects the business operation
    }
  }

  private payload(e: DomainEvent) {
    return { name: e.name, entityId: e.entityId, farmId: e.farmId ?? null, actorId: e.actorId ?? null, data: e.data ?? {}, at: e.at };
  }

  private scheduleDashboardInvalidate(farmId?: string): void {
    const key = farmId ?? '*';
    if (this.dashboardTimers.has(key)) return; // coalesce bursts into one refetch hint
    const t = setTimeout(() => {
      this.dashboardTimers.delete(key);
      const room = farmId ? farmRoom(farmId, 'dashboard') : allFarmsRoom('dashboard');
      this.server.to(room).emit('dashboard.invalidate', { farmId: farmId ?? null, at: new Date().toISOString() });
    }, DASHBOARD_DEBOUNCE_MS);
    t.unref();
    this.dashboardTimers.set(key, t);
  }

  private async onSessionRevoked(e: DomainEvent): Promise<void> {
    const familyId = e.data?.familyId;
    const except = e.data?.exceptFamilyId;
    await this.kickUser(e.entityId, (s) => (typeof familyId === 'string' ? sd(s).user.familyId === familyId : sd(s).user.familyId !== except), 'session_revoked');
  }

  private async kickUser(userId: string, match: (s: Socket) => boolean, reason: string): Promise<void> {
    for (const s of await this.server.fetchSockets()) {
      const sock = s as unknown as Socket;
      if (sd(sock)?.user?.id === userId && match(sock)) this.kick(sock, reason);
    }
  }

  private kick(socket: Socket, reason: string): void {
    socket.emit('auth.revoked', { reason });
    socket.disconnect(true);
  }

  // ───────────── permission re-checks ─────────────

  private async recheckAll(onlyUserId?: string): Promise<void> {
    for (const s of await this.server.fetchSockets()) {
      const sock = s as unknown as Socket;
      const d = sd(sock);
      if (!d?.user || (onlyUserId && d.user.id !== onlyUserId)) continue;
      try {
        d.user = await this.authn.revalidate(d.user.id, d.user.familyId, d.tv);
        await this.syncRooms(sock);
      } catch {
        this.kick(sock, 'session_invalid');
      }
    }
  }

  /** Leaves every topic room the user no longer has permission for. */
  private async syncRooms(socket: Socket): Promise<void> {
    const d = sd(socket);
    for (const [topic, farms] of [...d.subs.entries()]) {
      if (d.user.permissions.includes(TOPIC_PERMISSION[topic])) continue;
      for (const f of farms) await socket.leave(farmRoom(f, topic));
      await socket.leave(allFarmsRoom(topic));
      d.subs.delete(topic);
      socket.emit('subscription.revoked', { topic });
    }
  }
}
