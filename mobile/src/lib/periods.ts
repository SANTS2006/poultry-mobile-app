import { addDays } from './format';

export type PeriodKey = 'today' | 'last7' | 'thisMonth' | 'lastMonth' | 'last30' | 'thisYear';

export const PERIOD_LABELS: Record<PeriodKey, string> = {
  today: 'Today', last7: 'Last 7 days', last30: 'Last 30 days', thisMonth: 'This month', lastMonth: 'Last month', thisYear: 'This year',
};

const lastDayOfMonth = (y: number, m: number): string => new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); // m is 1-based; day 0 of next month

/** Date range (inclusive, YYYY-MM-DD, business calendar) for a preset, relative to `today` in the business time zone. */
export function periodRange(key: PeriodKey, today: string): { from: string; to: string } {
  const [y, m] = today.split('-').map(Number);
  switch (key) {
    case 'today': return { from: today, to: today };
    case 'last7': return { from: addDays(today, -6), to: today };
    case 'last30': return { from: addDays(today, -29), to: today };
    case 'thisMonth': return { from: `${y}-${String(m).padStart(2, '0')}-01`, to: today };
    case 'lastMonth': {
      const py = m === 1 ? y - 1 : y;
      const pm = m === 1 ? 12 : m - 1;
      return { from: `${py}-${String(pm).padStart(2, '0')}-01`, to: lastDayOfMonth(py, pm) };
    }
    case 'thisYear': return { from: `${y}-01-01`, to: today };
  }
}

/** Sensible bucket size for a range, so a year is not shown as 366 bars. */
export function defaultGroupBy(from: string, to: string): 'day' | 'week' | 'month' {
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
  return days <= 31 ? 'day' : days <= 120 ? 'week' : 'month';
}
