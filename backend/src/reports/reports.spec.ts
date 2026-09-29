import { extractPdfText } from '../../test/pdf-text';
import { pct, splitEggs } from './common';
import { csvCell, toCsv } from './csv';
import { toPdf } from './pdf';
import { bucketLabel, bucketsBetween, bucketStart, spanDays } from './period';
import type { ReportResult } from './report.types';

const sample = (over: Partial<ReportResult> = {}): ReportResult => ({
  meta: { report: 'sales', title: 'Sales report', from: '2026-06-01', to: '2026-06-30', groupBy: 'week', filters: { customerId: 'abc' }, generatedAt: '2026-07-01T10:00:00.000Z', currency: 'NLe', timezone: 'Africa/Freetown', notes: ['Not profit.'] },
  summary: { revenue: '337125.00', salesCount: 22, note: null },
  tables: [{
    name: 'trend', title: 'Sales by week', columns: [{ key: 'period', label: 'Period', type: 'text' }, { key: 'count', label: 'Sales', type: 'int' }, { key: 'revenue', label: 'Revenue (NLe)', type: 'money' }],
    rows: [{ period: 'Week of 2026-06-15', count: 5, revenue: '7750.00' }, { period: '=HYPERLINK("http://evil","x")', count: 1, revenue: '-9150.00' }, { period: 'Mama, "Kadi"\nLine2', count: 0, revenue: '0.00' }],
    totals: { period: 'Total', count: 6, revenue: '-1400.00' },
  }],
  ...over,
});

describe('period bucketing', () => {
  it('uses ISO weeks (Monday start) and calendar months', () => {
    expect(bucketStart('2026-06-17', 'week')).toBe('2026-06-15'); // Wednesday
    expect(bucketStart('2026-06-21', 'week')).toBe('2026-06-15'); // Sunday belongs to the week that started Monday
    expect(bucketStart('2026-06-22', 'week')).toBe('2026-06-22');
    expect(bucketStart('2026-01-01', 'week')).toBe('2025-12-29'); // crosses the year boundary
    expect(bucketStart('2026-06-17', 'month')).toBe('2026-06-01');
    expect(bucketStart('2026-06-17', 'day')).toBe('2026-06-17');
  });
  it('lists every period (empty ones too) in order', () => {
    expect(bucketsBetween('2026-06-17', '2026-06-20', 'day')).toEqual(['2026-06-17', '2026-06-18', '2026-06-19', '2026-06-20']);
    expect(bucketsBetween('2026-06-17', '2026-07-06', 'week')).toEqual(['2026-06-15', '2026-06-22', '2026-06-29', '2026-07-06']);
    expect(bucketsBetween('2025-11-15', '2026-02-02', 'month')).toEqual(['2025-11-01', '2025-12-01', '2026-01-01', '2026-02-01']);
    expect(bucketLabel('2026-06-15', 'week')).toBe('Week of 2026-06-15');
    expect(bucketLabel('2026-06-01', 'month')).toBe('2026-06');
    expect(spanDays('2026-06-17', '2026-06-17')).toBe(1);
    expect(spanDays('2026-01-01', '2026-12-31')).toBe(365);
  });
});

describe('helpers', () => {
  it('splits eggs with the supplied unit sizes and computes exact percentages', () => {
    expect(splitEggs(2065, 360, 30)).toEqual({ cartons: 5, crates: 8, singles: 25 });
    expect(splitEggs(29, 360, 30)).toEqual({ cartons: 0, crates: 0, singles: 29 });
    expect(pct(1, 3)).toBe('33.3');
    expect(pct(0, 0)).toBe('0.0');
  });
});

describe('CSV export hardening', () => {
  it('neutralises spreadsheet formulas but keeps real numbers intact', () => {
    for (const evil of ['=1+1', '+SUM(A1)', '-2+3', '@cmd', '\t=x', '\r=x']) expect(csvCell(evil)).toMatch(/^"?'/);
    expect(csvCell('-9150.00', true)).toBe('-9150.00'); // a genuine negative amount in a numeric column
    expect(csvCell('-9150.00', false)).toBe("'-9150.00"); // the same text in a TEXT column is treated as risky
    expect(csvCell(-5, true)).toBe('-5');
    expect(csvCell('=HYPERLINK("x")', true)).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell(null)).toBe('');
    expect(csvCell('plain')).toBe('plain');
  });
  it('escapes commas, quotes and newlines (RFC 4180) and writes a BOM with CRLF line endings', () => {
    const csv = toCsv(sample());
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain('\r\n');
    expect(csv).not.toMatch(/[^\r]\n(?![^"]*"(?:[^"]*"[^"]*")*[^"]*$)/); // no bare LF outside quoted fields
    expect(csv).toContain('"Mama, ""Kadi""\nLine2"');
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"",""x"")"`);
    expect(csv).toContain(',-9150.00'); // numeric column negative kept as a number
    expect(csv).toContain('Total,6,-1400.00');
  });
  it('contains the report header, summary and every table, or just the selected table', () => {
    const all = toCsv(sample());
    expect(all).toContain('Report,Sales report');
    expect(all).toContain('Period,2026-06-01 to 2026-06-30');
    expect(all).toContain('Filter customerId,abc');
    expect(all).toContain('Note,Not profit.');
    expect(all).toContain('revenue,337125.00');
    expect(all).toContain('Sales by week');
    const one = toCsv(sample(), 'trend');
    expect(one.startsWith('﻿Sales by week')).toBe(true);
    expect(one).not.toContain('Report,Sales report');
  });
});

describe('PDF export', () => {
  const text = async (buf: Buffer) => extractPdfText(buf);

  it('renders title, filters, summary, notes and formatted table data', async () => {
    const buf = await toPdf(sample(), 'Owner Person');
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
    const { text: t } = await text(buf);
    expect(t).toContain('Sales report');
    expect(t).toContain('Period: 2026-06-01 to 2026-06-30');
    expect(t).toContain('by Owner Person');
    expect(t).toContain('Filters: customerId = abc');
    expect(t).toContain('revenue: 337125.00');
    expect(t).toContain('Note: Not profit.');
    expect(t).toContain('Week of 2026-06-15');
    expect(t).toContain('7,750.00'); // money formatted with thousands separators
    expect(t).toContain('-9,150.00');
    expect(t).toContain('Total');
  });

  it('paginates long tables with a repeated header row and page numbers', async () => {
    const rows = Array.from({ length: 160 }, (_, i) => ({ period: `Day ${i + 1}`, count: i, revenue: (i * 10).toFixed(2) }));
    const buf = await toPdf(sample({ tables: [{ ...sample().tables[0], rows, totals: undefined }] }), 'X');
    const r = await text(buf);
    expect(r.total).toBeGreaterThan(3);
    expect(r.total).toBeLessThan(10); // 160 rows fit in a handful of pages; blank overflow pages would inflate this
    expect((r.text.match(/Page \d+ of \d+/g) ?? []).length).toBe(r.total); // exactly one footer per page
    expect(r.text).toContain(`Page 1 of ${r.total}`);
    expect(r.text).toContain(`Page ${r.total} of ${r.total}`);
    expect((r.text.match(/Revenue \(NLe\)/g) ?? []).length).toBeGreaterThanOrEqual(r.total); // header repeats on every page
    expect(r.text).toContain('Day 160');
  });

  it('says so when a period has no data', async () => {
    const empty = sample({ tables: [{ ...sample().tables[0], rows: [], totals: undefined }] });
    expect((await text(await toPdf(empty, 'X'))).text).toContain('No data for this period.');
  });
});
