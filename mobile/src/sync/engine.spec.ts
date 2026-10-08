import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DatabaseSync } from 'node:sqlite';
import { SyncEngine, dependenciesOf, type EngineDeps } from './engine';
import { estimateStockEggs } from './stock-estimate';
import { MemoryOutboxStorage, type OutboxStorage } from './storage';
import { SqliteOutboxStorage, type SqlDriver } from './sqlite-storage';
import { FakeClock, FakeNetwork, FakeTransport, nextId, production, sale } from './test-helpers';
import { AuthRequiredError, HttpError, NetworkError, type SyncEvent } from './types';
import { OfflineValidationError } from './validators';

function make(over: Partial<EngineDeps> & { storage?: OutboxStorage } = {}) {
  const storage = over.storage ?? new MemoryOutboxStorage();
  const transport = (over.transport as FakeTransport) ?? new FakeTransport();
  const network = (over.network as FakeNetwork) ?? new FakeNetwork(true);
  const clock = new FakeClock();
  const engine = new SyncEngine({ storage, transport, network, now: clock.now, newId: nextId, random: () => 0.5, syncOnEnqueue: false, ...over });
  return { engine, storage, transport, network, clock };
}
const settle = () => new Promise((r) => setImmediate(r));

describe('SyncEngine: durability and ordering', () => {
  it('stores first and sends nothing while offline; syncs in creation order when the connection returns', async () => {
    const { engine, transport, network } = make({ network: new FakeNetwork(false) });
    const a = await engine.enqueue('production.create', production());
    const b = await engine.enqueue('production.create', production({ shift: 'EVENING' }));
    const c = await engine.enqueue('customer.create', { name: 'Mama Kadi' });
    expect(transport.calls).toHaveLength(0);
    expect(await engine.summary()).toMatchObject({ pending: 3, unsynced: 3, online: false, lastSyncedAt: null });

    network.set(true);
    const report = await engine.sync();
    expect(report).toMatchObject({ sent: 3, synced: 3 });
    expect(transport.calls[0].operations.map((o) => o.clientId)).toEqual([a.clientId, b.clientId, c.clientId]);
    expect(await engine.summary()).toMatchObject({ pending: 0, synced: 3, unsynced: 0 });
    expect((await engine.summary()).lastSyncedAt).not.toBeNull();
  });

  it('rejects invalid input immediately without storing it, and never lets a client send prices or totals', async () => {
    const { engine, storage } = make();
    await expect(engine.enqueue('production.create', production({ entries: [{ unit: 'EGG', quantity: -1 }] }))).rejects.toBeInstanceOf(OfflineValidationError);
    await expect(engine.enqueue('sale.create', sale({ total: '1' }))).rejects.toThrow(/set by the server/);
    await expect(engine.enqueue('sale.create', sale({ items: [{ unit: 'CARTON', quantity: 1, unitPrice: '5' }] }))).rejects.toThrow(/not allowed/);
    await expect(engine.enqueue('expense.create', { categoryCode: 'FEED', description: 'Corn' })).rejects.toThrow(/total/i);
    await expect(engine.enqueue('production.create', production({ productionDate: '2999-01-01' }))).rejects.toThrow(/future/);
    expect(await storage.list()).toEqual([]);
  });

  it('runs one sync at a time (concurrent callers share a run)', async () => {
    const { engine, transport } = make({ network: new FakeNetwork(false) });
    await engine.enqueue('production.create', production());
    (engine as unknown as { network: FakeNetwork }).network.online = true;
    let release!: () => void;
    transport.script.push(async (_req, apply) => { await new Promise<void>((r) => { release = r; }); return apply(); });
    const [p1, p2] = [engine.sync(), engine.sync()];
    expect(p1).toBe(p2);
    await settle();
    release();
    await Promise.all([p1, p2]);
    expect(transport.calls).toHaveLength(1);
  });

  it('honours batch size', async () => {
    const { engine, transport } = make({ network: new FakeNetwork(false), batchSize: 2 });
    for (let i = 0; i < 5; i++) await engine.enqueue('production.create', production({ shift: ['MORNING', 'AFTERNOON', 'EVENING'][i % 3], productionDate: `2026-06-${10 + i}` }));
    (engine as unknown as { network: FakeNetwork }).network.online = true;
    await engine.sync();
    expect(transport.calls.map((c) => c.operations.length)).toEqual([2, 2, 1]);
  });
});

