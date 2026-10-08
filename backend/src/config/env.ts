import { z } from 'zod';

const isPlaceholder = (v: string) => /change_?me/i.test(v);

const schema = z
  .object({
    APP_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    DATABASE_URL: z.string().url().startsWith('postgres'),
    DIRECT_DATABASE_URL: z.string().url().startsWith('postgres'),
    JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
    JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
    DATA_ENCRYPTION_KEY: z.string().refine((v) => Buffer.from(v, 'base64').length === 32, {
      message: 'DATA_ENCRYPTION_KEY must be 32 bytes, base64-encoded',
    }),
    CORS_ORIGINS: z
      .string()
      .default('')
      .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean)),
    APP_LINK_BASE: z.string().default('makarifor://'),
    /** Brevo (https://www.brevo.com) transactional e-mail. Without a key, development/test capture messages in memory instead of sending. */
    BREVO_API_KEY: z.string().default(''),
    /** Sender address; it must be a verified sender in Brevo. */
    EMAIL_FROM: z.string().default(''),
    EMAIL_FROM_NAME: z.string().default('Makarifor Poultry'),
    PUSH_NOTIFICATION_CONFIG: z.string().default(''), // optional Expo access token (needed if Expo "enhanced push security" is on)
    PUSH_PROVIDER: z.enum(['expo', 'none']).optional(), // default: expo in staging/production, none elsewhere (never push from dev/test by accident)
    THROTTLE_OFF: z.enum(['0', '1']).optional(),
    /** Seconds between keep-alive queries that stop a serverless database (Neon) from going to sleep. 0 = off. Default: 240 in staging/production, off elsewhere. */
    DB_KEEPALIVE_SECONDS: z.coerce.number().int().min(0).max(3600).optional(),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  })
  .superRefine((env, ctx) => {
    if (env.JWT_SECRET === env.JWT_REFRESH_SECRET) {
      ctx.addIssue({ code: 'custom', path: ['JWT_REFRESH_SECRET'], message: 'must differ from JWT_SECRET' });
    }
    // Staging/production must never boot with placeholder secrets or unencrypted DB connections.
    if (env.APP_ENV === 'staging' || env.APP_ENV === 'production') {
      for (const k of ['JWT_SECRET', 'JWT_REFRESH_SECRET', 'DATA_ENCRYPTION_KEY', 'DATABASE_URL', 'DIRECT_DATABASE_URL'] as const) {
        if (isPlaceholder(env[k])) ctx.addIssue({ code: 'custom', path: [k], message: 'placeholder value not allowed' });
      }
      for (const k of ['DATABASE_URL', 'DIRECT_DATABASE_URL'] as const) {
        if (!/sslmode=(require|verify-full|verify-ca)/.test(env[k])) {
          ctx.addIssue({ code: 'custom', path: [k], message: 'must include sslmode=require (TLS is mandatory)' });
        }
      }
      if (env.THROTTLE_OFF === '1') {
        ctx.addIssue({ code: 'custom', path: ['THROTTLE_OFF'], message: 'rate limiting cannot be disabled in staging/production' });
      }
      if (!env.BREVO_API_KEY) {
        ctx.addIssue({ code: 'custom', path: ['BREVO_API_KEY'], message: 'required (invitations, password resets and verification cannot work without it)' });
      }
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(env.EMAIL_FROM)) {
        ctx.addIssue({ code: 'custom', path: ['EMAIL_FROM'], message: 'required: a sender e-mail address verified in Brevo' });
      }
      if (env.CORS_ORIGINS.includes('*')) {
        ctx.addIssue({ code: 'custom', path: ['CORS_ORIGINS'], message: 'wildcard origin not allowed' });
      }
    }
  });

export type Env = z.infer<typeof schema>;

/** Validates process.env. Error messages name variables but never echo values (secrets). */
export function parseEnv(raw: Record<string, unknown>): Env {
  // A blank line in .env ("PUSH_PROVIDER=") means "not set", not an invalid empty value.
  const cleaned = { ...raw };
  for (const k of ['PUSH_PROVIDER', 'THROTTLE_OFF', 'DB_KEEPALIVE_SECONDS']) if (cleaned[k] === '') delete cleaned[k];
  const result = schema.safeParse(cleaned);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  return result.data;
}
