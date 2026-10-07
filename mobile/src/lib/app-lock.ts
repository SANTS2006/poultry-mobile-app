/**
 * Biometric app lock policy (pure, so it is testable). The app locks when it returns from the background after longer than
 * `graceMs`, or when it was started cold, provided the user enabled the lock. Biometrics only unlock the local screen — they never
 * replace the password: the server session (refresh token in the Keychain/Keystore) is what actually authenticates requests.
 */
export const LOCK_GRACE_MS = 60_000;

export function shouldLock(opts: { enabled: boolean; backgroundedAt: number | null; now: number; graceMs?: number; coldStart?: boolean }): boolean {
  if (!opts.enabled) return false;
  if (opts.coldStart) return true;
  if (opts.backgroundedAt === null) return false;
  return opts.now - opts.backgroundedAt >= (opts.graceMs ?? LOCK_GRACE_MS);
}
