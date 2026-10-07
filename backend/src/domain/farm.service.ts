import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class FarmService {
  constructor(private readonly prisma: PrismaService) {}

  /** The schema supports several farms; until users are assigned to farms, a single active farm is the implicit default. */
  async resolve(farmId?: string): Promise<string> {
    if (farmId) {
      const f = await this.prisma.farm.findFirst({ where: { id: farmId, deletedAt: null }, select: { id: true } });
      if (!f) throw new BadRequestException('Unknown farm.');
      return f.id;
    }
    const farms = await this.prisma.farm.findMany({ where: { deletedAt: null }, select: { id: true }, take: 2 });
    if (farms.length === 0) throw new BadRequestException('No farm has been set up yet.');
    if (farms.length > 1) throw new BadRequestException('Specify farmId: more than one farm exists.');
    return farms[0].id;
  }
}
