import type { Cell, ReportResult, Table } from './report.types';

const NUMERIC = /^-?\d+(\.\d+)?$/;
const BOM = String.fromCharCode(0xfeff);

/**
 * CSV cell hardening. Spreadsheet programs execute cells that start with = + - @ (or tab/CR) as formulas ("CSV injection"), so any
 * text that could be read that way is prefixed with an apostrophe. Genuine numbers (including negatives) are left alone.
 */
export function csvCell(value: Cell | undefined, numericColumn = false): string {
  if (value === null || value === undefined) return '';
  let s = typeof value === 'string' ? value : String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(s) && !(numericColumn && NUMERIC.test(s))) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const line = (cells: Cell[], numeric: boolean[] = []): string => cells.map((c, i) => csvCell(c, numeric[i] ?? false)).join(',');

function tableLines(t: Table): string[] {
  const numeric = t.columns.map((c) => c.type === 'int' || c.type === 'money' || c.type === 'percent');
  const out = [line([t.title]), line(t.columns.map((c) => c.label))];
  for (const r of t.rows) out.push(line(t.columns.map((c) => r[c.key] ?? null), numeric));
  if (t.totals) out.push(line(t.columns.map((c) => t.totals?.[c.key] ?? null), numeric));
  return out;
}

/** UTF-8 with BOM (so Excel opens accented characters correctly); CRLF line endings per RFC 4180. One section per table unless `only` is given. */
export function toCsv(result: ReportResult, only?: string): string {
  const m = result.meta;
  const head = [
    line(['Report', m.title]), line(['Period', `${m.from} to ${m.to}`]), line(['Grouped by', m.groupBy]), line(['Currency', m.currency]),
    ...Object.entries(m.filters).map(([k, v]) => line([`Filter ${k}`, v])), line(['Generated at (UTC)', m.generatedAt]),
    ...m.notes.map((n) => line(['Note', n])),
  ];
  const summary = [line(['Summary']), ...Object.entries(result.summary).map(([k, v]) => line([k, v]))];
  const tables = result.tables.filter((t) => !only || t.name === only);
  const body = tables.flatMap((t) => ['', ...tableLines(t)]);
  const lines = only ? tableLines(tables[0]) : [...head, '', ...summary, ...body];
  return `${BOM}${lines.join('\r\n')}\r\n`;
}
