import { execSync } from 'child_process';
import { Controller, Get, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import request from 'supertest';
import { seedReferenceData } from '../prisma/seed';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { Public } from '../src/auth/decorators/public.decorator';
import { RequirePermissions } from '../src/auth/decorators/permissions.decorator';
import { hotp, base32Decode } from '../src/common/crypto/totp';
import { MailService } from '../src/mail/mail.service';

export const PASSWORD = 'tractor-ripple-lantern-92';

/** Routes used to prove authorization is deny-by-default and permission checks are real. */
@Controller('_probe')
export class ProbeController {
  @Public() @Get('open') open() { return { ok: true }; }
  @Get('undecorated') undecorated() { return { ok: true }; } // authenticated but no declaration ⇒ must be denied
  @RequirePermissions('sales.create') @Get('sales') sales() { return { ok: true }; }
  @RequirePermissions('production.create', 'sales.create') @Get('both') both() { return { ok: true }; }
}

export async function createApp(): Promise<{ app: INestApplication; mail: MailService; prisma: PrismaClient }> {
  const mod = await Test.createTestingModule({ imports: [AppModule], controllers: [ProbeController] }).compile();
  const app = mod.createNestApplication({ bufferLogs: true });
  configureApp(app);
  await app.init();
  return { app, mail: app.get(MailService), prisma: new PrismaClient() };
}

export async function seed(prisma: PrismaClient): Promise<void> {
  await seedReferenceData(prisma);
}

let counter = 0;
export const uniqueEmail = (p = 'user') => `${p}${Date.now()}${counter++}@example.com`;

export async function makeUser(
  prisma: PrismaClient,
  o: { email?: string; roles: string[]; password?: string; status?: 'ACTIVE' | 'DISABLED' | 'INVITED'; emailVerified?: boolean; fullName?: string },
) {
  const email = o.email ?? uniqueEmail();
  const roles = await prisma.role.findMany({ where: { code: { in: o.roles } } });
  const user = await prisma.user.create({
    data: {
      email, status: o.status ?? 'ACTIVE', emailVerified: o.emailVerified ?? true,
      passwordHash: await argon2.hash(o.password ?? PASSWORD, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 }),
      profile: { create: { fullName: o.fullName ?? 'Test User' } },
      roles: { create: roles.map((r) => ({ roleId: r.id })) },
    },
  });
  return { ...user, email, password: o.password ?? PASSWORD };
}

export const api = (app: INestApplication) => request(app.getHttpServer());

export function login(app: INestApplication, email: string, password = PASSWORD, headers: Record<string, string> = {}) {
  return api(app).post('/v1/auth/login').set(headers).send({ email, password });
}

/** Logs in a user that needs no MFA and returns tokens. */
export async function signIn(app: INestApplication, email: string, password = PASSWORD, headers: Record<string, string> = {}) {
  const res = await login(app, email, password, headers).expect(200);
  if (res.body.status !== 'authenticated') throw new Error(`expected authenticated, got ${res.body.status}`);
  return { accessToken: res.body.tokens.accessToken as string, refreshToken: res.body.tokens.refreshToken as string, body: res.body };
}

export const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

/** TOTP code for the given base32 secret at time `atMs`. */
export const totpAt = (secretB32: string, atMs: number): string => hotp(base32Decode(secretB32), Math.floor(atMs / 1000 / 30));

/**
 * Gives a test file its own PostgreSQL schema inside the *_test database (fresh migrations applied), so suites that need a
 * pristine "single farm" world cannot be disturbed by data other suites leave behind. Call BEFORE createApp().
 */
export async function useIsolatedSchema(name: string): Promise<void> {
  const base = new URL(process.env.DATABASE_URL as string);
  if (!/_test$/.test(base.pathname.replace('/', ''))) throw new Error('Refusing to use a schema outside a *_test database');
  base.searchParams.set('schema', name);
  const admin = new PrismaClient();
  await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
  await admin.$executeRawUnsafe(`CREATE SCHEMA "${name}"`);
  await admin.$disconnect();
  process.env.DATABASE_URL = base.toString();
  process.env.DIRECT_DATABASE_URL = base.toString();
  execSync('npx prisma migrate deploy', { stdio: 'ignore', env: process.env });
}
