import { execSync } from 'child_process';
import { PrismaClient } from '@prisma/client';

/** Resets the disposable test database and applies all migrations. Refuses to touch anything not named *_test. */
export default async function globalSetup(): Promise<void> {
  const url = process.env.DATABASE_URL ?? 'postgresql://postgres@localhost:5433/makarifor_test';
  const dbName = new URL(url).pathname.replace('/', '');
  if (!/_test$/.test(dbName)) {
    throw new Error(`Refusing to reset database "${dbName}": e2e tests require a database whose name ends in _test`);
  }
  process.env.DATABASE_URL = url;
  process.env.DIRECT_DATABASE_URL = process.env.DIRECT_DATABASE_URL ?? url;
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  await prisma.$executeRawUnsafe('DROP SCHEMA IF EXISTS public CASCADE');
  await prisma.$executeRawUnsafe('CREATE SCHEMA public');
  await prisma.$disconnect();
  execSync('npx prisma migrate deploy', { stdio: 'ignore', env: process.env });
}
