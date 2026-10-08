import { useState, type ReactNode } from 'react';
import { Pressable, View, type LayoutChangeEvent } from 'react-native';
import Svg, { Circle, Defs, G, Line, LinearGradient, Path, Rect, Stop } from 'react-native-svg';
import { Card, Row, Text } from './components';
import { selectHaptic } from './haptics';
import { Icon } from './icon';
import { space, useColors, useIsDark } from './theme';

/* ───────────────────────── palette ─────────────────────────
 * Categorical colours, in a FIXED order (never cycled; a 6th category folds into "Other"). Checked with the data-viz palette validator
 * against the card surface: adjacent colour-blind separation ΔE ≥ 8.4 and normal-vision ΔE ≥ 19 in both modes. Three light-mode slots
 * (aqua, yellow, magenta) are under 3:1 contrast on white, so every chart that uses them ALSO prints each label and value and offers a
 * table view. A single series uses the brand green, not a categorical slot. */
export const CATEGORICAL = {
  light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4'],
  dark: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181'],
} as const;
export const MAX_SLICES = 5;

export const compact = (n: number): string => (Math.abs(n) >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : Math.abs(n) >= 1000 ? `${+(n / 1000).toFixed(1)}k` : String(Math.round(n * 10) / 10));

/* ───────────────────────── pure helpers (unit-tested) ───────────────────────── */

export interface Slice { label: string; value: number }

/** Keeps the largest slices and folds the rest into "Other" so colours are never reused or invented. */
export function foldSlices(slices: Slice[], max = MAX_SLICES): Slice[] {
  const positive = slices.filter((s) => s.value > 0).sort((a, b) => b.value - a.value);
  if (positive.length <= max) return positive;
  const head = positive.slice(0, max - 1);
  return [...head, { label: 'Other', value: positive.slice(max - 1).reduce((a, s) => a + s.value, 0) }];
}

/** Equal-width bins over the data range. A constant series gets a single bin. */
export function histogramBins(values: number[], bins = 5): { from: number; to: number; count: number }[] {
  const v = values.filter((x) => Number.isFinite(x));
  if (!v.length) return [];
  const min = Math.min(...v); const max = Math.max(...v);
  if (min === max) return [{ from: min, to: max, count: v.length }];
  const n = Math.max(2, Math.min(bins, v.length));
  const width = (max - min) / n;
  const out = Array.from({ length: n }, (_, i) => ({ from: min + i * width, to: min + (i + 1) * width, count: 0 }));
  for (const x of v) out[Math.min(n - 1, Math.floor((x - min) / width))]!.count++;
  return out;
}

/** Index of the point nearest to x on an evenly spaced series. */
export const nearestIndex = (x: number, width: number, count: number): number => (count <= 1 ? 0 : Math.max(0, Math.min(count - 1, Math.round((x / Math.max(1, width)) * (count - 1)))));

/** Arc lengths for a ring of circumference `circ`, leaving `gap` between segments (so adjacent slices never touch). */
export function ringSegments(values: number[], circ: number, gap = 2): { len: number; offset: number }[] {
  const total = values.reduce((a, b) => a + b, 0);
  if (total <= 0) return [];
  let acc = 0;
  return values.map((v) => { const full = (v / total) * circ; const seg = { len: Math.max(0, full - (values.length > 1 ? gap : 0)), offset: -acc }; acc += full; return seg; });
}

/* ───────────────────────── frame ───────────────────────── */

/** Card with a title, a one-line takeaway, the chart, and a switch to a plain table of the same numbers (for screen readers and for anyone who prefers numbers). */
export function ChartCard({ title, subtitle, rows, children }: { title: string; subtitle?: string; rows: { label: string; value: string }[]; children: ReactNode }) {
  const c = useColors();
  const [table, setTable] = useState(false);
  return (
    <Card>
      <Row style={{ alignItems: 'flex-start' }}>
        <View style={{ flex: 1, gap: space.xxs }}>
          <Text variant="heading" accessibilityRole="header">{title}</Text>
          {subtitle ? <Text variant="caption" color={c.textSecondary}>{subtitle}</Text> : null}
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel={table ? `Show ${title} as a chart` : `Show ${title} as a table`} onPress={() => { selectHaptic(); setTable(!table); }} hitSlop={10} style={{ padding: space.xs }}>
          <Icon name={table ? 'bar-chart-outline' : 'list-outline'} size="md" color={c.textSecondary} />
        </Pressable>
      </Row>
      {table ? (
        <View accessibilityLabel={`${title} as a table`}>
          {rows.map((r, i) => (
            <Row key={`${r.label}-${i}`} style={{ justifyContent: 'space-between', paddingVertical: space.xs, borderTopWidth: i ? 1 : 0, borderColor: c.border }}>
              <Text variant="caption" color={c.textSecondary}>{r.label}</Text><Text variant="bodyStrong">{r.value}</Text>
            </Row>
          ))}
        </View>
      ) : children}
    </Card>
  );
}

