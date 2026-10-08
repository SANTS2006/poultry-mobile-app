import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import type { Env } from '../config/env';
import { SettingsService } from '../domain/settings.service';
import { localParts } from '../notifications/format';
import { PrismaService } from '../prisma/prisma.service';
import { BackupService } from './backup.service';

const TICK_MS = 60_000;
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Daily backups. Safe to run on every instance and across restarts: the day's job is created under a unique `windowKey`
 * (database-enforced), and a job is claimed with a compare-and-set, so exactly one instance performs each backup or retry.
 * If the server was down at the scheduled time, the next tick after it starts catches up. For stricter isolation, set
 * BACKUP_ENABLED=0 on the API and run `npm run backup:run` from an external scheduler instead.
 */
@Injectable()
export class BackupScheduler implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private busy = false;
  private lastRetentionDate = '';

  constructor(
    private readonly backups: BackupService, private readonly prisma: PrismaService, private readonly settings: SettingsService,
    private readonly logger: PinoLogger, @Inject(ConfigService) private readonly config: ConfigService<Env, true>,
  ) { this.logger.setContext(BackupScheduler.name); }

  onModuleInit(): void {
    if (this.config.get('APP_ENV', { infer: true }) === 'test') return; // tests call tick() directly
    this.timer = setInterval(() => { void this.tick().catch((e) => this.logger.error({ err: e }, 'Backup scheduler tick failed')); }, TICK_MS);
    this.timer.unref();
  }
  onModuleDestroy(): void { if (this.timer) clearInterval(this.timer); }

  /** Idempotent. Returns what it did (for tests and logs). */
  async tick(now = new Date()): Promise<{ started?: string; retried?: string; retention?: number }> {
    if (this.busy || !this.backups.enabled) return {};
    this.busy = true;
    const out: { started?: string; retried?: string; retention?: number } = {};
    try {
      const s = await this.backups.getSettings();
      await this.backups.failStale(now);
      if (s.enabled) {
        const { date, hm } = localParts(now, await this.settings.get<string>('business.timezone'));
        if (HM.test(s.scheduleTime) && hm >= s.scheduleTime) {
          const job = await this.backups.createJob('SCHEDULED', { windowKey: date });
          if (job) { out.started = job.id; await this.backups.execute(job.id); }
        }
        const due = await this.prisma.backupJob.findFirst({ where: { kind: 'SCHEDULED', status: 'FAILED', nextAttemptAt: { lte: now } }, orderBy: { createdAt: 'asc' } });
        if (due && (await this.backups.retry(due.id))) out.retried = due.id;
        if (date !== this.lastRetentionDate) { this.lastRetentionDate = date; out.retention = (await this.backups.applyRetention(now)).deleted.length; }
      }
      await this.backups.checkFreshness(now);
    } finally { this.busy = false; }
    return out;
  }
}
