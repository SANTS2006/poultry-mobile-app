import { LOCK_GRACE_MS, shouldLock } from './app-lock';

describe('app lock policy', () => {
  const now = 1_000_000;
  it('never locks when the user has not enabled it', () => {
    expect(shouldLock({ enabled: false, backgroundedAt: 0, now, coldStart: true })).toBe(false);
  });
  it('locks on a cold start when enabled', () => {
    expect(shouldLock({ enabled: true, backgroundedAt: null, now, coldStart: true })).toBe(true);
  });
  it('allows a short trip to another app without locking, then locks after the grace period', () => {
    expect(shouldLock({ enabled: true, backgroundedAt: now - 10_000, now })).toBe(false);
    expect(shouldLock({ enabled: true, backgroundedAt: now - LOCK_GRACE_MS, now })).toBe(true);
    expect(shouldLock({ enabled: true, backgroundedAt: now - 3_600_000, now })).toBe(true);
  });
  it('does not lock if the app was never backgrounded', () => {
    expect(shouldLock({ enabled: true, backgroundedAt: null, now })).toBe(false);
  });
});
