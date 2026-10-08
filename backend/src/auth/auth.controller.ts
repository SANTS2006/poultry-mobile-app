import { Body, Controller, Delete, Get, HttpCode, Patch, Param, ParseUUIDPipe, Post, Req, UnauthorizedException } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { AuditService } from '../audit/audit.service';
import { AuthService } from './auth.service';
import type { AuthUser, RequestMeta } from './auth.types';
import { CurrentUser, Meta } from './decorators/current-user.decorator';
import { AnyAuthenticated } from './decorators/permissions.decorator';
import { Public } from './decorators/public.decorator';
import {
  ChangeEmailDto, FirstPasswordDto, ChangePasswordDto, UpdateProfileDto, EmailOnlyDto, LoginDto, MfaConfirmDto, MfaLoginDto, RefreshDto, ResetPasswordDto, StepUpDto, TokenDto,
} from './dto/auth.dto';
import { AuthenticationService, bearerToken } from './guards/jwt-auth.guard';
import { MfaService } from './mfa.service';
import { SessionService } from './session.service';
import { TokenService } from './token.service';

const STRICT = { default: { limit: 5, ttl: 60_000 } }; // 5 / minute / client for credential-guessing surfaces
const MODERATE = { default: { limit: 10, ttl: 60_000 } };

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly mfa: MfaService,
    private readonly sessions: SessionService,
    private readonly tokens: TokenService,
    private readonly authn: AuthenticationService,
    private readonly audit: AuditService,
  ) {}

  @Public() @Throttle(STRICT) @HttpCode(200) @Post('login')
  login(@Body() dto: LoginDto, @Meta() meta: RequestMeta) {
    return this.auth.login(dto.email, dto.password, meta);
  }

  @Public() @Throttle(STRICT) @HttpCode(200) @Post('mfa/verify')
  mfaLogin(@Body() dto: MfaLoginDto, @Meta() meta: RequestMeta) {
    return this.auth.loginWithMfa(dto.mfaToken, { code: dto.code, recoveryCode: dto.recoveryCode }, meta);
  }

  @Public() @Throttle(MODERATE) @HttpCode(200) @Post('refresh')
  refresh(@Body() dto: RefreshDto, @Meta() meta: RequestMeta) {
    return this.auth.refresh(dto.refreshToken, meta);
  }

  @AnyAuthenticated() @HttpCode(204) @Post('logout')
  async logout(@CurrentUser() user: AuthUser, @Meta() meta: RequestMeta): Promise<void> {
    await this.auth.logout(user, meta);
  }

  @AnyAuthenticated() @HttpCode(204) @Post('logout-all')
  async logoutAll(@CurrentUser() user: AuthUser, @Meta() meta: RequestMeta): Promise<void> {
    await this.auth.logoutAll(user, meta);
  }

  @AnyAuthenticated() @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.auth.summary(user.id);
  }

  @AnyAuthenticated() @Throttle(MODERATE) @Patch('profile')
  updateProfile(@CurrentUser() user: AuthUser, @Body() dto: UpdateProfileDto, @Meta() meta: RequestMeta) {
    return this.auth.updateProfile(user, dto, meta);
  }

  @AnyAuthenticated() @Throttle(STRICT) @HttpCode(200) @Post('change-email')
  changeEmail(@CurrentUser() user: AuthUser, @Body() dto: ChangeEmailDto, @Meta() meta: RequestMeta) {
    return this.auth.changeEmail(user, dto.newEmail, dto.currentPassword, meta);
  }

  // ── e-mail verification / password reset (public, enumeration-safe, single-use tokens) ──

  @Public() @Throttle(MODERATE) @HttpCode(204) @Post('verify-email')
  async verifyEmail(@Body() dto: TokenDto): Promise<void> {
    await this.auth.verifyEmail(dto.token);
  }

  @Public() @Throttle({ default: { limit: 3, ttl: 60_000 } }) @HttpCode(202) @Post('resend-verification')
  async resend(@Body() dto: EmailOnlyDto) {
    await this.auth.resendVerification(dto.email);
    return { message: 'If the account exists and is unverified, an email has been sent.' };
  }

  /** First sign-in: swaps the temporary password from the invitation e-mail for the user's own, then continues the sign-in. */
  @Public() @Throttle(STRICT) @HttpCode(200) @Post('first-password')
  firstPassword(@Body() dto: FirstPasswordDto, @Meta() meta: RequestMeta) {
    return this.auth.completeFirstPassword(dto.passwordToken, dto.newPassword, meta);
  }

  @Public() @Throttle({ default: { limit: 3, ttl: 60_000 } }) @HttpCode(202) @Post('forgot-password')
  async forgot(@Body() dto: EmailOnlyDto, @Meta() meta: RequestMeta) {
    await this.auth.forgotPassword(dto.email, meta);
    return { message: 'If an account exists for that email, a reset code has been sent.' };
  }

  @Public() @Throttle(MODERATE) @HttpCode(204) @Post('reset-password')
  async reset(@Body() dto: ResetPasswordDto, @Meta() meta: RequestMeta): Promise<void> {
    await this.auth.resetPassword(dto.email, dto.code, dto.newPassword, meta);
  }

  @AnyAuthenticated() @Throttle(MODERATE) @HttpCode(204) @Post('change-password')
  async changePassword(@CurrentUser() user: AuthUser, @Body() dto: ChangePasswordDto, @Meta() meta: RequestMeta): Promise<void> {
    await this.auth.changePassword(user, dto.currentPassword, dto.newPassword, meta);
  }

  // ── MFA ──
  // enroll/confirm accept EITHER a normal access token (voluntary enrolment) OR the mfa-setup token issued at login
  // to privileged roles that must enrol before getting a session.

  @Public() @Throttle(MODERATE) @HttpCode(200) @Post('mfa/enroll')
  async enroll(@Req() req: Request) {
    const actor = await this.setupActor(req);
    return this.mfa.beginEnrollment(actor.userId, actor.email);
  }

  @Public() @Throttle(MODERATE) @HttpCode(200) @Post('mfa/confirm')
  async confirm(@Req() req: Request, @Body() dto: MfaConfirmDto, @Meta() meta: RequestMeta) {
    const actor = await this.setupActor(req);
    const recoveryCodes = await this.mfa.confirmEnrollment(actor.userId, dto.code, meta);
    if (actor.viaSetupToken) {
      const login = await this.auth.completeSetupLogin(actor.userId, meta);
      return { ...login, recoveryCodes };
    }
    return { status: 'enabled', recoveryCodes };
  }

  @AnyAuthenticated() @Throttle(STRICT) @HttpCode(200) @Post('mfa/recovery-codes')
  async regenerate(@CurrentUser() user: AuthUser, @Body() dto: StepUpDto, @Meta() meta: RequestMeta) {
    await this.auth.requirePasswordAndCode(user.id, dto.password, dto.code);
    return { recoveryCodes: await this.mfa.regenerateRecoveryCodes(user.id, meta) };
  }

  @AnyAuthenticated() @Throttle(STRICT) @HttpCode(204) @Post('mfa/disable')
  async disable(@CurrentUser() user: AuthUser, @Body() dto: StepUpDto, @Meta() meta: RequestMeta): Promise<void> {
    await this.auth.requirePasswordAndCode(user.id, dto.password, dto.code);
    await this.mfa.disable(user.id, user.familyId, meta);
  }

  // ── sessions / devices ──

  @AnyAuthenticated() @Get('sessions')
  async listSessions(@CurrentUser() user: AuthUser) {
    const rows = await this.sessions.listActive(user.id);
    return rows.map((s) => ({ ...s, current: s.familyId === user.familyId }));
  }

  @AnyAuthenticated() @HttpCode(204) @Delete('sessions/:id')
  async revokeSession(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Meta() meta: RequestMeta): Promise<void> {
    const ok = await this.sessions.revokeOwn(user.id, id);
    if (ok) await this.audit.record({ action: 'auth.session.revoked', userId: user.id, userName: user.fullName, entityType: 'session', entityId: id, ip: meta.ip, requestId: meta.requestId });
  }

  private async setupActor(req: Request): Promise<{ userId: string; email: string; viaSetupToken: boolean }> {
    const token = bearerToken(req.headers.authorization);
    if (!token) throw new UnauthorizedException('Your session is invalid or has expired. Please sign in again.');
    const typ = this.tokens.peekType(token);
    if (typ === 'mfa-setup') {
      const u = await this.authn.authenticateSetupToken(token);
      return { userId: u.id, email: u.email, viaSetupToken: true };
    }
    const user = await this.authn.authenticateAccessToken(token);
    return { userId: user.id, email: user.email, viaSetupToken: false };
  }
}
