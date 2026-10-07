import { useColorScheme } from 'react-native';
import { darkColors, lightColors, type Colors } from './tokens';

export { elevation, ICON, radius, space, TOUCH, type as typeScale } from './tokens';
export type { Colors } from './tokens';

export const useColors = (): Colors => (useColorScheme() === 'dark' ? darkColors : lightColors);
export const useIsDark = (): boolean => useColorScheme() === 'dark';

/** Legacy size names used across screens, mapped onto the type roles. */
export const font = { small: 13, body: 16, title: 22, h1: 28, big: 32 } as const;
