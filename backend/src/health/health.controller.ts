import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../auth/decorators/public.decorator';
import { PrismaService } from '../prisma/prisma.service';

@Public()
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /** Liveness: process is up. No dependencies, no details. */
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  /**
   * Readiness: database reachable. Reports no connection details. `dbRoundTripMs` is how long one trivial query takes: when it is above
   * ~50 ms the API and the database are far apart, and every request will feel slow however fast the code is (put them in the same region).
   */
  @Get('ready')
  async ready() {
    try {
      await this.prisma.$queryRaw`SELECT 1`; // the first call may open the connection
      const started = Date.now();
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'ok', dbRoundTripMs: Date.now() - started };
    } catch {
      throw new ServiceUnavailableException('Service not ready');
    }
  }
}
