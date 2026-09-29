import { validatePassword } from './password';

describe('client password check', () => {
  it('accepts a long passphrase', () => expect(validatePassword('tractor-ripple-lantern-92')).toEqual([]));
  it('requires 12 characters', () => expect(validatePassword('short-one')[0]).toMatch(/at least 12/));
  it('rejects repetitive and low-variety passwords', () => {
    expect(validatePassword('aaaaaaaaaaaaaa')).not.toEqual([]);
    expect(validatePassword('abababababab')).not.toEqual([]);
  });
  it('rejects passwords containing the email name', () => expect(validatePassword('newton-loves-eggs-1', 'newton@x.com')[0]).toMatch(/email name/));
  it('rejects absurdly long input', () => expect(validatePassword('x1'.repeat(70))[0]).toMatch(/at most 128/));
});
