import { Prisma } from '@prisma/client';
import { AllExceptionsFilter } from './all-exceptions.filter';

function run(exception: unknown) {
  const logs: string[] = [];
  const logger = { setContext: () => undefined, error: () => logs.push('error'), warn: () => logs.push('warn') };
  const filter = new AllExceptionsFilter(logger as never);
  let out: { status?: number; body?: { statusCode: number; message: string } } = {};
  const res = { status: (s: number) => ({ json: (b: never) => { out = { status: s, body: b }; } }) };
  const host = { switchToHttp: () => ({ getRequest: () => ({ id: 'r1', url: '/v1/dashboard' }), getResponse: () => res }) };
  filter.catch(exception, host as never);
  return { ...out, logs };
}

describe('AllExceptionsFilter: database outages', () => {
  it.each(['P1001', 'P1002', 'P1008', 'P1017', 'P2024'])('maps Prisma %s to a retryable 503 with a safe message (no host names)', (code) => {
    const e = new Prisma.PrismaClientKnownRequestError("Can't reach database server at `ep-secret.neon.tech:5432`", { code, clientVersion: '6' });
    const r = run(e);
    expect(r.status).toBe(503);
    expect(r.body?.message).toMatch(/try again in a moment/);
    expect(JSON.stringify(r.body)).not.toMatch(/neon|5432|ep-secret/);
    expect(r.logs).toEqual(['warn']);
  });
  it('still maps ordinary unknown errors to a generic 500', () => {
    expect(run(new Error('boom')).status).toBe(500);
  });
});
