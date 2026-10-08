const COMMON = new Set([
  'password1234', '123456789012', 'qwertyuiop12', 'iloveyou1234', 'welcome12345', 'admin1234567',
  'letmein12345', 'password12345', 'changeme1234', 'makarifor123', 'makarifor1234', 'qwertyuiopas', 'asdfghjklqwe', '1q2w3e4r5t6y', '1qaz2wsx3edc',
  'password!234', 'passw0rd1234', 'p@ssw0rd1234', 'welcome1234!', 'administrator', 'superadmin12', 'trustno1trustno1',
]);
/** Words that make a password guessable when they are most of it: "Poultry2026!", "Welcome12345", "Farm-Admin-1". */
const WEAK_WORDS = ['password', 'passw0rd', 'welcome', 'letmein', 'qwerty', 'admin', 'login', 'changeme', 'secret', 'poultry', 'chicken', 'eggs', 'farm', 'makarifor', 'abc123', 'iloveyou', 'monkey', 'dragon'];
const SEQUENCES = ['abcdefghijklmnopqrstuvwxyz', '01234567890123456789', 'qwertyuiopasdfghjklzxcvbnm', 'zyxwvutsrqponmlkjihgfedcba', '98765432109876543210'];

/** The password minus the digits, symbols and years people tack on the end ("farm-Admin-2026!" → "farmadmin"). */
const core = (p: string): string => p.toLowerCase().replace(/[^a-z]/g, '');
const hasSequence = (p: string): boolean => {
  const l = p.toLowerCase();
  return SEQUENCES.some((seq) => { for (let i = 0; i + 8 <= seq.length; i++) if (l.includes(seq.slice(i, i + 8))) return true; return false; });
};
/** "abcabcabcabc", "x1y2x1y2x1y2": a short chunk repeated to fill the length. */
const isRepeatedChunk = (p: string): boolean => { for (let n = 1; n <= p.length / 3; n++) { if (p.slice(0, n).repeat(Math.ceil(p.length / n)).slice(0, p.length) === p) return true; } return false; };

/** Returns a list of human-readable problems (empty = acceptable). NIST 800-63B style: length over composition. */
export function passwordProblems(password: string, context: { email?: string; fullName?: string; businessName?: string } = {}): string[] {
  const problems: string[] = [];
  if (password.length < 12) problems.push('Password must be at least 12 characters long.');
  if (password.length > 128) problems.push('Password must be at most 128 characters long.');
  const lower = password.toLowerCase();
  if (COMMON.has(lower) || /^(.)\1+$/.test(password)) problems.push('Password is too common or too repetitive.');
  if (new Set(password).size < 5) problems.push('Password needs more variety of characters.');
  const local = context.email?.split('@')[0]?.toLowerCase();
  if (local && local.length >= 4 && lower.includes(local)) problems.push('Password must not contain your email name.');
  const squashed = lower.replace(/[^a-z0-9]/g, '');
  const names = (context.fullName ?? '').toLowerCase().split(/\s+/).filter((n) => n.length >= 4);
  if (names.some((n) => squashed.includes(n.replace(/[^a-z]/g, '')))) problems.push('Password must not contain your name.');
  const biz = (context.businessName ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const bizWords = (context.businessName ?? '').toLowerCase().split(/\s+/).map((w) => w.replace(/[^a-z]/g, '')).filter((w) => w.length >= 6);
  if ((biz.length >= 5 && squashed.includes(biz)) || bizWords.some((w) => squashed.includes(w))) problems.push('Password must not contain the business name.');
  const stem = core(password);
  // Mostly made of common words ('Welcome-2026', 'farm-Admin-1', 'Password-Admin-1!'): strip them out and see what is left.
  const leftover = [...WEAK_WORDS].sort((x, y) => y.length - x.length).reduce((rest, w) => rest.split(w).join(''), stem);
  if (stem.length > 0 && leftover.length <= 3) problems.push('Password is built from common words. Use a few unrelated words instead.');
  if (hasSequence(password) || isRepeatedChunk(password)) problems.push('Password contains an obvious sequence or repeated pattern.');
  return problems;
}
