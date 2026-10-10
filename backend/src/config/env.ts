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
    /**
     * Backups go ONLY to Cloudflare R2 (never to the API server's disk apart from a short-lived temporary file that is deleted straight away).
     * BACKUP_ENCRYPTION_KEY (32 bytes, base64) must differ from DATA_ENCRYPTION_KEY and be stored somewhere other than the backups.
     * RECOVERY_ADMIN_DATABASE_URL is a server where scratch/recovery databases may be created (never the production database itself).
     */
    BACKUP_ENABLED: z.enum(['0', '1']).optional(),
    BACKUP_ENCRYPTION_KEY: z.string().default(''),
    BACKUP_R2_ACCOUNT_ID: z.string().default(''),
    BACKUP_R2_BUCKET: z.string().default(''),
    BACKUP_R2_ACCESS_KEY_ID: z.string().default(''),
    BACKUP_R2_SECRET_ACCESS_KEY: z.string().default(''),
    /** Only for a bucket in a jurisdiction such as the EU ("https://<account>.eu.r2.cloudflarestorage.com"); otherwise derived from the account id. */
    BACKUP_R2_ENDPOINT: z.string().default(''),
    BACKUP_R2_PREFIX: z.string().default('makarifor/'),
    BACKUP_PG_BIN_DIR: z.string().default(''),
    BACKUP_ALERT_EMAILS: z.string().default('').transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean)),
    BACKUP_STALE_HOURS: z.coerce.number().int().min(2).max(240).default(26),
    RECOVERY_ADMIN_DATABASE_URL: z.string().default(''),
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
      // A missing key does not stop the API from starting (that would turn a deploy into an outage); backups simply stay off and the
      // Backups screen shows a warning. A key that IS set must be valid and separate from the data key.
      if (env.BACKUP_ENABLED !== '0') {
        if (env.BACKUP_ENCRYPTION_KEY && Buffer.from(env.BACKUP_ENCRYPTION_KEY, 'base64').length !== 32) ctx.addIssue({ code: 'custom', path: ['BACKUP_ENCRYPTION_KEY'], message: 'must be 32 bytes, base64-encoded' });
        else if (env.BACKUP_ENCRYPTION_KEY && env.BACKUP_ENCRYPTION_KEY === env.DATA_ENCRYPTION_KEY) ctx.addIssue({ code: 'custom', path: ['BACKUP_ENCRYPTION_KEY'], message: 'must differ from DATA_ENCRYPTION_KEY' });
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
  for (const k of ['PUSH_PROVIDER', 'THROTTLE_OFF', 'DB_KEEPALIVE_SECONDS', 'BACKUP_ENABLED', 'BACKUP_STALE_HOURS', 'BACKUP_R2_PREFIX']) if (cleaned[k] === '') delete cleaned[k];
  const result = schema.safeParse(cleaned);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  return result.data;
}
