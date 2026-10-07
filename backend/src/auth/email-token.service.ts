import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EmailTokenType, Prisma } from '@prisma/client';
import type { Env } from '../config/env';
import { randomToken, sha256 } from '../common/crypto/tokens';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';

const TTL_MS: Record<EmailTokenType, number> = {
  VERIFY_EMAIL: 24 * 3600_000,
  RESET_PASSWORD: 60 * 60_000,
  INVITE: 72 * 3600_000,
};

const PATH: Record<EmailTokenType, string> = {
  VERIFY_EMAIL: 'verify-email',
  RESET_PASSWORD: 'reset-password',
  INVITE: 'accept-invite',
};

const SUBJECT: Record<EmailTokenType, string> = {
  VERIFY_EMAIL: 'Verify your Makarifor account email',
  RESET_PASSWORD: 'Reset your Makarifor password',
  INVITE: 'You have been invited to Makarifor Agriculture',
};

/** Single-use, expiring, hashed-at-rest tokens for e-mail verification, password reset and invitations. */
@Injectable()
export class EmailTokenService {
  private readonly linkBase: string;
  constructor(private readonly prisma: PrismaService, private readonly mail: MailService, config: ConfigService<Env, true>) {
    this.linkBase = config.get<string>('APP_LINK_BASE');
  }

  /** Invalidates earlier unused tokens of the same type, stores the hash of a new one, returns the raw token. */
  async issue(userId: string, type: EmailTokenType, tx?: Prisma.TransactionClient): Promise<string> {
    const db = tx ?? this.prisma;
    const token = randomToken(32);
    await db.emailToken.updateMany({ where: { userId, type, usedAt: null }, data: { usedAt: new Date() } });
    await db.emailToken.create({ data: { userId, type, tokenHash: sha256(token), expiresAt: new Date(Date.now() + TTL_MS[type]) } });
    return token;
  }

  /** Atomically consumes a token (compare-and-set on usedAt) so it can never be used twice. */
  async consume(token: string, type: EmailTokenType, tx?: Prisma.TransactionClient): Promise<string | null> {
    const db = tx ?? this.prisma;
    const row = await db.emailToken.findUnique({ where: { tokenHash: sha256(token) } });
    if (!row || row.type !== type || row.usedAt || row.expiresAt.getTime() <= Date.now()) return null;
    const won = await db.emailToken.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } });
    return won.count === 1 ? row.userId : null;
  }

  async sendLink(email: string, type: EmailTokenType, token: string): Promise<void> {
    const link = `${this.linkBase}${PATH[type]}?token=${encodeURIComponent(token)}`;
    const expiry = Math.round(TTL_MS[type] / 3600_000);
    await this.mail.send({
      to: email,
      subject: SUBJECT[type],
      text: `Open this link on your phone to continue:\n\n${link}\n\nThe link works once and expires in ${expiry >= 1 ? `${expiry} hour(s)` : '1 hour'}. If you did not expect this message, ignore it.`,
    });
  }
}
