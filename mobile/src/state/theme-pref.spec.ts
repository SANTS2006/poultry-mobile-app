import { Appearance } from 'react-native';
import { applyThemeMode, loadThemeMode, THEME_KEY, useThemeModeStore } from './theme-pref';

describe('theme preference', () => {
  const spy = jest.spyOn(Appearance, 'setColorScheme').mockImplementation(() => undefined);
  beforeEach(() => spy.mockClear());

  it('forces light or dark, and follows the phone for "system"', () => {
    applyThemeMode('dark');
    expect(spy).toHaveBeenLastCalledWith('dark');
    applyThemeMode('light');
    expect(spy).toHaveBeenLastCalledWith('light');
    applyThemeMode('system');
    expect(spy).toHaveBeenLastCalledWith('unspecified');
  });

  it('restores the saved choice at start-up and ignores junk values', async () => {
    await loadThemeMode({ get: async (k) => (k === THEME_KEY ? 'dark' : null) });
    expect(useThemeModeStore.getState().mode).toBe('dark');
    expect(spy).toHaveBeenLastCalledWith('dark');
    await loadThemeMode({ get: async () => 'purple' });
    expect(useThemeModeStore.getState().mode).toBe('system');
    await loadThemeMode({ get: async () => { throw new Error('store unavailable'); } });
    expect(useThemeModeStore.getState().mode).toBe('system');
  });
});
