import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { isNeonHost, READ_OPERATIONS, retryConnect, withConnectionDefaults } from './connection';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Database');
  private keepAlive: NodeJS.Timeout | null = null;
  private resetting: Promise<void> | null = null;
  private lastReset = 0;

  constructor() {
    // Interactive transactions wait for the database round trip of every statement. The default limit (5 s) is far too tight when the
    // database is in another region or the link is slow, and a transaction that runs out of time fails half-way and is retried forever.
    super({ datasourceUrl: withConnectionDefaults(process.env.DATABASE_URL), transactionOptions: { maxWait: 15_000, timeout: 60_000 } });
    // Every query goes through a wrapper that retries "could not reach the database" (P1001/P1002) a few times: those never ran the statement,
    // so a retry is safe (reads are also retried after "connection closed", which is how a sleeping Neon database shows up on an idle connection), and it rides out a Neon wake-up or a short network blip instead of failing the request.
    const retrying = this.$extends({ query: { $allOperations: ({ operation, args, query }) => retryConnect(() => query(args), undefined, undefined, READ_OPERATIONS.has(operation), () => this.resetPool()) } });
    const own = new Set<PropertyKey>(['onModuleInit', 'onModuleDestroy', 'keepAlive', 'log', 'resetting', 'lastReset', 'resetPool', '$connect', '$disconnect']);
    return new Proxy(this, {
      get: (target, prop) => {
        if (own.has(prop)) { const v = Reflect.get(target, prop, target) as unknown; return typeof v === 'function' ? v.bind(target) : v; }
        const v = Reflect.get(retrying, prop, retrying) as unknown;
        return typeof v === 'function' ? v.bind(retrying) : v;
      },
    });
  }

  /**
   * After the database has been unreachable, Prisma's pool can keep returning dead connections (every query fails with P1017) until the client is
   * disconnected and connected again. This does that, once at a time and at most every 1.5 s, however many requests notice the problem together.
   */
  async resetPool(): Promise<void> {
    if (this.resetting) return this.resetting;
    if (Date.now() - this.lastReset < 1500) return;
    this.resetting = (async () => {
      try { await this.$disconnect(); await this.$connect(); this.log.warn('Database connection was lost; the connection pool was reset'); }
      catch { /* still down: the retry that follows reports it */ }
      finally { this.lastReset = Date.now(); this.resetting = null; }
    })();
    return this.resetting;
  }

  async onModuleInit(): Promise<void> {
    await retryConnect(() => this.$connect());
    // Serverless databases (Neon) go to sleep after ~5 idle minutes and the next request then waits several seconds for the wake-up.
    // A tiny query every 4 minutes keeps it awake. On by default in staging/production and whenever the database is on Neon.
    const onByDefault = ['production', 'staging'].includes(process.env.APP_ENV ?? '') || isNeonHost(process.env.DATABASE_URL);
    const seconds = Number(process.env.DB_KEEPALIVE_SECONDS ?? (onByDefault ? 240 : 0));
    if (seconds > 0) {
      this.keepAlive = setInterval(() => {
        void this.$queryRaw`SELECT 1`.catch(() => { this.log.warn('Keep-alive query failed; resetting the connection pool'); void this.resetPool(); });
      }, seconds * 1000);
      this.keepAlive.unref();
    }
  }
  async onModuleDestroy(): Promise<void> {
    if (this.keepAlive) clearInterval(this.keepAlive);
    await this.$disconnect();
  }
}
