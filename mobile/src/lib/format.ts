/** Money values are decimal STRINGS from the server. They are formatted by string manipulation so no floating-point rounding can alter them. */
export function formatMoney(value: string | number | null | undefined, currency = ''): string {
  if (value === null || value === undefined || value === '') return '—';
  const s = String(value).trim();
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) return s;
  const [, sign, int, frac = ''] = m;
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const cents = (frac + '00').slice(0, 2);
  return `${currency ? `${currency} ` : ''}${sign}${grouped}.${cents}`;
}

export const formatInt = (n: number | null | undefined): string => (n === null || n === undefined ? '—' : String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ','));

/** "2,070 eggs" and the same in trays: 5 cartons · 3 crates · 12 eggs. */
export function eggBreakdown(eggs: number, unitEggs: { CARTON?: number; CRATE?: number } = { CARTON: 360, CRATE: 30 }): string {
  const carton = unitEggs.CARTON ?? 360, crate = unitEggs.CRATE ?? 30;
  const sign = eggs < 0 ? '−' : '';
  let r = Math.abs(eggs);
  const parts: string[] = [];
  const c = Math.floor(r / carton); r -= c * carton;
  const k = Math.floor(r / crate); r -= k * crate;
  if (c) parts.push(`${c} carton${c === 1 ? '' : 's'}`);
  if (k) parts.push(`${k} crate${k === 1 ? '' : 's'}`);
  if (r || parts.length === 0) parts.push(`${r} egg${r === 1 ? '' : 's'}`);
  return sign + parts.join(' · ');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "Mon 15 Jun 2026" from a YYYY-MM-DD business date (no time-zone shifting: it is a calendar date, not an instant). */
export function formatDate(d: string | null | undefined, withYear = true): string {
  if (!d || !/^\d{4}-\d{2}-\d{2}/.test(d)) return d ?? '—';
  const [y, m, day] = d.slice(0, 10).split('-').map(Number);
  const dow = DAYS[new Date(Date.UTC(y, m - 1, day)).getUTCDay()];
  return `${dow} ${day} ${MONTHS[m - 1]}${withYear ? ` ${y}` : ''}`;
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return iso;
  return `${t.getDate()} ${MONTHS[t.getMonth()]} ${t.getFullYear()}, ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
}

export function timeAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

/** Decimal-string input check used by money fields: at most 2 decimals, no sign. */
export const isMoneyInput = (s: string): boolean => /^\d{1,12}(\.\d{1,2})?$/.test(s.trim());

export const todayLocal = (now = new Date()): string => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Today's date in the BUSINESS time zone (what the server uses to reject future dates), not the phone's zone. Falls back to the phone's date if the zone is unknown. */
export function businessToday(timeZone: string | undefined, now = new Date()): string {
  if (timeZone) {
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
    } catch { /* unknown zone: fall through */ }
  }
  return todayLocal(now);
}
