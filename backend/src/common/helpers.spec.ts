import { Prisma } from '@prisma/client';
import { daysBetween, isValidDate, todayIn } from './dates';
import { deriveUuid } from './derive-uuid';
import { DomainEvents } from '../domain/events.service';
import { resolveTotal } from '../expenses/expenses.service';

describe('dates', () => {
  it('validates real calendar dates only', () => {
    expect(isValidDate('2026-06-17')).toBe(true);
    expect(isValidDate('2026-02-30')).toBe(false);
    expect(isValidDate('2026-6-1')).toBe(false);
    expect(isValidDate('yesterday')).toBe(false);
    expect(isValidDate('2024-02-29')).toBe(true);
    expect(isValidDate('2026-02-29')).toBe(false);
  });
  it('computes the business date in a time zone (not the server’s)', () => {
    const instant = new Date('2026-06-17T23:30:00Z');
    expect(todayIn('UTC', instant)).toBe('2026-06-17');
    expect(todayIn('Pacific/Auckland', instant)).toBe('2026-06-18'); // already the next day there
  });
  it('counts whole days', () => {
    expect(daysBetween('2026-06-10', '2026-06-17')).toBe(7);
    expect(daysBetween('2026-02-27', '2026-03-01')).toBe(2);
  });
});

describe('deriveUuid', () => {
  it('is deterministic, distinct per index, and shaped like a UUID', () => {
    const c = '11111111-1111-4111-8111-111111111111';
    expect(deriveUuid(c, 0)).toBe(deriveUuid(c, 0));
    expect(deriveUuid(c, 0)).not.toBe(deriveUuid(c, 1));
    expect(deriveUuid(c, 0)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('expense totals (exact decimals)', () => {
  it('multiplies quantity by unit cost without float error', () => {
    expect(resolveTotal('3', '0.10', undefined).total.toString()).toBe('0.3'); // 3 × 0.1 is 0.30000000000000004 in floats
    expect(resolveTotal('8', '1400', undefined).total.toString()).toBe('11200');
    expect(resolveTotal('2.5', '333.33', undefined).total.toString()).toBe('833.33');
  });
  it('requires agreement when everything is supplied and rejects incomplete or non-positive input', () => {
    expect(resolveTotal('8', '1400', '11200').total.equals(new Prisma.Decimal(11200))).toBe(true);
    expect(() => resolveTotal('8', '1400', '11000')).toThrow(/does not equal/);
    expect(() => resolveTotal('8', undefined, undefined)).toThrow(/both quantity and unitCost/);
    expect(() => resolveTotal(undefined, undefined, undefined)).toThrow(/Provide a total/);
    expect(() => resolveTotal(undefined, undefined, '0')).toThrow(/greater than zero/);
  });
});

describe('DomainEvents', () => {
  it('delivers to named and wildcard subscribers and isolates a failing subscriber', () => {
    const bus = new DomainEvents();
    const seen: string[] = [];
    bus.on('sale.created', () => { throw new Error('subscriber bug'); });
    bus.on('sale.created', (e) => seen.push(`named:${e.entityId}`));
    bus.on('*', (e) => seen.push(`all:${e.name}`));
    expect(() => bus.emit({ name: 'sale.created', entityId: 'abc' })).not.toThrow();
    expect(seen).toEqual(['named:abc', 'all:sale.created']);
  });
  it('supports unsubscribing', () => {
    const bus = new DomainEvents();
    const seen: string[] = [];
    const off = bus.on('payment.created', (e) => seen.push(e.entityId));
    bus.emit({ name: 'payment.created', entityId: '1' });
    off();
    bus.emit({ name: 'payment.created', entityId: '2' });
    expect(seen).toEqual(['1']);
  });
});
