/* One-time creation of the first Super Admin. Run by an operator with database access:
     npm run bootstrap:admin -- --email owner@example.com --name "Full Name" [--print-password]
   The admin receives an invitation email with a temporary password (initials of the business name + year) and must choose their own
   password at first sign-in (nobody ever types a password into this script).
   Refuses to run if a Super Admin already exists — use the normal invite flow afterwards. */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { AuditService } from '../src/audit/audit.service';
import { PasswordService } from '../src/common/crypto/password.service';
import { MailComposer } from '../src/mail/mail-composer.service';
import { UsersService } from '../src/users/users.service';
import { TEMP_PASSWORD_TTL_MS, temporaryPassword } from '../src/users/temp-password';
import { PrismaService } from '../src/prisma/prisma.service';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const email = arg('email')?.trim().toLowerCase();
  const name = arg('name')?.trim();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !name) {
    throw new Error('Usage: bootstrap-admin --email <email> --name "<full name>" [--print-password]');
  }
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const prisma = app.get(PrismaService);
  const role = await prisma.role.findUnique({ where: { code: 'SUPER_ADMIN' } });
  if (!role) throw new Error('Roles are not seeded. Run `npm run db:seed` first.');
  if ((await prisma.userRole.count({ where: { roleId: role.id } })) > 0) {
    throw new Error('A Super Admin already exists. Use the invitation flow (POST /v1/users/invite).');
  }
  const audit = app.get(AuditService);
  const business = await app.get(MailComposer).businessName();
  const temp = temporaryPassword(business);
  const user = await prisma.user.create({
    data: {
      email, status: 'INVITED', passwordHash: await app.get(PasswordService).hash(temp), mustChangePassword: true, emailVerified: true,
      tempPasswordExpiresAt: new Date(Date.now() + TEMP_PASSWORD_TTL_MS), profile: { create: { fullName: name } }, roles: { create: [{ roleId: role.id }] },
    },
  });
  await audit.record({ action: 'user.bootstrap_super_admin', entityType: 'user', entityId: user.id, after: { email } });
  const sent = await app.get(UsersService).sendInvitation(email, name, [{ name: role.name, description: role.description }], temp, 'The system administrator');
  process.stdout.write(`Super Admin created: ${email} (invitation e-mail ${sent ? 'sent' : 'NOT sent: check BREVO_API_KEY and EMAIL_FROM'})\n`);
  if (process.argv.includes('--print-password')) {
    process.stdout.write(`Temporary password (valid 72 h, only works to choose a new password): ${temp}\n`);
  }
  await app.close();
}

main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? e.message : 'failed'}\n`);
  process.exit(1);
});
