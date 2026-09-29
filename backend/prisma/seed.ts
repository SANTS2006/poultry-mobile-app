/* Idempotent reference-data seed: permissions, roles, shifts, product + units, expense categories, settings.
   Does NOT create users, prices, farms or coops: those come from the migration/admin so nothing is invented. */
import { PrismaClient } from '@prisma/client';
import { DEFAULT_SETTINGS, EGG_UNITS, EXPENSE_CATEGORIES, PERMISSIONS, ROLES, SHIFTS } from '../src/common/permissions';

export async function seedReferenceData(prisma: PrismaClient): Promise<void> {
  for (const code of PERMISSIONS) {
    await prisma.permission.upsert({ where: { code }, update: {}, create: { code } });
  }
  const perms = await prisma.permission.findMany();
  const permId = new Map(perms.map((p) => [p.code, p.id]));

  for (const r of ROLES) {
    const role = await prisma.role.upsert({
      where: { code: r.code },
      update: { name: r.name, description: r.description },
      create: { code: r.code, name: r.name, description: r.description, isSystem: true, mfaRequired: r.mfaRequired },
    });
    await prisma.rolePermission.createMany({
      data: r.permissions.map((p) => ({ roleId: role.id, permissionId: permId.get(p) as string })),
      skipDuplicates: true,
    });
  }
  for (const s of SHIFTS) await prisma.shift.upsert({ where: { code: s.code }, update: {}, create: { ...s } });
  for (const [i, c] of EXPENSE_CATEGORIES.entries()) {
    await prisma.expenseCategory.upsert({ where: { code: c.code }, update: {}, create: { ...c, sortOrder: i } });
  }
  const product = await prisma.product.upsert({
    where: { code: 'TABLE_EGG' }, update: {}, create: { code: 'TABLE_EGG', name: 'Table Egg' },
  });
  for (const u of EGG_UNITS) {
    await prisma.productUnit.upsert({
      where: { productId_code: { productId: product.id, code: u.code } },
      update: {}, create: { productId: product.id, ...u },
    });
  }
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await prisma.systemSetting.upsert({ where: { key }, update: {}, create: { key, value: value as never } });
  }
}

if (require.main === module) {
  const prisma = new PrismaClient();
  seedReferenceData(prisma)
    .then(() => prisma.$disconnect())
    .catch(async (e: unknown) => {
      process.stderr.write(`Seed failed: ${e instanceof Error ? e.message : 'unknown'}\n`);
      await prisma.$disconnect();
      process.exit(1);
    });
}
