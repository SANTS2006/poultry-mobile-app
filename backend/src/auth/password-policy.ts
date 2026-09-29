const COMMON = new Set([
  'password1234', '123456789012', 'qwertyuiop12', 'iloveyou1234', 'welcome12345', 'admin1234567',
  'letmein12345', 'password12345', 'changeme1234', 'makarifor123', 'makarifor1234',
]);

/** Returns a list of human-readable problems (empty = acceptable). NIST 800-63B style: length over composition. */
export function passwordProblems(password: string, context: { email?: string; fullName?: string } = {}): string[] {
  const problems: string[] = [];
  if (password.length < 12) problems.push('Password must be at least 12 characters long.');
  if (password.length > 128) problems.push('Password must be at most 128 characters long.');
  const lower = password.toLowerCase();
  if (COMMON.has(lower) || /^(.)\1+$/.test(password)) problems.push('Password is too common or too repetitive.');
  if (new Set(password).size < 5) problems.push('Password needs more variety of characters.');
  const local = context.email?.split('@')[0]?.toLowerCase();
  if (local && local.length >= 4 && lower.includes(local)) problems.push('Password must not contain your email name.');
  return problems;
}
