import { AuthRequiredError, HttpError, type SyncSummary } from '../sync/types';
import type { ApiClient } from './api-client';
import type { PublicApi } from './public-api';
import type { SecureStore, SessionTokens, TokenManager } from './token-manager';

export interface UserSummary { id: string; email: string; fullName: string; mfaEnabled: boolean; roles: string[]; permissions: string[] }

export type LoginOutcome =
  | { kind: 'authenticated'; user: UserSummary }
  | { kind: 'mfa_required'; mfaToken: string }
  | { kind: 'mfa_setup_required'; setupToken: string };

type AuthResponse =
  | { status: 'authenticated'; tokens: SessionTokens; user: UserSummary }
  | { status: 'mfa_required'; mfaToken: string }
  | { status: 'mfa_setup_required'; setupToken: string };

export type SessionStatus = 'booting' | 'signed_out' | 'signed_in';

const USER_KEY = 'auth.user';
/** What SessionManager needs from the offline layer (kept minimal so it can be tested without a database). */
export interface OutboxGate {
  summary(): Promise<SyncSummary>;
  getOwner(): Promise<string | null>;
  setOwner(userId: string): Promise<void>;
  wipe(): Promise<void>;
}

export class UnsyncedDataError extends Error {
  constructor(readonly count: number, readonly ownedByOtherUser: boolean) {
    super(ownedByOtherUser
      ? `${count} record(s) recorded on this phone by a different user have not been sent yet. Ask them to sign in and sync first.`
      : `${count} record(s) have not been sent to the server yet. Connect to the internet and sync before signing out, or they will be lost.`);
    this.name = 'UnsyncedDataError';
  }
}

/**
 * Owns the signed-in identity: login (password → MFA → tokens), silent restore at start-up (works offline from the cached profile),
 * and sign-out. Two safeguards protect offline data:
 *  • records waiting to be sent belong to the user who created them — another user cannot sign in on top of them
 *    (the server would attribute them to the wrong person);
 *  • signing out with unsent records is refused unless the user explicitly chooses to discard them.
 */
export class SessionManager {
  private listeners = new Set<(s: { status: SessionStatus; user: UserSummary | null }) => void>();
  status: SessionStatus = 'booting';
  user: UserSummary | null = null;

  constructor(
    private readonly secure: SecureStore, private readonly tokens: TokenManager, private readonly api: ApiClient, private readonly pub: PublicApi,
    private readonly outbox: OutboxGate, private readonly hooks: { onSignedIn?: (u: UserSummary) => void | Promise<void>; onSignedOut?: () => void | Promise<void> } = {},
  ) {}

  subscribe(l: (s: { status: SessionStatus; user: UserSummary | null }) => void): () => void { this.listeners.add(l); return () => { this.listeners.delete(l); }; }
  private publish(status: SessionStatus, user: UserSummary | null) { this.status = status; this.user = user; this.listeners.forEach((l) => l({ status, user })); }

  /** Start-up: use the stored session if there is one. Offline start-up trusts the cached profile; the server still decides on every request. */
  async restore(): Promise<void> {
    if (!(await this.tokens.hasSession())) return this.publish('signed_out', null);
    const cached = await this.readCachedUser();
    try {
      const fresh = await this.api.request<UserSummary>('GET', '/v1/auth/me');
      await this.secure.set(USER_KEY, JSON.stringify(fresh));
      await this.enter(fresh);
    } catch (e) {
      if (e instanceof AuthRequiredError || (e instanceof HttpError && (e.status === 401 || e.status === 403))) { await this.forget(); return this.publish('signed_out', null); }
      if (cached) { await this.enter(cached); return; } // offline / server down: keep working with the last known profile
      this.publish('signed_out', null);
    }
  }

