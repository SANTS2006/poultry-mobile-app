import { eggsOf, fromCents, previewSale, toCents } from './money';

describe('money previews', () => {
  it('converts to and from cents exactly', () => {
    expect(toCents('1550')).toBe(155000n);
    expect(toCents('129.17')).toBe(12917n);
    expect(toCents('0.5')).toBe(50n);
    expect(toCents('-45662.49')).toBe(-4566249n);
    expect(fromCents(12917n)).toBe('129.17');
    expect(fromCents(-5n)).toBe('-0.05');
    expect(() => toCents('1,5')).toThrow();
    expect(() => toCents('1.555')).toThrow();
  });

  it('previews a sale with no floating-point drift (14 crates × 129.17)', () => {
    const p = previewSale([{ unit: 'CRATE', quantity: 14, unitPrice: '129.17' }]);
    expect(p.total).toBe('1808.38');
    expect(0.1 + 0.2).not.toBe(0.3); // the trap this avoids
  });

  it('applies a discount, never goes below zero, and reports unknown prices', () => {
    expect(previewSale([{ unit: 'CARTON', quantity: 1, unitPrice: '1550' }], '50').total).toBe('1500.00');
    expect(previewSale([{ unit: 'CARTON', quantity: 1, unitPrice: '1550' }], '99999').total).toBe('0.00');
    const p = previewSale([{ unit: 'CARTON', quantity: 1, unitPrice: '1550' }, { unit: 'CRATE', quantity: 2, unitPrice: undefined }]);
    expect(p.missing).toEqual(['CRATE']);
    expect(p.subtotal).toBe('1550.00');
    expect(previewSale([{ unit: 'EGG', quantity: 0, unitPrice: undefined }]).missing).toEqual([]);
  });

  it('counts eggs from unit quantities', () => {
    expect(eggsOf([{ unit: 'CARTON', quantity: 2 }, { unit: 'CRATE', quantity: 3 }, { unit: 'EGG', quantity: 5 }], { CARTON: 360, CRATE: 30, EGG: 1 })).toBe(815);
  });
});
