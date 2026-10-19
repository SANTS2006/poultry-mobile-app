import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { isNeonHost, READ_OPERATIONS, retryConnect, withConnectionDefaults } from './connection';

const JOIN_OPERATIONS = new Set(['findUnique', 'findUniqueOrThrow', 'findFirst', 'findFirstOrThrow', 'findMany']);

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Database');
  private keepAlive: NodeJS.Timeout | null = null;
  private resetting: Promise<void> | null = null;
  private lastReset = 0;

  constructor() {
    // Interactive transactions wait for the database round trip of every statement. The default limit (5 s) is far too tight when the
    // database is in another region or the link is slow, and a transaction that runs out of time fails half-way and is retried forever.
    super({
      datasourceUrl: withConnectionDefaults(process.env.DATABASE_URL), transactionOptions: { maxWait: 15_000, timeout: 60_000 },
      // Developer aid: PRISMA_QUERY_LOG=1 prints every SQL statement (to count round trips). Off by default: statements can contain personal data.
      ...(process.env.PRISMA_QUERY_LOG === '1' ? { log: [{ emit: 'event' as const, level: 'query' as const }] } : {}),
    });
    if (process.env.PRISMA_QUERY_LOG === '1') {
      const t0 = Date.now();
      (this as unknown as { $on(e: 'query', cb: (q: { query: string; duration: number }) => void): void }).$on('query', (q) => process.stdout.write(`prisma:query +${Date.now() - t0}ms (${q.duration}ms) ${q.query.replace(/\s+/g, ' ').slice(0, 110)}\n`));
    }
    // Every query goes through a wrapper that retries "could not reach the database" (P1001/P1002) a few times: those never ran the statement,
    // so a retry is safe (reads are also retried after "connection closed", which is how a sleeping Neon database shows up on an idle connection), and it rides out a Neon wake-up or a short network blip instead of failing the request.
    const retrying = this.$extends({
      query: {
        $allOperations: ({ operation, args, query }) => {
          // Related records (a user with roles and permissions...) are fetched with ONE joined query instead of one query per level:
          // each extra query is a full network round trip to the database, which is what makes screens slow when it is far away.
          const a = args as { include?: unknown; select?: unknown; relationLoadStrategy?: string } | undefined;
          if (a && process.env.PRISMA_RELATION_JOINS !== '0' && JOIN_OPERATIONS.has(operation) && (a.include || a.select) && a.relationLoadStrategy === undefined) a.relationLoadStrategy = 'join';
          return retryConnect(() => query(args), undefined, undefined, READ_OPERATIONS.has(operation), () => this.resetPool());
        },
      },
    });
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
      try { await this.$disconnect(); await this.$connect(); void this.warm(); this.log.warn('Database connection was lost; the connection pool was reset'); }
      catch { /* still down: the retry that follows reports it */ }
      finally { this.lastReset = Date.now(); this.resetting = null; }
    })();
    return this.resetting;
  }

  /**
   * Opens several connections up front and keeps them alive. A connection to a far-away database costs several network round trips to set
   * up (TCP, TLS, login), and a request that needs three queries at once would otherwise pay for three fresh connections: that is most of
   * the time a first sign-in takes. Set DB_WARM_CONNECTIONS=0 to turn this off.
   */
  private async warm(): Promise<void> {
    const n = Number(process.env.DB_WARM_CONNECTIONS ?? (isNeonHost(process.env.DATABASE_URL) || process.env.APP_ENV === 'production' ? 4 : 0));
    if (n > 0) await Promise.allSettled(Array.from({ length: n }, () => this.$queryRaw`SELECT 1`));
  }

  async onModuleInit(): Promise<void> {
    await retryConnect(() => this.$connect());
    void this.warm();
    // Serverless databases (Neon) go to sleep after ~5 idle minutes and the next request then waits several seconds for the wake-up.
    // A tiny query every 4 minutes keeps it awake. On by default in staging/production and whenever the database is on Neon.
    const onByDefault = ['production', 'staging'].includes(process.env.APP_ENV ?? '') || isNeonHost(process.env.DATABASE_URL);
    const seconds = Number(process.env.DB_KEEPALIVE_SECONDS ?? (onByDefault ? 240 : 0));
    if (seconds > 0) {
      this.keepAlive = setInterval(() => {
        void this.warm().then(() => this.$queryRaw`SELECT 1`).catch(() => { this.log.warn('Keep-alive query failed; resetting the connection pool'); void this.resetPool(); });
      }, seconds * 1000);
      this.keepAlive.unref();
    }
  }
  async onModuleDestroy(): Promise<void> {
    if (this.keepAlive) clearInterval(this.keepAlive);
    await this.$disconnect();
  }
}