  /** Re-reads the profile (roles, permissions, MFA state) after something changed it. */
  async refreshProfile(): Promise<UserSummary | null> {
    try {
      const fresh = await this.api.request<UserSummary>('GET', '/v1/auth/me');
      await this.secure.set(USER_KEY, JSON.stringify(fresh));
      this.publish('signed_in', fresh);
      return fresh;
    } catch { return this.user; }
  }

  async login(email: string, password: string): Promise<LoginOutcome> {
    return this.handle(await this.pub.post<AuthResponse>('/v1/auth/login', { email: email.trim(), password }));
  }

  async verifyMfa(mfaToken: string, proof: { code?: string; recoveryCode?: string }): Promise<LoginOutcome> {
    return this.handle(await this.pub.post<AuthResponse>('/v1/auth/mfa/verify', { mfaToken, ...proof }));
  }

  /** Privileged roles must enrol before getting a session: the setup token authorises only these two calls. */
  async beginMfaSetup(setupToken: string) {
    return this.pub.post<{ secret: string; otpauthUri: string; qrCodeDataUrl: string }>('/v1/auth/mfa/enroll', undefined, { Authorization: `Bearer ${setupToken}` });
  }

  async confirmMfaSetup(setupToken: string, code: string): Promise<{ outcome: LoginOutcome; recoveryCodes: string[] }> {
    const res = await this.pub.post<AuthResponse & { recoveryCodes: string[] }>('/v1/auth/mfa/confirm', { code }, { Authorization: `Bearer ${setupToken}` });
    return { outcome: await this.handle(res), recoveryCodes: res.recoveryCodes };
  }

  private async handle(res: AuthResponse): Promise<LoginOutcome> {
    if (res.status === 'mfa_required') return { kind: 'mfa_required', mfaToken: res.mfaToken };
    if (res.status === 'mfa_setup_required') return { kind: 'mfa_setup_required', setupToken: res.setupToken };
    await this.assertOutboxAllows(res.user.id);
    await this.tokens.setSession(res.tokens);
    await this.secure.set(USER_KEY, JSON.stringify(res.user));
    await this.enter(res.user);
    return { kind: 'authenticated', user: res.user };
  }

  /** Refuses a sign-in that would let a different user inherit someone else's unsent records. */
  private async assertOutboxAllows(userId: string): Promise<void> {
    const owner = await this.outbox.getOwner();
    if (owner && owner !== userId) {
      const { unsynced } = await this.outbox.summary();
      if (unsynced > 0) throw new UnsyncedDataError(unsynced, true);
      await this.outbox.wipe(); // nothing pending: cached data of the previous user must not be shown to the next one
    }
  }

  private async enter(user: UserSummary) {
    await this.outbox.setOwner(user.id);
    this.publish('signed_in', user);
    await this.hooks.onSignedIn?.(user);
  }

  /** Signs out. With unsent records this throws UnsyncedDataError unless `discardUnsynced` is true (an explicit user decision). */
  async logout(opts: { discardUnsynced?: boolean } = {}): Promise<void> {
    const { unsynced } = await this.outbox.summary();
    if (unsynced > 0 && !opts.discardUnsynced) throw new UnsyncedDataError(unsynced, false);
    try { await this.api.request('POST', '/v1/auth/logout'); } catch { /* offline or already invalid: the local session is ended regardless */ }
    if (opts.discardUnsynced) await this.outbox.wipe();
    await this.forget();
    this.publish('signed_out', null);
  }

  /** The server ended this session (revoked, disabled, password changed…). Local data is kept for the same user. */
  async sessionEnded(): Promise<void> { await this.forget(); this.publish('signed_out', null); }

  private async forget() {
    await this.tokens.clear();
    await this.secure.delete(USER_KEY);
    await this.hooks.onSignedOut?.();
  }

  private async readCachedUser(): Promise<UserSummary | null> {
    const raw = await this.secure.get(USER_KEY);
    try { return raw ? (JSON.parse(raw) as UserSummary) : null; } catch { return null; }
  }

  can(permission: string): boolean { return this.user?.permissions.includes(permission) ?? false; }
}
