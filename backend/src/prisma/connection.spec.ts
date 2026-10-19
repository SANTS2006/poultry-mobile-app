import { Prisma } from '@prisma/client';
import { isConnectError, isNeonHost, READ_OPERATIONS, retryConnect, withConnectionDefaults } from './connection';

const known = (code: string) => new Prisma.PrismaClientKnownRequestError('x', { code, clientVersion: '6' });
const init = (code: string) => new Prisma.PrismaClientInitializationError('x', '6', code);

describe('database connection defaults', () => {
  it('adds generous timeouts, and pgbouncer for the Neon pooled host, without overriding what is set', () => {
    const u = new URL(withConnectionDefaults('postgresql://u:p@ep-x-pooler.us-east-2.aws.neon.tech/db?sslmode=require') as string);
    expect(u.searchParams.get('connect_timeout')).toBe('30'); expect(u.searchParams.get('pool_timeout')).toBe('30'); expect(u.searchParams.get('pgbouncer')).toBe('true'); expect(u.searchParams.get('sslmode')).toBe('require');
    const d = new URL(withConnectionDefaults('postgresql://u:p@ep-x.us-east-2.aws.neon.tech/db?sslmode=require') as string);
    expect(d.searchParams.has('pgbouncer')).toBe(false);
    const own = new URL(withConnectionDefaults('postgresql://u:p@h-pooler.x/db?connect_timeout=5&pgbouncer=false') as string);
    expect(own.searchParams.get('connect_timeout')).toBe('5'); expect(own.searchParams.get('pgbouncer')).toBe('false');
    expect(withConnectionDefaults(undefined)).toBeUndefined(); expect(withConnectionDefaults('not a url')).toBe('not a url');
    expect(new URL(withConnectionDefaults('postgresql://u:p%40ss@h/db') as string).password).toBe('p%40ss'); // passwords survive
  });
  it('recognises Neon hosts', () => { expect(isNeonHost('postgresql://u:p@ep-a.c-7.us-east-2.aws.neon.tech/db')).toBe(true); expect(isNeonHost('postgresql://u:p@localhost/db')).toBe(false); });
});

describe('retry when the database cannot be reached', () => {
  const noWait = async () => undefined;
  it('treats only "could not reach it" as retryable', () => {
    expect(isConnectError(known('P1001'))).toBe(true); expect(isConnectError(known('P1002'))).toBe(true); expect(isConnectError(init('P1001'))).toBe(true);
    for (const c of ['P2002', 'P2025', 'P2024', 'P1017', 'P1008']) expect(isConnectError(known(c))).toBe(false); // statement may have run, or not a connection problem
    expect(isConnectError(new Prisma.PrismaClientInitializationError("Can't reach database server at `h:5432`", '6'))).toBe(true); // code-less variant
    expect(isConnectError(new Prisma.PrismaClientInitializationError('Authentication failed', '6', 'P1000'))).toBe(false);
    expect(isConnectError(new Error('boom'))).toBe(false);
  });
  it('retries a closed connection (P1017) only when asked to — reads yes, writes never', async () => {
    expect(isConnectError(known('P1017'))).toBe(false); expect(isConnectError(known('P1017'), true)).toBe(true);
    expect(READ_OPERATIONS.has('findMany')).toBe(true); expect(READ_OPERATIONS.has('create')).toBe(false); expect(READ_OPERATIONS.has('update')).toBe(false); expect(READ_OPERATIONS.has('upsert')).toBe(false); expect(READ_OPERATIONS.has('$executeRaw')).toBe(false);
    let reads = 0; expect(await retryConnect(async () => { if (++reads < 2) throw known('P1017'); return 'ok'; }, [1], noWait, true)).toBe('ok');
    let writes = 0; await expect(retryConnect(async () => { writes++; throw known('P1017'); }, [1, 1], noWait, false)).rejects.toMatchObject({ code: 'P1017' }); expect(writes).toBe(1);
  });
  it('rides out a short outage and returns the result', async () => {
    let n = 0;
    expect(await retryConnect(async () => { if (++n < 3) throw known('P1001'); return 'ok'; }, [1, 1, 1], noWait)).toBe('ok'); expect(n).toBe(3);
  });
  it('gives up after the last delay and rethrows the original error', async () => {
    let n = 0;
    await expect(retryConnect(async () => { n++; throw known('P1001'); }, [1, 1], noWait)).rejects.toMatchObject({ code: 'P1001' }); expect(n).toBe(3);
  });
  it('never retries other errors (no duplicate writes)', async () => {
    let n = 0;
    await expect(retryConnect(async () => { n++; throw known('P2002'); }, [1, 1], noWait)).rejects.toMatchObject({ code: 'P2002' }); expect(n).toBe(1);
  });
});
