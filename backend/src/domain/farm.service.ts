import { BadRequestException, Injectable } from '@nestjs/common';
import { TtlCache } from '../common/cache';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class FarmService {
  private readonly defaultFarm = new TtlCache<string>(60_000);

  constructor(private readonly prisma: PrismaService) {}

  /** The schema supports several farms; until users are assigned to farms, a single active farm is the implicit default. */
  async resolve(farmId?: string): Promise<string> {
    if (farmId) {
      const f = await this.prisma.farm.findFirst({ where: { id: farmId, deletedAt: null }, select: { id: true } });
      if (!f) throw new BadRequestException('Unknown farm.');
      return f.id;
    }
    return this.defaultFarm.get('default', async () => {
      const farms = await this.prisma.farm.findMany({ where: { deletedAt: null }, select: { id: true }, take: 2 });
      if (farms.length === 0) throw new BadRequestException('No farm has been set up yet.');
      if (farms.length > 1) throw new BadRequestException('Specify farmId: more than one farm exists.');
      return farms[0].id;
    });
  }
}
