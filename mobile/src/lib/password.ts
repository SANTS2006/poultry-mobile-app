/**
 * Instant feedback that mirrors the server's password policy (backend/src/auth/password-policy.ts). The server is authoritative and
 * re-checks everything; this only saves a round trip.
 */
export function validatePassword(password: string, email?: string): string[] {
  const problems: string[] = [];
  if (password.length < 12) problems.push('Password must be at least 12 characters long.');
  if (password.length > 128) problems.push('Password must be at most 128 characters long.');
  if (password.length > 0 && (/^(.)\1+$/.test(password) || new Set(password).size < 5)) problems.push('Password needs more variety of characters.');
  const local = email?.split('@')[0]?.toLowerCase();
  if (local && local.length >= 4 && password.toLowerCase().includes(local)) problems.push('Password must not contain your email name.');
  return problems;
}
