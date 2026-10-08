import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EmailTokenType, Prisma } from '@prisma/client';
import type { Env } from '../config/env';
import { randomToken, sha256 } from '../common/crypto/tokens';
import { MailComposer } from '../mail/mail-composer.service';
import { PrismaService } from '../prisma/prisma.service';

/** Only e-mail confirmation uses a long token now: invitations e-mail a temporary password and password resets use 8-digit codes (PasswordResetService). The other enum values stay in the database only. */
type LinkType = 'VERIFY_EMAIL';

const TTL_MS: Record<EmailTokenType, number> = {
  VERIFY_EMAIL: 24 * 3600_000,
  RESET_PASSWORD: 60 * 60_000,
  INVITE: 72 * 3600_000,
};

const PATH: Record<LinkType, string> = { VERIFY_EMAIL: 'verify-email' };

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
    await this.mail.send(email, 'Confirm your email address', {
      preheader: 'Confirm this email address for your account.',
      heading: 'Confirm your email address',
      paragraphs: ['Please confirm this email address for your account.', 'In the app, open Settings, then Email address, and paste the code below.'],
      details: [{ label: 'Confirmation code', value: token, emphasis: true }, { label: 'Valid for', value: `${hours} hour${hours === 1 ? '' : 's'}, one use only` }],
      button: { label: 'Open the app to confirm', url: link },
      note: 'If you did not expect this email, ignore it.',
    });
  }
}
