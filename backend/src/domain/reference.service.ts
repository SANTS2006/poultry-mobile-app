import { Injectable } from '@nestjs/common';
import type { Coop, Shift } from '@prisma/client';
import { TtlCache } from '../common/cache';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Coops and shifts, read from memory (refreshed every 30 s and whenever a coop is added or changed) so that recording production does not
 * spend database round trips re-reading them inside a transaction.
 */
@Injectable()
export class ReferenceService {
  private readonly shifts = new TtlCache<Map<string, Shift>>(60_000);
  private readonly coops = new TtlCache<Map<string, Coop>>(30_000);

  constructor(private readonly prisma: PrismaService) {}

  async shift(code: string): Promise<Shift | undefined> {
    return (await this.shifts.get('all', async () => new Map((await this.prisma.shift.findMany()).map((s) => [s.code, s])))).get(code);
  }

  /** An active, not-deleted coop of the farm, or undefined. */
  async activeCoop(farmId: string, id: string): Promise<Coop | undefined> {
    const c = (await this.coops.get(farmId, async () => new Map((await this.prisma.coop.findMany({ where: { farmId, active: true, deletedAt: null } })).map((x) => [x.id, x])))).get(id);
    return c;
  }

  /** Call after a coop is created, renamed, retired or reactivated. */
  coopsChanged(): void { this.coops.clear(); }
}
