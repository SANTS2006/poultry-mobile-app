import { act, create } from 'react-test-renderer';
import { createElement } from 'react';
import { digits, email, fullName, money, newPassword, phone, positiveMoney, quantity, required, sameAs, useForm, type Form } from './validation';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function harness() {
  const ref: { form?: Form<'email' | 'password' | 'again'> } = {};
  const initial = { email: '', password: '', again: '' };
  const rules = { email: [required('Enter your email address.'), email], password: [required('Enter your password.'), newPassword()], again: [sameAs('password', 'The two passwords don’t match.')] };
  const C = () => { ref.form = useForm(initial, rules); return null; };
  act(() => { create(createElement(C)); });
  return ref as { form: Form<'email' | 'password' | 'again'> };
}

describe('rules', () => {
  it('accepts blank optional values and flags bad ones', () => {
    expect(email('', {})).toBeNull();
    expect(email('a@b.co', {})).toBeNull();
    expect(email('nope', {})).toMatch(/email/);
    expect(phone('', {})).toBeNull();
    expect(phone('+232 76 000 000', {})).toBeNull();
    expect(phone('12ab', {})).toMatch(/phone/);
    expect(fullName('Ada Lovelace', {})).toBeNull();
    expect(fullName('A', {})).toMatch(/2 letters/);
    expect(fullName('R2D2', {})).toMatch(/numbers/);
  });
  it('checks money, quantity, whole numbers and codes', () => {
    expect(money()('1500.50', {})).toBeNull();
    expect(money()('1500.505', {})).toMatch(/2 decimals/);
    expect(money()('-5', {})).not.toBeNull();
    expect(positiveMoney('price')('0', {})).toMatch(/more than zero/);
    expect(quantity()('2.5', {})).toBeNull();
    expect(quantity()('0', {})).toMatch(/more than zero/);
    expect(quantity()('abc', {})).not.toBeNull();
    expect(digits(6, 'Enter 6 digits.')('12345', {})).toBe('Enter 6 digits.');
    expect(digits(6, 'Enter 6 digits.')('123456', {})).toBeNull();
  });
  it('mirrors the server password policy', () => {
    expect(newPassword()('short', {})).toMatch(/12 characters/);
    expect(newPassword()('correct horse battery', {})).toBeNull();
  });
});

describe('useForm: stability', () => {
  it('keeps `set` the same function across renders so it can sit in an effect dependency list', () => {
    const seen: unknown[] = [];
    const C = () => { const f = useForm({ a: '' }, { a: [required('x')] }); seen.push(f.set); return null; };
    let r!: ReturnType<typeof create>;
    act(() => { r = create(createElement(C)); });
    act(() => { r.update(createElement(C)); });
    act(() => { r.update(createElement(C)); });
    expect(new Set(seen).size).toBe(1);
  });
});

describe('useForm: when errors appear', () => {
  it('does not complain about an empty field just because it was tapped and left', () => {
    const h = harness();
    act(() => { h.form.field('email').onBlur(); });
    expect(h.form.field('email').error).toBeNull();
  });
  it('flags a wrong format after the user typed something and left the field, then keeps it current', () => {
    const h = harness();
    act(() => { h.form.field('email').onChangeText('bob'); });
    expect(h.form.field('email').error).toBeNull(); // still typing, not left yet
    act(() => { h.form.field('email').onBlur(); });
    expect(h.form.field('email').error).toMatch(/email/);
    act(() => { h.form.field('email').onChangeText('bob@farm.com'); });
    expect(h.form.field('email').error).toBeNull();
  });
  it('shows "required" and every other problem only when the form is submitted', () => {
    const h = harness();
    let ok = true;
    act(() => { ok = h.form.submit(); });
    expect(ok).toBe(false);
    expect(h.form.field('email').error).toBe('Enter your email address.');
    expect(h.form.field('password').error).toBe('Enter your password.');
    act(() => { h.form.set('email', 'bob@farm.com'); h.form.set('password', 'correct horse battery'); h.form.set('again', 'different'); });
    act(() => { ok = h.form.submit(); });
    expect(ok).toBe(false);
    expect(h.form.field('again').error).toMatch(/don’t match/);
    act(() => { h.form.set('again', 'correct horse battery'); });
    act(() => { ok = h.form.submit(); });
    expect(ok).toBe(true);
    expect(h.form.valid).toBe(true);
  });
});
