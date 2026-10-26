import { useEffect, useState } from 'react';

/** The server sends at most one reset code a minute per account; the app counts the same minute down so nobody presses the button in vain. */
export const RESET_COOLDOWN_MS = 60_000;
const until = new Map<string, number>();
const key = (email: string): string => email.trim().toLowerCase();

export const startResetCooldown = (email: string, ms = RESET_COOLDOWN_MS): void => { if (key(email)) until.set(key(email), Date.now() + ms); };
export const resetSecondsLeft = (email: string, now = Date.now()): number => Math.max(0, Math.ceil(((until.get(key(email)) ?? 0) - now) / 1000));
export const formatCountdown = (s: number): string => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/** Seconds left before another code may be requested for this address (0 = now). Re-renders every second while counting. */
export function useResetCooldown(email: string): number {
  const [left, setLeft] = useState(() => resetSecondsLeft(email));
  useEffect(() => {
    setLeft(resetSecondsLeft(email)); // eslint-disable-line react-hooks/set-state-in-effect -- re-sync when the address changes
    const t = setInterval(() => setLeft(resetSecondsLeft(email)), 1000);
    return () => clearInterval(t);
  }, [email]);
  return left;
}
