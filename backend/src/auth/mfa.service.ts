import { BadRequestException, ConflictException, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import * as QRCode from 'qrcode';
import { AuditService } from '../audit/audit.service';
import { DomainEvents } from '../domain/events.service';
import { EncryptionService } from '../common/crypto/encryption.service';
import { generateRecoveryCode, normalizeRecoveryCode, sha256 } from '../common/crypto/tokens';
import { generateTotpSecret, otpauthUri, verifyTotp } from '../common/crypto/totp';
import { PrismaService } from '../prisma/prisma.service';
import type { RequestMeta } from './auth.types';
import { SessionService } from './session.service';

export const RECOVERY_CODE_COUNT = 10;
const CODE_INVALID = 'The verification code is not valid.';

@Injectable()
export class MfaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly enc: EncryptionService,
    private readonly audit: AuditService,
    private readonly sessions: SessionService,
    private readonly events: DomainEvents,
  ) {}

  async beginEnrollment(userId: string, email: string): Promise<{ secret: string; otpauthUri: string; qrCodeDataUrl: string }> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { mfaEnabled: true } });
    if (user.mfaEnabled) throw new ConflictException('Two-factor authentication is already enabled.');
    const secret = generateTotpSecret();
    const secretEncrypted = this.enc.encrypt(secret);
    await this.prisma.mfaSecret.upsert({
      where: { userId },
      create: { userId, secretEncrypted },
      update: { secretEncrypted, confirmedAt: null, lastUsedStep: null },
    });
    const uri = otpauthUri(secret, email);
    return { secret, otpauthUri: uri, qrCodeDataUrl: await QRCode.toDataURL(uri, { margin: 1, width: 240 }) };
  }

  /** Confirms enrolment with a first valid code, turns MFA on and returns one-time-visible recovery codes. */
  async confirmEnrollment(userId: string, code: string, meta: RequestMeta): Promise<string[]> {
    const rec = await this.prisma.mfaSecret.findUnique({ where: { userId } });
    if (!rec || rec.confirmedAt) throw new BadRequestException('Start two-factor setup first.');
    const step = verifyTotp(this.enc.decrypt(rec.secretEncrypted), code);
    if (step === null) throw new BadRequestException(CODE_INVALID);
    const codes = await this.prisma.$transaction(async (tx) => {
      await tx.mfaSecret.update({ where: { userId }, data: { confirmedAt: new Date(), lastUsedStep: step } });
      await tx.user.update({ where: { id: userId }, data: { mfaEnabled: true } });
      const fresh = await this.replaceRecoveryCodes(userId, tx);
      await this.audit.record({ action: 'auth.mfa.enabled', userId, entityType: 'user', entityId: userId, ip: meta.ip, requestId: meta.requestId }, tx);
      return fresh;
    });
    this.events.emit({ name: 'security.event', entityId: userId, data: { kind: 'mfa_enabled' } });
    return codes;
  }

  /**
   * Verifies a TOTP code or a recovery code for login/step-up. TOTP codes are single-use (replay-protected);
   * recovery codes are consumed atomically. Returns which method succeeded.
   */
  async verifyForUser(userId: string, input: { code?: string; recoveryCode?: string }): Promise<'totp' | 'recovery'> {
    if (input.recoveryCode) {
      const hash = sha256(normalizeRecoveryCode(input.recoveryCode));
      const row = await this.prisma.recoveryCode.findFirst({ where: { userId, codeHash: hash, usedAt: null } });
      if (row) {
        const won = await this.prisma.recoveryCode.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } });
        if (won.count === 1) return 'recovery';
      }
      throw new UnauthorizedException(CODE_INVALID);
    }
    const rec = await this.prisma.mfaSecret.findUnique({ where: { userId } });
    if (!rec?.confirmedAt || !input.code) throw new UnauthorizedException(CODE_INVALID);
    const step = verifyTotp(this.enc.decrypt(rec.secretEncrypted), input.code);
    if (step === null) throw new UnauthorizedException(CODE_INVALID);
    // Replay protection: accept a time-step only once (atomic compare-and-set).
    const won = await this.prisma.$executeRaw`
      UPDATE "MfaSecret" SET "lastUsedStep" = ${step}
      WHERE "userId" = ${userId}::uuid AND ("lastUsedStep" IS NULL OR "lastUsedStep" < ${step})`;
    if (won !== 1) throw new UnauthorizedException(CODE_INVALID);
    return 'totp';
  }

  async remainingRecoveryCodes(userId: string): Promise<number> {
    return this.prisma.recoveryCode.count({ where: { userId, usedAt: null } });
  }

  async regenerateRecoveryCodes(userId: string, meta: RequestMeta): Promise<string[]> {
    return this.prisma.$transaction(async (tx) => {
      const codes = await this.replaceRecoveryCodes(userId, tx);
      await this.audit.record({ action: 'auth.mfa.recovery_codes_regenerated', userId, entityType: 'user', entityId: userId, ip: meta.ip, requestId: meta.requestId }, tx);
      return codes;
    });
  }

  /** User-initiated disable (caller has re-authenticated). Refused for roles that require MFA. */
  async disable(userId: string, keepFamilyId: string, meta: RequestMeta): Promise<void> {
    const requiring = await this.prisma.userRole.count({ where: { userId, role: { mfaRequired: true } } });
    if (requiring > 0) throw new ForbiddenException('Two-factor authentication is required for your role and cannot be turned off.');
    await this.clear(userId, 'auth.mfa.disabled', meta, undefined, keepFamilyId);
  }

  /** Administrator reset (lost device). Signs the user out everywhere; audited with a mandatory reason. */
  async adminReset(targetUserId: string, actor: { id: string; name: string }, reason: string, meta: RequestMeta): Promise<void> {
    await this.clear(targetUserId, 'auth.mfa.reset_by_admin', meta, { actor, reason });
  }

  private async clear(
    userId: string, action: string, meta: RequestMeta, admin?: { actor: { id: string; name: string }; reason: string }, keepFamilyId?: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.mfaSecret.deleteMany({ where: { userId } });
      await tx.recoveryCode.deleteMany({ where: { userId } });
      await tx.user.update({ where: { id: userId }, data: { mfaEnabled: false, ...(admin ? { tokenVersion: { increment: 1 } } : {}) } });
      await this.audit.record({
        action, userId: admin?.actor.id ?? userId, userName: admin?.actor.name, entityType: 'user', entityId: userId,
        reason: admin?.reason, ip: meta.ip, requestId: meta.requestId,
      }, tx);
    });
    await this.sessions.revokeAllForUser(userId, action, keepFamilyId);
    this.events.emit({ name: 'security.event', entityId: userId, actorId: admin?.actor.id, data: { kind: admin ? 'mfa_reset' : 'mfa_disabled' } });
  }

  private async replaceRecoveryCodes(userId: string, tx: Parameters<Parameters<PrismaService['$transaction']>[0]>[0]): Promise<string[]> {
    await tx.recoveryCode.deleteMany({ where: { userId } });
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
    await tx.recoveryCode.createMany({ data: codes.map((c) => ({ userId, codeHash: sha256(normalizeRecoveryCode(c)) })) });
    return codes;
  }
}
