import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { TtlCache } from '../../common/cache';
import { DomainEvents } from '../../domain/events.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser } from '../auth.types';
import { IS_PUBLIC } from '../decorators/public.decorator';
import { TokenService } from '../token.service';

const UNAUTHENTICATED = 'Your session is invalid or has expired. Please sign in again.';

@Injectable()
export class AuthenticationService {
  /**
   * The live state of a signed-in user (account status, roles, permissions, session family), kept for 10 s per token. Without this every
   * request costs two database round trips before it does any work. The cache is emptied the moment anything that could change the answer
   * happens (session revoked, user disabled, roles/permissions changed); a bumped token version changes the key by itself.
   */
  private readonly live = new TtlCache<AuthUser>(10_000);

  constructor(private readonly tokens: TokenService, private readonly prisma: PrismaService, events: DomainEvents) {
    for (const name of ['session.revoked', 'user.status_changed', 'access.changed'] as const) events.on(name, () => this.live.clear());
  }

  /** Validates the short-lived token issued to privileged roles that must enrol in MFA before receiving a session. */
  async authenticateSetupToken(token: string): Promise<{ id: string; email: string }> {
    const claims = this.tokens.verify(token, 'mfa-setup');
    const user = await this.prisma.user.findUnique({ where: { id: claims.sub } });
    if (!user || user.deletedAt || user.status !== 'ACTIVE' || user.tokenVersion !== claims.tv) {
      throw new UnauthorizedException(UNAUTHENTICATED);
    }
    return { id: user.id, email: user.email };
  }

  /**
   * Validates an access token AND live server state on every request, so that disabling a user, revoking a session,
   * logging out everywhere, or changing roles takes effect immediately rather than when the token expires.
   */
  async authenticateAccessToken(token: string): Promise<AuthUser> {
    const claims = this.tokens.verify(token, 'access');
    return this.revalidate(claims.sub, claims.fid as string, claims.tv);
  }

  /** Re-checks live server state for an already-verified token (used per HTTP request and periodically for WebSockets). */
  async revalidate(userId: string, familyId: string, tokenVersion: number): Promise<AuthUser> {
    return this.live.get(`${userId}:${familyId}:${tokenVersion}`, () => this.loadLive(userId, familyId, tokenVersion));
  }

  private async loadLive(userId: string, familyId: string, tokenVersion: number): Promise<AuthUser> {
    // The two checks are independent, so they run at the same time (one round trip instead of two).
    const [user, activeFamily] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        include: { profile: true, roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } } },
      }),
      this.prisma.session.findFirst({ where: { familyId, userId, revokedAt: null, expiresAt: { gt: new Date() } }, select: { id: true } }),
    ]);
    if (!user || user.deletedAt || user.status !== 'ACTIVE' || user.tokenVersion !== tokenVersion) throw new UnauthorizedException(UNAUTHENTICATED);
    if (!activeFamily) throw new UnauthorizedException(UNAUTHENTICATED);
    // Session rows are rotated on refresh; the *family* is what a logout/revocation kills.
    return {
      id: user.id,
      email: user.email,
      fullName: user.profile?.fullName ?? user.email,
      familyId,
      roles: user.roles.map((r) => r.role.code),
      permissions: [...new Set(user.roles.flatMap((r) => r.role.permissions.map((p) => p.permission.code)))],
      mfaEnabled: user.mfaEnabled,
    };
  }

  /** Verifies signature/claims only (no database) — used to read `exp`/`tv`/`fid` for a WebSocket handshake. */
  verifyAccessClaims(token: string) {
    return this.tokens.verify(token, 'access');
  }
}

export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && token ? token : null;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly auth: AuthenticationService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true; // WebSocket connections authenticate in the gateway handshake
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()])) return true;
    const req = ctx.switchToHttp().getRequest<import('express').Request & { user?: AuthUser }>();
    const token = bearerToken(req.headers.authorization);
    if (!token) throw new UnauthorizedException(UNAUTHENTICATED);
    req.user = await this.auth.authenticateAccessToken(token);
    return true;
  }
}
