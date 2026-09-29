/* One-time creation of the first Super Admin. Run by an operator with database access:
     npm run bootstrap:admin -- --email owner@example.com --name "Full Name" [--print-link]
   The admin receives an invitation email to set their own password (nobody ever types a password into this script).
   Refuses to run if a Super Admin already exists — use the normal invite flow afterwards. */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { EmailTokenService } from '../src/auth/email-token.service';
import { AuditService } from '../src/audit/audit.service';
import { PrismaService } from '../src/prisma/prisma.service';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const email = arg('email')?.trim().toLowerCase();
  const name = arg('name')?.trim();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !name) {
    throw new Error('Usage: bootstrap-admin --email <email> --name "<full name>" [--print-link]');
  }
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const prisma = app.get(PrismaService);
  const role = await prisma.role.findUnique({ where: { code: 'SUPER_ADMIN' } });
  if (!role) throw new Error('Roles are not seeded. Run `npm run db:seed` first.');
  if ((await prisma.userRole.count({ where: { roleId: role.id } })) > 0) {
    throw new Error('A Super Admin already exists. Use the invitation flow (POST /v1/users/invite).');
  }
  const emailTokens = app.get(EmailTokenService);
  const audit = app.get(AuditService);
  const user = await prisma.user.create({
    data: { email, status: 'INVITED', profile: { create: { fullName: name } }, roles: { create: [{ roleId: role.id }] } },
  });
  const token = await emailTokens.issue(user.id, 'INVITE');
  await audit.record({ action: 'user.bootstrap_super_admin', entityType: 'user', entityId: user.id, after: { email } });
  await emailTokens.sendLink(email, 'INVITE', token);
  process.stdout.write(`Super Admin invited: ${email}\n`);
  if (process.argv.includes('--print-link')) {
    process.stdout.write(`One-time invitation token (treat as a password; expires in 72h):\n${token}\n`);
  }
  await app.close();
}

main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? e.message : 'failed'}\n`);
  process.exit(1);
});
