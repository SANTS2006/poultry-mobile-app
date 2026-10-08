import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHmac } from 'crypto';
import type { Env } from '../config/env';

export type TokenType = 'access' | 'mfa' | 'mfa-setup' | 'pwd-change';

export interface TokenClaims {
  sub: string;
  typ: TokenType;
  tv: number;
  fid?: string;
  exp?: number;
}

export const ACCESS_TTL_SECONDS = 15 * 60;
const PURPOSE_TTL: Record<Exclude<TokenType, 'access'>, number> = { mfa: 5 * 60, 'mfa-setup': 15 * 60, 'pwd-change': 15 * 60 };
const ISSUER = 'makarifor-api';
const AUDIENCE = 'makarifor-app';

@Injectable()
export class TokenService {
  private readonly refreshPepper: string;

  constructor(private readonly jwt: JwtService, config: ConfigService<Env, true>) {
    this.refreshPepper = config.get<string>('JWT_REFRESH_SECRET');
  }

  signAccess(userId: string, familyId: string, tokenVersion: number): string {
    return this.jwt.sign({ typ: 'access', tv: tokenVersion, fid: familyId }, { subject: userId, expiresIn: ACCESS_TTL_SECONDS, issuer: ISSUER, audience: AUDIENCE });
  }

  /** Short-lived, single-purpose tokens for the intermediate MFA steps. They are rejected as access tokens. */
  signPurpose(typ: Exclude<TokenType, 'access'>, userId: string, tokenVersion: number): string {
    return this.jwt.sign({ typ, tv: tokenVersion }, { subject: userId, expiresIn: PURPOSE_TTL[typ], issuer: ISSUER, audience: AUDIENCE });
  }

  verify(token: string, expected: TokenType): TokenClaims {
    try {
      const c = this.jwt.verify<TokenClaims>(token, { algorithms: ['HS256'], issuer: ISSUER, audience: AUDIENCE });
      if (c.typ !== expected || typeof c.sub !== 'string' || typeof c.tv !== 'number') throw new Error('wrong token type');
      if (expected === 'access' && typeof c.fid !== 'string') throw new Error('missing family');
      return c;
    } catch {
      throw new UnauthorizedException('Your session is invalid or has expired. Please sign in again.');
    }
  }

  /** Reads the (unverified) token type only to route to the right verifier; every path then fully verifies the token. */
  peekType(token: string): string | undefined {
    const decoded = this.jwt.decode<{ typ?: string } | null>(token);
    return typeof decoded?.typ === 'string' ? decoded.typ : undefined;
  }

  /** Refresh tokens are opaque random values; the DB stores only HMAC(pepper, token), so a DB leak cannot mint tokens. */
  hashRefreshToken(token: string): string {
    return createHmac('sha256', this.refreshPepper).update(token).digest('hex');
  }
}
