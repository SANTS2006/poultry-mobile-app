import { Injectable, UnauthorizedException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AuditService } from '../audit/audit.service';
import { DomainEvents } from '../domain/events.service';
import { randomToken } from '../common/crypto/tokens';
import { PrismaService } from '../prisma/prisma.service';
import type { RequestMeta } from './auth.types';
import { TokenService } from './token.service';

export const SESSION_ABSOLUTE_MS = 30 * 24 * 3600_000; // re-authentication required after 30 days
export const SESSION_IDLE_MS = 14 * 24 * 3600_000; // …or after 14 days without use
const MAX_ACTIVE_DEVICES = 10;
const INVALID = 'Your session is invalid or has expired. Please sign in again.';

@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
  ) {}

  /** Starts a new login (new token family). Returns the opaque refresh token — shown once, never stored in clear. */
  async create(userId: string, meta: RequestMeta): Promise<{ familyId: string; refreshToken: string; newDevice: boolean }> {
    const familyId = randomUUID();
    const refreshToken = randomToken(48);
    const newDevice = meta.deviceName
      ? (await this.prisma.session.count({ where: { userId, deviceName: meta.deviceName, platform: meta.platform ?? null } })) === 0
      : false;
    await this.prisma.session.create({
      data: {
        userId, familyId, refreshTokenHash: this.tokens.hashRefreshToken(refreshToken),
        deviceName: meta.deviceName, platform: meta.platform, ip: meta.ip, userAgent: meta.userAgent?.slice(0, 200),
        expiresAt: new Date(Date.now() + SESSION_ABSOLUTE_MS),
      },
    });
    await this.enforceDeviceLimit(userId);
    return { familyId, refreshToken, newDevice };
  }

  /**
   * Refresh-token rotation with reuse detection. Each refresh retires the presented token and issues a new one in the same
   * family. Presenting an already-rotated token means it was copied: the WHOLE family is revoked.
   */
  async rotate(presented: string, meta: RequestMeta): Promise<{ userId: string; familyId: string; refreshToken: string }> {
    const hash = this.tokens.hashRefreshToken(presented);
    const session = await this.prisma.session.findUnique({ where: { refreshTokenHash: hash } });
    if (!session) throw new UnauthorizedException(INVALID);

    if (session.revokedAt) {
      if (session.revokedReason === 'rotated') {
        await this.revokeFamily(session.familyId, 'reuse_detected');
        await this.audit.record({
          action: 'auth.refresh.reuse_detected', userId: session.userId, entityType: 'session', entityId: session.familyId,
          ip: meta.ip, deviceInfo: meta.deviceName, requestId: meta.requestId,
        });
        this.events.emit({ name: 'security.event', entityId: session.userId, data: { kind: 'refresh_reuse' } });
      }
      throw new UnauthorizedException(INVALID);
    }
    const now = Date.now();
    if (session.expiresAt.getTime() <= now || now - session.lastUsedAt.getTime() > SESSION_IDLE_MS) {
      await this.revokeFamily(session.familyId, 'expired');
      throw new UnauthorizedException(INVALID);
    }
    const user = await this.prisma.user.findUnique({ where: { id: session.userId }, select: { status: true, deletedAt: true } });
    if (!user || user.status !== 'ACTIVE' || user.deletedAt) throw new UnauthorizedException(INVALID);

    const refreshToken = randomToken(48);
    await this.prisma.$transaction(async (tx) => {
      // Compare-and-set: of two concurrent refreshes with the same token only one wins.
      const won = await tx.session.updateMany({
        where: { id: session.id, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: 'rotated' },
      });
      if (won.count !== 1) throw new UnauthorizedException(INVALID);
      await tx.session.create({
        data: {
          userId: session.userId, familyId: session.familyId, refreshTokenHash: this.tokens.hashRefreshToken(refreshToken),
          deviceName: session.deviceName, platform: session.platform, ip: meta.ip ?? session.ip,
          userAgent: session.userAgent, expiresAt: session.expiresAt, // absolute lifetime is NOT extended by refreshing
        },
      });
    });
    return { userId: session.userId, familyId: session.familyId, refreshToken };
  }

  async revokeFamily(familyId: string, reason: string): Promise<void> {
    const s = await this.prisma.session.findFirst({ where: { familyId }, select: { userId: true } });
    await this.prisma.session.updateMany({ where: { familyId, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: reason } });
    // live WebSocket connections of this device must drop immediately
    if (s) this.events.emit({ name: 'session.revoked', entityId: s.userId, data: { familyId } });
  }

  /** Revokes every active session of a user, optionally keeping one family (e.g. the caller's after a password change). */
  async revokeAllForUser(userId: string, reason: string, exceptFamilyId?: string): Promise<number> {
    const r = await this.prisma.session.updateMany({
      where: { userId, revokedAt: null, ...(exceptFamilyId ? { familyId: { not: exceptFamilyId } } : {}) },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
    this.events.emit({ name: 'session.revoked', entityId: userId, data: { exceptFamilyId: exceptFamilyId ?? null } });
    return r.count;
  }

  /** One row per signed-in device (the live token of each family). */
  listActive(userId: string) {
    return this.prisma.session.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { lastUsedAt: 'desc' },
      select: { id: true, familyId: true, deviceName: true, platform: true, ip: true, createdAt: true, lastUsedAt: true, expiresAt: true },
    });
  }

  /** Revokes the device that owns `sessionId`, only if it belongs to `userId`. */
  async revokeOwn(userId: string, sessionId: string): Promise<boolean> {
    const s = await this.prisma.session.findFirst({ where: { id: sessionId, userId }, select: { familyId: true } });
    if (!s) return false;
    await this.revokeFamily(s.familyId, 'revoked_by_user');
    return true;
  }

  touch(familyId: string): Promise<unknown> {
    return this.prisma.session.updateMany({ where: { familyId, revokedAt: null }, data: { lastUsedAt: new Date() } });
  }

  private async enforceDeviceLimit(userId: string): Promise<void> {
    const active = await this.prisma.session.findMany({
      where: { userId, revokedAt: null }, orderBy: { createdAt: 'desc' }, select: { familyId: true },
    });
    for (const s of active.slice(MAX_ACTIVE_DEVICES)) await this.revokeFamily(s.familyId, 'device_limit');
  }
}
