import { temporaryPassword } from './temp-password';

describe('temporaryPassword', () => {
  it('uses the initials of the business name and the year', () => {
    expect(temporaryPassword('Makarifor Agriculture', 2026)).toBe('MA2026');
    expect(temporaryPassword('Green Valley Poultry Farm', 2027)).toBe('GVPF2027');
    expect(temporaryPassword('  sunrise   eggs ', 2026)).toBe('SE2026');
  });
  it('uses the first three letters of a one-word name and ignores punctuation (&)', () => {
    expect(temporaryPassword('Makarifor', 2026)).toBe('MAK2026');
    expect(temporaryPassword('Ade & Sons', 2026)).toBe('AS2026');
  });
  it('never returns an empty prefix', () => {
    expect(temporaryPassword('', 2026)).toBe('PM2026');
    expect(temporaryPassword('123', 2026)).toBe('PM2026');
  });
});