describe('SyncEngine: never loses a record', () => {
  it('handles a LOST RESPONSE: the server applied the batch but the device never heard; the retry is answered "duplicate" and nothing is applied twice', async () => {
    const { engine, transport, clock } = make({ network: new FakeNetwork(false) });
    const a = await engine.enqueue('sale.create', sale());
    (engine as unknown as { network: FakeNetwork }).network.online = true;
    transport.script.push(async (_req, apply) => { apply(); throw new NetworkError('response lost'); }); // server stored it, reply dropped
    const first = await engine.sync();
    expect(first.networkFailure).toBe(true);
    expect((await engine.list())[0]).toMatchObject({ status: 'pending', lastError: { code: 'OFFLINE' } });
    expect(transport.applied.size).toBe(1);

    clock.advance(1000);
    await engine.sync();
    const item = (await engine.list())[0];
    expect(item.status).toBe('synced');
    expect(item.entityId).toBe(transport.applied.get(a.clientId));
    expect(transport.applied.size).toBe(1); // exactly one record on the server
  });

  it('recovers items left "syncing" by a crash or kill and resends them', async () => {
    const { engine, storage, transport } = make();
    const item = await storage.insert({ clientId: nextId(), type: 'production.create', payload: production(), status: 'syncing', attempts: 1, createdAt: 't', updatedAt: 't', nextAttemptAt: null, lastError: null, entityId: null, syncedAt: null });
    await engine.sync();
    expect((await storage.get(item.clientId))?.status).toBe('synced');
    expect(transport.calls[0].operations[0].clientId).toBe(item.clientId);
  });

  it('keeps everything and retries later when the server is unavailable (5xx), backing off exponentially with a cap', async () => {
    const { engine, transport, clock } = make({ maxBackoffMs: 60_000 });
    await engine.enqueue('sale.create', sale());
    const delays: number[] = [];
    for (let i = 0; i < 8; i++) {
      transport.script.push(() => { throw new HttpError(503, null); });
      await engine.sync();
      const it = (await engine.list())[0];
      expect(it.status).toBe('pending');
      expect(it.lastError?.code).toBe('SERVER_UNAVAILABLE');
      delays.push(new Date(it.nextAttemptAt as string).getTime() - clock.ms);
      clock.advance(delays[delays.length - 1] + 1);
    }
    expect(delays[1]).toBeGreaterThan(delays[0]);
    expect(delays[3]).toBeGreaterThan(delays[1]);
    expect(Math.max(...delays)).toBeLessThanOrEqual(60_000); // capped
    await engine.sync(); // server recovers
    expect((await engine.list())[0].status).toBe('synced');
  });

  it('does not resend before the back-off time, then resends', async () => {
    const { engine, transport, clock } = make();
    await engine.enqueue('sale.create', sale());
    transport.calls.length = 0;
    transport.script.push(() => { throw new HttpError(500, null); });
    await engine.sync();
    const callsAfterFailure = transport.calls.length;
    await engine.sync(); // too early
    expect(transport.calls.length).toBe(callsAfterFailure);
    clock.advance(10 * 60_000);
    await engine.sync();
    expect(transport.calls.length).toBe(callsAfterFailure + 1);
  });

  it('treats retryable per-record server errors and missing results as "try again", not as failures', async () => {
    const { engine, transport, clock } = make();
    await engine.enqueue('sale.create', sale());
    transport.script.push((req) => ({ serverTime: 't', results: [{ clientId: req.operations[0].clientId, entityType: 'sale', status: 'error', retryable: true, code: 'SERVER_ERROR' }] }));
    await engine.sync();
    expect((await engine.list())[0]).toMatchObject({ status: 'pending', attempts: 1, lastError: { code: 'SERVER_ERROR' } });
    transport.script.push(() => ({ serverTime: 't', results: [] })); // server silently omitted it
    clock.advance(3600_000);
    await engine.sync();
    expect((await engine.list())[0]).toMatchObject({ status: 'pending', attempts: 2, lastError: { code: 'NO_RESULT' } });
  });

  it('keeps refused batches visible as rejected (a malformed request never deletes data)', async () => {
    const { engine, transport } = make();
    await engine.enqueue('sale.create', sale());
    transport.script.push(() => { throw new HttpError(400, { message: 'bad' }); });
    await engine.sync();
    expect((await engine.list())[0]).toMatchObject({ status: 'rejected', lastError: { code: 'HTTP_400' } });
  });

  it('stops and asks for sign-in on auth failure without penalising the records; resumes after login', async () => {
    const { engine, transport } = make();
    const events: SyncEvent[] = [];
    engine.subscribe((e) => events.push(e));
    await engine.enqueue('sale.create', sale());
    transport.script.push(() => { throw new AuthRequiredError(); });
    const r = await engine.sync();
    expect(r.skipped).toBe('auth_required');
    expect(events.some((e) => e.type === 'auth_required')).toBe(true);
    const item = (await engine.list())[0];
    expect(item).toMatchObject({ status: 'pending', attempts: 0 });
    const callsBefore = transport.calls.length;
    expect((await engine.sync()).skipped).toBe('auth_required');
    expect(transport.calls.length).toBe(callsBefore); // no hammering the server
    await engine.resumeAfterLogin();
    expect((await engine.list())[0].status).toBe('synced');
  });
});

