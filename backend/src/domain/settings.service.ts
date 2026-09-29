import { Injectable } from '@nestjs/common';
import { DEFAULT_SETTINGS } from '../common/permissions';
import { todayIn } from '../common/dates';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class SettingsService {
  constructor(private readonly prisma: PrismaService) {}

  async get<T = unknown>(key: string): Promise<T> {
    const row = await this.prisma.systemSetting.findUnique({ where: { key } });
    return (row ? row.value : DEFAULT_SETTINGS[key]) as T;
  }

  async today(): Promise<string> {
    return todayIn(await this.get<string>('business.timezone'));
  }
}
