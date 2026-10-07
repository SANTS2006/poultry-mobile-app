import {
  BadRequestException, ForbiddenException, HttpException, HttpStatus, Injectable, UnauthorizedException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { DomainEvents } from '../domain/events.service';
import { PasswordService } from '../common/crypto/password.service';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUser, RequestMeta } from './auth.types';
import { EmailTokenService } from './email-token.service';
import { MfaService } from './mfa.service';
import { passwordProblems } from './password-policy';
import { SessionService } from './session.service';
import { ACCESS_TTL_SECONDS, TokenService } from './token.service';

export const MAX_FAILED_ATTEMPTS = 5;
const LOCK_CAP_MINUTES = 30;
const BAD_CREDENTIALS = 'Invalid email or password.';

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: 'Bearer';
}

export type UserSummary = { id: string; email: string; fullName: string; avatar: string | null; emailVerified: boolean; pendingEmail: string | null; roles: string[]; permissions: string[]; mfaEnabled: boolean };

export type LoginResult =
  | { status: 'authenticated'; tokens: SessionTokens; user: UserSummary }
  | { status: 'mfa_required'; mfaToken: string }
  | { status: 'mfa_setup_required'; setupToken: string };

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly sessions: SessionService,
    private readonly mfa: MfaService,
    private readonly emailTokens: EmailTokenService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    private readonly events: DomainEvents,
  ) {}

  // ───────────── login ─────────────

  async login(emailRaw: string, password: string, meta: RequestMeta): Promise<LoginResult> {
    const email = emailRaw.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email }, include: { profile: true } });

    if (user?.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      // Still verify to keep timing uniform, but never let a locked account authenticate.
      await this.passwords.verify(user.passwordHash, password);
      await this.audit.record({ action: 'auth.login.blocked_locked', userId: user.id, entityType: 'user', entityId: user.id, ip: meta.ip, requestId: meta.requestId });
      throw new HttpException('Too many failed attempts. Please try again later.', HttpStatus.TOO_MANY_REQUESTS);
    }

    const ok = await this.passwords.verify(user?.passwordHash, password);
    if (!user || !ok) {
      await this.registerFailure(user?.id ?? null, meta);
      throw new UnauthorizedException(BAD_CREDENTIALS);
    }
    // From here the caller has proven knowledge of the password, so account-state messages leak nothing new.
    if (user.status === 'DISABLED') {
      await this.audit.record({ action: 'auth.login.disabled_account', userId: user.id, ip: meta.ip, requestId: meta.requestId });
      throw new ForbiddenException('Your account has been disabled. Please contact an administrator.');
    }
    if (user.status !== 'ACTIVE') throw new ForbiddenException('Your account is not active. Please contact an administrator.');
    if (!user.emailVerified) throw new ForbiddenException('Please verify your email address before signing in.');

    await this.prisma.user.update({ where: { id: user.id }, data: { failedAttempts: 0, lockedUntil: null } });
    if (this.passwords.needsRehash(user.passwordHash as string)) {
      await this.prisma.user.update({ where: { id: user.id }, data: { passwordHash: await this.passwords.hash(password) } });
    }

    if (user.mfaEnabled) {
      return { status: 'mfa_required', mfaToken: this.tokens.signPurpose('mfa', user.id, user.tokenVersion) };
    }
    const requiresMfa = (await this.prisma.userRole.count({ where: { userId: user.id, role: { mfaRequired: true } } })) > 0;
    if (requiresMfa) {
      // MFA enforcement: privileged roles get no session until an authenticator is enrolled.
      await this.audit.record({ action: 'auth.login.mfa_setup_required', userId: user.id, ip: meta.ip, requestId: meta.requestId });
      return { status: 'mfa_setup_required', setupToken: this.tokens.signPurpose('mfa-setup', user.id, user.tokenVersion) };
    }
    return this.startSession(user.id, meta, 'password');
  }

  /** Second step of login: TOTP or recovery code against the short-lived mfa token. */
  async loginWithMfa(mfaToken: string, input: { code?: string; recoveryCode?: string }, meta: RequestMeta): Promise<LoginResult> {
    if (!input.code === !input.recoveryCode) throw new BadRequestException('Provide either a verification code or a recovery code.');
    const claims = this.tokens.verify(mfaToken, 'mfa');
    const user = await this.prisma.user.findUnique({ where: { id: claims.sub } });
    if (!user || user.status !== 'ACTIVE' || user.tokenVersion !== claims.tv || !user.mfaEnabled) {
      throw new UnauthorizedException('Your session is invalid or has expired. Please sign in again.');
    }
    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      throw new HttpException('Too many failed attempts. Please try again later.', HttpStatus.TOO_MANY_REQUESTS);
    }
    let method: 'totp' | 'recovery';
    try {
      method = await this.mfa.verifyForUser(user.id, input);
    } catch (e) {
      await this.registerFailure(user.id, meta, 'auth.mfa.failed'); // MFA guesses count toward lockout
      throw e;
    }
    await this.prisma.user.update({ where: { id: user.id }, data: { failedAttempts: 0, lockedUntil: null } });
    if (method === 'recovery') {
      await this.audit.record({ action: 'auth.mfa.recovery_code_used', userId: user.id, entityType: 'user', entityId: user.id, ip: meta.ip, requestId: meta.requestId });
    }
    return this.startSession(user.id, meta, method === 'recovery' ? 'mfa_recovery' : 'mfa');
  }

  /** Finishes forced MFA enrolment (from the setup token) by issuing the first session. */
  async completeSetupLogin(userId: string, meta: RequestMeta): Promise<LoginResult> {
    return this.startSession(userId, meta, 'mfa_setup');
  }

  private async startSession(userId: string, meta: RequestMeta, via: string): Promise<LoginResult> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const { familyId, refreshToken, newDevice } = await this.sessions.create(userId, meta);
    await this.prisma.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } });
    await this.audit.record({ action: 'auth.login.success', userId, entityType: 'user', entityId: userId, ip: meta.ip, deviceInfo: meta.deviceName, requestId: meta.requestId, after: { via } });
    if (newDevice) {
      await this.audit.record({ action: 'auth.login.new_device', userId, entityType: 'user', entityId: userId, ip: meta.ip, deviceInfo: `${meta.deviceName ?? ''} ${meta.platform ?? ''}`.trim(), requestId: meta.requestId });
      this.events.emit({ name: 'security.event', entityId: userId, data: { kind: 'new_device', device: (meta.deviceName ?? 'a new device').slice(0, 60) } });
    }
    return {
      status: 'authenticated',
      tokens: this.buildTokens(userId, familyId, user.tokenVersion, refreshToken),
      user: await this.summary(userId),
    };
  }

  private buildTokens(userId: string, familyId: string, tokenVersion: number, refreshToken: string): SessionTokens {
    return { accessToken: this.tokens.signAccess(userId, familyId, tokenVersion), refreshToken, expiresIn: ACCESS_TTL_SECONDS, tokenType: 'Bearer' };
  }

  /** Progressive lockout: 5 failures → 1 min, then doubling up to 30 min. Unknown emails are audited but cannot be locked. */
  private async registerFailure(userId: string | null, meta: RequestMeta, action = 'auth.login.failed'): Promise<void> {
    if (userId) {
      const u = await this.prisma.user.update({ where: { id: userId }, data: { failedAttempts: { increment: 1 } }, select: { failedAttempts: true } });
      if (u.failedAttempts >= MAX_FAILED_ATTEMPTS) {
        const minutes = Math.min(LOCK_CAP_MINUTES, 2 ** (u.failedAttempts - MAX_FAILED_ATTEMPTS));
        await this.prisma.user.update({ where: { id: userId }, data: { lockedUntil: new Date(Date.now() + minutes * 60_000) } });
        await this.audit.record({ action: 'auth.account.locked', userId, entityType: 'user', entityId: userId, ip: meta.ip, requestId: meta.requestId, after: { minutes, failedAttempts: u.failedAttempts } });
        this.events.emit({ name: 'security.event', entityId: userId, data: { kind: 'account_locked', minutes } });
        this.events.emit({ name: 'admin.event', entityId: userId, data: { kind: 'account_locked' } });
      }
    }
    // The attempted email is only recorded for known accounts (avoid storing arbitrary attacker-supplied strings).
    await this.audit.record({ action, userId, entityType: userId ? 'user' : undefined, entityId: userId ?? undefined, ip: meta.ip, deviceInfo: meta.deviceName, requestId: meta.requestId, after: userId ? undefined : { unknownAccount: true } });
  }

  // ───────────── refresh / logout ─────────────

  async refresh(refreshToken: string, meta: RequestMeta): Promise<SessionTokens> {
    const r = await this.sessions.rotate(refreshToken, meta);
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: r.userId }, select: { tokenVersion: true } });
    return this.buildTokens(r.userId, r.familyId, user.tokenVersion, r.refreshToken);
  }

  async logout(user: AuthUser, meta: RequestMeta): Promise<void> {
    await this.sessions.revokeFamily(user.familyId, 'logout');
    await this.audit.record({ action: 'auth.logout', userId: user.id, userName: user.fullName, ip: meta.ip, requestId: meta.requestId });
  }

  /** Logout from all devices: revokes every session and bumps tokenVersion so outstanding access tokens die at once. */
  async logoutAll(user: AuthUser, meta: RequestMeta): Promise<void> {
    await this.prisma.user.update({ where: { id: user.id }, data: { tokenVersion: { increment: 1 } } });
    await this.sessions.revokeAllForUser(user.id, 'logout_all');
    await this.audit.record({ action: 'auth.logout_all', userId: user.id, userName: user.fullName, ip: meta.ip, requestId: meta.requestId });
  }

  // ───────────── e-mail verification, invites, password reset ─────────────

  async verifyEmail(token: string): Promise<void> {
    const userId = await this.emailTokens.consume(token, 'VERIFY_EMAIL');
    if (!userId) throw new BadRequestException('This link is invalid or has expired.');
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true, pendingEmail: true } });
    if (user.pendingEmail) {
      // The link was sent to the new address, so using it proves the mailbox: only now does the sign-in address change.
      try {
        await this.prisma.user.update({ where: { id: userId }, data: { email: user.pendingEmail, pendingEmail: null, emailVerified: true } });
      } catch {
        await this.prisma.user.update({ where: { id: userId }, data: { pendingEmail: null } });
        throw new BadRequestException('That email address is no longer available. Request the change again with a different one.');
      }
      await this.audit.record({ action: 'auth.email.changed', userId, entityType: 'user', entityId: userId, before: { email: user.email }, after: { email: user.pendingEmail } });
      await this.mail.send({ to: user.email, subject: 'Your Makarifor email address was changed', text: `The sign-in email for your account is now ${user.pendingEmail}. If this was not you, contact an administrator immediately.` });
      return;
    }
    await this.prisma.user.update({ where: { id: userId }, data: { emailVerified: true } });
    await this.audit.record({ action: 'auth.email.verified', userId, entityType: 'user', entityId: userId });
  }

  /** Always resolves the same way whether or not the account exists (no user enumeration). */
  async resendVerification(emailRaw: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { email: emailRaw.trim().toLowerCase() } });
    if (!user || user.emailVerified || user.status === 'DISABLED' || !user.passwordHash) return;
    const token = await this.emailTokens.issue(user.id, 'VERIFY_EMAIL');
    await this.emailTokens.sendLink(user.email, 'VERIFY_EMAIL', token);
  }

  /** Invitee sets their password. The invitation link itself proves control of the mailbox, so e-mail becomes verified. */
  async acceptInvite(token: string, password: string, fullName: string | undefined): Promise<void> {
    const userId = await this.emailTokens.consume(token, 'INVITE');
    if (!userId) throw new BadRequestException('This invitation is invalid or has expired.');
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, include: { profile: true } });
    const problems = passwordProblems(password, { email: user.email });
    if (problems.length) {
      // Token was consumed by the compare-and-set; re-issue so the invitee can retry with a stronger password.
      const retry = await this.emailTokens.issue(userId, 'INVITE');
      await this.emailTokens.sendLink(user.email, 'INVITE', retry);
      throw new BadRequestException(`${problems.join(' ')} A fresh invitation link has been emailed to you.`);
    }
    const passwordHash = await this.passwords.hash(password);
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: userId }, data: { passwordHash, status: 'ACTIVE', emailVerified: true } });
      if (fullName && user.profile) await tx.profile.update({ where: { userId }, data: { fullName } });
      await this.audit.record({ action: 'auth.invite.accepted', userId, entityType: 'user', entityId: userId }, tx);
    });
  }

  async forgotPassword(emailRaw: string, meta: RequestMeta): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { email: emailRaw.trim().toLowerCase() } });
    if (!user || user.status === 'DISABLED' || !user.passwordHash) return; // silent: identical response for every input
    const token = await this.emailTokens.issue(user.id, 'RESET_PASSWORD');
    await this.emailTokens.sendLink(user.email, 'RESET_PASSWORD', token);
    await this.audit.record({ action: 'auth.password.reset_requested', userId: user.id, entityType: 'user', entityId: user.id, ip: meta.ip, requestId: meta.requestId });
  }

  async resetPassword(token: string, newPassword: string, meta: RequestMeta): Promise<void> {
    const userId = await this.emailTokens.consume(token, 'RESET_PASSWORD');
    if (!userId) throw new BadRequestException('This link is invalid or has expired.');
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const problems = passwordProblems(newPassword, { email: user.email });
    if (problems.length) {
      const retry = await this.emailTokens.issue(userId, 'RESET_PASSWORD');
      await this.emailTokens.sendLink(user.email, 'RESET_PASSWORD', retry);
      throw new BadRequestException(`${problems.join(' ')} A fresh reset link has been emailed to you.`);
    }
    const passwordHash = await this.passwords.hash(newPassword);
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { passwordHash, emailVerified: true, failedAttempts: 0, lockedUntil: null, tokenVersion: { increment: 1 }, ...(user.status === 'LOCKED' ? { status: 'ACTIVE' } : {}) },
      });
      await this.audit.record({ action: 'auth.password.reset', userId, entityType: 'user', entityId: userId, ip: meta.ip, requestId: meta.requestId }, tx);
    });
    await this.sessions.revokeAllForUser(userId, 'password_reset'); // a reset signs out every device
    this.events.emit({ name: 'security.event', entityId: userId, data: { kind: 'password_changed' } });
    await this.mail.send({ to: user.email, subject: 'Your Makarifor password was changed', text: 'Your password was just reset. If this was not you, contact an administrator immediately.' });
  }

  async changePassword(user: AuthUser, currentPassword: string, newPassword: string, meta: RequestMeta): Promise<void> {
    const row = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    if (!(await this.passwords.verify(row.passwordHash, currentPassword))) {
      await this.audit.record({ action: 'auth.password.change_failed', userId: user.id, ip: meta.ip, requestId: meta.requestId });
      throw new ForbiddenException('Your current password is incorrect.');
    }
    if (currentPassword === newPassword) throw new BadRequestException('Choose a password different from your current one.');
    const problems = passwordProblems(newPassword, { email: user.email });
    if (problems.length) throw new BadRequestException(problems.join(' '));
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { passwordHash: await this.passwords.hash(newPassword) } });
      await this.audit.record({ action: 'auth.password.changed', userId: user.id, userName: user.fullName, entityType: 'user', entityId: user.id, ip: meta.ip, requestId: meta.requestId }, tx);
    });
    await this.sessions.revokeAllForUser(user.id, 'password_changed', user.familyId); // keep only this device signed in
    this.events.emit({ name: 'security.event', entityId: user.id, data: { kind: 'password_changed' } });
    await this.mail.send({ to: user.email, subject: 'Your Makarifor password was changed', text: 'Your password was just changed. If this was not you, contact an administrator immediately.' });
  }

  /** Own display name and picture. The picture itself is never written to the audit log, only that it changed. */
  async updateProfile(user: AuthUser, input: { fullName?: string; avatar?: string | null }, meta: RequestMeta): Promise<UserSummary> {
    const data: { fullName?: string; avatar?: string | null } = {};
    if (input.fullName !== undefined) data.fullName = input.fullName;
    if (input.avatar !== undefined) data.avatar = input.avatar;
    if (Object.keys(data).length === 0) throw new BadRequestException('Nothing to change.');
    await this.prisma.$transaction(async (tx) => {
      await tx.profile.upsert({ where: { userId: user.id }, update: data, create: { userId: user.id, fullName: data.fullName ?? user.fullName, avatar: data.avatar ?? null } });
      await this.audit.record({
        action: 'auth.profile.updated', userId: user.id, userName: user.fullName, entityType: 'user', entityId: user.id,
        before: input.fullName !== undefined ? { fullName: user.fullName } : undefined,
        after: { ...(input.fullName !== undefined ? { fullName: input.fullName } : {}), ...(input.avatar !== undefined ? { avatar: input.avatar === null ? 'removed' : 'changed' } : {}) },
        ip: meta.ip, requestId: meta.requestId,
      }, tx);
    });
    return this.summary(user.id);
  }

  /** Changing the sign-in address needs the current password. The address changes only after the link sent to the NEW mailbox is used (a typo can't lock anyone out), and the old one is told. */
  async changeEmail(user: AuthUser, newEmail: string, currentPassword: string, meta: RequestMeta): Promise<UserSummary> {
    const row = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    if (!(await this.passwords.verify(row.passwordHash, currentPassword))) {
      await this.audit.record({ action: 'auth.email.change_failed', userId: user.id, ip: meta.ip, requestId: meta.requestId });
      throw new ForbiddenException('Your current password is incorrect.');
    }
    if (newEmail === row.email) throw new BadRequestException('That is already your email address.');
    const taken = await this.prisma.user.findUnique({ where: { email: newEmail }, select: { id: true } });
    if (taken) throw new BadRequestException('That email address cannot be used. Try a different one.');
    await this.prisma.user.update({ where: { id: user.id }, data: { pendingEmail: newEmail } });
    await this.audit.record({ action: 'auth.email.change_requested', userId: user.id, userName: user.fullName, entityType: 'user', entityId: user.id, after: { pendingEmail: newEmail }, ip: meta.ip, requestId: meta.requestId });
    const token = await this.emailTokens.issue(user.id, 'VERIFY_EMAIL');
    await this.emailTokens.sendLink(newEmail, 'VERIFY_EMAIL', token);
    return this.summary(user.id);
  }

  // ───────────── helpers ─────────────

  async summary(userId: string): Promise<UserSummary> {
    const u = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: { profile: true, roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } } },
    });
    return {
      id: u.id, email: u.email, fullName: u.profile?.fullName ?? u.email, avatar: u.profile?.avatar ?? null, emailVerified: u.emailVerified, pendingEmail: u.pendingEmail, mfaEnabled: u.mfaEnabled,
      roles: u.roles.map((r) => r.role.code),
      permissions: [...new Set(u.roles.flatMap((r) => r.role.permissions.map((p) => p.permission.code)))],
    };
  }

  /** Re-authentication for sensitive operations (MFA disable, recovery-code regeneration). */
  async requirePasswordAndCode(userId: string, password: string, code: string): Promise<void> {
    const row = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const okPw = await this.passwords.verify(row.passwordHash, password);
    if (!okPw) throw new ForbiddenException('Your password is incorrect.');
    await this.mfa.verifyForUser(userId, { code });
  }
}
