import { BadRequestException, Injectable } from '@nestjs/common';
import { randomInt } from 'crypto';
import { PinoLogger } from 'nestjs-pino';
import { AuditService } from '../audit/audit.service';
import { background } from '../common/background';
import { safeEqual } from '../common/crypto/tokens';
import { MailComposer } from '../mail/mail-composer.service';
import { PrismaService } from '../prisma/prisma.service';
import type { RequestMeta } from './auth.types';
import { TokenService } from './token.service';

export const RESET_CODE_TTL_MS = 5 * 60_000;
export const RESET_CODE_MAX_ATTEMPTS = 5;
export const RESET_CODE_COOLDOWN_MS = 60_000;
const INVALID = 'That code is incorrect or has expired. Request a new one.';

/**
 * Password-reset codes. Design:
 *  • 8 digits from a CSPRNG, valid for 5 minutes, usable exactly once (compare-and-set on `usedAt`);
 *  • bound to the e-mail address it was sent to: redeeming needs that address AND the code, and the code dies if the account's address changed;
 *  • only the HMAC of the code is stored (keyed with a server secret and the user id), never the code;
 *  • 5 wrong tries lock the code; requesting a new one replaces the old one; a new request within a minute of the last is ignored;
 *  • every answer is identical for unknown accounts, so the endpoints reveal nothing about who has an account.
 */
@Injectable()
export class PasswordResetService {
  constructor(
    private readonly prisma: PrismaService, private readonly tokens: TokenService, private readonly mail: MailComposer, private readonly audit: AuditService, private readonly logger: PinoLogger,
  ) { this.logger.setContext(PasswordResetService.name); }

  private hash(userId: string, code: string): string { return this.tokens.hashRefreshToken(`reset:${userId}:${code}`); }

  /** Requests being handled right now (e-mail address → true): pressing the button again meanwhile changes nothing. */
  private readonly inFlight = new Set<string>();

  /**
   * Answers at once and does the rest (look the account up, store the code, send the e-mail) in the background, so the person never waits for the
   * database or the mail provider and pressing the button again is harmless: a repeat while the first is being handled, or within a minute of the
   * last code, is ignored. Always resolves the same way, whether or not the account exists.
   */
  request(emailRaw: string, meta: RequestMeta): Promise<void> | void {
    const email = emailRaw.trim().toLowerCase();
    if (this.inFlight.has(email)) return;
    this.inFlight.add(email);
    return background(() => this.issue(email, meta).finally(() => this.inFlight.delete(email)), (e) => this.logger.error({ err: e instanceof Error ? e.message : 'failed' }, 'Could not issue a password reset code'));
  }

  private async issue(email: string, meta: RequestMeta): Promise<void> {
    // the account and its newest code are looked up side by side
    const [user, latest] = await Promise.all([
      this.prisma.user.findUnique({ where: { email } }),
      this.prisma.passwordResetCode.findFirst({ where: { user: { email } }, orderBy: { createdAt: 'desc' } }),
    ]);
    if (!user || user.status === 'DISABLED' || !user.passwordHash) return;
    if (latest && Date.now() - latest.createdAt.getTime() < RESET_CODE_COOLDOWN_MS) return; // anti-spam: at most one e-mail a minute per account
    const code = String(randomInt(0, 100_000_000)).padStart(8, '0');
    const created = await this.prisma.passwordResetCode.create({ data: { userId: user.id, email: user.email, codeHash: this.hash(user.id, code), expiresAt: new Date(Date.now() + RESET_CODE_TTL_MS) } });
    // the e-mail goes out straight away; older codes are retired alongside it
    await Promise.all([
      this.prisma.passwordResetCode.updateMany({ where: { userId: user.id, usedAt: null, id: { not: created.id } }, data: { usedAt: new Date() } }),
      this.mail.send(user.email, 'Your password reset code', {
        preheader: `Your reset code is ${code}. It works once and expires in 5 minutes.`,
        heading: 'Reset your password',
        paragraphs: ['We received a request to reset the password for your account. Enter this code in the app, together with this email address, to choose a new password.'],
        details: [
          { label: 'Reset code', value: code.replace(/(\d{4})(\d{4})/, '$1 $2'), emphasis: true },
          { label: 'Valid for', value: '5 minutes, one use only' },
          { label: 'Works only for', value: user.email },
        ],
        note: 'If you did not ask for this, ignore this email: your password has not changed. Never share this code with anyone.',
      }),
    ]);
    await this.audit.record({ action: 'auth.password.reset_requested', userId: user.id, entityType: 'user', entityId: user.id, ip: meta.ip, requestId: meta.requestId });
  }

  /**
   * Checks the code WITHOUT using it up (so a too-weak new password can be corrected within the 5 minutes) and returns the user id.
   * Wrong codes count as attempts; the fifth locks the code.
   */
  async verify(emailRaw: string, codeRaw: string, meta: RequestMeta): Promise<{ userId: string; codeId: string }> {
    const email = emailRaw.trim().toLowerCase();
    const code = codeRaw.replace(/\s+/g, '');
    const user = await this.prisma.user.findUnique({ where: { email } });
    const row = user ? await this.prisma.passwordResetCode.findFirst({ where: { userId: user.id, usedAt: null, expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'desc' } }) : null;
    if (!user || !row || row.email !== user.email || row.attempts >= RESET_CODE_MAX_ATTEMPTS) {
      // keep the timing of the "no such account" path close to the real one
      this.hash(user?.id ?? '00000000-0000-0000-0000-000000000000', code);
      throw new BadRequestException(INVALID);
    }
    if (!safeEqual(row.codeHash, this.hash(user.id, code))) {
      const updated = await this.prisma.passwordResetCode.update({ where: { id: row.id }, data: { attempts: { increment: 1 } } });
      if (updated.attempts >= RESET_CODE_MAX_ATTEMPTS) {
        await this.prisma.passwordResetCode.update({ where: { id: row.id }, data: { usedAt: new Date() } });
        await this.audit.record({ action: 'auth.password.reset_code_locked', userId: user.id, entityType: 'user', entityId: user.id, ip: meta.ip, requestId: meta.requestId });
      }
      throw new BadRequestException(INVALID);
    }
    return { userId: user.id, codeId: row.id };
  }

  /** Uses the code up. Exactly one caller can win, even with simultaneous requests. */
  async consume(codeId: string): Promise<boolean> {
    const won = await this.prisma.passwordResetCode.updateMany({ where: { id: codeId, usedAt: null, expiresAt: { gt: new Date() } }, data: { usedAt: new Date() } });
    return won.count === 1;
  }
}
