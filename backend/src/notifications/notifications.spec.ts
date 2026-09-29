import { fmtEggs, fmtMoney, localParts, shiftLabel } from './format';
import { ExpoPushProvider } from './push/expo.provider';
import { EXPO_TOKEN_RE, PushMessage, PushTransportError } from './push/push.provider';

type Call = { url: string; headers: Record<string, string>; body: unknown };
const msg = (i: number, over: Partial<PushMessage> = {}): PushMessage => ({ to: `ExponentPushToken[abcdefghij${String(i).padStart(4, '0')}]`, title: 'T', body: 'B', data: { notificationId: 'n' }, channelId: 'sales', priority: 'default', ...over });

function provider(handler: (call: Call) => { ok?: boolean; status?: number; json?: unknown } | Error, token = '') {
  const calls: Call[] = [];
  const p = new ExpoPushProvider(token, async (url, init) => {
    const call = { url, headers: init.headers, body: JSON.parse(init.body) as unknown };
    calls.push(call);
    const r = handler(call);
    if (r instanceof Error) throw r;
    return { ok: r.ok ?? true, status: r.status ?? 200, json: async () => r.json };
  }, 1000);
  return { p, calls };
}

describe('ExpoPushProvider', () => {
  it('sends the documented request shape and maps tickets', async () => {
    const { p, calls } = provider((c) => ({ json: { data: (c.body as unknown[]).map((_, i) => (i === 1 ? { status: 'error', message: 'The recipient device is not registered ExponentPushToken[abcdefghij0002]', details: { error: 'DeviceNotRegistered' } } : { status: 'ok', id: `tk-${i}` })) } }));
    const tickets = await p.send([msg(1), msg(2), msg(3, { priority: 'high', channelId: 'security' })]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://exp.host/--/api/v2/push/send');
    expect(calls[0].headers).toMatchObject({ Accept: 'application/json', 'Content-Type': 'application/json' });
    expect(calls[0].headers.Authorization).toBeUndefined(); // no token configured
    expect(calls[0].body).toEqual([
      expect.objectContaining({ to: expect.stringContaining('ExponentPushToken['), title: 'T', body: 'B', data: { notificationId: 'n' }, channelId: 'sales', priority: 'default', sound: 'default' }),
      expect.anything(), expect.objectContaining({ priority: 'high', channelId: 'security' }),
    ]);
    expect(tickets[0]).toEqual({ status: 'ok', id: 'tk-0' });
    expect(tickets[1]).toMatchObject({ status: 'error', error: 'DeviceNotRegistered' });
    expect(JSON.stringify(tickets[1])).not.toContain('ExponentPushToken['); // token text is scrubbed from provider messages
  });

  it('sends the access token as a bearer header only when configured', async () => {
    const { p, calls } = provider(() => ({ json: { data: [{ status: 'ok', id: 'a' }] } }), 'secret-access-token');
    await p.send([msg(1)]);
    expect(calls[0].headers.Authorization).toBe('Bearer secret-access-token');
  });

  it('chunks at 100 messages per request and keeps ticket order', async () => {
    let n = 0;
    const { p, calls } = provider((c) => ({ json: { data: (c.body as unknown[]).map(() => ({ status: 'ok', id: `t${n++}` })) } }));
    const tickets = await p.send(Array.from({ length: 250 }, (_, i) => msg(i)));
    expect(calls.map((c) => (c.body as unknown[]).length)).toEqual([100, 100, 50]);
    expect(tickets.map((t) => (t.status === 'ok' ? t.id : '')).slice(0, 3)).toEqual(['t0', 't1', 't2']);
    expect(tickets).toHaveLength(250);
  });

  it('reads receipts and surfaces per-ticket errors', async () => {
    const { p, calls } = provider(() => ({ json: { data: { a: { status: 'ok' }, b: { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } } } } }));
    const r = await p.receipts(['a', 'b']);
    expect(calls[0].url).toBe('https://exp.host/--/api/v2/push/getReceipts');
    expect(calls[0].body).toEqual({ ids: ['a', 'b'] });
    expect(r.a).toEqual({ status: 'ok' });
    expect(r.b).toMatchObject({ status: 'error', error: 'DeviceNotRegistered' });
  });

  it('turns HTTP errors, malformed replies and network failures into PushTransportError without leaking anything', async () => {
    await expect(provider(() => ({ ok: false, status: 503 })).p.send([msg(1)])).rejects.toBeInstanceOf(PushTransportError);
    await expect(provider(() => ({ json: { data: [] } })).p.send([msg(1)])).rejects.toThrow(/unexpected response/);
    const net = provider(() => new Error('ECONNRESET ExponentPushToken[abcdefghij0001] secret-host'));
    const err = await net.p.send([msg(1)]).catch((e: Error) => e);
    expect(err).toBeInstanceOf(PushTransportError);
    expect((err as Error).message).not.toMatch(/ExponentPushToken|secret-host|ECONNRESET/);
  });
});

describe('push token format', () => {
  it('accepts Expo tokens only', () => {
    expect(EXPO_TOKEN_RE.test('ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]')).toBe(true);
    expect(EXPO_TOKEN_RE.test('ExpoPushToken[abc_DEF-123456]')).toBe(true);
    for (const bad of ['', 'abc', 'ExponentPushToken[]', 'ExponentPushToken[short]', 'fcm:APA91b...', 'ExponentPushToken[abc def 1234567]', "ExponentPushToken[a'; DROP TABLE x;--12345]"]) expect(EXPO_TOKEN_RE.test(bad)).toBe(false);
  });
});

describe('display formatting', () => {
  it('groups thousands and keeps money exact (no float maths)', () => {
    expect(fmtEggs(12450)).toBe('12,450 eggs');
    expect(fmtMoney('NLe', '85000')).toBe('NLe 85,000');
    expect(fmtMoney('NLe', '1234567.5')).toBe('NLe 1,234,567.50');
    expect(fmtMoney('NLe', '0.3')).toBe('NLe 0.30');
    expect(fmtMoney('NLe', '-9150')).toBe('NLe -9,150');
    expect(shiftLabel('MORNING')).toBe('Morning');
  });
  it('computes wall-clock time in the business time zone', () => {
    const instant = new Date('2026-06-17T23:30:00Z');
    expect(localParts(instant, 'UTC')).toEqual({ date: '2026-06-17', hm: '23:30' });
    expect(localParts(instant, 'Pacific/Auckland')).toEqual({ date: '2026-06-18', hm: '11:30' });
  });
});
