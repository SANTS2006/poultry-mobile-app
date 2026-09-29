import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import * as jwt from 'jsonwebtoken';
import { api, bearer, createApp, login, makeUser, PASSWORD, seed, signIn, useIsolatedSchema } from './helpers';

/** Cross-cutting security checks (OWASP API Top 10 flavoured) that no single feature suite owns. */
describe('Security regression suite (e2e, real PostgreSQL)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let owner: { id: string; email: string; token: string; refresh: string };
  let staff: { id: string; email: string; token: string; refresh: string };

  beforeAll(async () => {
    delete process.env.THROTTLE_OFF; // this suite exercises the real rate limiter
    await useIsolatedSchema('sec');
    ({ app, prisma } = await createApp());
    await seed(prisma);
    await prisma.role.updateMany({ data: { mfaRequired: false } });
    await prisma.farm.create({ data: { name: 'Sec Farm' } });
    const mk = async (role: string) => {
      const u = await makeUser(prisma, { roles: [role] });
      const s = await signIn(app, u.email);
      return { id: u.id, email: u.email, token: s.accessToken, refresh: s.refreshToken };
    };
    owner = await mk('OWNER');
    staff = await mk('PRODUCTION_STAFF');
  });
  afterAll(async () => { await prisma.$disconnect(); await app.close(); });

  describe('deny by default', () => {
    it('every non-public route refuses an unauthenticated caller with 401 (route table walked at runtime)', async () => {
      const router = (app.getHttpAdapter().getInstance() as { router?: { stack: { route?: { path: string; methods: Record<string, boolean> } }[] } }).router;
      const routes = (router?.stack ?? []).filter((l) => l.route).flatMap((l) => Object.keys(l.route!.methods).filter((m) => ['get', 'post', 'put', 'patch', 'delete'].includes(m)).map((m) => ({ m: m.toUpperCase(), p: l.route!.path })))
        .filter((r) => r.p.startsWith('/v1/') && !r.p.includes('*'));
      expect(routes.length).toBeGreaterThan(80); // proves the walk actually found the API
      const PUBLIC = new Set(['/v1/health/live', '/v1/health/ready', '/v1/auth/login', '/v1/auth/mfa/verify', '/v1/auth/refresh', '/v1/auth/verify-email',
        '/v1/auth/resend-verification', '/v1/auth/accept-invite', '/v1/auth/forgot-password', '/v1/auth/reset-password', '/v1/auth/mfa/enroll', '/v1/auth/mfa/confirm', '/v1/_probe/open']);
      const uuid = '11111111-1111-4111-8111-111111111111';
      const leaks: string[] = [];
      for (const r of routes) {
        if (PUBLIC.has(r.p)) continue;
        const path = r.p.replace(/:[A-Za-z]+/g, uuid);
        const res = await (api(app) as unknown as Record<string, (p: string) => import('supertest').Test>)[r.m.toLowerCase()](path).send({}).catch((e: Error) => ({ status: `ERR ${e.message}` }));
        if (res.status !== 401) leaks.push(`${r.m} ${r.p} -> ${res.status}`);
      }
      expect(leaks).toEqual([]);
    });

    it('a low-privilege user is forbidden (403) from admin, finance and reporting surfaces', async () => {
      for (const [m, p] of [['get', '/v1/users'], ['get', '/v1/audit'], ['get', '/v1/expenses'], ['get', '/v1/reports/sales?from=2026-01-01&to=2026-01-02'],
        ['get', '/v1/notifications/config'], ['post', '/v1/prices'], ['get', '/v1/customers'], ['post', '/v1/sales']] as const) {
        const res = await (api(app)[m] as (p: string) => import('supertest').Test)(p).set(bearer(staff.token)).send({});
        expect([403]).toContain(res.status);
      }
    });
  });

  describe('token handling', () => {
    it('rejects tampered, unsigned, wrong-secret, wrong-type and expired tokens', async () => {
      const claims = jwt.decode(owner.token) as Record<string, unknown>;
      const attempts: Record<string, string> = {
        garbage: 'not.a.jwt',
        noneAlg: `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.`,
        wrongSecret: jwt.sign(claims, 'x'.repeat(40), { algorithm: 'HS256' }),
        expired: jwt.sign({ ...claims, exp: Math.floor(Date.now() / 1000) - 60 }, process.env.JWT_SECRET as string, { algorithm: 'HS256' }),
        wrongType: jwt.sign({ ...claims, typ: 'mfa' }, process.env.JWT_SECRET as string, { algorithm: 'HS256' }),
        refreshAsAccess: owner.refresh,
        tamperedPayload: `${owner.token.split('.')[0]}.${Buffer.from(JSON.stringify({ ...claims, sub: staff.id })).toString('base64url')}.${owner.token.split('.')[2]}`,
      };
      for (const [name, token] of Object.entries(attempts)) {
        const res = await api(app).get('/v1/auth/me').set(bearer(token));
        expect({ name, status: res.status }).toEqual({ name, status: 401 });
      }
      await api(app).get('/v1/auth/me').set(bearer(owner.token)).expect(200); // the genuine one still works
    });

    it('rejects a reused refresh token and revokes the whole family (theft detection)', async () => {
      const s = await signIn(app, owner.email);
      const r1 = await api(app).post('/v1/auth/refresh').send({ refreshToken: s.refreshToken }).expect(200);
      await api(app).post('/v1/auth/refresh').send({ refreshToken: s.refreshToken }).expect(401); // replay of the old one
      await api(app).post('/v1/auth/refresh').send({ refreshToken: r1.body.refreshToken }).expect(401); // family is dead
      await api(app).get('/v1/auth/me').set(bearer(r1.body.accessToken)).expect(401);
    });

    it('cannot revoke someone else\'s session by guessing its id (no IDOR)', async () => {
      const victim = await makeUser(prisma, { roles: ['SALES_STAFF'] });
      const vs = await signIn(app, victim.email);
      const sessions = await api(app).get('/v1/auth/sessions').set(bearer(vs.accessToken)).expect(200);
      const victimSession = sessions.body[0].id as string;
      await api(app).delete(`/v1/auth/sessions/${victimSession}`).set(bearer(staff.token)).expect(204); // silently ignored
      await api(app).get('/v1/auth/me').set(bearer(vs.accessToken)).expect(200); // victim is unaffected
    });
  });

  describe('injection and input hardening', () => {
    const PAYLOADS = ["'; DROP TABLE \"User\"; --", "' OR '1'='1", '" OR 1=1 --', '%00', '${jndi:ldap://x}', '<script>alert(1)</script>', '../../etc/passwd', '{"$ne":null}'];

    it('search and filter parameters treat SQL/JS metacharacters as plain text (no 500s, tables intact)', async () => {
      for (const p of PAYLOADS) {
        for (const path of [`/v1/users?q=${encodeURIComponent(p)}`, `/v1/customers?q=${encodeURIComponent(p)}`, `/v1/expenses?q=${encodeURIComponent(p)}`]) {
          const res = await api(app).get(path).set(bearer(owner.token));
          expect({ path, ok: res.status < 500 }).toEqual({ path, ok: true });
        }
        const a = await api(app).get(`/v1/audit?action=${encodeURIComponent(p)}`).set(bearer(owner.token));
        expect(a.status).toBe(400); // validated allow-list pattern, never reaches SQL
      }
      expect(await prisma.user.count()).toBeGreaterThan(1);
    });

    it('stores hostile text verbatim and never executes or reflects it as markup', async () => {
      const c = await api(app).post('/v1/customers').set(bearer(owner.token)).send({ name: '<img src=x onerror=alert(1)>', type: 'REGULAR' }).expect(201);
      const got = await api(app).get(`/v1/customers/${c.body.id}`).set(bearer(owner.token)).expect(200);
      expect(got.body.name).toBe('<img src=x onerror=alert(1)>');
      expect(got.headers['content-type']).toContain('application/json');
      expect(got.headers['x-content-type-options']).toBe('nosniff');
    });

    it('rejects oversized bodies, malformed JSON and non-UUID ids without leaking internals', async () => {
      const big = await api(app).post('/v1/customers').set(bearer(owner.token)).send({ name: 'x'.repeat(400_000) });
      expect(big.status).toBe(413);
      const bad = await api(app).post('/v1/customers').set(bearer(owner.token)).set('Content-Type', 'application/json').send('{"name": ');
      expect(bad.status).toBe(400);
      const id = await api(app).get('/v1/customers/not-a-uuid').set(bearer(owner.token));
      expect(id.status).toBe(400);
      for (const r of [big, bad, id]) {
        const text = JSON.stringify(r.body);
        expect(text).not.toMatch(/prisma|postgres|node_modules|at .*\.ts|stack/i);
      }
    });

    it('prototype-pollution style bodies never pollute Object.prototype or reach the stored record', async () => {
      const raw = '{"name":"Proto Test","__proto__":{"admin":true,"polluted":"yes"},"constructor":{"prototype":{"polluted":"yes"}}}';
      const res = await api(app).post('/v1/customers').set(bearer(owner.token)).set('Content-Type', 'application/json').send(raw);
      expect([201, 400]).toContain(res.status); // ignoring or refusing the keys are both safe; polluting is not
      expect(({} as Record<string, unknown>).admin).toBeUndefined();
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      if (res.status === 201) expect(JSON.stringify(res.body)).not.toMatch(/polluted|admin/);
      const users = await api(app).get('/v1/users?limit=5').set(bearer(owner.token)).expect(200);
      expect(users.body.items.every((u: Record<string, unknown>) => u.admin === undefined)).toBe(true);
    });
  });

  describe('transport and headers', () => {
    it('sets security headers, hides the framework, and does not allow foreign origins', async () => {
      const res = await api(app).get('/v1/health/live').set('Origin', 'https://evil.example');
      expect(res.headers['x-powered-by']).toBeUndefined();
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBeDefined();
      expect(res.headers['strict-transport-security']).toBeDefined();
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      const pre = await api(app).options('/v1/auth/login').set('Origin', 'https://evil.example').set('Access-Control-Request-Method', 'POST');
      expect(pre.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('API responses that carry data are not cacheable by shared caches', async () => {
      const res = await api(app).get('/v1/auth/me').set(bearer(owner.token)).expect(200);
      const cc = String(res.headers['cache-control'] ?? '');
      expect(cc === '' || /no-store|private|no-cache/.test(cc)).toBe(true);
    });
  });

  describe('credential attacks', () => {
    it('rate-limits password guessing and locks the account progressively without revealing whether the email exists', async () => {
      const victim = await makeUser(prisma, { roles: ['SALES_STAFF'] });
      const statuses: number[] = [];
      for (let i = 0; i < 8; i++) statuses.push((await login(app, victim.email, `wrong-password-${i}-xx`)).status);
      expect(statuses).toContain(429); // throttler engaged
      const unknown = await login(app, 'nobody-here@example.com', 'wrong-password-xx');
      const known = await login(app, victim.email, 'wrong-password-yy');
      // same generic message for unknown accounts and wrong passwords (no user enumeration), whatever the throttle state
      if (unknown.status === 401 && known.status === 401) expect(unknown.body.message).toBe(known.body.message);
      expect(JSON.stringify(unknown.body)).not.toMatch(/exist|not found|no such/i);
    });

    it('never returns password hashes, MFA secrets or token hashes from any user endpoint', async () => {
      const list = await api(app).get('/v1/users?limit=100').set(bearer(owner.token)).expect(200);
      const one = await api(app).get(`/v1/users/${staff.id}`).set(bearer(owner.token)).expect(200);
      const dump = JSON.stringify([list.body, one.body]);
      expect(dump).not.toMatch(/\$argon2|passwordHash|mfaSecret|recovery|tokenHash|refreshToken/i);
      expect(PASSWORD.length).toBeGreaterThan(0);
    });
  });
});
