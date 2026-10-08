/* DEVELOPMENT ONLY. Creates demo users with a KNOWN password plus a farm, coops, prices, customers and opening stock so the app can be tried at once.
     npm run demo:data              (idempotent)
     npm run demo:data -- --no-mfa  also switches off the mandatory-MFA flag on roles (local convenience; never do this in a real environment)
     npm run demo:data -- --allow-remote   permit a NON-local database (e.g. a throwaway Neon project/branch used for testing)
   Always requires APP_ENV=development. Without --allow-remote the database host must also be local. Never point this at real business data:
   it creates accounts with a publicly known password. */
import * as argon2 from 'argon2';
import { Prisma, PrismaClient } from '@prisma/client';

export const DEMO_PASSWORD = 'demo-password-tractor-2026';
const USERS = [
  { email: 'superadmin@demo.local', name: 'Demo Super Admin', role: 'SUPER_ADMIN' },
  { email: 'owner@demo.local', name: 'Demo Owner', role: 'OWNER' },
  { email: 'manager@demo.local', name: 'Demo Manager', role: 'FARM_MANAGER' },
  { email: 'production@demo.local', name: 'Demo Production Staff', role: 'PRODUCTION_STAFF' },
  { email: 'sales@demo.local', name: 'Demo Sales Staff', role: 'SALES_STAFF' },
  { email: 'accountant@demo.local', name: 'Demo Accountant', role: 'ACCOUNTANT' },
];

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? '';
  const host = (() => { try { return new URL(url).hostname; } catch { return ''; } })();
  const local = ['localhost', '127.0.0.1', 'db', '::1'].includes(host);
  const allowRemote = process.argv.includes('--allow-remote');
  if (process.env.APP_ENV !== 'development') throw new Error('Refusing to run: demo data needs APP_ENV=development (set it in .env).');
  if (!local && !allowRemote) {
    throw new Error(`Refusing to run: the database host "${host}" is not local. If this is a throwaway test database, repeat with:  npm run demo:data -- --no-mfa --allow-remote`);
  }
  if (!local) process.stdout.write(`WARNING: creating demo accounts with a known password on remote database "${host}". Delete them before real use.\n`);
  const prisma = new PrismaClient();
  try {
    if ((await prisma.role.count()) === 0) throw new Error('Run `npm run db:seed` first.');
    if (process.argv.includes('--no-mfa')) await prisma.role.updateMany({ data: { mfaRequired: false } });

    const hash = await argon2.hash(DEMO_PASSWORD, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
    for (const u of USERS) {
      const role = await prisma.role.findUniqueOrThrow({ where: { code: u.role } });
      const existing = await prisma.user.findUnique({ where: { email: u.email } });
      if (existing) continue;
      await prisma.user.create({
        data: { email: u.email, passwordHash: hash, status: 'ACTIVE', emailVerified: true, profile: { create: { fullName: u.name } }, roles: { create: [{ roleId: role.id }] } },
      });
    }

    const farm = (await prisma.farm.findFirst()) ?? (await prisma.farm.create({ data: { name: 'Demo Farm' } }));
    for (const name of ['Coop 1', 'Coop 2']) {
      if (!(await prisma.coop.findFirst({ where: { farmId: farm.id, name } }))) await prisma.coop.create({ data: { farmId: farm.id, name } });
    }
    for (const [code, amount] of [['CARTON', '1550.00'], ['CRATE', '129.17'], ['EGG', '4.31']] as const) {
      const unit = await prisma.productUnit.findFirstOrThrow({ where: { code } });
      if (!(await prisma.price.findFirst({ where: { productUnitId: unit.id } }))) {
        await prisma.price.create({ data: { productUnitId: unit.id, amount: new Prisma.Decimal(amount), effectiveFrom: new Date('2026-01-01T00:00:00Z'), reason: 'demo data' } });
      }
    }
    await prisma.systemSetting.update({ where: { key: 'sales.creditEnabled' }, data: { value: true } });
    if (!(await prisma.customer.findFirst({ where: { name: 'Mama Kadi' } }))) {
      await prisma.customer.create({ data: { name: 'Mama Kadi', phone: '+23276000001', type: 'REGULAR', creditAllowed: true, creditLimit: new Prisma.Decimal('5000') } });
      await prisma.customer.create({ data: { name: 'Alhaji Bah', phone: '+23276000002', type: 'WHOLESALE' } });
    }
    const egg = await prisma.productUnit.findFirstOrThrow({ where: { code: 'EGG' } });
    if ((await prisma.inventoryTransaction.count({ where: { farmId: farm.id } })) === 0) {
      await prisma.inventoryBalance.upsert({
        where: { farmId_productId: { farmId: farm.id, productId: egg.productId } }, update: { quantityEggs: 5000 }, create: { farmId: farm.id, productId: egg.productId, quantityEggs: 5000 },
      });
      await prisma.inventoryTransaction.create({ data: { farmId: farm.id, productId: egg.productId, type: 'OPENING', quantityEggs: 5000, occurredAt: new Date(), reason: 'demo opening stock' } });
    }
    process.stdout.write(`Demo data ready. Password for all demo users: ${DEMO_PASSWORD}\n${USERS.map((u) => `  ${u.email}  (${u.role})`).join('\n')}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e: unknown) => { process.stderr.write(`${e instanceof Error ? e.message : 'failed'}\n`); process.exit(1); });
