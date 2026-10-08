import { useApp } from './app';
import { applyThemeMode, THEME_KEY, useThemeModeStore, type ThemeMode } from './theme-pref';

/** Current choice plus a setter that applies it immediately and remembers it. */
export function useThemeMode(): { mode: ThemeMode; setMode: (m: ThemeMode) => void } {
  const mode = useThemeModeStore((s) => s.mode);
  const { services } = useApp();
  return {
    mode,
    setMode: (m) => {
      useThemeModeStore.setState({ mode: m });
      applyThemeMode(m);
      void services.secure.set(THEME_KEY, m).catch(() => undefined);
    },
  };
}
