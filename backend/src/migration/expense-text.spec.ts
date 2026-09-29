import { Prisma } from '@prisma/client';
import { cleanDescription, parseExpenseText } from './expense-text';

const D = (n: number) => new Prisma.Decimal(n);
const show = (t: string, a: number) => parseExpenseText(t, D(a)).items.map((i) => [i.description, i.total.toNumber(), i.quantity, i.unitCost?.toNumber() ?? null]);

describe('parseExpenseText (real strings from the workbook)', () => {
  it('splits five people paid in one Labour cell when the amounts add up exactly', () => {
    const r = parseExpenseText('Emmanuel Welder (le3,500), Foday Kalie (le6,350), Mr Usiff funeral (le500) Baba (le3,500), Musa, Nabiella & others (le 400)', D(14250));
    expect(r.kind).toBe('split');
    expect(r.items.map((i) => [i.description, i.total.toNumber()])).toEqual([
      ['Emmanuel Welder', 3500], ['Foday Kalie', 6350], ['Mr Usiff funeral', 500], ['Baba', 3500], ['Musa, Nabiella & others', 400],
    ]);
  });

  it('handles quantity×unit-cost tokens and mixed items', () => {
    expect(show('Feeders (le300*13), Bike Tire (le500)', 4400)).toEqual([['Feeders', 3900, 13, 300], ['Bike Tire', 500, null, null]]);
    expect(show('concentrate (le 1,400*8)', 11200)).toEqual([['concentrate', 11200, 8, 1400]]);
    expect(show('Cartoon (le20*24), Crate (le350*3', 1530)).toEqual([['Cartoon', 480, 24, 20], ['Crate', 1050, 3, 350]]);
  });

  it('tolerates unbalanced brackets and stray words', () => {
    expect(show('Abu Kamara (le 5,000), Neneh (le 300', 5300)).toEqual([['Abu Kamara', 5000, null, null], ['Neneh', 300, null, null]]);
    expect(show('Corn (Mr Ibrahim(le 40,000) & Concentrate (le 1,400*8)', 51200)).toEqual([['Corn Mr Ibrahim', 40000, null, null], ['Concentrate', 11200, 8, 1400]]);
    expect(show('Board 4 Net(le125*14) & Top up 4 Cameras (le100)', 1850)).toEqual([['Board 4 Net', 1750, 14, 125], ['Top up 4 Cameras', 100, null, null]]);
  });

  it('reads a bare quantity×price (no "le") only when it equals the amount', () => {
    expect(show('Egg Crate (3*350)', 1050)).toEqual([['Egg Crate', 1050, 3, 350]]);
    expect(show('PKC (2*200)', 400)).toEqual([['PKC', 400, 2, 200]]);
    expect(parseExpenseText('Egg Crate (3*350)', D(999)).kind).toBe('mismatch');
  });

  it('NEVER splits when the text disagrees with the amount cell (kept whole, flagged as mismatch)', () => {
    const r = parseExpenseText('Baba (le1,000), Abass (le500)', D(1600));
    expect(r.kind).toBe('mismatch');
    expect(r.items).toHaveLength(1);
    expect(r.items[0].total.toNumber()).toBe(1600);
    expect(r.detail).toMatch(/1500.*1600/);
  });

  it('leaves plain descriptions untouched and never invents quantities', () => {
    const r = parseExpenseText('Diesel 4 power Tila', D(155));
    expect(r.kind).toBe('single');
    expect(r.items[0]).toMatchObject({ description: 'Diesel 4 power Tila', quantity: null, unitCost: null });
  });

  it('keeps decimal arithmetic exact', () => {
    expect(parseExpenseText('a (le0.1), b (le0.2)', D(0.3)).kind).toBe('split');
  });

  it('cleanDescription trims separators and unmatched brackets', () => {
    expect(cleanDescription(' , & Baba ')).toBe('Baba');
    expect(cleanDescription('Corn (Mr Ibrahim')).toBe('Corn Mr Ibrahim');
    expect(cleanDescription('   ')).toBe('');
  });
});
