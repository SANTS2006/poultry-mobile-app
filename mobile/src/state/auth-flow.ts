import { create } from 'zustand';

/**
 * Short-lived credentials of a half-finished sign-in (after the password, before MFA). Kept in memory only — never in the URL,
 * never persisted — and cleared as soon as the flow ends.
 */
interface AuthFlow {
  mfaToken: string | null;
  setupToken: string | null;
  passwordToken: string | null;
  recoveryCodes: string[] | null;
  startMfa(t: string): void;
  startSetup(t: string): void;
  startPasswordChange(t: string): void;
  showRecoveryCodes(c: string[]): void;
  clear(): void;
}

export const useAuthFlow = create<AuthFlow>((set) => ({
  mfaToken: null, setupToken: null, passwordToken: null, recoveryCodes: null,
  startMfa: (mfaToken) => set({ mfaToken, setupToken: null, passwordToken: null }),
  startSetup: (setupToken) => set({ setupToken, mfaToken: null, passwordToken: null }),
  startPasswordChange: (passwordToken) => set({ passwordToken, mfaToken: null, setupToken: null }),
  showRecoveryCodes: (recoveryCodes) => set({ recoveryCodes }),
  clear: () => set({ mfaToken: null, setupToken: null, passwordToken: null, recoveryCodes: null }),
}));
