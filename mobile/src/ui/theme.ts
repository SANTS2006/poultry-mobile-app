import { useColorScheme } from 'react-native';

const light = {
  bg: '#F4F6F5', card: '#FFFFFF', text: '#14201A', muted: '#5B6B63', border: '#DDE4E0', primary: '#0F5132', onPrimary: '#FFFFFF',
  primarySoft: '#E3F1EA', danger: '#B42318', dangerSoft: '#FDECEA', warn: '#9A6700', warnSoft: '#FFF4D6', ok: '#1A7F4B', okSoft: '#E1F5EA', info: '#175CD3', infoSoft: '#E6EEFB',
  input: '#FFFFFF', overlay: 'rgba(0,0,0,0.4)',
};
const dark: typeof light = {
  bg: '#0E1512', card: '#17211C', text: '#EAF1ED', muted: '#93A59B', border: '#2A3831', primary: '#4FBF87', onPrimary: '#06210F',
  primarySoft: '#173A2A', danger: '#F97066', dangerSoft: '#3A1B18', warn: '#F7C948', warnSoft: '#3A300F', ok: '#5FD18D', okSoft: '#12301F', info: '#7FB0FF', infoSoft: '#15243D',
  input: '#111A16', overlay: 'rgba(0,0,0,0.6)',
};

export type Colors = typeof light;
export const useColors = (): Colors => (useColorScheme() === 'dark' ? dark : light);

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const radius = { sm: 8, md: 12, lg: 16, pill: 999 } as const;
export const font = { small: 13, body: 16, title: 20, h1: 26, big: 34 } as const;
/** Minimum touch target (accessibility guideline: 44–48 dp). */
export const TOUCH = 48;
