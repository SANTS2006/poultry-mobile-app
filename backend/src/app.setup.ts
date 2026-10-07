import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import compression from 'compression';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import type { Env } from './config/env';
import { SecureIoAdapter } from './realtime/io.adapter';

/** Shared by main.ts and the e2e tests so tests exercise the real security configuration. */
export function configureApp(app: INestApplication): void {
  const express = app as NestExpressApplication;
  const config = app.get<ConfigService<Env, true>>(ConfigService);

  express.disable('x-powered-by');
  express.set('trust proxy', 1); // behind a single TLS-terminating proxy (Render/Fly/etc.); adjust per host
  express.useLogger(app.get(Logger));
  express.useBodyParser('json', { limit: '256kb' });

  app.use(
    helmet({
      // API-only service: lock down everything, allow nothing to be framed or sniffed.
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      referrerPolicy: { policy: 'no-referrer' },
      hsts: { maxAge: 31_536_000, includeSubDomains: true },
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );
  app.use(compression());
  app.use((_req: unknown, res: { setHeader(k: string, v: string): void }, next: () => void) => {
    res.setHeader('Cache-Control', 'no-store'); // API responses contain business/financial data
    next();
  });

  app.enableCors({
    origin: config.get('CORS_ORIGINS', { infer: true }), // [] => no cross-origin browser access; native apps unaffected
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Request-Id', 'Idempotency-Key'],
    maxAge: 600,
  });

  app.useWebSocketAdapter(new SecureIoAdapter(app, config.get('CORS_ORIGINS', { infer: true })));
  app.setGlobalPrefix('v1', { exclude: ['health/live', 'health/ready'] });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // strip unknown properties …
      forbidNonWhitelisted: true, // … and reject them (mass-assignment protection)
      transform: true,
      transformOptions: { enableImplicitConversion: false },
      stopAtFirstError: true,
    }),
  );
  app.enableShutdownHooks();
}