describe('SyncEngine: conflicts, rejections and explicit decisions', () => {
  const conflict = { status: 'conflict' as const, code: 'INSUFFICIENT_STOCK', message: 'not enough stock', detail: { availableEggs: 100, requestedEggs: 360 } };

  it('holds a conflicted sale for a decision (never retried on its own, never deleted); retry succeeds once the cause is fixed', async () => {
    const { engine, transport } = make();
    const events: SyncEvent[] = [];
    engine.subscribe((e) => events.push(e));
    const s = await engine.enqueue('sale.create', sale());
    transport.outcomes.set(s.clientId, conflict);
    await engine.sync();
    const held = (await engine.list())[0];
    expect(held).toMatchObject({ status: 'conflict', lastError: { code: 'INSUFFICIENT_STOCK', detail: { availableEggs: 100, requestedEggs: 360 } } });
    expect(events.some((e) => e.type === 'needs_attention')).toBe(true);
    const before = transport.calls.length;
    await engine.sync();
    expect(transport.calls.length).toBe(before); // no automatic retry of a conflict

    transport.outcomes.delete(s.clientId); // stock was recorded meanwhile
    await engine.resolve(s.clientId, 'retry');
    await engine.sync();
    expect((await engine.list())[0].status).toBe('synced');
  });

  it('discard is explicit, logged, and refused for items that are waiting or already synced', async () => {
    const { engine, transport, storage } = make({ network: new FakeNetwork(false) });
    const pending = await engine.enqueue('sale.create', sale());
    await expect(engine.resolve(pending.clientId, 'discard')).rejects.toThrow(/Only conflicted/);
    (engine as unknown as { network: FakeNetwork }).network.online = true;
    transport.outcomes.set(pending.clientId, { status: 'rejected', code: 'VALIDATION', message: 'bad' });
    await engine.sync();
    await engine.resolve(pending.clientId, 'discard');
    expect(await storage.get(pending.clientId)).toBeNull();
    const log = JSON.parse((await storage.getKv('sync.discardLog')) as string);
    expect(log[0]).toMatchObject({ clientId: pending.clientId, type: 'sale.create', reason: { code: 'VALIDATION' } });
    expect(log[0].payload.items).toBeDefined(); // what was discarded is preserved in the log
    const ok = await engine.enqueue('production.create', production());
    await engine.sync();
    await expect(engine.resolve(ok.clientId, 'discard')).rejects.toThrow(/Only conflicted/);
  });

  it('lets the user correct a rejected record and resend it under the same operation id', async () => {
    const { engine, transport } = make();
    const item = await engine.enqueue('customer.create', { name: 'Mama Kadi' });
    transport.outcomes.set(item.clientId, { status: 'rejected', code: 'VALIDATION', message: 'name too short' });
    await engine.sync();
    expect((await engine.list())[0].status).toBe('rejected');
    transport.outcomes.delete(item.clientId);
    await expect(engine.correctAndRetry(item.clientId, { name: 'x' })).rejects.toBeInstanceOf(OfflineValidationError);
    await engine.correctAndRetry(item.clientId, { name: 'Mama Kadi Sesay' });
    await engine.sync();
    const done = (await engine.list())[0];
    expect(done.status).toBe('synced');
    expect(done.clientId).toBe(item.clientId);
    expect(done.payload.name).toBe('Mama Kadi Sesay');
  });

  it('holds back dependent records until their dependency syncs, and blocks (not drops) them if it fails', async () => {
    const { engine, transport } = make({ network: new FakeNetwork(false) });
    const customer = await engine.enqueue('customer.create', { name: 'Mama Kadi' });
    const s = await engine.enqueue('sale.create', sale({ customerClientId: customer.clientId }));
    const p = await engine.enqueue('payment.create', { saleClientId: s.clientId, amount: '500' });
    expect(dependenciesOf(s)).toEqual([customer.clientId]);
    expect(dependenciesOf(p)).toEqual([s.clientId]);

    (engine as unknown as { network: FakeNetwork }).network.online = true;
    await engine.sync();
    expect(transport.calls.map((c) => c.operations.map((o) => o.type))).toEqual([['customer.create'], ['sale.create'], ['payment.create']]); // strictly in dependency order
    expect((await engine.summary()).synced).toBe(3);

    // failure path
    const c2 = await engine.enqueue('customer.create', { name: 'Bad Customer' });
    transport.outcomes.set(c2.clientId, { status: 'rejected', code: 'VALIDATION', message: 'nope' });
    await engine.sync();
    const s2 = await engine.enqueue('sale.create', sale({ customerClientId: c2.clientId }));
    await engine.sync();
    expect((await engine.list()).find((i) => i.clientId === s2.clientId)).toMatchObject({ status: 'blocked', lastError: { code: 'DEPENDENCY_FAILED' } });
    expect((await engine.summary()).blocked).toBe(1);

    transport.outcomes.delete(c2.clientId);
    await engine.resolve(c2.clientId, 'retry'); // fixing the dependency releases the dependent
    await engine.sync();
    expect((await engine.list()).filter((i) => [c2.clientId, s2.clientId].includes(i.clientId)).map((i) => i.status)).toEqual(['synced', 'synced']);
  });

  it('purges old synced items after the retention period but never touches unsynced ones', async () => {
    const { engine, clock, network } = make({ syncedRetentionMs: 60_000, network: new FakeNetwork(false) });
    await engine.enqueue('production.create', production());
    network.set(true);
    await engine.sync();
    expect(await engine.list()).toHaveLength(1);
    const pending = await engine.enqueue('production.create', production({ shift: 'EVENING' }));
    clock.advance(120_000);
    network.set(false);
    await engine.enqueue('production.create', production({ shift: 'AFTERNOON' }));
    network.set(true);
    await engine.sync();
    const left = await engine.list();
    expect(left.some((i) => i.clientId === pending.clientId)).toBe(true);
    expect(left).toHaveLength(2); // the first synced one was purged; the two newer ones remain
  });

  it('reports changes to subscribers and isolates a throwing listener', async () => {
    const { engine } = make({ network: new FakeNetwork(false) });
    const seen: string[] = [];
    engine.subscribe(() => { throw new Error('ui bug'); });
    engine.subscribe((e) => seen.push(e.type));
    await expect(engine.enqueue('production.create', production())).resolves.toBeDefined();
    expect(seen).toContain('summary');
  });

  it('auto-sync reacts to connectivity coming back', async () => {
    const network = new FakeNetwork(false);
    const { engine, transport } = make({ network });
    await engine.enqueue('production.create', production());
    const stop = engine.startAutoSync(1_000_000);
    network.set(true);
    await settle();
    await engine.sync();
    stop();
    expect(transport.applied.size).toBe(1);
  });
});

