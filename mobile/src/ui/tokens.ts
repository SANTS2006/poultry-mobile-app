/**
 * Design tokens ("Farmhouse modern"): deep egg-farm green for the brand, one warm yolk-amber accent, quiet neutral surfaces.
 * Every text/background pair used by the UI is checked against WCAG AA in tokens.spec.ts.
 */
export const lightColors = {
  bg: '#F5F7F4', surface: '#FFFFFF', card: '#FFFFFF', input: '#FFFFFF',
  text: '#12201A', textSecondary: '#4F5F56', muted: '#5C6B62', border: '#E0E6E1', borderStrong: '#C5CFC7',
  primary: '#0B6B3A', onPrimary: '#FFFFFF', primarySoft: '#E3F2E9', onPrimarySoft: '#0A4F2B',
  accent: '#F2B33D', onAccent: '#2B1D00', accentSoft: '#FFF2D3', onAccentSoft: '#6B4600',
  danger: '#B3261E', dangerSoft: '#FDECEA', ok: '#176B3D', okSoft: '#E1F4E8', warn: '#845400', warnSoft: '#FFF2D3', info: '#1C5BBF', infoSoft: '#E7EFFC',
  overlay: 'rgba(10,20,15,0.45)', shadow: '#0A140F', skeleton: '#E7ECE8',
};

export const darkColors: typeof lightColors = {
  bg: '#0D1411', surface: '#131C17', card: '#17221C', input: '#101813',
  text: '#ECF3EE', textSecondary: '#B4C4B9', muted: '#9AACA0', border: '#26352D', borderStrong: '#3A4D42',
  primary: '#4CC38A', onPrimary: '#04210F', primarySoft: '#173A2A', onPrimarySoft: '#BDEBD3',
  accent: '#F5C05A', onAccent: '#2B1D00', accentSoft: '#3A2D0F', onAccentSoft: '#F7D88E',
  danger: '#FF8A80', dangerSoft: '#3A1B18', ok: '#6FD69C', okSoft: '#12301F', warn: '#F5C05A', warnSoft: '#3A2D0F', info: '#8DB8FF', infoSoft: '#15243D',
  overlay: 'rgba(0,0,0,0.65)', shadow: '#000000', skeleton: '#1F2C25',
};

export type Colors = typeof lightColors;

/** 4-pt spacing scale. Screen gutter is `lg` (16); sections are separated by `xl` (24). */
export const space = { xxs: 2, xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, xxxl: 48 } as const;

/** Three radii only: small controls, cards, sheets/hero surfaces (plus a pill). */
export const radius = { sm: 10, md: 14, lg: 20, pill: 999 } as const;

/** Type roles. Weights are limited to regular / semibold / bold. */
export const type = {
  display: { fontSize: 32, lineHeight: 38, fontWeight: '700', letterSpacing: -0.5 },
  title: { fontSize: 22, lineHeight: 28, fontWeight: '700', letterSpacing: -0.2 },
  heading: { fontSize: 17, lineHeight: 24, fontWeight: '600' },
  body: { fontSize: 16, lineHeight: 23, fontWeight: '400' },
  bodyStrong: { fontSize: 16, lineHeight: 23, fontWeight: '600' },
  label: { fontSize: 14, lineHeight: 20, fontWeight: '600' },
  caption: { fontSize: 13, lineHeight: 18, fontWeight: '400' },
  overline: { fontSize: 12, lineHeight: 16, fontWeight: '600', letterSpacing: 0.6 },
} as const;
export type TypeRole = keyof typeof type;

/** Minimum touch target (iOS 44 pt / Android 48 dp). */
export const TOUCH = 48;
export const ICON = { sm: 18, md: 22, lg: 28 } as const;

/** One soft elevation for cards, one stronger for floating things (toast, sheets). */
export const elevation = {
  card: { shadowColor: '#0A140F', shadowOpacity: 0.06, shadowRadius: 10, shadowOffset: { width: 0, height: 2 }, elevation: 1 },
  float: { shadowColor: '#0A140F', shadowOpacity: 0.16, shadowRadius: 18, shadowOffset: { width: 0, height: 8 }, elevation: 6 },
} as const;

/** WCAG relative luminance / contrast helpers (used by tests and by the status-colour checks). */
export function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
