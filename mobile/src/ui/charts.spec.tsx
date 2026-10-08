import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { BarChart, CATEGORICAL, ChartCard, compact, foldSlices, Histogram, histogramBins, LineChart, nearestIndex, PieChart, ringSegments } from './charts';
import { contrast, darkColors, lightColors } from './tokens';

jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const render = (el: React.ReactElement): ReactTestRenderer => { let r!: ReactTestRenderer; act(() => { r = create(el); }); return r; };
const texts = (r: ReactTestRenderer): string => {
  const out: string[] = [];
  const walk = (n: unknown): void => { if (n === null || n === undefined) return; if (typeof n === 'string') { out.push(n); return; } if (Array.isArray(n)) { n.forEach(walk); return; } walk((n as { children?: unknown }).children); };
  walk(r.toJSON());
  return out.join(' ');
};

describe('chart helpers', () => {
  it('formats big numbers compactly', () => {
    expect([compact(0), compact(950), compact(1200), compact(15500), compact(2_400_000)]).toEqual(['0', '950', '1.2k', '15.5k', '2.4M']);
  });
  it('folds extra categories into "Other" instead of inventing colours', () => {
    const s = foldSlices([1, 2, 3, 4, 5, 6, 7].map((v) => ({ label: `c${v}`, value: v })));
    expect(s).toHaveLength(5);
    expect(s[4]).toEqual({ label: 'Other', value: 1 + 2 + 3 });
    expect(foldSlices([{ label: 'a', value: 0 }, { label: 'b', value: 3 }])).toEqual([{ label: 'b', value: 3 }]); // empty slices are dropped
  });
  it('bins values into equal-width ranges that account for every value', () => {
    const bins = histogramBins([1, 2, 2, 3, 9, 10], 3);
    expect(bins).toHaveLength(3);
    expect(bins.reduce((a, b) => a + b.count, 0)).toBe(6);
    expect(bins[0]!.from).toBe(1); expect(bins[2]!.to).toBe(10);
    expect(histogramBins([5, 5, 5], 4)).toEqual([{ from: 5, to: 5, count: 3 }]);
    expect(histogramBins([], 4)).toEqual([]);
  });
  it('maps a touch position to the nearest point', () => {
    expect([nearestIndex(0, 100, 5), nearestIndex(50, 100, 5), nearestIndex(100, 100, 5), nearestIndex(-20, 100, 5), nearestIndex(500, 100, 5), nearestIndex(10, 100, 1)]).toEqual([0, 2, 4, 0, 4, 0]);
  });
  it('lays out ring segments with a gap between slices and no overlap', () => {
    const segs = ringSegments([1, 1, 2], 400, 2);
    expect(segs.map((s) => Math.round(s.len))).toEqual([98, 98, 198]);
    expect(segs.map((s) => s.offset)).toEqual([-0, -100, -200]);
    expect(ringSegments([5], 400, 2)[0]!.len).toBe(400); // one slice: a full ring, no gap
    expect(ringSegments([0, 0], 400)).toEqual([]);
  });
  it('keeps the categorical order fixed and each colour readable on its card', () => {
    expect(CATEGORICAL.light).toHaveLength(5);
    expect(CATEGORICAL.dark).toHaveLength(5);
    for (const col of CATEGORICAL.dark) expect(contrast(col, darkColors.card)).toBeGreaterThanOrEqual(3); // dark: all pass 3:1
    for (const col of [CATEGORICAL.light[0], CATEGORICAL.light[1]]) expect(contrast(col, lightColors.card)).toBeGreaterThanOrEqual(3);
  });
});

describe('chart components', () => {
  it('ChartCard switches between the chart and a table of the same numbers', () => {
    const r = render(<ChartCard title="Eggs" subtitle="Last 3 days" rows={[{ label: 'Mon', value: '10' }, { label: 'Tue', value: '20' }]}><LineChart label="Eggs" data={[{ label: 'Mon', value: 10 }, { label: 'Tue', value: 20 }]} /></ChartCard>);
    expect(texts(r)).toContain('Last 3 days');
    expect(texts(r)).not.toContain('Tue 20');
    act(() => { r.root.findAll((n) => n.props.accessibilityLabel === 'Show Eggs as a table' && typeof n.props.onPress === 'function')[0].props.onPress(); });
    expect(texts(r)).toContain('Mon');
    expect(texts(r)).toContain('20');
    expect(r.root.findAll((n) => n.props.accessibilityLabel === 'Eggs as a table').length).toBeGreaterThan(0);
  });
  it('PieChart prints every label, value and percentage (colour is never the only cue)', () => {
    const r = render(<PieChart label="By coop" centerLabel="eggs today" slices={[{ label: 'Coop 1', value: 300 }, { label: 'Coop 2', value: 100 }]} />);
    const t = texts(r);
    for (const needle of ['Coop 1', 'Coop 2', '300', '100', '75%', '25%', 'eggs today']) expect(t).toContain(needle);
    act(() => { r.root.findAll((n) => n.props.accessibilityLabel === 'Coop 2: 100, 25%' && typeof n.props.onPress === 'function')[0].props.onPress(); });
    expect(texts(r)).toContain('Coop 2'); // picking a slice puts it in the middle
  });
  it('Histogram and BarChart describe their data for screen readers', () => {
    const h = render(<Histogram label="Daily eggs" values={[100, 120, 130, 300, 310]} bins={3} unit="eggs" />);
    expect(h.root.findAll((n) => typeof n.props.accessibilityLabel === 'string' && n.props.accessibilityLabel.startsWith('Daily eggs.')).length).toBeGreaterThan(0);
    const b = render(<BarChart label="By shift" data={[{ label: 'Morning', value: 5 }, { label: 'Evening', value: 7 }]} />);
    expect(b.root.findAll((n) => typeof n.props.accessibilityLabel === 'string' && n.props.accessibilityLabel.includes('Morning 5, Evening 7')).length).toBeGreaterThan(0);
  });
});
