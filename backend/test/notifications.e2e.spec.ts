import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { io, Socket } from 'socket.io-client';
import { totpAt } from './helpers';
import { AuditService } from '../src/audit/audit.service';
import { MailService } from '../src/mail/mail.service';
import { NotificationScheduler } from '../src/notifications/notification.scheduler';
import { NotificationsService } from '../src/notifications/notifications.service';
import { PUSH_PROVIDER, PushMessage, PushProvider, PushReceipt, PushTicket, PushTransportError } from '../src/notifications/push/push.provider';
import { api, bearer, createApp, login, makeUser, PASSWORD, seed, signIn, useIsolatedSchema } from './helpers';

/** Push provider double: records everything "sent" and can be scripted to fail. */
class FakePush implements PushProvider {
  readonly name = 'fake';
  enabled = true;
  sent: PushMessage[] = [];
  private n = 0;
  nextTickets: (PushTicket | 'throw')[] = [];
  receiptMap: Record<string, PushReceipt> = {};
  async send(messages: PushMessage[]): Promise<PushTicket[]> {
    this.sent.push(...messages);
    if (this.nextTickets[0] === 'throw') { this.nextTickets.shift(); throw new PushTransportError('down'); }
    return messages.map(() => (this.nextTickets.shift() as PushTicket | undefined) ?? { status: 'ok', id: `ticket-${++this.n}` });
  }
  async receipts(ids: string[]): Promise<Record<string, PushReceipt>> { return Object.fromEntries(ids.filter((i) => this.receiptMap[i]).map((i) => [i, this.receiptMap[i]])); }
  to(token: string) { return this.sent.filter((m) => m.to === token); }
}

const today = () => new Date().toISOString().slice(0, 10);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tokenFor = (name: string) => `ExponentPushToken[${name.padEnd(12, 'x')}${randomUUID().replace(/-/g, '').slice(0, 10)}]`;

