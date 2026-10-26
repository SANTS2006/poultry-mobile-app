import { passwordRules, passwordStrength, validatePassword } from './password';

describe('client password check', () => {
  it('accepts a long passphrase', () => expect(validatePassword('tractor-ripple-lantern-92')).toEqual([]));
  it('requires 12 characters', () => expect(validatePassword('short-one')[0]).toMatch(/at least 12/));
  it('rejects repetitive and low-variety passwords', () => {
    expect(validatePassword('aaaaaaaaaaaaaa')).not.toEqual([]);
    expect(validatePassword('abababababab')).not.toEqual([]);
  });
  it('rejects passwords containing the email name', () => expect(validatePassword('newton-loves-eggs-1', 'newton@x.com')[0]).toMatch(/email name/));
  it('rejects absurdly long input', () => expect(validatePassword('x1'.repeat(70))[0]).toMatch(/at most 128/));
  it('rejects obvious sequences, repeated patterns and common words, like the server', () => {
    expect(validatePassword('abcdefgh-xyz-91')).toContain('Password contains an obvious sequence or repeated pattern.');
    expect(validatePassword('Welcome-Admin-2026!')[0]).toMatch(/common words/);
    expect(validatePassword('farm-Admin-1999')[0]).toMatch(/common words/);
  });
  it('lists each rule with its own state so the screen can tick them off', () => {
    const r = passwordRules('short', 'newton@x.com');
    expect(r.map((x) => x.id)).toEqual(['length', 'variety', 'email', 'pattern', 'words']);
    expect(r.find((x) => x.id === 'length')!.ok).toBe(false);
    expect(passwordRules('tractor-ripple-lantern-92').every((x) => x.ok)).toBe(true);
  });
  it('grades a valid password by length', () => {
    expect(passwordStrength('').level).toBe(0);
    expect(passwordStrength('short').level).toBe(1);
    expect(passwordStrength('tractor-ripple-9').level).toBe(3);
    expect(passwordStrength('tractor-ripple-lantern-92').level).toBe(4);
  });
});
