import { Injectable } from '@nestjs/common';
import { DEFAULT_SETTINGS } from '../common/permissions';
import { todayIn } from '../common/dates';
import { TtlCache } from '../common/cache';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class SettingsService {
  /** All settings in one query, kept for 30 s (settings are read several times per request and change rarely). */
  private readonly cache = new TtlCache<Map<string, unknown>>(30_000);

  constructor(private readonly prisma: PrismaService) {}

  async get<T = unknown>(key: string): Promise<T> {
    const all = await this.cache.get('all', async () => new Map((await this.prisma.systemSetting.findMany({ select: { key: true, value: true } })).map((r) => [r.key, r.value as unknown])));
    return (all.has(key) ? all.get(key) : DEFAULT_SETTINGS[key]) as T;
  }

  /** Write used by admin configuration screens (bumps the row version; callers audit before/after). */
  async set(key: string, value: unknown, updatedBy: string): Promise<void> {
    this.cache.clear();
    await this.prisma.systemSetting.upsert({
      where: { key }, create: { key, value: value as never, updatedBy },
      update: { value: value as never, updatedBy, version: { increment: 1 } },
    });
    this.cache.clear();
  }

  async today(): Promise<string> {
    return todayIn(await this.get<string>('business.timezone'));
  }
}
