import { useCallback, useMemo, useState } from 'react';
import { validatePassword } from './password';

/**
 * Form validation with one rule for when errors appear (the same on every screen):
 *  • a field is never flagged just because it was tapped or left empty;
 *  • once the user has typed something and left the field, it is checked against its format rules and the error stays up to date as they edit;
 *  • pressing the submit button checks everything, including "required".
 * The server re-checks every value; these rules only save a round trip and tell people what to fix.
 */
export type Values = Record<string, string>;
export type Rule<V extends Values = Values> = ((value: string, all: V) => string | null) & { required?: true };

export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Marks a field as mandatory. Only enforced on submit (an empty field is not an error while the user is still filling in the form). */
export const required = (message: string): Rule => Object.assign((v: string) => (v.trim() ? null : message), { required: true as const });
export const email: Rule = (v) => (!v.trim() || EMAIL_RE.test(v.trim()) ? null : 'That doesn’t look like an email address.');
export const minLength = (n: number, message?: string): Rule => (v) => (!v.trim() || v.trim().length >= n ? null : message ?? `Use at least ${n} characters.`);
export const maxLength = (n: number): Rule => (v) => (v.length <= n ? null : `Use at most ${n} characters.`);
export const fullName: Rule = (v) => (!v.trim() ? null : v.trim().length < 2 ? 'Enter your full name (at least 2 letters).' : /\d/.test(v) ? 'A name cannot contain numbers.' : null);
/** Optional phone number: 7–15 digits, with an optional leading + and common separators. */
export const phone: Rule = (v) => (!v.trim() || /^\+?[\d\s\-()]{7,20}$/.test(v.trim()) && v.replace(/\D/g, '').length >= 7 && v.replace(/\D/g, '').length <= 15 ? null : 'Enter a valid phone number, e.g. +232 76 000 000.');
export const money = (what = 'amount'): Rule => (v) => (!v.trim() || /^\d{1,12}(\.\d{1,2})?$/.test(v.trim()) ? null : `Enter the ${what} as a number with at most 2 decimals, e.g. 1500 or 1500.50.`);
export const positiveMoney = (what = 'amount'): Rule => (v) => money(what)(v, {}) ?? (!v.trim() || Number(v) > 0 ? null : `The ${what} must be more than zero.`);
export const quantity = (what = 'quantity'): Rule => (v) => (!v.trim() || /^\d{1,9}(\.\d{1,3})?$/.test(v.trim()) ? (v.trim() && Number(v) <= 0 ? `The ${what} must be more than zero.` : null) : `Enter the ${what} as a number, e.g. 12 or 2.5.`);
export const wholeNumber = (what = 'number'): Rule => (v) => (!v.trim() || /^\d{1,9}$/.test(v.trim()) ? null : `Enter the ${what} as a whole number.`);
export const digits = (n: number, message: string): Rule => (v) => (!v.trim() || new RegExp(`^\\d{${n}}$`).test(v.trim()) ? null : message);
export const newPassword = (emailOf?: (all: Values) => string | undefined): Rule => (v, all) => (v ? validatePassword(v, emailOf?.(all))[0] ?? null : null);
export const sameAs = (other: string, message = 'The two values don’t match.'): Rule => (v, all) => (!v || v === all[other] ? null : message);
export const differentFrom = (other: string, message: string): Rule => (v, all) => (!v || v !== all[other] ? null : message);

const firstError = (rules: Rule[], value: string, all: Values, skipRequired: boolean): string | null => {
  for (const r of rules) { if (skipRequired && r.required) continue; const e = r(value, all); if (e) return e; }
  return null;
};

export interface Form<K extends string> {
  values: Record<K, string>;
  set(name: K, value: string): void;
  /** Props for <Field>: value, onChangeText, onBlur and the (timed) error. */
  field(name: K): { value: string; onChangeText: (t: string) => void; onBlur: () => void; error: string | null };
  error(name: K): string | null;
  /** Checks every field (shows all errors) and says whether the form is valid. */
  submit(): boolean;
  /** True when every rule passes right now (use to enable a button; does not show errors). */
  valid: boolean;
  reset(values?: Partial<Record<K, string>>): void;
}

export function useForm<K extends string>(initial: Record<K, string>, rules: Partial<Record<K, Rule<Record<K, string>>[]>>): Form<K> {
  const [initialValues] = useState(initial);
  const [values, setValues] = useState<Record<K, string>>(initial);
  const [touched, setTouched] = useState<Partial<Record<K, boolean>>>({});
  const [submitted, setSubmitted] = useState(false);
  const r = rules as Partial<Record<K, Rule[]>>;
  const errorOf = useCallback((name: K, all: Record<K, string>, full: boolean): string | null => firstError(r[name] ?? [], all[name], all, !full), [r]);

  const error = useCallback((name: K) => {
    if (submitted) return errorOf(name, values, true);
    if (touched[name] && values[name] !== '') return errorOf(name, values, false);
    return null;
  }, [submitted, touched, values, errorOf]);

  // `set` keeps the same identity for the life of the form, so it is safe to use in effect dependency lists.
  const set = useCallback((name: K, value: string) => setValues((v) => ({ ...v, [name]: value })), []);

  return useMemo<Form<K>>(() => ({
    values,
    set,
    field: (name) => ({
      value: values[name], error: error(name),
      onChangeText: (t: string) => setValues((v) => ({ ...v, [name]: t })),
      onBlur: () => setTouched((t) => (t[name] ? t : { ...t, [name]: true })),
    }),
    error,
    submit: () => { setSubmitted(true); return (Object.keys(values) as K[]).every((k) => !errorOf(k, values, true)); },
    valid: (Object.keys(values) as K[]).every((k) => !errorOf(k, values, true)),
    reset: (next) => { setValues({ ...initialValues, ...next }); setTouched({}); setSubmitted(false); },
  }), [values, set, error, errorOf, initialValues]);
}
