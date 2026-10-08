import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Prisma, PrismaClient } from '@prisma/client';
import { io, Socket } from 'socket.io-client';
import { DomainEvents } from '../src/domain/events.service';
import { api, bearer, createApp, makeUser, PASSWORD, seed, signIn, useIsolatedSchema } from './helpers';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Realtime: authenticated WebSockets, topic authorisation, live dashboard (e2e, real PostgreSQL + real sockets)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let url: string;
  let jwt: JwtService;
  let farmId: string;
  let coop1: string;
  let coop2: string;
  const open: Socket[] = [];
  type Who = 'admin' | 'owner' | 'manager' | 'prod' | 'sales' | 'acct';
  const users = {} as Record<Who, { id: string; email: string; token: string; refresh: string }>;

  const post = (path: string, who: Who, body?: object) => api(app).post(`/v1${path}`).set(bearer(users[who].token)).send(body);
  const get = (path: string, who: Who) => api(app).get(`/v1${path}`).set(bearer(users[who].token));
  const put = (path: string, who: Who, body: object) => api(app).put(`/v1${path}`).set(bearer(users[who].token)).send(body);

  /** Connects and resolves once the server says `ready`; rejects with the connect error message otherwise. */
  const connect = (token: unknown, opts: { transports?: string[] } = {}): Promise<Socket> => new Promise((resolve, reject) => {
    const s = io(url, { path: '/realtime', transports: (opts.transports ?? ['websocket']) as never, auth: { token }, reconnection: false, timeout: 4000 });
    open.push(s);
    const seen: { name: string; payload: Record<string, unknown> }[] = [];
    (s as unknown as { seen: typeof seen }).seen = seen; // events that can arrive immediately after connect
    for (const n of ['auth.expiring', 'auth.revoked']) s.on(n, (payload) => seen.push({ name: n, payload }));
    s.once('ready', () => resolve(s));
    s.once('connect_error', (e) => { s.close(); reject(e); });
  });
  const connectAs = (who: Who) => connect(users[who].token);
  const subscribe = (s: Socket, body: unknown): Promise<{ ok: boolean; joined?: string[]; denied?: { topic: string; reason: string }[]; error?: string }> =>
    new Promise((resolve) => s.emit('subscribe', body, resolve));

  /** Records every listed event received by a socket. */
  const record = (s: Socket, names: string[]) => {
    const got: { name: string; payload: Record<string, unknown> }[] = [];
    for (const n of names) s.on(n, (payload) => got.push({ name: n, payload }));
    return got;
  };
  const until = async (cond: () => boolean, ms = 3000) => { const t = Date.now(); while (!cond()) { if (Date.now() - t > ms) throw new Error('timed out waiting for condition'); await sleep(25); } };
  const seenOf = (s: Socket) => (s as unknown as { seen: { name: string; payload: Record<string, unknown> }[] }).seen;
  const revokedReason = async (s: Socket): Promise<string> => { await until(() => seenOf(s).some((e) => e.name === 'auth.revoked')); return seenOf(s).find((e) => e.name === 'auth.revoked')!.payload.reason as string; };

  beforeAll(async () => {
    process.env.THROTTLE_OFF = '1';
    await useIsolatedSchema('rt');
    ({ app, prisma } = await createApp());
    await app.listen(0);
    url = `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}`;
    jwt = app.get(JwtService);
    await seed(prisma);
    await prisma.role.updateMany({ data: { mfaRequired: false } });
    farmId = (await prisma.farm.create({ data: { name: 'RT Farm' } })).id;
    coop1 = (await prisma.coop.create({ data: { farmId, name: 'Coop 1' } })).id;
    coop2 = (await prisma.coop.create({ data: { farmId, name: 'Coop 2' } })).id;
    const carton = await prisma.productUnit.findFirstOrThrow({ where: { code: 'CARTON' } });
    await prisma.price.create({ data: { productUnitId: carton.id, amount: new Prisma.Decimal('1550'), effectiveFrom: new Date('2026-01-01T00:00:00Z') } });
    for (const [k, role] of [['admin', 'SUPER_ADMIN'], ['owner', 'OWNER'], ['manager', 'FARM_MANAGER'], ['prod', 'PRODUCTION_STAFF'], ['sales', 'SALES_STAFF'], ['acct', 'ACCOUNTANT']] as const) {
      const u = await makeUser(prisma, { roles: [role], fullName: `${k} user` });
      const s = await signIn(app, u.email);
      users[k] = { id: u.id, email: u.email, token: s.accessToken, refresh: s.refreshToken };
    }
  });
  afterEach(() => { for (const s of open.splice(0)) s.close(); });
  afterAll(async () => { await prisma.$disconnect(); await app.close(); });

  // ───────────────────────── live dashboard (REST) ─────────────────────────
  describe('dashboard (deterministic data)', () => {
    it('is permission-filtered and computed from the database', async () => {
      // production and sales staff get a summary of what they may see (and nothing else)
      const p0 = (await get('/dashboard', 'prod').expect(200)).body;
      expect(p0.production).toBeDefined();
      expect([p0.sales, p0.expenses, p0.cash, p0.receivables, p0.inventory]).toEqual([undefined, undefined, undefined, undefined, undefined]);
      const s0 = (await get('/dashboard', 'sales').expect(200)).body;
      expect(s0.sales).toBeDefined();
      expect([s0.production, s0.expenses, s0.cash, s0.receivables]).toEqual([undefined, undefined, undefined, undefined]);
      await api(app).get('/v1/dashboard').expect(401);

      // data: production 570 (coop 1 morning) + 300 (coop 2 evening); a cash sale, a part-paid credit sale, an expense
      await post('/production', 'manager', { coopId: coop1, shift: 'MORNING', entries: [{ unit: 'CARTON', quantity: 1 }, { unit: 'CRATE', quantity: 7 }] }).expect(201);
      await post('/production', 'manager', { coopId: coop2, shift: 'EVENING', entries: [{ unit: 'CRATE', quantity: 10 }] }).expect(201);
      await prisma.systemSetting.update({ where: { key: 'sales.creditEnabled' }, data: { value: true } });
      const cust = (await post('/customers', 'owner', { name: 'Mama Kadi', creditAllowed: true, creditLimit: '5000' }).expect(201)).body.id;
      await post('/sales', 'sales', { items: [{ unit: 'CARTON', quantity: 1 }] }).expect(201); // 1550 paid
      await post('/sales', 'sales', { items: [{ unit: 'CARTON', quantity: 1 }], customerId: cust, amountPaid: '500' }).expect(201); // 1050 owed
      await post('/expenses', 'manager', { categoryCode: 'FEED', description: 'Concentrate', quantity: '8', unitCost: '1400' }).expect(201);

      const d = (await get('/dashboard', 'owner').expect(200)).body;
      expect(d.production.todayEggs).toBe(870);
      expect(d.production.byCoop).toEqual(expect.arrayContaining([{ coopId: coop1, name: 'Coop 1', eggs: 570 }, { coopId: coop2, name: 'Coop 2', eggs: 300 }]));
      expect(d.production.byShift).toEqual(expect.arrayContaining([{ shift: 'MORNING', eggs: 570 }, { shift: 'AFTERNOON', eggs: 0 }, { shift: 'EVENING', eggs: 300 }]));
      expect(d.production.notRecordedToday).toHaveLength(4); // 2 coops × 3 shifts − 2 recorded
      expect(d.production.last14Days).toHaveLength(14);
      expect(d.production.last14Days[13].eggs).toBe(870);
      expect(d.inventory).toMatchObject({ quantityEggs: 150, lowStock: true, breakdown: { cartons: 0, crates: 5, eggs: 0 } });
      expect(d.sales).toMatchObject({ todayRevenue: '3100', todayCount: 2, todayEggsSold: 720 });
      expect(d.sales.last14Days[13]).toMatchObject({ revenue: '3100' });
      expect(d.expenses).toMatchObject({ todayTotal: '11200', todayCount: 1, monthToDateTotal: '11200' });
      expect(d.expenses.byCategoryToday).toEqual([{ category: 'Feed', total: '11200' }]);
      expect(d.cash).toMatchObject({ receivedToday: '2050', expensesToday: '11200', netCashFlowToday: '-9150' });
      expect(d.cash.basis).toMatch(/not profit/);
      expect(d.receivables).toEqual({ outstandingTotal: '1050', customersWithBalance: 1 });
      expect(JSON.stringify(d)).not.toMatch(/profit"/); // never labelled as profit
      expect(d.businessDate).toBe(new Date().toISOString().slice(0, 10));
    });

    it('shows each role only the sections it may see', async () => {
      const mgr = (await get('/dashboard', 'manager').expect(200)).body;
      expect(Object.keys(mgr)).toEqual(expect.arrayContaining(['production', 'inventory', 'sales', 'expenses']));
      expect(mgr.cash).toBeUndefined(); // no payments.read
      expect(mgr.receivables).toBeUndefined(); // no customers.financial
      const acct = (await get('/dashboard', 'acct').expect(200)).body;
      expect(acct.production).toBeUndefined();
      expect(acct.inventory).toBeUndefined();
      expect(acct.cash).toBeDefined();
      expect(acct.receivables.outstandingTotal).toBe('1050');
      expect(acct.needsReview).toEqual({ sales: 0, expenses: 0 });
      await get(`/dashboard?farmId=${randomUUID()}`, 'owner').expect(400);
      await get('/dashboard?farmId=nope', 'owner').expect(400);
    });
  });

  // ───────────────────────── handshake ─────────────────────────
  describe('handshake authentication', () => {
    it('accepts a valid access token and announces when it expires', async () => {
      const s = await connectAs('prod');
      expect(s.connected).toBe(true);
    });

    it('refuses missing, malformed, foreign-signed, expired, wrong-type and non-string tokens with one generic error', async () => {
      const claims = { typ: 'access', tv: 0, fid: randomUUID() };
      const opts = { subject: users.admin.id, issuer: 'makarifor-api', audience: 'makarifor-app' };
      const foreign = new JwtService({ secret: 'some-other-secret-some-other-secret-1234' }).sign(claims, { ...opts, expiresIn: 600 });
      const expired = jwt.sign(claims, { ...opts, expiresIn: -60 });
      const mfaTyped = jwt.sign({ typ: 'mfa', tv: 0 }, { ...opts, expiresIn: 600 });
      const noSession = jwt.sign(claims, { ...opts, expiresIn: 600 }); // valid signature, but no such session family
      for (const bad of [undefined, '', 'garbage', foreign, expired, mfaTyped, noSession, 12345, { token: 'x' }, 'x'.repeat(5000)]) {
        await expect(connect(bad)).rejects.toThrow('unauthorized');
      }
    });

    it('refuses long-polling (WebSocket only) and tokens sent in the query string', async () => {
      await expect(connect(users.admin.token, { transports: ['polling'] })).rejects.toBeDefined();
      const s = io(url, { path: '/realtime', transports: ['websocket'], query: { token: users.admin.token }, reconnection: false, timeout: 3000 });
      open.push(s);
      await expect(new Promise((res, rej) => { s.once('ready', res); s.once('connect_error', rej); })).rejects.toBeDefined();
    });

    it('refuses disabled users and revoked sessions at connect time', async () => {
      const u = await makeUser(prisma, { roles: ['SALES_STAFF'] });
      const s1 = await signIn(app, u.email);
      await post(`/users/${u.id}/disable`, 'admin', { reason: 'left the company' }).expect(200);
      await expect(connect(s1.accessToken)).rejects.toThrow('unauthorized');
      await post(`/users/${u.id}/reactivate`, 'admin', { reason: 'came back' }).expect(200);
      const s2 = await signIn(app, u.email);
      await api(app).post('/v1/auth/logout').set(bearer(s2.accessToken)).expect(204);
      await expect(connect(s2.accessToken)).rejects.toThrow('unauthorized');
    });

    it('caps concurrent connections per user', async () => {
      const u = await makeUser(prisma, { roles: ['SALES_STAFF'] });
      const t = (await signIn(app, u.email)).accessToken;
      for (let i = 0; i < 5; i++) await connect(t);
      await expect(connect(t)).rejects.toThrow('unauthorized');
    });
  });

  // ───────────────────────── subscriptions ─────────────────────────
  describe('subscription authorisation', () => {
    beforeAll(async () => {
      await post('/inventory/adjustments', 'manager', { type: 'ADJUSTMENT', direction: 'INCREASE', unit: 'CARTON', quantity: 100, reason: 'test stock for realtime suite' }).expect(201);
    });

    it('joins only topics the user is permitted to receive; unknown topics and raw room names are refused', async () => {
      const s = await connectAs('prod');
      const r = await subscribe(s, { topics: ['production', 'sales', 'payments', 'expenses', 'dashboard', 'system', 'inventory', 'nonsense', `f:${farmId}:sales`, 'u:someone'] });
      expect(r.ok).toBe(true);
      expect(r.joined).toEqual(['production']);
      const reasons = Object.fromEntries((r.denied ?? []).map((d) => [d.topic, d.reason]));
      expect(reasons).toMatchObject({ sales: 'forbidden', payments: 'forbidden', expenses: 'forbidden', dashboard: 'forbidden', system: 'forbidden', inventory: 'forbidden', nonsense: 'unknown_topic' });
      expect(Object.values(reasons).filter((v) => v === 'unknown_topic')).toHaveLength(3);
    });

    it('validates the request shape, the farm and the size', async () => {
      const s = await connectAs('admin');
      expect((await subscribe(s, undefined)).error).toBe('invalid_request');
      expect((await subscribe(s, { topics: 'sales' })).error).toBe('invalid_request');
      expect((await subscribe(s, { topics: [] })).error).toBe('invalid_request');
      expect((await subscribe(s, { topics: Array(11).fill('sales') })).error).toBe('invalid_request');
      expect((await subscribe(s, { topics: ['sales'], farmId: randomUUID() })).error).toBe('unknown_farm');
      expect((await subscribe(s, { topics: ['sales'], farmId: { $ne: 1 } })).error).toBe('invalid_request');
      expect((await subscribe(s, { topics: ['sales'], farmId })).joined).toEqual(['sales']);
    });

    it('cannot be used to join arbitrary rooms through other message names', async () => {
      const s = await connectAs('prod');
      const got = record(s, ['sale.created', 'inventory.updated']);
      s.emit('join', `f:${farmId}:sales`);
      s.emit('join-room', `t:sales`);
      await post('/sales', 'sales', { items: [{ unit: 'CARTON', quantity: 1 }] }).expect(201);
      await sleep(300);
      expect(got).toEqual([]);
    });

    it('rate-limits control messages and drops persistent abusers', async () => {
      const s = await connectAs('manager');
      const results = [];
      for (let i = 0; i < 30; i++) results.push((await subscribe(s, { topics: ['production'] })).error);
      expect(results.filter((e) => e === 'rate_limited').length).toBeGreaterThan(5);
      for (let i = 0; i < 80 && s.connected; i++) s.emit('subscribe', { topics: ['production'] }, () => undefined);
      await until(() => s.disconnected);
    });

    it('drops connections that send oversized messages', async () => {
      const s = await connectAs('manager');
      s.emit('subscribe', { topics: ['production'], junk: 'x'.repeat(50_000) }, () => undefined);
      await until(() => s.disconnected);
    });
  });

  // ───────────────────────── live delivery ─────────────────────────
  describe('event delivery', () => {
    const NAMES = ['production.created', 'production.updated', 'inventory.updated', 'sale.created', 'sale.updated', 'payment.created', 'expense.created', 'customer.created', 'dashboard.invalidate', 'system.alert', 'notification.created'];

    it('routes each event only to subscribers of its topic (and never to unsubscribed sockets)', async () => {
      await post('/inventory/adjustments', 'manager', { type: 'ADJUSTMENT', direction: 'INCREASE', unit: 'CARTON', quantity: 20, reason: 'test stock for realtime' }).expect(201);
      const prod = await connectAs('prod'); const sales = await connectAs('sales'); const acct = await connectAs('acct'); const idle = await connectAs('admin');
      await subscribe(prod, { topics: ['production', 'sales', 'inventory'] });
      await subscribe(sales, { topics: ['sales', 'inventory', 'production'] });
      await subscribe(acct, { topics: ['payments', 'expenses', 'sales', 'dashboard'] });
      const gProd = record(prod, NAMES); const gSales = record(sales, NAMES); const gAcct = record(acct, NAMES); const gIdle = record(idle, NAMES);

      const sale = (await post('/sales', 'sales', { items: [{ unit: 'CARTON', quantity: 2 }] }).expect(201)).body;
      await until(() => gSales.some((e) => e.name === 'sale.created') && gAcct.some((e) => e.name === 'payment.created'));
      expect(gSales.map((e) => e.name).sort()).toEqual(['inventory.updated', 'sale.created']);
      expect(gAcct.map((e) => e.name)).toEqual(expect.arrayContaining(['sale.created', 'payment.created']));
      expect(gAcct.some((e) => e.name === 'inventory.updated')).toBe(false); // not subscribed to inventory / no permission
      expect(gProd).toEqual([]); // production staff asked for sales/inventory but hold neither permission
      expect(gIdle).toEqual([]); // connected but never subscribed
      const created = gSales.find((e) => e.name === 'sale.created')!.payload;
      expect(created).toMatchObject({ name: 'sale.created', entityId: sale.id, farmId, actorId: users.sales.id, data: { paymentStatus: 'PAID', eggs: 720 } });

      const prodRec = await post('/production', 'manager', { coopId: coop2, shift: 'MORNING', entries: [{ unit: 'CRATE', quantity: 3 }] }).expect(201);
      await until(() => gProd.some((e) => e.name === 'production.created'));
      expect(gProd.find((e) => e.name === 'production.created')!.payload).toMatchObject({ entityId: prodRec.body.id, data: { totalEggs: 90 } });
      expect(gSales.some((e) => e.name === 'production.created')).toBe(false); // sales staff have no production.read
      expect(gSales.some((e) => e.name === 'inventory.updated')).toBe(true);

      await post('/expenses', 'manager', { categoryCode: 'FEED', description: 'Corn', total: '100' }).expect(201);
      await until(() => gAcct.some((e) => e.name === 'expense.created'));
      expect(gProd.some((e) => e.name === 'expense.created')).toBe(false);
      expect(gSales.some((e) => e.name === 'expense.created')).toBe(false);
    });

    it('never puts amounts, prices or customer names in event payloads', async () => {
      const acct = await connectAs('acct'); const sales = await connectAs('sales');
      await subscribe(acct, { topics: ['sales', 'payments', 'customers', 'expenses'] });
      await subscribe(sales, { topics: ['sales', 'customers'] });
      const gA = record(acct, NAMES); const gS = record(sales, NAMES);
      const c = (await post('/customers', 'sales', { name: 'Confidential Customer Ltd', phone: '+23276999999' }).expect(201)).body;
      await post('/sales', 'sales', { items: [{ unit: 'CARTON', quantity: 1 }], customerId: c.id }).expect(201);
      await until(() => gA.some((e) => e.name === 'payment.created') && gS.some((e) => e.name === 'customer.created'));
      const wire = JSON.stringify([...gA, ...gS]);
      expect(wire).not.toMatch(/Confidential|23276999999|1550|unitPrice|lineTotal|"total"|"amount"|"paidAmount"/);
      for (const e of [...gA, ...gS]) expect(Object.keys(e.payload).sort()).toEqual(['actorId', 'at', 'data', 'entityId', 'farmId', 'name']);
    });

    it('publishes nothing for failed or replayed operations', async () => {
      const sales = await connectAs('sales');
      const sub = await subscribe(sales, { topics: ['sales', 'inventory', 'payments'] });
      expect(sub.denied).toEqual([{ topic: 'payments', reason: 'forbidden' }]); // may record payments, not read them
      const got = record(sales, NAMES);
      await post('/sales', 'sales', { items: [{ unit: 'CARTON', quantity: 9000 }] }).expect(409); // insufficient stock → rollback
      const clientId = randomUUID();
      await post('/sales', 'sales', { items: [{ unit: 'CARTON', quantity: 1 }], clientId }).expect(201);
      await until(() => got.length >= 2);
      const before = got.length;
      await post('/sales', 'sales', { items: [{ unit: 'CARTON', quantity: 1 }], clientId }).expect(200); // idempotent replay
      await sleep(400);
      expect(got.length).toBe(before);
      expect(got.map((e) => e.name).sort()).toEqual(['inventory.updated', 'sale.created']);
    });

    it('sends a coalesced dashboard.invalidate hint to dashboard subscribers only', async () => {
      const acct = await connectAs('acct'); const prod = await connectAs('prod');
      await subscribe(acct, { topics: ['dashboard'] });
      const bad = await subscribe(prod, { topics: ['dashboard'] });
      expect(bad.denied?.[0]).toMatchObject({ topic: 'dashboard', reason: 'forbidden' });
      const gA = record(acct, ['dashboard.invalidate']); const gP = record(prod, ['dashboard.invalidate']);
      await Promise.all([1, 2, 3].map(() => post('/expenses', 'manager', { categoryCode: 'FEED', description: 'burst', total: '10' }).expect(201)));
      await until(() => gA.length >= 1);
      await sleep(700);
      expect(gA.length).toBeLessThanOrEqual(2); // three writes in a burst collapse into (at most a couple of) hints
      expect(gA.length).toBeGreaterThanOrEqual(1);
      expect(gP).toEqual([]);
      const after = (await get('/dashboard', 'acct').expect(200)).body; // and the refetch shows the new numbers
      expect(after.expenses.todayCount).toBeGreaterThanOrEqual(3);
    });

    it('delivers user-targeted notifications only to that user’s own devices, and system alerts only to settings managers', async () => {
      const bus = app.get(DomainEvents);
      const a1 = await connectAs('sales'); const a2 = await connect((await signIn(app, users.sales.email, PASSWORD, { 'X-Device-Name': 'second' })).accessToken);
      const b = await connectAs('manager'); const admin = await connectAs('admin');
      await subscribe(admin, { topics: ['system'] });
      const mgrSub = await subscribe(b, { topics: ['system'] });
      expect(mgrSub.denied?.[0].reason).toBe('forbidden');
      const g1 = record(a1, NAMES); const g2 = record(a2, NAMES); const gb = record(b, NAMES); const ga = record(admin, NAMES);
      bus.emit({ name: 'notification.created', entityId: randomUUID(), data: { userId: users.sales.id, category: 'SALES' } });
      bus.emit({ name: 'system.alert', entityId: randomUUID(), data: { level: 'warning' } });
      await until(() => g1.length === 1 && g2.length === 1 && ga.length === 1);
      expect(g1[0].name).toBe('notification.created');
      expect(gb).toEqual([]);
      expect(ga[0].name).toBe('system.alert');
      expect(g1.some((e) => e.name === 'system.alert')).toBe(false);
    });
  });

  // ───────────────────────── connection lifetime ─────────────────────────
  describe('connection lifecycle and revocation', () => {
    it('disconnects a user immediately when an administrator disables them (others unaffected)', async () => {
      const u = await makeUser(prisma, { roles: ['SALES_STAFF'] });
      const t = (await signIn(app, u.email)).accessToken;
      const victim = await connect(t); const bystander = await connectAs('sales');
      await subscribe(victim, { topics: ['sales'] });
      const reason = revokedReason(victim);
      await post(`/users/${u.id}/disable`, 'admin', { reason: 'account compromised' }).expect(200);
      expect(await reason).toMatch(/session_revoked|account_disabled/);
      await until(() => victim.disconnected, 1500);
      expect(bystander.connected).toBe(true);
      const got = record(bystander, ['sale.created']); // and events still reach everyone else
      await subscribe(bystander, { topics: ['sales'] });
      await post('/sales', 'sales', { items: [{ unit: 'CARTON', quantity: 1 }] }).expect(201);
      await until(() => got.length === 1);
    });

    it('logout drops only that device; logout-all drops every device; admin session revoke drops the user', async () => {
      const u = await makeUser(prisma, { roles: ['SALES_STAFF'] });
      const a = await signIn(app, u.email, PASSWORD, { 'X-Device-Name': 'A' });
      const b = await signIn(app, u.email, PASSWORD, { 'X-Device-Name': 'B' });
      const sa = await connect(a.accessToken); const sb = await connect(b.accessToken);
      await api(app).post('/v1/auth/logout').set(bearer(a.accessToken)).expect(204);
      await until(() => sa.disconnected, 1500);
      expect(sb.connected).toBe(true);
      const c = await signIn(app, u.email, PASSWORD, { 'X-Device-Name': 'C' });
      const sc = await connect(c.accessToken);
      await api(app).post('/v1/auth/logout-all').set(bearer(c.accessToken)).expect(204);
      await until(() => sb.disconnected && sc.disconnected, 1500);
      const d = await signIn(app, u.email, PASSWORD, { 'X-Device-Name': 'D' });
      const sd = await connect(d.accessToken);
      await api(app).delete(`/v1/users/${u.id}/sessions`).set(bearer(users.admin.token)).send({ reason: 'lost phone' }).expect(200);
      await until(() => sd.disconnected, 1500);
    });

    it('a password change keeps the current device connected and drops the others', async () => {
      const u = await makeUser(prisma, { roles: ['SALES_STAFF'] });
      const a = await signIn(app, u.email, PASSWORD, { 'X-Device-Name': 'A' });
      const b = await signIn(app, u.email, PASSWORD, { 'X-Device-Name': 'B' });
      const sa = await connect(a.accessToken); const sb = await connect(b.accessToken);
      await api(app).post('/v1/auth/change-password').set(bearer(a.accessToken)).send({ currentPassword: PASSWORD, newPassword: 'meadow-gravel-orbit-58' }).expect(204);
      await until(() => sb.disconnected, 1500);
      await sleep(200);
      expect(sa.connected).toBe(true);
    });

    it('stops delivering topics as soon as a role change removes the permission (connection stays up)', async () => {
      const u = await makeUser(prisma, { roles: ['SALES_STAFF'] });
      const t = (await signIn(app, u.email)).accessToken;
      const s = await connect(t);
      await subscribe(s, { topics: ['sales', 'inventory'] });
      const got = record(s, ['sale.created', 'inventory.updated', 'subscription.revoked']);
      await post('/sales', 'sales', { items: [{ unit: 'CARTON', quantity: 1 }] }).expect(201);
      await until(() => got.some((e) => e.name === 'sale.created'));
      await put(`/users/${u.id}/roles`, 'admin', { roleCodes: ['PRODUCTION_STAFF'], reason: 'moved to production' }).expect(200);
      await until(() => got.filter((e) => e.name === 'subscription.revoked').length === 2);
      expect(got.filter((e) => e.name === 'subscription.revoked').map((e) => e.payload.topic).sort()).toEqual(['inventory', 'sales']);
      got.length = 0;
      await post('/sales', 'sales', { items: [{ unit: 'CARTON', quantity: 1 }] }).expect(201);
      await sleep(500);
      expect(got).toEqual([]);
      expect(s.connected).toBe(true);
    });

    it('re-checks everyone when a role’s permissions are edited', async () => {
      const s = await connectAs('sales');
      await subscribe(s, { topics: ['sales'] });
      const got = record(s, ['sale.created', 'subscription.revoked']);
      const role = await prisma.role.findUniqueOrThrow({ where: { code: 'SALES_STAFF' }, include: { permissions: { include: { permission: true } } } });
      const codes = role.permissions.map((p) => p.permission.code);
      try {
        await put(`/roles/${role.id}/permissions`, 'admin', { permissionCodes: codes.filter((c) => c !== 'sales.read'), reason: 'temporary lock-down' }).expect(200);
        await until(() => got.some((e) => e.name === 'subscription.revoked'));
        await post('/sales', 'owner', { items: [{ unit: 'CARTON', quantity: 1 }] }).expect(201);
        await sleep(400);
        expect(got.some((e) => e.name === 'sale.created')).toBe(false);
      } finally {
        await put(`/roles/${role.id}/permissions`, 'admin', { permissionCodes: codes, reason: 'restore permissions' }).expect(200);
      }
    });

    it('closes the connection when the access token expires, after warning the client', async () => {
      const claims = await prisma.session.findFirstOrThrow({ where: { userId: users.prod.id, revokedAt: null } });
      const user = await prisma.user.findUniqueOrThrow({ where: { id: users.prod.id } });
      const short = jwt.sign({ typ: 'access', tv: user.tokenVersion, fid: claims.familyId }, { subject: users.prod.id, issuer: 'makarifor-api', audience: 'makarifor-app', expiresIn: 2 });
      const s = await connect(short);
      await until(() => seenOf(s).some((e) => e.name === 'auth.expiring'), 2500); // warning arrives first (token lives < 60 s)
      expect(await revokedReason(s)).toBe('token_expired');
      await until(() => s.disconnected, 1500);
    });

    it('lets a client extend the connection with a fresh token (same user only)', async () => {
      const session = await prisma.session.findFirstOrThrow({ where: { userId: users.manager.id, revokedAt: null } });
      const user = await prisma.user.findUniqueOrThrow({ where: { id: users.manager.id } });
      const short = jwt.sign({ typ: 'access', tv: user.tokenVersion, fid: session.familyId }, { subject: users.manager.id, issuer: 'makarifor-api', audience: 'makarifor-app', expiresIn: 2 });
      const s = await connect(short);
      const ack = await new Promise<{ ok: boolean; expiresAt?: string }>((r) => s.emit('reauth', { accessToken: users.manager.token }, r));
      expect(ack.ok).toBe(true);
      await sleep(2600);
      expect(s.connected).toBe(true); // survived the original expiry

      const other = await connectAs('owner');
      const revoked = revokedReason(other);
      const bad = await new Promise<{ ok: boolean }>((r) => other.emit('reauth', { accessToken: users.admin.token }, r)); // someone else's token
      expect(bad.ok).toBe(false);
      expect(await revoked).toBe('reauth_failed');
      await until(() => other.disconnected, 1500);

      const junk = await connectAs('owner');
      const ack2 = await new Promise<{ ok: boolean }>((r) => junk.emit('reauth', { accessToken: 'nope' }, r));
      expect(ack2.ok).toBe(false);
      await until(() => junk.disconnected, 1500);
    });
  });

  // ───────────────────────── observability of failures ─────────────────────────
  describe('robustness', () => {
    it('a misbehaving event subscriber cannot break business operations', async () => {
      const bus = app.get(DomainEvents);
      const off = bus.on('sale.created', () => { throw new Error('buggy listener'); });
      try {
        await post('/sales', 'sales', { items: [{ unit: 'CARTON', quantity: 1 }] }).expect(201);
      } finally { off(); }
    });

    it('does not expose the realtime endpoint to browsers from arbitrary origins', async () => {
      const res = await fetch(`${url}/realtime/?EIO=4&transport=polling`, { headers: { Origin: 'https://evil.example' } });
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    });
  });
});
