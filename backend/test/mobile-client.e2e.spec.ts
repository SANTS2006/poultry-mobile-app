import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { io } from 'socket.io-client';
import { createEndpoints } from '../../mobile/src/api/endpoints';
import { ApiClient } from '../../mobile/src/services/api-client';
import { PublicApi } from '../../mobile/src/services/public-api';
import { RealtimeClient, type SocketFactory } from '../../mobile/src/services/realtime';
import { SessionManager, UnsyncedDataError, type OutboxGate } from '../../mobile/src/services/session-manager';
import { MemorySecureStore, TokenManager } from '../../mobile/src/services/token-manager';
import type { SyncSummary } from '../../mobile/src/sync/types';
import { api, bearer, createApp, makeUser, seed, totpAt, useIsolatedSchema } from './helpers';

/** The REAL mobile client code (session manager, token refresh, typed endpoints, realtime client) talking to the REAL server over HTTP/WebSocket. */
describe('Mobile client against the live backend (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let base: string;
  class Gate implements OutboxGate {
    unsynced = 0;
    owner: string | null = null;
    async summary() { return { unsynced: this.unsynced } as SyncSummary; }
    async getOwner() { return this.owner; }
    async setOwner(id: string) { this.owner = id; }
    async wipe() { this.unsynced = 0; }
  }
  const gate = new Gate();

  function client() {
    const secure = new MemorySecureStore();
    const f = fetch as never;
    const tokens = new TokenManager(secure, base, f, { 'x-device-name': 'Test phone', 'x-platform': 'android' });
    const apiClient = new ApiClient(base, tokens, f, { 'x-device-name': 'Test phone', 'x-platform': 'android' });
    const pub = new PublicApi(base, f, { 'x-device-name': 'Test phone', 'x-platform': 'android' });
    const session = new SessionManager(secure, tokens, apiClient, pub, gate);
    return { secure, tokens, apiClient, session, ep: createEndpoints(apiClient) };
  }

  beforeAll(async () => {
    process.env.THROTTLE_OFF = '1';
    await useIsolatedSchema('mob');
    ({ app, prisma } = await createApp());
    await seed(prisma);
    await app.listen(0);
    base = `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}`;
    await prisma.farm.create({ data: { name: 'Mobile Farm' } });
  });
  afterAll(async () => { await prisma.$disconnect(); await app.close(); });

  it('privileged role: password → mandatory MFA enrolment → session; next sign-in asks for a code; recovery works', async () => {
    const u = await makeUser(prisma, { roles: ['OWNER'], fullName: 'Owner One' });
    const c = client();
    const out = await c.session.login(u.email, u.password);
    if (out.kind !== 'mfa_setup_required') throw new Error(`expected setup, got ${out.kind}`);
    expect(c.session.status).toBe('booting'); // no session before MFA is set up
    const enrol = await c.session.beginMfaSetup(out.setupToken);
    expect(enrol.qrCodeDataUrl.startsWith('data:image/png')).toBe(true);
    const done = await c.session.confirmMfaSetup(out.setupToken, totpAt(enrol.secret, Date.now()));
    expect(done.outcome.kind).toBe('authenticated');
    expect(done.recoveryCodes.length).toBeGreaterThanOrEqual(8);
    expect(c.session.can('reports.export')).toBe(true);
    expect((await c.ep.account.me()) as { email: string }).toMatchObject({ email: u.email });

    await c.session.logout();
    expect(c.session.status).toBe('signed_out');
    const again = await c.session.login(u.email, u.password);
    if (again.kind !== 'mfa_required') throw new Error('expected MFA');
    const bad = await c.session.verifyMfa(again.mfaToken, { code: '000000' }).catch((e) => e);
    expect((bad as { status?: number }).status).toBe(401);
    const ok = await c.session.verifyMfa(again.mfaToken, { code: totpAt(enrol.secret, Date.now() + 30_000) });
    expect(ok.kind).toBe('authenticated');

    // recovery code path from a fresh device
    const c2 = client();
    const l2 = await c2.session.login(u.email, u.password);
    if (l2.kind !== 'mfa_required') throw new Error('expected MFA');
    expect((await c2.session.verifyMfa(l2.mfaToken, { recoveryCode: done.recoveryCodes[0] })).kind).toBe('authenticated');
  });

  it('restores a stored session (refreshing an expired access token) and signs out when the server revokes it', async () => {
    await prisma.role.updateMany({ data: { mfaRequired: false } });
    const u = await makeUser(prisma, { roles: ['FARM_MANAGER'] });
    const c = client();
    await c.session.login(u.email, u.password);
    // force the access token to look expired: the next call must refresh exactly once and keep working
    await c.secure.set('auth.expiresAt', '0');
    const c2Session = new SessionManager(c.secure, c.tokens, c.apiClient, new PublicApi(base, fetch as never), gate);
    await c2Session.restore();
    expect(c2Session.status).toBe('signed_in');
    expect(c.tokens.refreshCalls).toBe(1);
    expect(c2Session.can('sales.read')).toBe(true);
    expect(c2Session.can('users.manage')).toBe(false);

    await prisma.user.update({ where: { id: u.id }, data: { status: 'DISABLED' } });
    await c.secure.set('auth.expiresAt', '0');
    const c3 = new SessionManager(c.secure, c.tokens, c.apiClient, new PublicApi(base, fetch as never), gate);
    await c3.restore();
    expect(c3.status).toBe('signed_out');
    expect(await c.tokens.hasSession()).toBe(false);
  });

  it('every typed endpoint path the app uses exists and is permission-checked', async () => {
    const owner = await makeUser(prisma, { roles: ['OWNER'] });
    await prisma.user.update({ where: { id: owner.id }, data: { mfaEnabled: false } });
    const c = client();
    const r = await c.session.login(owner.email, owner.password);
    expect(r.kind).toBe('authenticated');
    const ep = c.ep;
    const today = new Date().toISOString().slice(0, 10);
    await ep.dashboard();
    await ep.inventory.current();
    await ep.inventory.reconciliation();
    await ep.production.list({ limit: 5 });
    await ep.sales.list({ limit: 5 });
    await ep.customers.list({ limit: 5 });
    await ep.expenses.list({ limit: 5 });
    await ep.expenses.categories();
    await ep.payments.list({ limit: 5 });
    await ep.notifications.list({ limit: 5 });
    await ep.notifications.unread();
    await ep.notifications.preferences();
    await ep.notifications.config();
    await ep.account.sessions();
    await ep.admin.users({ limit: 5 });
    await ep.admin.roles();
    await ep.prices();
    const audit = await ep.admin.audit({ limit: 5, action: 'auth.*' });
    expect(audit.items.length).toBeGreaterThan(0);
    expect((await ep.admin.verifyAudit()).intact).toBe(true);
    for (const name of ['production', 'sales', 'expenses', 'inventory', 'financial']) {
      const rep = await ep.reports.run(name, { from: today, to: today, groupBy: 'day' });
      expect(rep.meta.report).toBe(name);
    }
    // export download through the authenticated client (bearer header, binary body)
    const pdf = await c.apiClient.download(ep.reports.exportPath('sales', { from: today, to: today, groupBy: 'day', format: 'pdf' }));
    expect(Buffer.from(pdf.bytes).subarray(0, 5).toString()).toBe('%PDF-');
    // a production-only user is refused the finance endpoints (server-side, whatever the UI shows)
    const staff = await makeUser(prisma, { roles: ['PRODUCTION_STAFF'] });
    const s = client();
    await s.session.login(staff.email, staff.password);
    await expect(s.ep.expenses.list({})).rejects.toMatchObject({ status: 403 });
    await expect(s.ep.reports.run('sales', { from: today, to: today })).rejects.toMatchObject({ status: 403 });
    await expect(s.ep.admin.audit({})).rejects.toMatchObject({ status: 403 });
  });

  it('refuses another user on top of unsent records, but the same user may continue', async () => {
    await prisma.role.updateMany({ data: { mfaRequired: false } });
    const a = await makeUser(prisma, { roles: ['SALES_STAFF'] });
    const b = await makeUser(prisma, { roles: ['SALES_STAFF'] });
    const c = client();
    await c.session.login(a.email, a.password);
    gate.unsynced = 2;
    await expect(c.session.login(b.email, b.password)).rejects.toBeInstanceOf(UnsyncedDataError);
    await expect(c.session.logout()).rejects.toBeInstanceOf(UnsyncedDataError);
    gate.unsynced = 0;
    await c.session.logout();
  });

  it('realtime: the real client subscribes only to permitted topics, gets refetch hints, and learns about revocation', async () => {
    await prisma.role.updateMany({ data: { mfaRequired: false } });
    const mgr = await makeUser(prisma, { roles: ['FARM_MANAGER'] });
    const c = client();
    await c.session.login(mgr.email, mgr.password);
    const hints: string[][][] = [];
    let ended = 0;
    const rt = new RealtimeClient({
      url: base, factory: io as unknown as SocketFactory, getToken: () => c.tokens.getAccessToken(),
      permissions: () => c.session.user?.permissions ?? [], onInvalidate: (k) => hints.push(k), onSessionEnded: () => { ended++; },
    });
    rt.start();
    const until = async (cond: () => boolean, ms = 4000) => { const t = Date.now(); while (!cond()) { if (Date.now() - t > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 25)); } };
    await until(() => rt.connected);
    await new Promise((r) => setTimeout(r, 300)); // let the subscribe ack settle

    const coop = await prisma.coop.create({ data: { farmId: (await prisma.farm.findFirstOrThrow()).id, name: 'RT coop' } });
    const owner = await makeUser(prisma, { roles: ['OWNER'] });
    await prisma.user.update({ where: { id: owner.id }, data: { mfaEnabled: false } });
    const oc = client();
    await oc.session.login(owner.email, owner.password);
    await api(app).post('/v1/production').set(bearer(await oc.tokens.getAccessToken())).send({ coopId: coop.id, shift: 'MORNING', entries: [{ unit: 'EGG', quantity: 30 }] }).expect(201);
    await until(() => hints.some((h) => h.some((k) => k[0] === 'production')));

    // administrator disables the manager: the socket is dropped and the client reports the session as ended
    await api(app).post(`/v1/users/${mgr.id}/disable`).set(bearer(await oc.tokens.getAccessToken())).send({ reason: 'left the farm' }).expect(200);
    await until(() => ended > 0);
    rt.stop();
  });
});