function useWidth(): [number, (e: LayoutChangeEvent) => void] {
  const [w, setW] = useState(0);
  return [w, (e) => { const next = Math.round(e.nativeEvent.layout.width); if (next !== w) setW(next); }];
}

const AXIS_H = 18;

/* ───────────────────────── line / area ───────────────────────── */

/** Trend over time. Touch or drag to read any point; the readout above the chart names it. One series, one colour, no dual axes. */
export function LineChart({ data, height = 150, format = compact, unit = '', label, area = true }: { data: { label: string; value: number }[]; height?: number; format?: (n: number) => string; unit?: string; label: string; area?: boolean }) {
  const c = useColors();
  const [w, onLayout] = useWidth();
  const [sel, setSel] = useState<number | null>(null);
  const n = data.length;
  const max = Math.max(1, ...data.map((d) => d.value));
  const top = max * 1.12;
  const padL = 34; const innerW = Math.max(1, w - padL - 6); const innerH = height - AXIS_H - 6;
  const x = (i: number) => padL + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const y = (v: number) => 4 + innerH - (v / top) * innerH;
  const idx = sel ?? n - 1;
  const point = data[idx];
  const path = data.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(d.value).toFixed(1)}`).join(' ');
  const areaPath = n > 1 ? `${path} L${x(n - 1).toFixed(1)} ${(4 + innerH).toFixed(1)} L${x(0).toFixed(1)} ${(4 + innerH).toFixed(1)} Z` : '';
  const ticks = [0, 0.5, 1].map((t) => t * max);
  return (
    <View accessible accessibilityLabel={`${label}. Latest ${point ? `${point.label}: ${format(point.value)} ${unit}` : 'no data'}`} style={{ gap: space.sm }}>
      <Text variant="bodyStrong">{point ? `${point.label} · ${format(point.value)}${unit ? ` ${unit}` : ''}` : '—'}</Text>
      <View onLayout={onLayout} style={{ height }}>
        {w > 0 ? (
          <>
            <Svg width={w} height={height}>
              <Defs><LinearGradient id="area" x1="0" y1="0" x2="0" y2="1"><Stop offset="0" stopColor={c.primary} stopOpacity="0.28" /><Stop offset="1" stopColor={c.primary} stopOpacity="0" /></LinearGradient></Defs>
              {ticks.map((t) => (
                <G key={t}>
                  <Line x1={padL} x2={w - 6} y1={y(t)} y2={y(t)} stroke={c.border} strokeWidth={1} strokeDasharray={t === 0 ? undefined : '3,4'} />
                </G>
              ))}
              {area && n > 1 ? <Path d={areaPath} fill="url(#area)" /> : null}
              {n > 1 ? <Path d={path} stroke={c.primary} strokeWidth={2} fill="none" strokeLinejoin="round" strokeLinecap="round" /> : null}
              {sel !== null ? <Line x1={x(idx)} x2={x(idx)} y1={4} y2={4 + innerH} stroke={c.borderStrong} strokeWidth={1} /> : null}
              {point ? <><Circle cx={x(idx)} cy={y(point.value)} r={6} fill={c.card} /><Circle cx={x(idx)} cy={y(point.value)} r={4} fill={c.primary} /></> : null}
            </Svg>
            {ticks.map((t) => <Text key={t} variant="caption" color={c.textSecondary} style={{ position: 'absolute', left: 0, top: y(t) - 8, width: padL - 4, textAlign: 'right', fontSize: 10 }}>{compact(t)}</Text>)}
            <View style={{ position: 'absolute', left: padL, right: 6, bottom: 0, flexDirection: 'row', justifyContent: 'space-between' }}>
              <Text variant="caption" color={c.textSecondary} style={{ fontSize: 10 }}>{data[0]?.label}</Text>
              {n > 2 ? <Text variant="caption" color={c.textSecondary} style={{ fontSize: 10 }}>{data[Math.floor((n - 1) / 2)]?.label}</Text> : null}
              <Text variant="caption" color={c.textSecondary} style={{ fontSize: 10 }}>{n > 1 ? data[n - 1]?.label : ''}</Text>
            </View>
            <View
              style={{ position: 'absolute', left: padL, right: 0, top: 0, bottom: AXIS_H }}
              onStartShouldSetResponder={() => true} onMoveShouldSetResponder={() => true}
              onResponderGrant={(e) => setSel(nearestIndex(e.nativeEvent.locationX, innerW, n))} onResponderMove={(e) => setSel(nearestIndex(e.nativeEvent.locationX, innerW, n))}
              onResponderRelease={() => setSel(null)} onResponderTerminate={() => setSel(null)}
            />
          </>
        ) : null}
      </View>
    </View>
  );
}

/* ───────────────────────── bars ───────────────────────── */

/** Bars from the baseline, a 2 px gap between bars, today's bar in the strong colour. Tap a bar to read it. */
export function BarChart({ data, height = 120, label, format = compact, unit = '', highlightLast = true }: { data: { label: string; value: number }[]; height?: number; label: string; format?: (n: number) => string; unit?: string; highlightLast?: boolean }) {
  const c = useColors();
  const [w, onLayout] = useWidth();
  const [sel, setSel] = useState<number | null>(null);
  const n = data.length;
  const max = Math.max(1, ...data.map((d) => d.value));
  const innerH = height - AXIS_H - 4;
  const slot = n ? Math.max(1, w) / n : 1;
  const idx = sel ?? (highlightLast ? n - 1 : null);
  const point = idx !== null ? data[idx] : null;
  return (
    <View accessible accessibilityLabel={`${label}. ${data.map((d) => `${d.label} ${format(d.value)}`).join(', ')}`} style={{ gap: space.sm }}>
      <Text variant="bodyStrong">{point ? `${point.label} · ${format(point.value)}${unit ? ` ${unit}` : ''}` : ' '}</Text>
      <View onLayout={onLayout} style={{ height }}>
        {w > 0 ? (
          <Svg width={w} height={height}>
            <Line x1={0} x2={w} y1={4 + innerH} y2={4 + innerH} stroke={c.border} strokeWidth={1} />
            {data.map((d, i) => {
              const h = Math.max(d.value > 0 ? 3 : 0, (d.value / max) * innerH);
              const bw = Math.max(2, slot - 2);
              return <Rect key={`${d.label}-${i}`} x={i * slot + 1} y={4 + innerH - h} width={bw} height={h} rx={Math.min(4, bw / 2)} fill={c.primary} opacity={idx === null || idx === i ? 1 : 0.4} />;
            })}
          </Svg>
        ) : null}
        {w > 0 ? (
          <View style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: AXIS_H, flexDirection: 'row' }}>
            {data.map((d, i) => <Pressable key={`${d.label}-${i}`} accessibilityLabel={`${d.label}: ${format(d.value)} ${unit}`} onPress={() => { selectHaptic(); setSel(sel === i ? null : i); }} style={{ flex: 1 }} />)}
          </View>
        ) : null}
        <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, flexDirection: 'row', justifyContent: 'space-between' }}>
          <Text variant="caption" color={c.textSecondary} style={{ fontSize: 10 }}>{data[0]?.label}</Text>
          <Text variant="caption" color={c.textSecondary} style={{ fontSize: 10 }}>{n > 1 ? data[n - 1]?.label : ''}</Text>
        </View>
      </View>
    </View>
  );
}

/* ───────────────────────── histogram ───────────────────────── */

/** How the values are spread: touching bars (no gaps) over equal-width ranges, with the count in each. */
export function Histogram({ values, bins = 5, height = 110, unit = '', countLabel = 'days', label }: { values: number[]; bins?: number; height?: number; unit?: string; countLabel?: string; label: string }) {
  const c = useColors();
  const [w, onLayout] = useWidth();
  const [sel, setSel] = useState<number | null>(null);
  const hist = histogramBins(values, bins);
  const max = Math.max(1, ...hist.map((b) => b.count));
  const innerH = height - AXIS_H - 4;
  const slot = hist.length ? Math.max(1, w) / hist.length : 1;
  const idx = sel ?? (hist.length ? hist.reduce((best, b, i) => (b.count > hist[best]!.count ? i : best), 0) : null);
  const b = idx !== null ? hist[idx] : null;
  const range = (x: { from: number; to: number }) => (x.from === x.to ? compact(x.from) : `${compact(x.from)}–${compact(x.to)}`);
  if (!hist.length) return null;
  return (
    <View accessible accessibilityLabel={`${label}. ${hist.map((h) => `${range(h)}: ${h.count} ${countLabel}`).join(', ')}`} style={{ gap: space.sm }}>
      <Text variant="bodyStrong">{b ? `${range(b)}${unit ? ` ${unit}` : ''} · ${b.count} ${countLabel}` : ' '}</Text>
      <View onLayout={onLayout} style={{ height }}>
        {w > 0 ? (
          <Svg width={w} height={height}>
            <Line x1={0} x2={w} y1={4 + innerH} y2={4 + innerH} stroke={c.border} strokeWidth={1} />
            {hist.map((h, i) => {
              const bh = Math.max(h.count ? 3 : 0, (h.count / max) * innerH);
              return <Rect key={i} x={i * slot + 1} y={4 + innerH - bh} width={Math.max(2, slot - 2)} height={bh} rx={3} fill={c.primary} opacity={idx === i ? 1 : 0.55} />;
            })}
          </Svg>
        ) : null}
        {w > 0 ? (
          <View style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: AXIS_H, flexDirection: 'row' }}>
            {hist.map((h, i) => <Pressable key={i} accessibilityLabel={`${range(h)}: ${h.count} ${countLabel}`} onPress={() => { selectHaptic(); setSel(sel === i ? null : i); }} style={{ flex: 1 }} />)}
          </View>
        ) : null}
        <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, flexDirection: 'row', justifyContent: 'space-between' }}>
          <Text variant="caption" color={c.textSecondary} style={{ fontSize: 10 }}>{compact(hist[0]!.from)}</Text>
          <Text variant="caption" color={c.textSecondary} style={{ fontSize: 10 }}>{compact(hist[hist.length - 1]!.to)}</Text>
        </View>
      </View>
    </View>
  );
}

/* ───────────────────────── pie / donut ───────────────────────── */

/** Share of a whole. Every slice is labelled with its value and percentage in the legend (colour is never the only cue). Tap a row or the ring to pick a slice. */
export function PieChart({ slices, donut = true, size = 150, centerLabel, format = compact, label }: { slices: Slice[]; donut?: boolean; size?: number; centerLabel?: string; format?: (n: number) => string; label: string }) {
  const c = useColors();
  const dark = useIsDark();
  const palette = dark ? CATEGORICAL.dark : CATEGORICAL.light;
  const [sel, setSel] = useState<number | null>(null);
  const parts = foldSlices(slices);
  const total = parts.reduce((a, s) => a + s.value, 0);
  if (!parts.length) return null;
  const stroke = donut ? size * 0.2 : size / 2;
  const r = donut ? (size - stroke) / 2 : size / 4;
  const circ = 2 * Math.PI * r;
  const segs = ringSegments(parts.map((p) => p.value), circ, 2);
  const picked = sel !== null ? parts[sel] : null;
  const pct = (v: number) => `${Math.round((v / total) * 100)}%`;
  return (
    <View accessible accessibilityLabel={`${label}. ${parts.map((p) => `${p.label} ${format(p.value)}, ${pct(p.value)}`).join('; ')}`} style={{ gap: space.lg, alignItems: 'center' }}>
      <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
        <Svg width={size} height={size}>
          <G rotation={-90} origin={`${size / 2}, ${size / 2}`}>
            {parts.map((p, i) => (
              <Circle key={p.label} cx={size / 2} cy={size / 2} r={r} stroke={palette[i]} strokeWidth={stroke} fill="none" strokeDasharray={`${segs[i]!.len} ${circ - segs[i]!.len}`} strokeDashoffset={segs[i]!.offset} opacity={sel === null || sel === i ? 1 : 0.35} />
            ))}
          </G>
        </Svg>
        {donut ? (
          <View style={{ position: 'absolute', alignItems: 'center', maxWidth: size * 0.6 }}>
            <Text variant="title" numberOfLines={1} adjustsFontSizeToFit>{picked ? format(picked.value) : format(total)}</Text>
            <Text variant="caption" color={c.textSecondary} numberOfLines={1}>{picked ? picked.label : centerLabel ?? 'Total'}</Text>
          </View>
        ) : null}
      </View>
      <View style={{ alignSelf: 'stretch' }}>
        {parts.map((p, i) => (
          <Pressable key={p.label} accessibilityRole="button" accessibilityLabel={`${p.label}: ${format(p.value)}, ${pct(p.value)}`} onPress={() => { selectHaptic(); setSel(sel === i ? null : i); }}
            style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: space.sm, minHeight: 36, borderTopWidth: i ? 1 : 0, borderColor: c.border }}>
            <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: palette[i], borderWidth: 2, borderColor: c.card }} />
            <Text variant="body" style={{ flex: 1 }} numberOfLines={1}>{p.label}</Text>
            <Text variant="bodyStrong">{format(p.value)}</Text>
            <Text variant="caption" color={c.textSecondary} style={{ width: 40, textAlign: 'right' }}>{pct(p.value)}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}
