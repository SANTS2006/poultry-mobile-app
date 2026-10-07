import { contrast, darkColors, lightColors, type Colors } from './tokens';

/** [foreground, background, minimum ratio]. 4.5 = WCAG AA for normal text; 3 for large text / UI components. */
const PAIRS: [keyof Colors, keyof Colors, number][] = [
  ['text', 'bg', 4.5], ['text', 'card', 4.5], ['text', 'input', 4.5],
  ['textSecondary', 'bg', 4.5], ['textSecondary', 'card', 4.5], ['muted', 'bg', 4.5], ['muted', 'card', 4.5],
  ['onPrimary', 'primary', 4.5], ['onDanger', 'danger', 4.5], ['primary', 'bg', 4.5], ['primary', 'card', 4.5], ['onPrimarySoft', 'primarySoft', 4.5],
  ['onAccent', 'accent', 4.5], ['onAccentSoft', 'accentSoft', 4.5],
  ['danger', 'card', 4.5], ['danger', 'dangerSoft', 4.5], ['ok', 'card', 4.5], ['ok', 'okSoft', 4.5],
  ['warn', 'card', 4.5], ['warn', 'warnSoft', 4.5], ['info', 'card', 4.5], ['info', 'infoSoft', 4.5],
  ['borderStrong', 'bg', 1.4],
];

describe.each([['light', lightColors], ['dark', darkColors]] as const)('%s palette contrast (WCAG AA)', (_name, c) => {
  it.each(PAIRS)('%s on %s ≥ %s', (fg, bg, min) => {
    expect(contrast(c[fg], c[bg])).toBeGreaterThanOrEqual(min);
  });
});

describe('contrast helper', () => {
  it('matches the known black/white ratio of 21', () => expect(Math.round(contrast('#000000', '#FFFFFF'))).toBe(21));
});
