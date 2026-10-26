/**
 * Instant feedback that mirrors the server's password policy (backend/src/auth/password-policy.ts). The server is authoritative and
 * re-checks everything (including your name and the business name, which the phone does not know); this only saves a round trip and shows
 * people what is expected while they type.
 */
const COMMON = new Set([
  'password1234', '123456789012', 'qwertyuiop12', 'iloveyou1234', 'welcome12345', 'admin1234567', 'letmein12345', 'password12345', 'changeme1234',
  'makarifor123', 'makarifor1234', 'qwertyuiopas', 'asdfghjklqwe', '1q2w3e4r5t6y', '1qaz2wsx3edc', 'password!234', 'passw0rd1234', 'p@ssw0rd1234',
  'welcome1234!', 'administrator', 'superadmin12', 'trustno1trustno1',
]);
const WEAK_WORDS = ['password', 'passw0rd', 'welcome', 'letmein', 'qwerty', 'admin', 'login', 'changeme', 'secret', 'poultry', 'chicken', 'eggs', 'farm', 'makarifor', 'abc123', 'iloveyou', 'monkey', 'dragon'];
const SEQUENCES = ['abcdefghijklmnopqrstuvwxyz', '01234567890123456789', 'qwertyuiopasdfghjklzxcvbnm', 'zyxwvutsrqponmlkjihgfedcba', '98765432109876543210'];

const core = (p: string): string => p.toLowerCase().replace(/[^a-z]/g, '');
const hasSequence = (p: string): boolean => {
  const l = p.toLowerCase();
  return SEQUENCES.some((seq) => { for (let i = 0; i + 8 <= seq.length; i++) if (l.includes(seq.slice(i, i + 8))) return true; return false; });
};
const isRepeatedChunk = (p: string): boolean => { for (let n = 1; n <= p.length / 3; n++) { if (p.slice(0, n).repeat(Math.ceil(p.length / n)).slice(0, p.length) === p) return true; } return false; };
const builtFromCommonWords = (p: string): boolean => {
  const stem = core(p);
  const leftover = [...WEAK_WORDS].sort((x, y) => y.length - x.length).reduce((rest, w) => rest.split(w).join(''), stem);
  return COMMON.has(p.toLowerCase()) || (stem.length > 0 && leftover.length <= 3);
};

export interface PasswordRule {
  id: 'length' | 'variety' | 'email' | 'pattern' | 'words';
  /** shown to the person as a requirement */
  label: string;
  /** a small example or explanation under the label */
  hint?: string;
  ok: boolean;
  /** the sentence used when this rule is broken (same wording as the server) */
  problem: string;
}

/** Every rule that can be checked on the phone, in the order they are shown. `email` is only listed when the address is known. */
export function passwordRules(password: string, email?: string): PasswordRule[] {
  const rules: PasswordRule[] = [
    {
      id: 'length', label: '12 to 128 characters', hint: 'Longer is stronger. A few unrelated words work well.',
      ok: password.length >= 12 && password.length <= 128,
      problem: password.length > 128 ? 'Password must be at most 128 characters long.' : 'Password must be at least 12 characters long.',
    },
    { id: 'variety', label: 'At least 5 different characters', hint: 'Not just one letter or a few characters repeated.', ok: password.length > 0 && !/^(.)\1+$/.test(password) && new Set(password).size >= 5, problem: 'Password needs more variety of characters.' },
  ];
  const local = email?.split('@')[0]?.toLowerCase();
  if (local && local.length >= 4) rules.push({ id: 'email', label: 'Does not contain your email name', hint: `Avoid “${local}”.`, ok: !password.toLowerCase().includes(local), problem: 'Password must not contain your email name.' });
  rules.push(
    { id: 'pattern', label: 'No obvious sequence or repeated pattern', hint: 'Such as abcdefgh, 12345678, qwertyui or abcabcabc.', ok: password.length > 0 && !hasSequence(password) && !isRepeatedChunk(password), problem: 'Password contains an obvious sequence or repeated pattern.' },
    { id: 'words', label: 'Not a common password or made only of common words', hint: 'Such as password, welcome, admin, farm or poultry (with numbers added).', ok: password.length > 0 && !builtFromCommonWords(password), problem: 'Password is too common or built from common words. Use a few unrelated words instead.' },
  );
  return rules;
}

/** The sentences for every broken rule (empty = acceptable on the phone). */
export function validatePassword(password: string, email?: string): string[] {
  if (password.length === 0) return ['Password must be at least 12 characters long.'];
  return passwordRules(password, email).filter((r) => !r.ok).map((r) => r.problem);
}

export type Strength = { level: 0 | 1 | 2 | 3 | 4; label: string };
/** 0 = nothing typed or rules not met yet, then Good, Strong, Excellent as the password gets longer. */
export function passwordStrength(password: string, email?: string): Strength {
  if (!password) return { level: 0, label: 'Start typing' };
  if (passwordRules(password, email).some((r) => !r.ok)) return { level: 1, label: 'Not valid yet' };
  if (password.length < 16) return { level: 2, label: 'Good' };
  if (password.length < 20) return { level: 3, label: 'Strong' };
  return { level: 4, label: 'Excellent' };
}
