/**
 * Operator tool for backups, independent of the mobile app and of the running API.
 *   npm run backup:cli -- run                 take a backup now (same workflow as the app: encrypt, store, verify, audit)
 *   npm run backup:cli -- tick                what the scheduler does each minute (use from an external cron / platform scheduler)
 *   npm run backup:cli -- verify <jobId> [--deep]
 *   npm run backup:cli -- decrypt <file.dump.enc> <jobId> <out.dump>   (needs only BACKUP_ENCRYPTION_KEY; no database)
 *   npm run backup:cli -- list
 * Restore the decrypted file with:  pg_restore --no-owner --no-privileges --dbname=<new database url> out.dump
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { decryptFile, parseKey } from '../src/backup/backup.crypto';
import { BackupScheduler } from '../src/backup/backup.scheduler';
import { BackupService } from '../src/backup/backup.service';
import { PrismaService } from '../src/prisma/prisma.service';

async function main(): Promise<number> {
  const [cmd, a, b, c] = process.argv.slice(2);
  if (cmd === 'decrypt') {
    if (!a || !b || !c) { process.stderr.write('usage: decrypt <file.dump.enc> <jobId> <out.dump>\n'); return 2; }
    await decryptFile(a, c, parseKey(process.env.BACKUP_ENCRYPTION_KEY ?? ''), b);
    process.stdout.write(`decrypted to ${c}\n`);
    return 0;
  }
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const backups = app.get(BackupService);
    if (cmd === 'run') {
      if (!backups.enabled) { process.stderr.write('Backups are not enabled (check BACKUP_ENABLED and BACKUP_ENCRYPTION_KEY).\n'); return 1; }
      const job = await backups.createJob('MANUAL');
      const done = await backups.execute(job!.id);
      process.stdout.write(`${done.status} ${done.id} ${done.error ?? ''}\n`);
      return done.status === 'SUCCESSFUL' ? 0 : 1;
    }
    if (cmd === 'tick') { process.stdout.write(`${JSON.stringify(await app.get(BackupScheduler).tick())}\n`); return 0; }
    if (cmd === 'verify' && a) { const r = await backups.verify(a, { deep: b === '--deep' }); process.stdout.write(`${JSON.stringify(r, null, 2)}\n`); return r.ok ? 0 : 1; }
    if (cmd === 'list') {
      for (const j of await app.get(PrismaService).backupJob.findMany({ orderBy: { createdAt: 'desc' }, take: 30 })) process.stdout.write(`${j.createdAt.toISOString()}  ${j.status.padEnd(10)} ${j.verification.padEnd(12)} ${j.kind.padEnd(11)} ${j.id}\n`);
      return 0;
    }
    process.stderr.write('usage: run | tick | verify <jobId> [--deep] | decrypt <file> <jobId> <out> | list\n');
    return 2;
  } finally { await app.close(); }
}
main().then((code) => process.exit(code), (e: unknown) => { process.stderr.write(`${e instanceof Error ? e.message : 'failed'}\n`); process.exit(1); });
