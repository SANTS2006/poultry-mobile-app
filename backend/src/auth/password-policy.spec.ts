import { passwordProblems } from './password-policy';

const ctx = { email: 'ada.lovelace@farm.com', fullName: 'Ada Lovelace', businessName: 'Makarifor Agriculture' };

describe('passwordProblems', () => {
  it('accepts a long passphrase of unrelated words', () => {
    expect(passwordProblems('meadow-gravel-orbit-58', ctx)).toEqual([]);
    expect(passwordProblems('correct horse battery staple', ctx)).toEqual([]);
  });
  it('refuses short, repetitive and low-variety passwords', () => {
    expect(passwordProblems('short', ctx).join(' ')).toMatch(/12 characters/);
    expect(passwordProblems('aaaaaaaaaaaaaa', ctx).length).toBeGreaterThan(0);
    expect(passwordProblems('abababababab', ctx).length).toBeGreaterThan(0);
  });
  it('refuses passwords built from the person’s own details or the business name', () => {
    expect(passwordProblems('ada.lovelace-2026-x', ctx).join(' ')).toMatch(/email name/);
    expect(passwordProblems('lovelace-and-friends-77', ctx).join(' ')).toMatch(/your name/);
    expect(passwordProblems('Makarifor-farm-x9-77', ctx).join(' ')).toMatch(/business name/);
  });
  it('refuses common words with a year or symbol on the end, and obvious sequences', () => {
    for (const bad of ['Welcome-2026-abc!', 'Poultry2026!!', 'Password-Admin-1!', 'abcdefgh-xyz-12', 'qwertyuiop-77']) expect(passwordProblems(bad, ctx).length).toBeGreaterThan(0);
  });
  it('does not flag ordinary words that merely contain a short common one', () => {
    expect(passwordProblems('farmhouse-lantern-quartz-19', { email: 'x@y.co' })).toEqual([]);
  });
});
