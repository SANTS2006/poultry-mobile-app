import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    // Interactive transactions wait for the database round trip of every statement. The default limit (5 s) is far too tight when the
    // database is in another region or the link is slow, and a transaction that runs out of time fails half-way and is retried forever.
    super({ transactionOptions: { maxWait: 15_000, timeout: 60_000 } });
  }

  private keepAlive: NodeJS.Timeout | null = null;

  async onModuleInit(): Promise<void> {
    await this.$connect();
    // Serverless databases (Neon) go to sleep after a few idle minutes and the next request then waits several seconds for the wake-up.
    // A tiny query now and then keeps the first request of the day as fast as the rest. On by default in staging/production (every 4 min).
    const seconds = Number(process.env.DB_KEEPALIVE_SECONDS ?? (['production', 'staging'].includes(process.env.APP_ENV ?? '') ? 240 : 0));
    if (seconds > 0) {
      this.keepAlive = setInterval(() => { void this.$queryRaw`SELECT 1`.catch(() => undefined); }, seconds * 1000);
      this.keepAlive.unref();
    }
  }
  async onModuleDestroy(): Promise<void> {
    if (this.keepAlive) clearInterval(this.keepAlive);
    await this.$disconnect();
  }
}
