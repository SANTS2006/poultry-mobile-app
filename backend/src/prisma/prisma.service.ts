import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    // Interactive transactions wait for the database round trip of every statement. The default limit (5 s) is far too tight when the
    // database is in another region or the link is slow, and a transaction that runs out of time fails half-way and is retried forever.
    super({ transactionOptions: { maxWait: 15_000, timeout: 60_000 } });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }
  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
