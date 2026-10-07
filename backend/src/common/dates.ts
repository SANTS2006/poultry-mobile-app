/** Business-calendar helpers. Dates are plain YYYY-MM-DD strings in the configured business time zone (no time-of-day). */
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
}

export function todayIn(timeZone: string, now = new Date()): string {
  // the en-CA locale formats as YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export const toDbDate = (s: string): Date => new Date(`${s}T00:00:00.000Z`);
export const fromDbDate = (d: Date): string => d.toISOString().slice(0, 10);

export function daysBetween(from: string, to: string): number {
  return Math.round((toDbDate(to).getTime() - toDbDate(from).getTime()) / 86_400_000);
}

/**
 * Timestamp for a stock movement caused by a record dated `businessDate`: the real time for today's records, otherwise noon on that
 * date (so back-dated production/sales land in the right reporting period instead of "whenever someone typed them in").
 */
export function eventTime(businessDate: string, today: string, now = new Date()): Date {
  return businessDate === today ? now : new Date(`${businessDate}T12:00:00.000Z`);
}
