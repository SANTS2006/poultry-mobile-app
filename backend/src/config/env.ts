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
    EMAIL_HOST: z.string().default(''),
    EMAIL_PORT: z.coerce.number().int().default(587),
    EMAIL_USER: z.string().default(''),
    EMAIL_PASSWORD: z.string().default(''),
    EMAIL_FROM: z.string().default(''),
    PUSH_NOTIFICATION_CONFIG: z.string().default(''), // optional Expo access token (needed if Expo "enhanced push security" is on)
    PUSH_PROVIDER: z.enum(['expo', 'none']).optional(), // default: expo in staging/production, none elsewhere (never push from dev/test by accident)
    THROTTLE_OFF: z.enum(['0', '1']).optional(),
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
      if (!env.EMAIL_HOST) {
        ctx.addIssue({ code: 'custom', path: ['EMAIL_HOST'], message: 'required (email verification/reset cannot work without it)' });
      }
      if (env.CORS_ORIGINS.includes('*')) {
        ctx.addIssue({ code: 'custom', path: ['CORS_ORIGINS'], message: 'wildcard origin not allowed' });
      }
    }
  });

export type Env = z.infer<typeof schema>;

/** Validates process.env. Error messages name variables but never echo values (secrets). */
export function parseEnv(raw: Record<string, unknown>): Env {
  const result = schema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  return result.data;
}
