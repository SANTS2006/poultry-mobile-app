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
  app.enableShutdownHooks(); // SIGTERM: stop accepting requests, let in-flight ones finish, close the database pool and sockets
  await app.listen(port, '0.0.0.0');
  // Slow or stalled clients cannot hold connections forever.
  const server = app.getHttpServer() as import('http').Server;
  server.requestTimeout = 120_000; server.headersTimeout = 30_000; server.keepAliveTimeout = 65_000;
}

bootstrap().catch((err: unknown) => {
  // Config errors list variable names only (never values) — safe to print before the logger exists.
  process.stderr.write(`Failed to start: ${err instanceof Error ? err.message : 'unknown error'}\n`);
  process.exit(1);
});
