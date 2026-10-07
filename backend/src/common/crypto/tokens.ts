import { createHash, randomBytes, timingSafeEqual } from 'crypto';

/** URL-safe random secret (default 256 bits). */
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');

/** SHA-256 hex. Only for high-entropy random tokens (refresh/email tokens, recovery codes) — never passwords. */
export const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Recovery code like "k3f9-a82d-77qz" (~60 bits of entropy from a 32-symbol alphabet). */
export function generateRecoveryCode(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'; // no look-alikes; 31 symbols
  const bytes = randomBytes(12);
  let out = '';
  for (let i = 0; i < 12; i++) {
    out += alphabet[bytes[i] % alphabet.length];
    if (i % 4 === 3 && i < 11) out += '-';
  }
  return out;
}

export const normalizeRecoveryCode = (code: string): string => code.trim().toLowerCase();
