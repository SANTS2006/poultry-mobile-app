/**
 * The temporary password in an invitation: the initials of the business name followed by the current year ("Makarifor Agriculture" in
 * 2026 → "MA2026"). A single-word name uses its first three letters. It is deliberately simple to read out; it is safe to use only
 * because it (a) works for a single purpose — choosing a real password — (b) expires, and (c) is rejected for everything else.
 */
export function temporaryPassword(businessName: string, year = new Date().getFullYear()): string {
  const words = businessName.normalize('NFKD').replace(/[^\p{L}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  const letters = words.length >= 2 ? words.map((w) => w[0]).join('') : (words[0] ?? 'PM').slice(0, 3);
  return `${letters.toUpperCase()}${year}`;
}

export const TEMP_PASSWORD_TTL_MS = 72 * 3600_000;
