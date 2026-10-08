import { create } from 'zustand';
import type { SessionStatus, UserSummary } from '../services/session-manager';
import type { SyncSummary } from '../sync/types';

export interface AppState {
  status: SessionStatus;
  user: UserSummary | null;
  sync: SyncSummary | null;
  realtime: 'connected' | 'disconnected';
  /** biometric app lock */
  locked: boolean;
  biometricLock: boolean;
  setSession(status: SessionStatus, user: UserSummary | null): void;
  setSync(s: SyncSummary): void;
  setRealtime(s: 'connected' | 'disconnected'): void;
  setLocked(v: boolean): void;
  setBiometricLock(v: boolean): void;
  /** "Retry" for unsent records, set by the app once the sync engine exists (so shared UI can offer it without knowing about services) */
  retryHandler: (() => void) | null;
  setRetryHandler(h: (() => void) | null): void;
}

export const useAppStore = create<AppState>((set) => ({
  status: 'booting', user: null, sync: null, realtime: 'disconnected', locked: false, biometricLock: false, retryHandler: null,
  setSession: (status, user) => set({ status, user }),
  setSync: (sync) => set({ sync }),
  setRealtime: (realtime) => set({ realtime }),
  setLocked: (locked) => set({ locked }),
  setBiometricLock: (biometricLock) => set({ biometricLock }),
  setRetryHandler: (retryHandler) => set({ retryHandler }),
}));

/** UI-side permission check (convenience only: the server enforces every permission again). */
export function useCan(...permissions: string[]): boolean {
  const user = useAppStore((s) => s.user);
  return !!user && permissions.every((p) => user.permissions.includes(p));
}

export function useCanAny(...permissions: string[]): boolean {
  const user = useAppStore((s) => s.user);
  return !!user && permissions.some((p) => user.permissions.includes(p));
}
