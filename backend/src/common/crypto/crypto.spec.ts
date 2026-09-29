import { ConfigService } from '@nestjs/config';
import { EncryptionService } from './encryption.service';
import { PasswordService } from './password.service';
import { generateRecoveryCode, normalizeRecoveryCode, randomToken, safeEqual, sha256 } from './tokens';
import { base32Decode, base32Encode, hotp, verifyTotp } from './totp';
import { passwordProblems } from '../../auth/password-policy';
import { scrub } from '../../audit/audit.service';

describe('TOTP (RFC 6238 / RFC 4226)', () => {
  const secret = Buffer.from('12345678901234567890'); // RFC test seed

  it('matches the RFC 4226 Appendix D HOTP vectors', () => {
    const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
    expected.forEach((code, counter) => expect(hotp(secret, counter)).toBe(code));
  });

  it('matches the RFC 6238 Appendix B vector (T=59s → 94287082, last 6 digits 287082)', () => {
    expect(hotp(secret, Math.floor(59 / 30))).toBe('287082');
    expect(verifyTotp(base32Encode(secret), '287082', 59_000)).toBe(1);
  });

  it('accepts ±1 step of drift but not more, and rejects malformed input', () => {
    const b32 = base32Encode(secret);
    const now = 1_700_000_000_000;
    const step = Math.floor(now / 1000 / 30);
    expect(verifyTotp(b32, hotp(secret, step - 1), now)).toBe(step - 1);
    expect(verifyTotp(b32, hotp(secret, step + 1), now)).toBe(step + 1);
    expect(verifyTotp(b32, hotp(secret, step + 2), now)).toBeNull();
    expect(verifyTotp(b32, 'abc123', now)).toBeNull();
    expect(verifyTotp(b32, '12345', now)).toBeNull();
  });

  it('round-trips base32', () => {
    const buf = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255, 9, 8, 7]);
    expect(base32Decode(base32Encode(buf))).toEqual(buf);
  });
});

describe('tokens & recovery codes', () => {
  it('generates unique url-safe tokens and stable hashes', () => {
    const a = randomToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(a);
    expect(sha256('x')).toBe(sha256('x'));
  });
  it('generates well-formed, distinct recovery codes and normalises case', () => {
    const codes = new Set(Array.from({ length: 200 }, generateRecoveryCode));
    expect(codes.size).toBe(200);
    for (const c of codes) expect(c).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
    expect(normalizeRecoveryCode(' ABCD-EFGH-JKMN ')).toBe('abcd-efgh-jkmn');
  });
  it('safeEqual compares correctly', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('PasswordService (Argon2id)', () => {
  const svc = new PasswordService();
  it('hashes with argon2id, verifies, and never stores plaintext', async () => {
    const h = await svc.hash('correct horse battery staple');
    expect(h.startsWith('$argon2id$')).toBe(true);
    expect(h).not.toContain('correct horse');
    expect(await svc.verify(h, 'correct horse battery staple')).toBe(true);
    expect(await svc.verify(h, 'wrong')).toBe(false);
    expect(await svc.verify(undefined, 'anything')).toBe(false); // unknown user path
  });
  it('salts: same password yields different hashes', async () => {
    expect(await svc.hash('same-password-123')).not.toBe(await svc.hash('same-password-123'));
  });
});

describe('EncryptionService (AES-256-GCM)', () => {
  const svc = new EncryptionService({ get: () => Buffer.alloc(32, 9).toString('base64') } as unknown as ConfigService<never, true>);
  it('round-trips and detects tampering', () => {
    const c = svc.encrypt('JBSWY3DPEHPK3PXP');
    expect(c).not.toContain('JBSWY3DP');
    expect(svc.decrypt(c)).toBe('JBSWY3DPEHPK3PXP');
    const parts = c.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => svc.decrypt(parts.join('.'))).toThrow();
  });
  it('uses a fresh IV each time', () => {
    expect(svc.encrypt('x')).not.toBe(svc.encrypt('x'));
  });
});

describe('password policy', () => {
  it('accepts a long passphrase', () => expect(passwordProblems('tractor-ripple-lantern-92')).toEqual([]));
  it('rejects short, common, repetitive and email-derived passwords', () => {
    expect(passwordProblems('short').length).toBeGreaterThan(0);
    expect(passwordProblems('password12345').length).toBeGreaterThan(0);
    expect(passwordProblems('aaaaaaaaaaaaaa').length).toBeGreaterThan(0);
    expect(passwordProblems('johnsmith-2026-xyz', { email: 'johnsmith@x.com' }).length).toBeGreaterThan(0);
  });
  it('rejects over-long input (hash-DoS guard)', () => expect(passwordProblems('a1'.repeat(70)).length).toBeGreaterThan(0));
});

describe('audit scrubbing', () => {
  it('redacts credential-like fields at any depth', () => {
    const out = scrub({ email: 'a@b.c', password: 'x', nested: { refreshToken: 'y', ok: 1, list: [{ secret: 'z', n: 2 }] } });
    expect(JSON.stringify(out)).not.toMatch(/"x"|"y"|"z"/);
    expect(out).toMatchObject({ email: 'a@b.c', nested: { ok: 1 } });
  });
});