describe('Notifications: rules, privacy, preferences, delivery tracking, scheduler, realtime (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let push: FakePush;
  let notif: NotificationsService;
  let scheduler: NotificationScheduler;
  let mail: MailService;
  let baseUrl: string;
  let farmId: string;
  let coop1: string;
  let coop2: string;
  type Who = 'admin' | 'admin2' | 'owner' | 'manager' | 'prod' | 'sales' | 'acct';
  const users = {} as Record<Who, { id: string; email: string; token: string; refresh: string; device: string }>;
  const open: Socket[] = [];

  const post = (path: string, who: Who, body?: object) => api(app).post(`/v1${path}`).set(bearer(users[who].token)).send(body);
  const get = (path: string, who: Who) => api(app).get(`/v1${path}`).set(bearer(users[who].token));
  const put = (path: string, who: Who, body: object) => api(app).put(`/v1${path}`).set(bearer(users[who].token)).send(body);
  const settle = async () => { await notif.drain(); };
  const notesOf = (who: Who, type?: string) => prisma.notification.findMany({ where: { userId: users[who].id, ...(type ? { type } : {}) }, orderBy: { createdAt: 'asc' } });
  const countOf = async (who: Who, type: string) => (await notesOf(who, type)).length;

  beforeAll(async () => {
    process.env.THROTTLE_OFF = '1';
    await useIsolatedSchema('notif');
    push = new FakePush();
    ({ app, prisma, mail } = await createApp((b) => b.overrideProvider(PUSH_PROVIDER).useValue(push)));
    await app.listen(0);
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}`;
    notif = app.get(NotificationsService);
    scheduler = app.get(NotificationScheduler);
    await seed(prisma);
    await prisma.role.updateMany({ data: { mfaRequired: false } });
    farmId = (await prisma.farm.create({ data: { name: 'Notif Farm' } })).id;
    coop1 = (await prisma.coop.create({ data: { farmId, name: 'Coop 1' } })).id;
    coop2 = (await prisma.coop.create({ data: { farmId, name: 'Coop 2' } })).id;
    const carton = await prisma.productUnit.findFirstOrThrow({ where: { code: 'CARTON' } });
    await prisma.price.create({ data: { productUnitId: carton.id, amount: new Prisma.Decimal('1550'), effectiveFrom: new Date('2026-01-01T00:00:00Z') } });
    for (const [k, role] of [['admin', 'SUPER_ADMIN'], ['admin2', 'SUPER_ADMIN'], ['owner', 'OWNER'], ['manager', 'FARM_MANAGER'], ['prod', 'PRODUCTION_STAFF'], ['sales', 'SALES_STAFF'], ['acct', 'ACCOUNTANT']] as const) {
      const u = await makeUser(prisma, { roles: [role], fullName: `${k} user` });
      const s = await signIn(app, u.email, PASSWORD, { 'X-Device-Name': `${k}-phone` });
      users[k] = { id: u.id, email: u.email, token: s.accessToken, refresh: s.refreshToken, device: tokenFor(k) };
    }
    await settle();
    // owner deliberately has NO push device: in-app only
    for (const k of ['admin', 'admin2', 'manager', 'prod', 'sales', 'acct'] as const) await post('/notifications/devices', k, { pushToken: users[k].device, platform: 'android', deviceName: `${k}-phone` }).expect(201);
    await post('/inventory/adjustments', 'manager', { type: 'ADJUSTMENT', direction: 'INCREASE', unit: 'CARTON', quantity: 100, reason: 'opening stock for notification tests' }).expect(201);
    await settle();
    push.sent.length = 0;
  });
  afterEach(() => { for (const s of open.splice(0)) s.close(); });
  afterAll(async () => { await prisma.$disconnect(); await app.close(); });

  // ───────────────────────── devices & test push ─────────────────────────
  describe('push devices', () => {
    it('registers valid Expo tokens only, moves a token to the new owner, and lets users remove only their own', async () => {
      for (const bad of ['', 'nope', 'ExponentPushToken[]', "ExponentPushToken[x'; DROP TABLE y;--zzzz]", 'fcm:APA91bxxxxxxxxxx']) await post('/notifications/devices', 'sales', { pushToken: bad, platform: 'ios' }).expect(400);
      await post('/notifications/devices', 'sales', { pushToken: tokenFor('x'), platform: 'windows' }).expect(400);
      await post('/notifications/devices', 'sales', { pushToken: tokenFor('x'), platform: 'ios', isAdmin: true }).expect(400);
      const shared = tokenFor('shared');
      await post('/notifications/devices', 'sales', { pushToken: shared, platform: 'ios' }).expect(201);
      await post('/notifications/devices', 'acct', { pushToken: shared, platform: 'ios' }).expect(201); // phone changed hands
      const row = await prisma.notificationDevice.findUniqueOrThrow({ where: { pushToken: shared } });
      expect(row.userId).toBe(users.acct.id);
      await api(app).delete('/v1/notifications/devices').set(bearer(users.sales.token)).send({ pushToken: shared }).expect(204); // not theirs any more
      expect(await prisma.notificationDevice.count({ where: { pushToken: shared } })).toBe(1);
      await api(app).delete('/v1/notifications/devices').set(bearer(users.acct.token)).send({ pushToken: shared }).expect(204);
      expect(await prisma.notificationDevice.count({ where: { pushToken: shared } })).toBe(0);
      await api(app).post('/v1/notifications/devices').send({ pushToken: shared, platform: 'ios' }).expect(401);
    });

    it('sends a test notification to the caller’s own devices only', async () => {
      push.sent.length = 0;
      const r = await post('/notifications/test', 'manager').expect(200);
      expect(r.body).toEqual({ sent: 1, provider: 'fake' });
      expect(push.sent.map((m) => m.to)).toEqual([users.manager.device]);
      expect(push.sent[0]).toMatchObject({ channelId: 'system', title: 'Makarifor', body: 'Test notification.' });
    });
  });

  // ───────────────────────── rules, recipients & privacy ─────────────────────────
  describe('role-based rules and lock-screen privacy', () => {
    it('notifies managers (not the actor, not unrelated roles) with details in-app but generic text in the push', async () => {
      push.sent.length = 0;
      const r = await post('/production', 'prod', { coopId: coop1, shift: 'MORNING', entries: [{ unit: 'CARTON', quantity: 1 }, { unit: 'CRATE', quantity: 7 }] }).expect(201);
      await settle();
      const [n] = await notesOf('manager', 'production.recorded');
      expect(n).toMatchObject({ category: 'PRODUCTION', title: 'Production recorded', entityType: 'production_record', entityId: r.body.id });
      expect(n.body).toBe('Coop 1 morning: 570 eggs.'); // details are fine inside the authenticated app
      expect(await notesOf('prod', 'production.recorded')).toHaveLength(0); // never the person who did it
      for (const k of ['sales', 'acct', 'owner'] as const) expect(await notesOf(k, 'production.recorded')).toHaveLength(0);
      const pushes = push.to(users.manager.device);
      expect(pushes).toHaveLength(1);
      expect(pushes[0]).toMatchObject({ title: 'Production recorded', body: 'New production was recorded.', channelId: 'production', priority: 'default' });
      expect(JSON.stringify(pushes[0])).not.toMatch(/570|Coop 1|eggs/i);
      expect(Object.keys(pushes[0].data).sort()).toEqual(['entityId', 'entityType', 'notificationId', 'type']); // ids only
      expect(pushes[0].data.notificationId).toBe(n.id);
    });

    it('routes financial notifications only to roles and permissions that may see finance', async () => {
      await prisma.systemSetting.update({ where: { key: 'sales.creditEnabled' }, data: { value: true } });
      const cust = (await post('/customers', 'owner', { name: 'Mama Kadi', creditAllowed: true, creditLimit: '5000' }).expect(201)).body.id;
      push.sent.length = 0;
      const sale = (await post('/sales', 'sales', { items: [{ unit: 'CARTON', quantity: 1 }], customerId: cust, amountPaid: '500' }).expect(201)).body;
      await post('/expenses', 'manager', { categoryCode: 'FEED', description: 'Concentrate', quantity: '8', unitCost: '1400' }).expect(201);
      await post('/payments', 'acct', { saleId: sale.id, amount: '300' }).expect(201);
      await settle();

      // sale alerts: owner + manager (not the seller, not production staff, not the accountant)
      expect((await notesOf('owner', 'sale.created'))[0].body).toMatch(/^S-\d{8}-[0-9A-F]{8}: NLe 1,550\.$/);
      expect(await countOf('manager', 'sale.created')).toBe(1);
      for (const k of ['sales', 'prod', 'acct', 'admin'] as const) expect(await countOf(k, 'sale.created')).toBe(0);
      // the till payment is covered by the sale alert; only the LATER payment produces "payment received"
      expect(await countOf('owner', 'payment.received')).toBe(1);
      expect((await notesOf('owner', 'payment.received'))[0].body).toMatch(/^NLe 300 on S-/);
      expect(await countOf('acct', 'payment.received')).toBe(0); // the accountant recorded it
      expect(await countOf('manager', 'payment.received')).toBe(0);
      // expense alerts: owner + manager minus actor
      expect(await countOf('owner', 'expense.recorded')).toBe(1);
      expect(await countOf('manager', 'expense.recorded')).toBe(0);
      // production staff never see any financial notification
      const prodTypes = (await prisma.notification.findMany({ where: { userId: users.prod.id } })).map((n) => n.type);
      expect(prodTypes.filter((t) => /sale|expense|payment/.test(t))).toEqual([]);
      // no lock-screen leak anywhere
      expect(JSON.stringify(push.sent)).not.toMatch(/1,?550|11,?200|300|Mama Kadi|Concentrate|S-\d{8}/);
    });

    it('sends "large sale" alerts only when configured, and only to the owner', async () => {
      await put('/notifications/config', 'owner', { largeSaleThreshold: '3000' }).expect(200);
      await post('/sales', 'sales', { items: [{ unit: 'CARTON', quantity: 1 }] }).expect(201); // 1550: below
      await post('/sales', 'sales', { items: [{ unit: 'CARTON', quantity: 3 }] }).expect(201); // 4650: above
      await settle();
      const large = await notesOf('owner', 'sale.large');
      expect(large).toHaveLength(1);
      expect(large[0].body).toMatch(/NLe 4,650\./);
      expect(await countOf('manager', 'sale.large')).toBe(0);
      await put('/notifications/config', 'owner', { largeSaleThreshold: null }).expect(200);
    });

    it('alerts once about low stock and about adjustments, without repeating', async () => {
      const bal = (await prisma.inventoryBalance.findFirstOrThrow({ where: { farmId } })).quantityEggs;
      await post('/inventory/adjustments', 'manager', { type: 'LOSS', unit: 'EGG', quantity: bal - 500, reason: 'flood loss test' }).expect(201);
      await settle();
      const low = await notesOf('owner', 'inventory.low');
      expect(low).toHaveLength(1);
      expect(low[0].body).toBe('Stock is 500 eggs, below the configured threshold of 1,000 eggs.');
      for (const k of ['manager', 'sales'] as const) expect(await countOf(k, 'inventory.low')).toBe(1); // sales staff need availability
      for (const k of ['prod', 'acct'] as const) expect(await countOf(k, 'inventory.low')).toBe(0);
      await post('/inventory/adjustments', 'manager', { type: 'DAMAGE', unit: 'EGG', quantity: 5, reason: 'cracked in test' }).expect(201);
      await settle();
      expect(await countOf('owner', 'inventory.low')).toBe(1); // de-duplicated within 24 h
      expect(await countOf('owner', 'inventory.adjusted')).toBe(3); // opening stock + loss + damage
      expect(await countOf('manager', 'inventory.adjusted')).toBe(0); // the actor / not in audience
      expect(await countOf('admin', 'inventory.adjusted')).toBe(3);
      await post('/inventory/adjustments', 'manager', { type: 'ADJUSTMENT', direction: 'INCREASE', unit: 'CARTON', quantity: 100, reason: 'restock after test' }).expect(201);
      await settle();
    });

    it('warns the owner once when monthly expenses pass the configured threshold', async () => {
      await put('/notifications/config', 'owner', { monthlyExpenseThreshold: '1000' }).expect(200);
      await post('/expenses', 'manager', { categoryCode: 'FEED', description: 'Corn A', total: '600' }).expect(201);
      await post('/expenses', 'manager', { categoryCode: 'FEED', description: 'Corn B', total: '600' }).expect(201);
      await post('/expenses', 'manager', { categoryCode: 'FEED', description: 'Corn C', total: '600' }).expect(201);
      await settle();
      const thr = (await prisma.notification.findMany({ where: { userId: users.owner.id, type: { startsWith: 'expense.threshold.' } } }));
      expect(thr).toHaveLength(1);
      expect(thr[0].title).toBe('Monthly expense threshold exceeded');
      await put('/notifications/config', 'owner', { monthlyExpenseThreshold: null }).expect(200);
    });

    it('tells users about offline sync outcomes: attention needed buzzes the phone, plain success does not', async () => {
      push.sent.length = 0;
      const ok = randomUUID();
      await api(app).post('/v1/sync/push').set(bearer(users.sales.token)).send({ deviceId: 'd1', operations: [{ clientId: ok, type: 'customer.create', payload: { name: 'Synced Customer' } }] }).expect(200);
      await settle();
      expect((await notesOf('sales', 'sync.done'))[0]).toMatchObject({ category: 'SYNC', title: 'Offline records synchronized', body: '1 record(s) were synchronized.' });
      expect(push.to(users.sales.device)).toHaveLength(0);
      await api(app).post('/v1/sync/push').set(bearer(users.sales.token)).send({ deviceId: 'd1', operations: [{ clientId: randomUUID(), type: 'sale.create', payload: { items: [{ unit: 'CARTON', quantity: 90000 }] } }] }).expect(200);
      await settle();
      expect((await notesOf('sales', 'sync.attention'))[0].body).toBe('1 record(s) need your attention. Open Sync status to fix, retry or discard them.');
      expect(push.to(users.sales.device).map((m) => m.body)).toEqual(['Some records could not be synchronized.']);
    });
  });

  // ───────────────────────── preferences ─────────────────────────
  describe('preferences', () => {
    it('lets users mute non-critical categories and never lets them mute security, administration or system notices', async () => {
      const p = (await get('/notifications/preferences', 'manager').expect(200)).body.preferences;
      expect(p.find((x: { category: string }) => x.category === 'SECURITY')).toEqual({ category: 'SECURITY', mutable: false, enabled: true });
      expect(p.find((x: { category: string }) => x.category === 'PRODUCTION')).toEqual({ category: 'PRODUCTION', mutable: true, enabled: true });
      for (const c of ['SECURITY', 'ADMIN', 'SYSTEM']) await put('/notifications/preferences', 'manager', { preferences: [{ category: c, enabled: false }] }).expect(400);
      await put('/notifications/preferences', 'manager', { preferences: [{ category: 'BOGUS', enabled: false }] }).expect(400);
      await put('/notifications/preferences', 'manager', { preferences: [{ category: 'PRODUCTION', enabled: 'no' }] }).expect(400);

      try {
        await put('/notifications/preferences', 'manager', { preferences: [{ category: 'PRODUCTION', enabled: false }, { category: 'SECURITY', enabled: true }] }).expect(200);
        const before = await countOf('manager', 'production.recorded');
        push.sent.length = 0;
        await post('/production', 'prod', { coopId: coop2, shift: 'MORNING', entries: [{ unit: 'CRATE', quantity: 10 }] }).expect(201);
        await settle();
        expect(await countOf('manager', 'production.recorded')).toBe(before); // muted: no record, no push
        expect(push.to(users.manager.device)).toHaveLength(0);

        // …but a security notice still arrives while everything else is muted
        await login(app, users.manager.email, PASSWORD, { 'X-Device-Name': 'brand-new-tablet' }).expect(200);
        await settle();
        expect((await notesOf('manager', 'security.new_device')).filter((n) => n.body.includes('brand-new-tablet'))).toHaveLength(1);

      } finally {
        await put('/notifications/preferences', 'manager', { preferences: [{ category: 'PRODUCTION', enabled: true }] }).expect(200);
      }
    });
  });

  // ───────────────────────── security & administration ─────────────────────────
  describe('security and administration notifications', () => {
    it('warns about a new device once, with generic lock-screen text and high priority', async () => {
      push.sent.length = 0;
      const dev = { 'X-Device-Name': `laptop-${randomUUID().slice(0, 6)}`, 'X-Platform': 'ios' };
      await login(app, users.sales.email, PASSWORD, dev).expect(200);
      await login(app, users.sales.email, PASSWORD, dev).expect(200); // same device: nothing new
      await settle();
      const list = (await notesOf('sales', 'security.new_device')).filter((n) => n.body.includes(dev['X-Device-Name']));
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ category: 'SECURITY', title: 'New device signed in' });
      const m = push.to(users.sales.device).filter((x) => x.data.type === 'security.new_device');
      expect(m).toHaveLength(1);
      expect(m[0]).toMatchObject({ title: 'Security alert', body: 'A new device signed into your account.', channelId: 'security', priority: 'high' });
      expect(JSON.stringify(m[0])).not.toContain('laptop');
    });

    it('notifies on password change and on MFA enable / disable', async () => {
      const u = await makeUser(prisma, { roles: ['SALES_STAFF'] });
      const s = await signIn(app, u.email);
      await api(app).post('/v1/auth/change-password').set(bearer(s.accessToken)).send({ currentPassword: PASSWORD, newPassword: 'meadow-gravel-orbit-58' }).expect(204);
      const enroll = await api(app).post('/v1/auth/mfa/enroll').set(bearer(s.accessToken)).expect(200);
      await api(app).post('/v1/auth/mfa/confirm').set(bearer(s.accessToken)).send({ code: totpAt(enroll.body.secret, Date.now()) }).expect(200);
      const real = Date.now;
      jest.spyOn(Date, 'now').mockImplementation(() => real() + 31_000);
      try { await api(app).post('/v1/auth/mfa/disable').set(bearer(s.accessToken)).send({ password: 'meadow-gravel-orbit-58', code: totpAt(enroll.body.secret, Date.now()) }).expect(204); } finally { jest.restoreAllMocks(); }
      await settle();
      const types = (await prisma.notification.findMany({ where: { userId: u.id } })).map((n) => n.type).sort();
      expect(types).toEqual(expect.arrayContaining(['security.password_changed', 'security.mfa_enabled', 'security.mfa_disabled']));
      expect((await prisma.notification.findMany({ where: { userId: u.id, category: 'SECURITY' } })).length).toBe(types.length);
    });

    it('reports repeated failed logins to the account owner and to Super Admins', async () => {
      const u = await makeUser(prisma, { roles: ['SALES_STAFF'], fullName: 'Locked Out Person' });
      const adminBefore = await countOf('admin', 'admin.account_locked');
      for (let i = 0; i < 5; i++) await login(app, u.email, 'wrong-password-123').expect(401);
      await settle();
      const mine = await prisma.notification.findMany({ where: { userId: u.id, type: 'security.account_locked' } });
      expect(mine).toHaveLength(1);
      expect(mine[0].body).toMatch(/locked for 1 minute/);
      expect(await countOf('admin', 'admin.account_locked')).toBe(adminBefore + 1);
      const adminNote = (await notesOf('admin', 'admin.account_locked')).pop()!;
      expect(adminNote).toMatchObject({ category: 'SECURITY' });
      expect(adminNote.body).toContain('Locked Out Person');
      for (const k of ['manager', 'sales', 'prod'] as const) expect(await countOf(k, 'admin.account_locked')).toBe(0); // not for ordinary staff
    });

    it('warns a user whose refresh token was replayed', async () => {
      const u = await makeUser(prisma, { roles: ['SALES_STAFF'] });
      const s = await signIn(app, u.email);
      await api(app).post('/v1/auth/refresh').send({ refreshToken: s.refreshToken }).expect(200);
      await api(app).post('/v1/auth/refresh').send({ refreshToken: s.refreshToken }).expect(401); // replay
      await settle();
      expect(await prisma.notification.count({ where: { userId: u.id, type: 'security.refresh_reuse' } })).toBe(1);
    });

    it('tells the user AND the administrators (but not the acting admin) when a role changes', async () => {
      const u = await makeUser(prisma, { roles: ['SALES_STAFF'], fullName: 'Role Change Person' });
      const before = { owner: await countOf('owner', 'admin.role_changed'), admin2: await countOf('admin2', 'admin.role_changed'), actor: await countOf('admin', 'admin.role_changed') };
      await put(`/users/${u.id}/roles`, 'admin', { roleCodes: ['PRODUCTION_STAFF'], reason: 'moved to production' }).expect(200);
      await settle();
      expect(await prisma.notification.count({ where: { userId: u.id, type: 'security.role_changed' } })).toBe(1);
      expect(await countOf('owner', 'admin.role_changed')).toBe(before.owner + 1);
      expect(await countOf('admin2', 'admin.role_changed')).toBe(before.admin2 + 1);
      expect(await countOf('admin', 'admin.role_changed')).toBe(before.actor); // never the person who did it
      expect((await notesOf('owner', 'admin.role_changed')).pop()!.body).toContain('Role Change Person');
      expect(await countOf('manager', 'admin.role_changed')).toBe(0);
    });

    it('a DISABLED user gets no business notifications but is told their account was disabled; admins are informed', async () => {
      const u = await makeUser(prisma, { roles: ['FARM_MANAGER'], fullName: 'Soon Disabled' });
      const dev = tokenFor('disabled');
      const s = await signIn(app, u.email);
      await api(app).post('/v1/notifications/devices').set(bearer(s.accessToken)).send({ pushToken: dev, platform: 'android' }).expect(201);
      await post(`/users/${u.id}/disable`, 'admin', { reason: 'left the company' }).expect(200);
      await settle();
      expect(await prisma.notification.count({ where: { userId: u.id, type: 'security.account_disabled' } })).toBe(1);
      expect(push.to(dev).map((m) => m.body)).toEqual(['Your account has been disabled.']);
      expect(await countOf('owner', 'admin.user_disabled')).toBeGreaterThanOrEqual(1);
      push.sent.length = 0;
      await post('/production', 'prod', { coopId: coop1, shift: 'AFTERNOON', entries: [{ unit: 'CRATE', quantity: 3 }] }).expect(201);
      await settle();
      expect(await prisma.notification.count({ where: { userId: u.id, type: 'production.recorded' } })).toBe(0); // business notices stop immediately
      expect(push.to(dev)).toHaveLength(0);
    });

    it('defence in depth: a stray "muted" row cannot silence security notices, and a disabled user is skipped even when named directly', async () => {
      const u = await makeUser(prisma, { roles: ['FARM_MANAGER'] });
      await prisma.notificationPreference.create({ data: { userId: u.id, category: 'SECURITY', enabled: false } }); // could only exist through a bug or manual DB edit
      await prisma.notificationPreference.create({ data: { userId: u.id, category: 'SALES', enabled: false } });
      const spec = (category: 'SECURITY' | 'SALES', type: string) => ({ category, type, recipients: [u.id], title: 't', body: 'b', push: false as const });
      expect(await notif.notify(spec('SECURITY', 'test.security'))).toHaveLength(1); // cannot be muted
      expect(await notif.notify(spec('SALES', 'test.sales'))).toHaveLength(0); // ordinary categories honour the mute
      await prisma.user.update({ where: { id: u.id }, data: { status: 'DISABLED' } });
      expect(await notif.notify({ ...spec('SECURITY', 'test.security2') })).toHaveLength(0); // disabled: nothing…
      expect(await notif.notify({ ...spec('SECURITY', 'test.security3'), allowInactive: true })).toHaveLength(1); // …except the explicit "account disabled" exception
      await prisma.user.update({ where: { id: u.id }, data: { deletedAt: new Date() } });
      expect(await notif.notify({ ...spec('SECURITY', 'test.security4'), allowInactive: true })).toHaveLength(0); // deleted users never
    });

    it('announces new accounts to administrators only', async () => {
      const before = await countOf('owner', 'admin.user_created');
      await post('/users/invite', 'admin', { email: `new${Date.now()}@example.com`, fullName: 'Brand New Hire', roleCodes: ['SALES_STAFF'] }).expect(201);
      await settle();
      expect(await countOf('owner', 'admin.user_created')).toBe(before + 1);
      expect((await notesOf('owner', 'admin.user_created')).pop()!.body).toBe('An account was created for Brand New Hire.');
      expect(await countOf('manager', 'admin.user_created')).toBe(0);
    });
  });

  // ───────────────────────── notification center ─────────────────────────
  describe('notification center', () => {
    it('lists, filters and paginates only the caller’s notifications, with an unread counter', async () => {
      const total = await prisma.notification.count({ where: { userId: users.owner.id } });
      const page = (await get('/notifications?limit=3', 'owner').expect(200)).body;
      expect(page.items).toHaveLength(3);
      expect(page.total).toBe(total);
      expect(page.unread).toBe(total); // nothing read yet
      expect(page.items[0].createdAt >= page.items[1].createdAt).toBe(true); // newest first
      expect(page.items[0]).toEqual(expect.objectContaining({ id: expect.any(String), category: expect.any(String), type: expect.any(String), title: expect.any(String), body: expect.any(String), read: false }));
      const sales = (await get('/notifications?category=SALES&limit=100', 'owner').expect(200)).body;
      expect(sales.items.length).toBeGreaterThan(0);
      expect(sales.items.every((n: { category: string }) => n.category === 'SALES')).toBe(true);
      expect((await get('/notifications/unread-count', 'owner').expect(200)).body).toEqual({ unread: total });
      await get('/notifications?limit=101', 'owner').expect(400);
      await get('/notifications?category=NOPE', 'owner').expect(400);
      await get('/notifications?status=maybe', 'owner').expect(400);
      await api(app).get('/v1/notifications').expect(401);
      const mine = (await get('/notifications?limit=100', 'owner').expect(200)).body.items.map((n: { id: string }) => n.id);
      const theirs = (await get('/notifications?limit=100', 'manager').expect(200)).body.items.map((n: { id: string }) => n.id);
      expect(mine.filter((id: string) => theirs.includes(id))).toEqual([]); // no overlap: strictly per user
    });

    it('marks single, category and all notifications read; another user’s notification is simply not found', async () => {
      const first = (await get('/notifications?limit=1&status=unread', 'owner').expect(200)).body.items[0];
      await get(`/notifications/${first.id}`, 'manager').expect(404);
      await post(`/notifications/${first.id}/read`, 'manager').expect(404);
      await post(`/notifications/${first.id}/opened`, 'manager').expect(404);
      await get('/notifications/not-a-uuid', 'owner').expect(400);
      const before = (await get('/notifications/unread-count', 'owner').expect(200)).body.unread;
      const read = (await post(`/notifications/${first.id}/read`, 'owner').expect(200)).body;
      expect(read).toMatchObject({ id: first.id, read: true, unread: before - 1 });
      await post(`/notifications/${first.id}/read`, 'owner').expect(200); // idempotent
      expect((await get('/notifications/unread-count', 'owner').expect(200)).body.unread).toBe(before - 1);
      expect((await get(`/notifications/${first.id}`, 'owner').expect(200)).body.readAt).not.toBeNull();
      const cat = (await post('/notifications/read-all', 'owner', { category: 'EXPENSES' }).expect(200)).body;
      expect((await get('/notifications?category=EXPENSES&status=unread', 'owner').expect(200)).body.total).toBe(0);
      expect(cat.unread).toBeGreaterThan(0); // other categories untouched
      expect((await get('/notifications?status=read&limit=100', 'owner').expect(200)).body.items.every((n: { read: boolean }) => n.read)).toBe(true);
      const all = (await post('/notifications/read-all', 'owner', {}).expect(200)).body;
      expect(all.unread).toBe(0);
      expect((await get('/notifications?status=unread', 'owner').expect(200)).body.total).toBe(0);
      expect((await get('/notifications?status=all', 'owner').expect(200)).body.total).toBeGreaterThan(5); // history is kept
    });

    it('tracks "opened" on the delivery and marks the notification read', async () => {
      push.sent.length = 0;
      await post('/production', 'prod', { coopId: coop2, shift: 'EVENING', entries: [{ unit: 'CRATE', quantity: 2 }] }).expect(201);
      await settle();
      const n = (await notesOf('manager', 'production.recorded')).pop()!;
      expect(n.readAt).toBeNull();
      await post(`/notifications/${n.id}/opened`, 'manager').expect(200);
      expect((await prisma.notification.findUniqueOrThrow({ where: { id: n.id } })).readAt).not.toBeNull();
      expect((await prisma.notificationDelivery.findFirstOrThrow({ where: { notificationId: n.id } }))).toMatchObject({ status: 'OPENED' });
    });
  });

  // ───────────────────────── delivery tracking ─────────────────────────
  describe('delivery tracking', () => {
    const triggerProduction = async (shift: 'MORNING' | 'AFTERNOON' | 'EVENING', coop: string, date: string) => {
      await post('/production', 'manager', { coopId: coop, shift, productionDate: date, entries: [{ unit: 'EGG', quantity: 30 }] }).expect(201); // actor = manager; recipients: none of manager
      await post('/production', 'prod', { coopId: coop === coop1 ? coop2 : coop1, shift, productionDate: date, entries: [{ unit: 'EGG', quantity: 30 }] }).expect(201);
      await settle();
    };
    const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

    it('records SENT with the provider ticket, then DELIVERED from receipts', async () => {
      push.sent.length = 0;
      await triggerProduction('MORNING', coop1, day(3));
      const d = await prisma.notificationDelivery.findFirstOrThrow({ where: { notification: { userId: users.manager.id, type: 'production.recorded' } }, orderBy: { sentAt: 'desc' } });
      expect(d).toMatchObject({ status: 'SENT' });
      expect(d.ticketId).toMatch(/^ticket-\d+$/);
      expect(d.sentAt).not.toBeNull();
      expect(await notif.pollReceipts(new Date())).toMatchObject({ checked: 0 }); // too early: Expo receipts need ~15 min
      push.receiptMap[d.ticketId as string] = { status: 'ok' };
      const r = await notif.pollReceipts(new Date(Date.now() + 16 * 60_000));
      expect(r.delivered).toBeGreaterThanOrEqual(1);
      expect(await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: d.id } })).toMatchObject({ status: 'DELIVERED' });
    });

    it('records FAILED for provider errors and removes devices Expo says are gone (ticket and receipt)', async () => {
      const dev = tokenFor('doomed');
      const u = await makeUser(prisma, { roles: ['FARM_MANAGER'] });
      const s = await signIn(app, u.email);
      await api(app).post('/v1/notifications/devices').set(bearer(s.accessToken)).send({ pushToken: dev, platform: 'ios' }).expect(201);
      push.nextTickets.push({ status: 'error', error: 'DeviceNotRegistered', message: 'gone' });
      await triggerProduction('EVENING', coop1, day(4));
      const failed = await prisma.notificationDelivery.findFirstOrThrow({ where: { notification: { userId: u.id }, status: 'FAILED' } });
      expect(failed.error).toBe('DeviceNotRegistered');
      expect(await prisma.notificationDevice.count({ where: { pushToken: dev } })).toBe(0); // stale token removed
      expect(await prisma.notification.count({ where: { userId: u.id, type: 'production.recorded' } })).toBeGreaterThan(0); // in-app copy survives

      // receipt-level failure
      const dev2 = tokenFor('doomed2');
      await api(app).post('/v1/notifications/devices').set(bearer(s.accessToken)).send({ pushToken: dev2, platform: 'ios' }).expect(201);
      await triggerProduction('AFTERNOON', coop1, day(5));
      const dev2Row = await prisma.notificationDevice.findUniqueOrThrow({ where: { pushToken: dev2 } });
      const sent = await prisma.notificationDelivery.findFirstOrThrow({ where: { deviceId: dev2Row.id, status: 'SENT' } });
      push.receiptMap[sent.ticketId as string] = { status: 'error', error: 'DeviceNotRegistered', message: `gone ${dev2}` };
      await notif.pollReceipts(new Date(Date.now() + 16 * 60_000));
      expect(await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: sent.id } })).toMatchObject({ status: 'FAILED', error: 'DeviceNotRegistered' });
      expect(await prisma.notificationDevice.count({ where: { pushToken: dev2 } })).toBe(0);
    });

    it('keeps the in-app notification when the push service is unreachable', async () => {
      push.nextTickets.push('throw');
      const before = await countOf('manager', 'production.recorded');
      await triggerProduction('MORNING', coop2, day(6));
      expect(await countOf('manager', 'production.recorded')).toBe(before + 1);
      const d = await prisma.notificationDelivery.findFirstOrThrow({ where: { error: 'TransportError' } });
      expect(d.status).toBe('FAILED');
      expect(JSON.stringify(d)).not.toContain('ExponentPushToken');
    });

    it('creates no push work at all when push is not configured', async () => {
      const wasEnabled = push.enabled;
      push.enabled = false;
      try {
        const sentBefore = push.sent.length;
        const deliveriesBefore = await prisma.notificationDelivery.count();
        const before = await countOf('manager', 'production.recorded');
        await triggerProduction('AFTERNOON', coop2, day(7));
        expect(await countOf('manager', 'production.recorded')).toBe(before + 1);
        expect(push.sent.length).toBe(sentBefore);
        expect(await prisma.notificationDelivery.count()).toBe(deliveriesBefore);
      } finally { push.enabled = wasEnabled; }
    });
  });

  // ───────────────────────── scheduler: daily summary & reminders ─────────────────────────
  describe('scheduled notifications', () => {
    const at = (hm: string) => new Date(`${today()}T${hm}:00Z`); // business time zone is UTC+0

    it('sends the daily summary at the configured time, once, built from live data and limited to what each role may see', async () => {
      await scheduler.tick(at('17:59'));
      await settle();
      expect(await prisma.notification.count({ where: { type: 'daily.summary' } })).toBe(0);
      push.sent.length = 0;
      await scheduler.tick(at('18:00'));
      await settle();
      const dash = async (who: Who) => (await get('/dashboard', who).expect(200)).body;
      const mgr = (await notesOf('manager', 'daily.summary'))[0];
      const acct = (await notesOf('acct', 'daily.summary'))[0];
      const owner = (await notesOf('owner', 'daily.summary'))[0];
      expect(mgr.title).toBe(`Daily poultry summary — ${today()}`);
      const dm = await dash('manager'); const da = await dash('acct'); const dof = await dash('owner');
      const fmt = (n: number) => n.toLocaleString('en-US');
      expect(mgr.body).toContain(`Production: ${fmt(dm.production.todayEggs)} eggs`);
      expect(mgr.body).toContain(`Current stock: ${fmt(dm.inventory.quantityEggs)} eggs`);
      expect(mgr.body).toMatch(/Sales: NLe /);
      expect(mgr.body).not.toMatch(/Outstanding customer balances/); // no customers.financial
      expect(acct.body).toMatch(/Outstanding customer balances: NLe /);
      expect(acct.body).not.toMatch(/Production:|Current stock:/); // finance role: no production data
      expect(da.receivables.outstandingTotal).toBeDefined();
      expect(owner.body.split('\n').length).toBe(5); // production, sales, expenses, stock, receivables
      expect(dof.sales.todayRevenue).toBeDefined();
      for (const k of ['prod', 'sales'] as const) expect(await countOf(k, 'daily.summary')).toBe(0); // no dashboard.read
      const pushes = push.sent.filter((m) => m.data.type === 'daily.summary');
      expect(pushes.length).toBeGreaterThan(0);
      expect(pushes.every((m) => m.body === 'Your daily poultry summary is ready.')).toBe(true); // figures never on the lock screen
      const n = await prisma.notification.count({ where: { type: 'daily.summary' } });
      await scheduler.tick(at('18:30'));
      await settle();
      expect(await prisma.notification.count({ where: { type: 'daily.summary' } })).toBe(n); // once per day
    });

    it('respects the disable switch, per-user muting, account status, and the optional e-mail copy', async () => {
      await prisma.notification.deleteMany({ where: { type: 'daily.summary' } });
      await put('/notifications/config', 'owner', { dailySummaryEnabled: false }).expect(200);
      await scheduler.tick(at('19:00')); await settle();
      expect(await prisma.notification.count({ where: { type: 'daily.summary' } })).toBe(0);

      await put('/notifications/config', 'owner', { dailySummaryEnabled: true, dailySummaryEmail: true }).expect(200);
      await put('/notifications/preferences', 'acct', { preferences: [{ category: 'DAILY_SUMMARY', enabled: false }] }).expect(200);
      mail.outbox.length = 0;
      await scheduler.tick(at('19:05')); await settle();
      expect(await countOf('acct', 'daily.summary')).toBe(0); // muted
      expect(await countOf('manager', 'daily.summary')).toBe(1);
      expect(mail.outbox.map((m) => m.to).sort()).toEqual(expect.arrayContaining([users.manager.email, users.owner.email]));
      expect(mail.outbox.some((m) => m.to === users.acct.email)).toBe(false);
      expect(mail.outbox[0].subject).toMatch(/^Daily poultry summary/);
      await put('/notifications/preferences', 'acct', { preferences: [{ category: 'DAILY_SUMMARY', enabled: true }] }).expect(200);
      await put('/notifications/config', 'owner', { dailySummaryEmail: false }).expect(200);
    });

    it('reminds about missing production only when a shift really is missing, once per day', async () => {
      await prisma.notification.deleteMany({ where: { type: { startsWith: 'production.reminder' } } });
      await scheduler.tick(at('09:59')); await settle();
      expect(await prisma.notification.count({ where: { type: { startsWith: 'production.reminder' } } })).toBe(0);
      push.sent.length = 0;
      // Morning: Coop 1 and Coop 2 were both recorded earlier today → no reminder. Afternoon: only coop 1 recorded today → reminder.
      await scheduler.tick(at('15:00')); await settle();
      expect(await countOf('prod', 'production.reminder.MORNING')).toBe(0);
      expect(await countOf('prod', 'production.reminder.AFTERNOON')).toBe(1);
      const rem = (await notesOf('prod', 'production.reminder.AFTERNOON'))[0];
      expect(rem.title).toBe('Afternoon production has not been recorded');
      expect(rem.body).toBe('Coop 2 still need afternoon production for today.');
      expect(await countOf('manager', 'production.reminder.AFTERNOON')).toBe(1);
      for (const k of ['sales', 'acct', 'owner'] as const) expect(await countOf(k, 'production.reminder.AFTERNOON')).toBe(0);
      expect(push.to(users.prod.device).map((m) => m.body)).toContain('Afternoon production has not been recorded.');
      await scheduler.tick(at('15:10')); await settle();
      expect(await countOf('prod', 'production.reminder.AFTERNOON')).toBe(1); // no repeat
      // once it is recorded, the next reminder time finds nothing to remind about
      await post('/production', 'prod', { coopId: coop2, shift: 'EVENING', entries: [{ unit: 'CRATE', quantity: 1 }] }).catch(() => undefined);
      await post('/production', 'manager', { coopId: coop1, shift: 'EVENING', entries: [{ unit: 'CRATE', quantity: 1 }] }).catch(() => undefined);
      await scheduler.tick(at('19:00')); await settle();
      expect(await countOf('prod', 'production.reminder.EVENING')).toBe(0);
    });

    it('purges stale devices, old deliveries and old notifications, and keeps recent ones', async () => {
      const old = await prisma.user.findFirstOrThrow({ where: { id: users.acct.id } });
      const staleTok = tokenFor('stale');
      await prisma.notificationDevice.create({ data: { userId: old.id, pushToken: staleTok, platform: 'ios', lastSeenAt: new Date(Date.now() - 100 * 86_400_000) } });
      const ancient = await prisma.notification.create({ data: { userId: old.id, category: 'SALES', type: 'test.ancient', title: 'x', body: 'y', createdAt: new Date(Date.now() - 400 * 86_400_000) } });
      const recent = await prisma.notification.create({ data: { userId: old.id, category: 'SALES', type: 'test.recent', title: 'x', body: 'y' } });
      const oldDelivery = await prisma.notificationDelivery.create({ data: { notificationId: recent.id, status: 'SENT', sentAt: new Date(Date.now() - 100 * 86_400_000) } });
      const freshDevices = await prisma.notificationDevice.count();
      const r = await notif.purge();
      expect(r).toMatchObject({ devices: 1, notifications: 1 });
      expect(r.deliveries).toBeGreaterThanOrEqual(1);
      expect(await prisma.notificationDevice.count({ where: { pushToken: staleTok } })).toBe(0);
      expect(await prisma.notification.count({ where: { id: ancient.id } })).toBe(0);
      expect(await prisma.notification.count({ where: { id: recent.id } })).toBe(1);
      expect(await prisma.notificationDelivery.count({ where: { id: oldDelivery.id } })).toBe(0);
      expect(await prisma.notificationDevice.count()).toBe(freshDevices - 1);
    });
  });

  // ───────────────────────── configuration ─────────────────────────
  describe('administrator configuration', () => {
    it('needs notifications.manage, validates input, stores it and audits before/after', async () => {
      await get('/notifications/config', 'manager').expect(403);
      await put('/notifications/config', 'manager', { dailySummaryTime: '07:00' }).expect(403);
      await put('/notifications/config', 'owner', {}).expect(400);
      for (const bad of [{ dailySummaryTime: '25:00' }, { dailySummaryTime: '6pm' }, { largeSaleThreshold: '12.345' }, { largeSaleThreshold: 'lots' }, { productionReminders: [{ shift: 'NIGHT', time: '10:00' }] },
        { productionReminders: [{ shift: 'MORNING', time: '10:00' }, { shift: 'MORNING', time: '11:00' }, { shift: 'AFTERNOON', time: '12:00' }, { shift: 'EVENING', time: '13:00' }] }, { dailySummaryEnabled: 'yes' }, { unknownKey: 1 }]) {
        await put('/notifications/config', 'owner', bad).expect(400);
      }
      const r = await put('/notifications/config', 'owner', { dailySummaryTime: '07:30', productionReminders: [{ shift: 'MORNING', time: '09:00' }] }).expect(200);
      expect(r.body).toMatchObject({ dailySummaryTime: '07:30', productionReminders: [{ shift: 'MORNING', time: '09:00' }] });
      const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'settings.notifications_changed' }, orderBy: { seq: 'desc' } });
      expect(JSON.stringify(log.before)).toContain('18:00');
      expect(JSON.stringify(log.after)).toContain('07:30');
      await put('/notifications/config', 'owner', { dailySummaryTime: '18:00', productionReminders: [{ shift: 'MORNING', time: '10:00' }, { shift: 'AFTERNOON', time: '15:00' }, { shift: 'EVENING', time: '19:00' }] }).expect(200);
      expect(await app.get(AuditService).verifyChain(100_000)).toBeNull();
    });
  });

  // ───────────────────────── realtime ─────────────────────────
  describe('realtime delivery of new notifications', () => {
    it('pushes notification.created over WebSocket to the recipient only (id and category, no content)', async () => {
      const connect = (token: string) => new Promise<Socket>((resolve, reject) => {
        const s = io(baseUrl, { path: '/realtime', transports: ['websocket'], auth: { token }, reconnection: false, timeout: 4000 });
        open.push(s); s.once('ready', () => resolve(s)); s.once('connect_error', reject);
      });
      const mgr = await connect(users.manager.token); const sales = await connect(users.sales.token);
      const gotMgr: { entityId: string; data: Record<string, unknown> }[] = []; const gotSales: unknown[] = [];
      mgr.on('notification.created', (e) => gotMgr.push(e)); sales.on('notification.created', (e) => gotSales.push(e));
      await post('/production', 'prod', { coopId: coop1, shift: 'EVENING', productionDate: new Date(Date.now() - 9 * 86_400_000).toISOString().slice(0, 10), entries: [{ unit: 'EGG', quantity: 9 }] }).expect(403); // too old for staff: creates nothing
      await post('/production', 'manager', { coopId: coop1, shift: 'EVENING', productionDate: new Date(Date.now() - 9 * 86_400_000).toISOString().slice(0, 10), entries: [{ unit: 'EGG', quantity: 9 }] }).expect(201);
      await post('/production', 'prod', { coopId: coop2, shift: 'MORNING', productionDate: new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10), entries: [{ unit: 'EGG', quantity: 9 }] }).expect(201);
      const start = Date.now();
      while (gotMgr.length === 0 && Date.now() - start < 3000) await sleep(25);
      await sleep(200);
      expect(gotMgr).toHaveLength(1);
      expect(gotMgr[0].data).toEqual({ userId: users.manager.id, category: 'PRODUCTION' });
      expect(JSON.stringify(gotMgr[0])).not.toMatch(/eggs|Coop/);
      expect(gotSales).toEqual([]);
    });
  });
});
