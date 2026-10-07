import { addDays, businessToday, eggBreakdown, formatDate, formatInt, formatMoney, isMoneyInput, timeAgo } from './format';

describe('formatting', () => {
  it('formats money from decimal strings without floating point', () => {
    expect(formatMoney('8345.89', 'NLe')).toBe('NLe 8,345.89');
    expect(formatMoney('0.1')).toBe('0.10');
    expect(formatMoney('1234567890123.45')).toBe('1,234,567,890,123.45');
    expect(formatMoney('-45662.49', 'NLe')).toBe('NLe -45,662.49');
    expect(formatMoney('1550')).toBe('1,550.00');
    expect(formatMoney(null)).toBe('—');
    expect(formatMoney('abc')).toBe('abc');
  });
  it('shows eggs as trays and singles', () => {
    expect(eggBreakdown(2070)).toBe('5 cartons · 9 crates'); // 1800 + 270
    expect(eggBreakdown(0)).toBe('0 eggs');
    expect(eggBreakdown(1)).toBe('1 egg');
    expect(eggBreakdown(-640)).toBe('−1 carton · 9 crates · 10 eggs');
  });
  it('formats calendar dates without time-zone drift', () => {
    expect(formatDate('2026-06-15')).toBe('Mon 15 Jun 2026');
    expect(formatDate('2026-01-01', false)).toBe('Thu 1 Jan');
    expect(formatDate(null)).toBe('—');
  });
  it('adds days across month and year boundaries', () => {
    expect(addDays('2026-06-30', 1)).toBe('2026-07-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
  });
  it('validates money input', () => {
    expect(['1', '1.5', '1.55', '0'].every(isMoneyInput)).toBe(true);
    expect(['', '1.555', '-1', '1,5', 'abc', '1e3'].some(isMoneyInput)).toBe(false);
  });
  it('groups integers and words elapsed time', () => {
    expect(formatInt(1234567)).toBe('1,234,567');
    const now = Date.parse('2026-06-15T12:00:00Z');
    expect(timeAgo('2026-06-15T11:59:40Z', now)).toBe('just now');
    expect(timeAgo('2026-06-15T11:30:00Z', now)).toBe('30 min ago');
    expect(timeAgo('2026-06-14T12:00:00Z', now)).toBe('1 d ago');
    expect(timeAgo(null)).toBe('never');
  });
  it('computes today in the business time zone, not the phone zone', () => {
    const t = new Date('2026-06-15T23:30:00Z');
    expect(businessToday('Africa/Freetown', t)).toBe('2026-06-15');
    expect(businessToday('Pacific/Auckland', t)).toBe('2026-06-16'); // already tomorrow there
    expect(businessToday('Not/AZone', t)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(businessToday(undefined, t)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
