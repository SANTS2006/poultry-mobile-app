import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EmailTokenType, Prisma } from '@prisma/client';
import type { Env } from '../config/env';
import { randomToken, sha256 } from '../common/crypto/tokens';
import { MailComposer } from '../mail/mail-composer.service';
import { PrismaService } from '../prisma/prisma.service';

/** Invitations no longer use tokens (a temporary password is e-mailed instead); the INVITE value stays in the database enum only. */
type LinkType = 'VERIFY_EMAIL' | 'RESET_PASSWORD';

const TTL_MS: Record<EmailTokenType, number> = {
  VERIFY_EMAIL: 24 * 3600_000,
  RESET_PASSWORD: 60 * 60_000,
  INVITE: 72 * 3600_000,
};

const PATH: Record<LinkType, string> = { VERIFY_EMAIL: 'verify-email', RESET_PASSWORD: 'reset-password' };

/** Single-use, expiring, hashed-at-rest tokens for e-mail verification, password reset and invitations. */
@Injectable()
export class EmailTokenService {
  private readonly linkBase: string;
  constructor(private readonly prisma: PrismaService, private readonly mail: MailComposer, config: ConfigService<Env, true>) {
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

  /**
   * E-mails a single-use token. The token is shown as a code to copy into the app (links with a custom scheme are not clickable in many
   * mail apps and do not work in Expo Go) and also as a button for builds where the link does open the app.
   */
  async sendLink(email: string, type: LinkType, token: string): Promise<void> {
    const link = `${this.linkBase}${PATH[type]}?token=${encodeURIComponent(token)}`;
    const hours = Math.max(1, Math.round(TTL_MS[type] / 3600_000));
    const reset = type === 'RESET_PASSWORD';
    await this.mail.send(email, reset ? 'Reset your password' : 'Confirm your email address', {
      preheader: reset ? 'Use this code to choose a new password.' : 'Confirm this email address for your account.',
      heading: reset ? 'Reset your password' : 'Confirm your email address',
      paragraphs: [
        reset ? 'We received a request to reset the password for your account.' : 'Please confirm this email address for your account.',
        reset ? 'In the app, open Forgot password, then choose “I have a reset code” and paste the code below.' : 'In the app, open Settings, then Email address, and paste the code below.',
      ],
      details: [{ label: reset ? 'Reset code' : 'Confirmation code', value: token, emphasis: true }, { label: 'Valid for', value: `${hours} hour${hours === 1 ? '' : 's'}, one use only` }],
      button: { label: reset ? 'Open the app to reset' : 'Open the app to confirm', url: link },
      note: reset ? 'If you did not ask for this, ignore this email: your password has not changed.' : 'If you did not expect this email, ignore it.',
    });
  }
}