describe('durable storage (real SQLite)', () => {
  const open = (file: string): { db: DatabaseSync; driver: SqlDriver } => {
    const db = new DatabaseSync(file);
    return {
      db,
      driver: {
        async run(sql, params = []) { db.prepare(sql).run(...params); },
        async all<T>(sql: string, params: (string | number | null)[] = []) { return db.prepare(sql).all(...params) as T[]; },
      },
    };
  };
  const dbFile = () => join(mkdtempSync(join(tmpdir(), 'outbox-')), 'app.db');

  it('survives an app restart: records queued offline are still there and get synced by a brand-new engine', async () => {
    const file = dbFile();
    const first = open(file);
    const s1 = new SqliteOutboxStorage(first.driver);
    await s1.init();
    const offline = new SyncEngine({ storage: s1, transport: new FakeTransport(), network: new FakeNetwork(false), newId: nextId });
    const a = await offline.enqueue('production.create', production());
    const b = await offline.enqueue('sale.create', sale());
    first.db.close(); // app killed

    const second = open(file);
    const s2 = new SqliteOutboxStorage(second.driver);
    await s2.init();
    const transport = new FakeTransport();
    const online = new SyncEngine({ storage: s2, transport, network: new FakeNetwork(true), newId: nextId });
    expect((await online.list()).map((i) => i.clientId)).toEqual([a.clientId, b.clientId]);
    expect(await online.sync()).toMatchObject({ synced: 2 });
    expect(transport.applied.size).toBe(2);
    second.db.close();
  });

  it('round-trips every field, keeps order, enforces unique client ids, and stores key/values', async () => {
    const { db, driver } = open(':memory:');
    const s = new SqliteOutboxStorage(driver);
    await s.init();
    const base = { type: 'sale.create' as const, payload: { items: [{ unit: 'CARTON', quantity: 2 }], notes: 'ünïcode ✓' }, status: 'pending' as const, attempts: 0, createdAt: 'c', updatedAt: 'u', nextAttemptAt: null, lastError: null, entityId: null, syncedAt: null };
    const one = await s.insert({ ...base, clientId: nextId() });
    const two = await s.insert({ ...base, clientId: nextId() });
    expect(two.seq).toBeGreaterThan(one.seq);
    await expect(s.insert({ ...base, clientId: one.clientId })).rejects.toThrow();
    const upd = await s.update(one.clientId, { status: 'conflict', lastError: { code: 'X', detail: { a: 1 } }, attempts: 3 });
    expect(upd).toMatchObject({ status: 'conflict', attempts: 3, lastError: { code: 'X', detail: { a: 1 } }, payload: base.payload });
    expect((await s.list({ statuses: ['conflict'] })).map((i) => i.clientId)).toEqual([one.clientId]);
    expect((await s.list()).map((i) => i.clientId)).toEqual([one.clientId, two.clientId]);
    await s.setKv('k', 'v1'); await s.setKv('k', 'v2');
    expect(await s.getKv('k')).toBe('v2');
    expect(await s.getKv('missing')).toBeNull();
    await s.remove(two.clientId);
    expect(await s.get(two.clientId)).toBeNull();
    db.close();
  });

  it('is safe against SQL injection through payload content', async () => {
    const { db, driver } = open(':memory:');
    const s = new SqliteOutboxStorage(driver);
    await s.init();
    const evil = "x'); DROP TABLE outbox;--";
    await s.insert({ clientId: nextId(), type: 'customer.create', payload: { name: evil }, status: 'pending', attempts: 0, createdAt: 'c', updatedAt: 'u', nextAttemptAt: null, lastError: null, entityId: null, syncedAt: null });
    expect((await s.list())[0].payload.name).toBe(evil);
    db.close();
  });
});

