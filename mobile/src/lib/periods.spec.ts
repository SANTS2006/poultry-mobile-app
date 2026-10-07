import { defaultGroupBy, periodRange } from './periods';

describe('report periods', () => {
  it('computes presets in the business calendar', () => {
    expect(periodRange('today', '2026-06-15')).toEqual({ from: '2026-06-15', to: '2026-06-15' });
    expect(periodRange('last7', '2026-06-15')).toEqual({ from: '2026-06-09', to: '2026-06-15' });
    expect(periodRange('thisMonth', '2026-06-15')).toEqual({ from: '2026-06-01', to: '2026-06-15' });
    expect(periodRange('thisYear', '2026-06-15')).toEqual({ from: '2026-01-01', to: '2026-06-15' });
  });
  it('handles last month across year boundaries and short months', () => {
    expect(periodRange('lastMonth', '2026-06-15')).toEqual({ from: '2026-05-01', to: '2026-05-31' });
    expect(periodRange('lastMonth', '2026-01-10')).toEqual({ from: '2025-12-01', to: '2025-12-31' });
    expect(periodRange('lastMonth', '2026-03-01')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(periodRange('lastMonth', '2028-03-01')).toEqual({ from: '2028-02-01', to: '2028-02-29' }); // leap year
  });
  it('spans 30 days for the last-30 preset', () => {
    expect(periodRange('last30', '2026-03-01')).toEqual({ from: '2026-01-31', to: '2026-03-01' });
  });
  it('picks a readable bucket size', () => {
    expect(defaultGroupBy('2026-06-01', '2026-06-30')).toBe('day');
    expect(defaultGroupBy('2026-04-01', '2026-06-30')).toBe('week');
    expect(defaultGroupBy('2026-01-01', '2026-12-31')).toBe('month');
  });
});
