import { randomUUID } from 'crypto';
import type { Params } from 'nestjs-pino';
import type { Env } from '../../config/env';

// Never log credentials, tokens or secrets — redacted at every nesting level we use.
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'req.body.password',
  'req.body.currentPassword',
  'req.body.newPassword',
  'req.body.refreshToken',
  'req.body.token',
  'req.body.code',
  'req.body.mfaCode',
  'req.body.recoveryCode',
  '*.password',
  '*.passwordHash',
  '*.refreshToken',
  '*.accessToken',
  '*.secret',
  '*.DATABASE_URL',
  '*.DIRECT_DATABASE_URL',
];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function loggerParams(env: Pick<Env, 'APP_ENV' | 'LOG_LEVEL'>): Params {
  return {
    pinoHttp: {
      level: env.LOG_LEVEL,
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
      genReqId: (req, res) => {
        const incoming = req.headers['x-request-id'];
        const id = typeof incoming === 'string' && UUID_RE.test(incoming) ? incoming : randomUUID();
        res.setHeader('X-Request-Id', id);
        return id;
      },
      // Log method/url/status only — no bodies, no query strings with potential secrets.
      serializers: {
        req: (req) => ({ id: req.id, method: req.method, url: String(req.url).split('?')[0] }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
      autoLogging: { ignore: (req) => String(req.url).startsWith('/health') },
      transport:
        env.APP_ENV === 'development' ? { target: 'pino-pretty', options: { singleLine: true } } : undefined,
    },
  };
}
