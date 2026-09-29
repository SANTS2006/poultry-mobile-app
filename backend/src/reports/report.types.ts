export type GroupBy = 'day' | 'week' | 'month';
export type ColumnType = 'text' | 'int' | 'money' | 'percent' | 'date';

export interface Column { key: string; label: string; type: ColumnType }
export type Cell = string | number | boolean | null;

export interface Table {
  name: string;
  title: string;
  columns: Column[];
  rows: Record<string, Cell>[];
  totals?: Record<string, Cell>;
}

export interface ReportMeta {
  report: string;
  title: string;
  from: string;
  to: string;
  groupBy: GroupBy;
  filters: Record<string, string>;
  generatedAt: string;
  currency: string;
  timezone: string;
  /** honest caveats (e.g. "this is cash flow, not profit", "N records have no date") */
  notes: string[];
}

export interface ReportResult {
  meta: ReportMeta;
  summary: Record<string, Cell>;
  tables: Table[];
}

export interface ReportRequest {
  from: string;
  to: string;
  groupBy: GroupBy;
  detail: boolean;
  /** normalised, validated filter values (uuid / code strings) */
  filters: Record<string, string | boolean | undefined>;
}