describe('local stock estimate', () => {
  const units = { EGG: 1, CRATE: 30, CARTON: 360 };
  const item = (type: 'production.create' | 'sale.create', payload: Record<string, unknown>, status: 'pending' | 'synced' | 'conflict') => ({
    clientId: nextId(), type, payload, status, attempts: 0, createdAt: '', updatedAt: '', nextAttemptAt: null, lastError: null, entityId: null, syncedAt: null, seq: 1,
  });
  it('adds unsent production, subtracts unsent sales, ignores synced and conflicted items', () => {
    const out = [
      item('production.create', { entries: [{ unit: 'CARTON', quantity: 1 }, { unit: 'CRATE', quantity: 7 }] }, 'pending'), // +570
      item('sale.create', { items: [{ unit: 'CARTON', quantity: 1 }] }, 'pending'), // −360
      item('sale.create', { items: [{ unit: 'CARTON', quantity: 5 }] }, 'synced'), // already in server stock
      item('sale.create', { items: [{ unit: 'CARTON', quantity: 9 }] }, 'conflict'), // not applied
    ];
    expect(estimateStockEggs(1000, units, out as never)).toBe(1000 + 570 - 360);
  });
});

describe('SyncEngine: the Retry button', () => {
  const failOnce = (transport: FakeTransport) => transport.script.push((req, apply) => {
    const ok = apply();
    return { ...ok, results: ok.results.map((r) => ({ clientId: r.clientId, entityType: 'x', status: 'error', code: 'SERVER_ERROR', message: 'The server could not process this yet.', retryable: true })) };
  });

  it('sends a waiting record immediately instead of waiting out the automatic delay, and starts the attempt count over', async () => {
    const { engine, transport, storage } = make();
    failOnce(transport);
    const item = await engine.enqueue('production.create', production());
    await engine.sync();
    const waiting = await storage.get(item.clientId);
    expect(waiting).toMatchObject({ status: 'pending', attempts: 1 });
    expect(waiting!.nextAttemptAt).not.toBeNull();

    const callsBefore = transport.calls.length;
    await engine.sync(); // the normal schedule respects the delay…
    expect(transport.calls.length).toBe(callsBefore);

    const report = await engine.retry(); // …the button does not
    expect(report.synced).toBe(1);
    expect(await storage.get(item.clientId)).toMatchObject({ status: 'synced', attempts: 0, nextAttemptAt: null });
  });

  it('retries one record only when given its id, and also retries records the server refused', async () => {
    const { engine, transport, storage } = make();
    const a = await engine.enqueue('production.create', production());
    const b = await engine.enqueue('production.create', production({ shift: 'EVENING' }));
    transport.outcomes.set(a.clientId, { status: 'rejected', code: 'BUSINESS_RULE', message: 'No.' });
    transport.outcomes.set(b.clientId, { status: 'rejected', code: 'BUSINESS_RULE', message: 'No.' });
    await engine.sync();
    expect((await storage.get(a.clientId))!.status).toBe('rejected');

    transport.outcomes.delete(a.clientId); // the problem was fixed (e.g. permission granted)
    const report = await engine.retry(a.clientId);
    expect(report.synced).toBe(1);
    expect((await storage.get(a.clientId))!.status).toBe('synced');
    expect((await storage.get(b.clientId))!.status).toBe('rejected'); // untouched

    transport.outcomes.delete(b.clientId);
    expect((await engine.retry()).synced).toBe(1);
    expect((await storage.get(b.clientId))!.status).toBe('synced');
  });

  it('says why nothing happened when offline or signed out, and keeps every record', async () => {
    const { engine, network, storage } = make({ network: new FakeNetwork(false) });
    const item = await engine.enqueue('production.create', production());
    expect((await engine.retry()).skipped).toBe('offline');
    expect((await storage.get(item.clientId))!.status).toBe('pending');
    network.set(true);
    expect((await engine.retry()).synced).toBe(1);
  });
});
