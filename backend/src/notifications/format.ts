/** Display formatting only (never used for calculations). */
export const fmtEggs = (n: number): string => `${n.toLocaleString('en-US')} eggs`;

export function fmtMoney(currency: string, amount: string): string {
  const neg = amount.startsWith('-');
  const [int, frac = ''] = amount.replace('-', '').split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const cents = frac.replace(/0+$/, '');
  return `${currency} ${neg ? "-" : ""}${grouped}${cents ? `.${cents.padEnd(2, "0")}` : ""}`;
}

const SHIFT_LABEL: Record<string, string> = { MORNING: 'Morning', AFTERNOON: 'Afternoon', EVENING: 'Evening' };
export const shiftLabel = (code: string): string => SHIFT_LABEL[code] ?? code;

/** Wall-clock parts in an IANA time zone. */
export function localParts(now: Date, timeZone: string): { date: string; hm: string } {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const hm = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
  return { date, hm };
}
