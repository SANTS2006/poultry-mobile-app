import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import type { Env } from './config/env';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  configureApp(app);
  const port = app.get<ConfigService<Env, true>>(ConfigService).get('PORT', { infer: true });
  await app.listen(port, '0.0.0.0');
}

bootstrap().catch((err: unknown) => {
  // Config errors list variable names only (never values) — safe to print before the logger exists.
  process.stderr.write(`Failed to start: ${err instanceof Error ? err.message : 'unknown error'}\n`);
  process.exit(1);
});
