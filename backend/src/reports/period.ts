import type { GroupBy } from './report.types';

const DAY = 86_400_000;
const ms = (d: string) => new Date(`${d}T00:00:00.000Z`).getTime();
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

/** First day of the reporting bucket that contains `date`: the day itself, the ISO week's Monday, or the 1st of the month. */
export function bucketStart(date: string, groupBy: GroupBy): string {
  if (groupBy === 'day') return date;
  if (groupBy === 'month') return `${date.slice(0, 7)}-01`;
  const dow = (new Date(`${date}T00:00:00.000Z`).getUTCDay() + 6) % 7; // Monday = 0
  return iso(ms(date) - dow * DAY);
}

/** All bucket starts covering [from, to], in order (used to show empty periods as zeros instead of leaving gaps). */
export function bucketsBetween(from: string, to: string, groupBy: GroupBy): string[] {
  const out: string[] = [];
  let cur = bucketStart(from, groupBy);
  while (cur <= to) {
    out.push(cur);
    if (groupBy === 'day') cur = iso(ms(cur) + DAY);
    else if (groupBy === 'week') cur = iso(ms(cur) + 7 * DAY);
    else { const d = new Date(`${cur}T00:00:00.000Z`); d.setUTCMonth(d.getUTCMonth() + 1); cur = iso(d.getTime()); }
  }
  return out;
}

/** Human label for a bucket: "2026-06-15" (day), "Week of 2026-06-15", "2026-06". */
export function bucketLabel(start: string, groupBy: GroupBy): string {
  return groupBy === 'day' ? start : groupBy === 'week' ? `Week of ${start}` : start.slice(0, 7);
}

export function spanDays(from: string, to: string): number { return Math.round((ms(to) - ms(from)) / DAY) + 1; }
