import { parseEnv } from './env';

const base = {
  APP_ENV: 'development',
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  DIRECT_DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  JWT_SECRET: 'a'.repeat(40),
  JWT_REFRESH_SECRET: 'b'.repeat(40),
  DATA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
};

describe('parseEnv', () => {
  it('accepts a valid development config and applies defaults', () => {
    const env = parseEnv(base);
    expect(env.PORT).toBe(3000);
    expect(env.CORS_ORIGINS).toEqual([]);
  });

  it('rejects short or identical JWT secrets', () => {
    expect(() => parseEnv({ ...base, JWT_SECRET: 'short' })).toThrow(/JWT_SECRET/);
    expect(() => parseEnv({ ...base, JWT_REFRESH_SECRET: base.JWT_SECRET })).toThrow(/must differ/);
  });

  it('rejects a malformed encryption key', () => {
    expect(() => parseEnv({ ...base, DATA_ENCRYPTION_KEY: 'abc' })).toThrow(/DATA_ENCRYPTION_KEY/);
  });

  it('requires TLS on database URLs in production', () => {
    expect(() => parseEnv({ ...base, APP_ENV: 'production' })).toThrow(/sslmode/);
    const ok = { ...base, APP_ENV: 'production', DATABASE_URL: `${base.DATABASE_URL}?sslmode=require`, DIRECT_DATABASE_URL: `${base.DIRECT_DATABASE_URL}?sslmode=require` };
    expect(parseEnv(ok).APP_ENV).toBe('production');
  });

  it('rejects placeholder secrets and wildcard CORS in production', () => {
    const prod = { ...base, APP_ENV: 'production', DATABASE_URL: `${base.DATABASE_URL}?sslmode=require`, DIRECT_DATABASE_URL: `${base.DIRECT_DATABASE_URL}?sslmode=require` };
    expect(() => parseEnv({ ...prod, JWT_SECRET: 'CHANGE_ME_'.padEnd(40, 'x') })).toThrow(/placeholder/);
    expect(() => parseEnv({ ...prod, CORS_ORIGINS: '*' })).toThrow(/wildcard/);
  });

  it('never echoes secret values in error messages', () => {
    const secret = 'super-secret-value';
    try {
      parseEnv({ ...base, JWT_SECRET: secret.slice(0, 5), DATABASE_URL: 'not-a-url' });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as Error).message).not.toContain('not-a-url');
      expect((e as Error).message).not.toContain(secret.slice(0, 5));
    }
  });

  it('parses comma-separated CORS origins', () => {
    expect(parseEnv({ ...base, CORS_ORIGINS: 'https://a.example, https://b.example' }).CORS_ORIGINS).toEqual([
      'https://a.example', 'https://b.example',
    ]);
  });
});
