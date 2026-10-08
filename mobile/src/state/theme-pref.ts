import { Appearance } from 'react-native';
import { create } from 'zustand';

export type ThemeMode = 'system' | 'light' | 'dark';
export const THEME_KEY = 'pref.themeMode';

const valid = (v: string | null): v is ThemeMode => v === 'system' || v === 'light' || v === 'dark';

/** Forces the whole app (and native pieces such as the keyboard and system dialogs) to light or dark; `system` follows the phone. */
export function applyThemeMode(mode: ThemeMode): void {
  Appearance.setColorScheme(mode === 'system' ? 'unspecified' : mode);
}

/** Reads the saved choice and applies it. Called once at start-up, before the first screen, so there is no flash of the wrong theme. */
export async function loadThemeMode(secure: { get(k: string): Promise<string | null> }): Promise<void> {
  try {
    const saved = await secure.get(THEME_KEY);
    const mode = valid(saved) ? saved : 'system';
    useThemeModeStore.setState({ mode });
    applyThemeMode(mode);
  } catch { /* keep following the phone */ }
}

export const useThemeModeStore = create<{ mode: ThemeMode }>(() => ({ mode: 'system' }));
