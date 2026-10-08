import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaClient } from '@prisma/client';
import { AuditService } from '../src/audit/audit.service';
import { PERMISSIONS } from '../src/common/permissions';
import { MailService } from '../src/mail/mail.service';
import { temporaryPassword } from '../src/users/temp-password';
import { UsersService } from '../src/users/users.service';
import { api, bearer, createApp, login, makeUser, PASSWORD, seed, signIn, totpAt, uniqueEmail } from './helpers';

/** Pulls the single-use token out of the most recent captured e-mail for `to`. */
const tokenFromMail = (mail: MailService, to: string): string => {
  const msg = [...mail.outbox].reverse().find((m) => m.to === to);
  const m = msg?.text.match(/token=([A-Za-z0-9_%-]+)/);
  if (!m) throw new Error(`no token mail for ${to}`);
  return decodeURIComponent(m[1]);
};

describe('Authentication, sessions, MFA, RBAC (e2e, real PostgreSQL)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let mail: MailService;
  let jwt: JwtService;
  let admin: { email: string; id: string };
  let adminToken: string;

  beforeAll(async () => {
    process.env.THROTTLE_OFF = '1';
    ({ app, mail, prisma } = await createApp());
    jwt = app.get(JwtService);
    await seed(prisma);
    const u = await makeUser(prisma, { roles: ['SUPER_ADMIN'], fullName: 'Super One' });
    // Super Admin requires MFA by policy; for the bulk of tests give them a session via a role-less MFA-exempt path:
    await prisma.role.update({ where: { code: 'SUPER_ADMIN' }, data: { mfaRequired: false } });
    admin = { email: u.email, id: u.id };
    adminToken = (await signIn(app, u.email)).accessToken;
  });
  afterAll(async () => {
    await prisma.$disconnect();
    await app.close();
  });

  // ───────────────────────── login basics ─────────────────────────
  describe('login', () => {
    it('returns tokens and a permission summary for valid credentials (no password hash leaked)', async () => {
      const u = await makeUser(prisma, { roles: ['SALES_STAFF'] });
      const res = await login(app, u.email).expect(200);
      expect(res.body.status).toBe('authenticated');
      expect(res.body.tokens.tokenType).toBe('Bearer');
      expect(res.body.user.permissions).toContain('sales.create');
      expect(res.body.user.permissions).not.toContain('expenses.read');
      expect(JSON.stringify(res.body)).not.toMatch(/argon2|passwordHash/);
    });

    it('stores passwords only as Argon2id hashes', async () => {
      const u = await makeUser(prisma, { roles: ['SALES_STAFF'] });
      const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
      expect(row.passwordHash).toMatch(/^\$argon2id\$/);
      expect(row.passwordHash).not.toContain(PASSWORD);
    });

    it('gives the same generic error for a wrong password and an unknown email (no user enumeration)', async () => {
      const u = await makeUser(prisma, { roles: ['SALES_STAFF'] });
      const bad = await login(app, u.email, 'wrong-password-123').expect(401);
      const unknown = await login(app, uniqueEmail('ghost'), 'wrong-password-123').expect(401);
      expect(bad.body.message).toBe(unknown.body.message);
      expect(bad.body.message).toBe('Invalid email or password.');
    });

    it('blocks unverified and disabled accounts only after the password is proven', async () => {
      const unverified = await makeUser(prisma, { roles: ['SALES_STAFF'], emailVerified: false });
      const disabled = await makeUser(prisma, { roles: ['SALES_STAFF'], status: 'DISABLED' });
      await login(app, unverified.email).expect(403);
      await login(app, disabled.email).expect(403);
      await login(app, disabled.email, 'wrong-password-123').expect(401); // wrong password reveals nothing about status
    });

    it('rejects malformed bodies and mass-assignment attempts', async () => {
      await api(app).post('/v1/auth/login').send({ email: 'not-an-email', password: 'x' }).expect(400);
      await api(app).post('/v1/auth/login').send({ email: 'a@b.co', password: 'x', isAdmin: true }).expect(400);
      await api(app).post('/v1/auth/login').send({ email: { $ne: null }, password: { $ne: null } }).expect(400); // NoSQL-style payloads
    });

    it("treats SQL metacharacters in the e-mail as data (parameterised queries)", async () => {
      await login(app, "x'; DROP TABLE \"User\";--@example.com").expect((r) => expect([400, 401]).toContain(r.status));
      expect(await prisma.user.count()).toBeGreaterThan(0);
    });

    it('records new-device logins in the audit trail', async () => {
      const u = await makeUser(prisma, { roles: ['SALES_STAFF'] });
      await signIn(app, u.email, PASSWORD, { 'X-Device-Name': 'Pixel 8', 'X-Platform': 'android' });
      const row = await prisma.auditLog.findFirst({ where: { userId: u.id, action: 'auth.login.new_device' } });
      expect(row).not.toBeNull();
      await signIn(app, u.email, PASSWORD, { 'X-Device-Name': 'Pixel 8', 'X-Platform': 'android' });
      expect(await prisma.auditLog.count({ where: { userId: u.id, action: 'auth.login.new_device' } })).toBe(1);
    });
  });

  // ───────────────────────── lockout ─────────────────────────
  describe('account lockout', () => {
    it('locks after 5 failures with 429 even for the right password, audits it, and recovers when the lock expires', async () => {
      const u = await makeUser(prisma, { roles: ['SALES_STAFF'] });
      for (let i = 0; i < 5; i++) await login(app, u.email, 'wrong-password-123').expect(401);
      await login(app, u.email).expect(429); // correct password, but locked
      expect(await prisma.auditLog.count({ where: { userId: u.id, action: 'auth.account.locked' } })).toBe(1);
      await prisma.user.update({ where: { id: u.id }, data: { lockedUntil: new Date(Date.now() - 1000) } });
      await login(app, u.email).expect(200);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).failedAttempts).toBe(0);
    });

    it('increases the lock duration progressively', async () => {
      const u = await makeUser(prisma, { roles: ['SALES_STAFF'] });
      for (let i = 0; i < 5; i++) await login(app, u.email, 'wrong-password-123');
      const first = (await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).lockedUntil!.getTime() - Date.now();
      await prisma.user.update({ where: { id: u.id }, data: { lockedUntil: new Date(Date.now() - 1) } });
      await login(app, u.email, 'wrong-password-123'); // 6th failure
      const second = (await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).lockedUntil!.getTime() - Date.now();
      expect(second).toBeGreaterThan(first);
    });
  });

  describe('rate limiting', () => {
    it('throttles the login endpoint per client (429)', async () => {
      delete process.env.THROTTLE_OFF;
      try {
        const statuses: number[] = [];
        for (let i = 0; i < 8; i++) statuses.push((await login(app, uniqueEmail('rl'), 'wrong-password-123')).status);
        expect(statuses).toContain(429);
      } finally {
        process.env.THROTTLE_OFF = '1';
      }
    });
  });

  // ───────────────────────── token validation ─────────────────────────
  describe('access-token validation', () => {
    it('rejects missing, malformed, wrong-scheme, foreign-signed, alg=none and expired tokens', async () => {
      await api(app).get('/v1/auth/me').expect(401);
      await api(app).get('/v1/auth/me').set('Authorization', 'Bearer garbage').expect(401);
      await api(app).get('/v1/auth/me').set('Authorization', `Basic ${adminToken}`).expect(401);

      const claims = { typ: 'access', tv: 0, fid: '00000000-0000-4000-8000-000000000000' };
      const opts = { subject: admin.id, issuer: 'makarifor-api', audience: 'makarifor-app' };
      const foreign = new JwtService({ secret: 'some-other-secret-some-other-secret-1234' }).sign(claims, { ...opts, expiresIn: 600 });
      await api(app).get('/v1/auth/me').set(bearer(foreign)).expect(401);

      const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(JSON.stringify({ ...claims, sub: admin.id, iss: opts.issuer, aud: opts.audience, exp: Math.floor(Date.now() / 1000) + 600 })).toString('base64url');
      await api(app).get('/v1/auth/me').set('Authorization', `Bearer ${header}.${payload}.`).expect(401);

      const expired = jwt.sign(claims, { ...opts, expiresIn: -60 });
      await api(app).get('/v1/auth/me').set(bearer(expired)).expect(401);
    });

    it('rejects an otherwise-valid token once the user’s tokenVersion has moved on (independent of session state)', async () => {
      const u = await makeUser(prisma, { roles: ['SALES_STAFF'] });
      const s = await signIn(app, u.email);
      await api(app).get('/v1/auth/me').set(bearer(s.accessToken)).expect(200);
      await prisma.user.update({ where: { id: u.id }, data: { tokenVersion: { increment: 1 } } });
      await api(app).get('/v1/auth/me').set(bearer(s.accessToken)).expect(401);
    });

    it('rejects a validly signed token for the wrong audience/type and for a non-existent session family', async () => {
      const wrongAud = jwt.sign({ typ: 'access', tv: 0, fid: '00000000-0000-4000-8000-000000000000' }, { subject: admin.id, issuer: 'makarifor-api', audience: 'someone-else', expiresIn: 600 });
      await api(app).get('/v1/auth/me').set(bearer(wrongAud)).expect(401);
      const noFamily = jwt.sign({ typ: 'access', tv: 0, fid: '00000000-0000-4000-8000-000000000000' }, { subject: admin.id, issuer: 'makarifor-api', audience: 'makarifor-app', expiresIn: 600 });
      await api(app).get('/v1/auth/me').set(bearer(noFamily)).expect(401);
      const mfaTok = jwt.sign({ typ: 'mfa', tv: 0 }, { subject: admin.id, issuer: 'makarifor-api', audience: 'makarifor-app', expiresIn: 600 });
      await api(app).get('/v1/auth/me').set(bearer(mfaTok)).expect(401); // purpose tokens are not access tokens
    });
  });

  // ───────────────────────── refresh rotation ─────────────────────────
  describe('refresh-token rotation', () => {
    it('rotates on every refresh and detects reuse of a retired token by revoking the whole family', async () => {
      const u = await makeUser(prisma, { roles: ['SALES_STAFF'] });
      const s = await signIn(app, u.email);
      const r1 = await api(app).post('/v1/auth/refresh').send({ refreshToken: s.refreshToken }).expect(200);
      expect(r1.body.refreshToken).not.toBe(s.refreshToken);
      await api(app).get('/v1/auth/me').set(bearer(r1.body.accessToken)).expect(200);
      // old access token of the same family is still fine (in-flight requests), new pair works:
      const r2 = await api(app).post('/v1/auth/refresh').send({ refreshToken: r1.body.refreshToken }).expect(200);

      // attacker (or buggy client) replays the FIRST refresh token → family burned
      await api(app).post('/v1/auth/refresh').send({ refreshToken: s.refreshToken }).expect(401);
      await api(app).post('/v1/auth/refresh').send({ refreshToken: r2.body.refreshToken }).expect(401);
      await api(app).get('/v1/auth/me').set(bearer(r2.body.accessToken)).expect(401);
      expect(await prisma.auditLog.count({ where: { userId: u.id, action: 'auth.refresh.reuse_detected' } })).toBe(1);
    });

    it('rejects unknown refresh tokens and never stores them in clear text', async () => {
      await api(app).post('/v1/auth/refresh').send({ refreshToken: 'x'.repeat(64) }).expect(401);
      const u = await makeUser(prisma, { roles: ['SALES_STAFF'] });
      const s = await signIn(app, u.email);
      const rows = await prisma.session.findMany({ where: { userId: u.id } });
      expect(rows.every((r) => r.refreshTokenHash !== s.refreshToken && r.refreshTokenHash.length === 64)).toBe(true);
    });

    it('does not extend the absolute session lifetime and enforces the idle timeout', async () => {
      const u = await makeUser(prisma, { roles: ['SALES_STAFF'] });
      const s = await signIn(app, u.email);
      const first = await prisma.session.findFirstOrThrow({ where: { userId: u.id } });
      const r = await api(app).post('/v1/auth/refresh').send({ refreshToken: s.refreshToken }).expect(200);
      const live = await prisma.session.findFirstOrThrow({ where: { userId: u.id, revokedAt: null } });
      expect(live.expiresAt.getTime()).toBe(first.expiresAt.getTime());
      await prisma.session.update({ where: { id: live.id }, data: { lastUsedAt: new Date(Date.now() - 15 * 24 * 3600_000) } });
      await api(app).post('/v1/auth/refresh').send({ refreshToken: r.body.refreshToken }).expect(401);
    });
  });

  // ───────────────────────── logout / sessions ─────────────────────────
  describe('logout and device sessions', () => {
    it('logout revokes the session immediately (access + refresh)', async () => {
      const u = await makeUser(prisma, { roles: ['SALES_STAFF'] });
      const s = await signIn(app, u.email);
      await api(app).post('/v1/auth/logout').set(bearer(s.accessToken)).expect(204);
      await api(app).get('/v1/auth/me').set(bearer(s.accessToken)).expect(401);
      await api(app).post('/v1/auth/refresh').send({ refreshToken: s.refreshToken }).expect(401);
    });

    it('logout-all signs out every device at once', async () => {
      const u = await makeUser(prisma, { roles: ['SALES_STAFF'] });
      const a = await signIn(app, u.email, PASSWORD, { 'X-Device-Name': 'A' });
      const b = await signIn(app, u.email, PASSWORD, { 'X-Device-Name': 'B' });
      await api(app).post('/v1/auth/logout-all').set(bearer(a.accessToken)).expect(204);
      await api(app).get('/v1/auth/me').set(bearer(a.accessToken)).expect(401);
      await api(app).get('/v1/auth/me').set(bearer(b.accessToken)).expect(401);
      await api(app).post('/v1/auth/refresh').send({ refreshToken: b.refreshToken }).expect(401);
    });

    it('lists own devices, flags the current one, revokes a chosen one, and cannot touch another user’s', async () => {
      const u = await makeUser(prisma, { roles: ['SALES_STAFF'] });
      const other = await makeUser(prisma, { roles: ['SALES_STAFF'] });
      const a = await signIn(app, u.email, PASSWORD, { 'X-Device-Name': 'Phone' });
      const b = await signIn(app, u.email, PASSWORD, { 'X-Device-Name': 'Tablet' });
      const o = await signIn(app, other.email);
      const list = await api(app).get('/v1/auth/sessions').set(bearer(a.accessToken)).expect(200);
      expect(list.body).toHaveLength(2);
      expect(list.body.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
      expect(JSON.stringify(list.body)).not.toMatch(/refreshTokenHash|familyId":"undefined/);
      const tablet = list.body.find((s: { deviceName: string }) => s.deviceName === 'Tablet');
      const otherSession = (await api(app).get('/v1/auth/sessions').set(bearer(o.accessToken)).expect(200)).body[0];
      await api(app).delete(`/v1/auth/sessions/${otherSession.id}`).set(bearer(a.accessToken)).expect(204); // silently ignored
      await api(app).get('/v1/auth/me').set(bearer(o.accessToken)).expect(200);
      await api(app).delete(`/v1/auth/sessions/${tablet.id}`).set(bearer(a.accessToken)).expect(204);
      await api(app).get('/v1/auth/me').set(bearer(b.accessToken)).expect(401);
      await api(app).get('/v1/auth/me').set(bearer(a.accessToken)).expect(200);
    });
  });

  // ───────────────────────── authorization ─────────────────────────
  describe('RBAC enforcement (server-side)', () => {
    it('denies by default: authenticated route without an explicit declaration is forbidden; @Public works unauthenticated', async () => {
      const u = await makeUser(prisma, { roles: ['SUPER_ADMIN'] });
      const s = await signIn(app, u.email);
      await api(app).get('/v1/_probe/open').expect(200);
      await api(app).get('/v1/_probe/undecorated').set(bearer(s.accessToken)).expect(403);
      await api(app).get('/v1/_probe/undecorated').expect(401);
    });

    it('requires every listed permission', async () => {
      const sales = await signIn(app, (await makeUser(prisma, { roles: ['SALES_STAFF'] })).email);
      const mgr = await signIn(app, (await makeUser(prisma, { roles: ['FARM_MANAGER'] })).email);
      await api(app).get('/v1/_probe/sales').set(bearer(sales.accessToken)).expect(200);
      await api(app).get('/v1/_probe/both').set(bearer(sales.accessToken)).expect(403);
      await api(app).get('/v1/_probe/both').set(bearer(mgr.accessToken)).expect(200);
    });

    it('keeps production staff away from user administration, roles and audit-sensitive endpoints', async () => {
      const p = await signIn(app, (await makeUser(prisma, { roles: ['PRODUCTION_STAFF'] })).email);
      await api(app).get('/v1/users').set(bearer(p.accessToken)).expect(403);
      await api(app).get('/v1/roles').set(bearer(p.accessToken)).expect(403);
      await api(app).get('/v1/permissions').set(bearer(p.accessToken)).expect(403);
      await api(app).post('/v1/users/invite').set(bearer(p.accessToken)).send({ email: uniqueEmail(), fullName: 'X Y', roleCodes: ['SUPER_ADMIN'] }).expect(403);
    });

    it('applies permission changes on the very next request (no stale privileges)', async () => {
      const u = await makeUser(prisma, { roles: ['SALES_STAFF'] });
      const s = await signIn(app, u.email);
      await api(app).get('/v1/_probe/sales').set(bearer(s.accessToken)).expect(200);
      const prod = await prisma.role.findUniqueOrThrow({ where: { code: 'PRODUCTION_STAFF' } });
      await prisma.userRole.deleteMany({ where: { userId: u.id } });
      await prisma.userRole.create({ data: { userId: u.id, roleId: prod.id } });
      await api(app).get('/v1/_probe/sales').set(bearer(s.accessToken)).expect(403);
    });
  });

  // ───────────────────────── user administration ─────────────────────────
  describe('invitation and user management', () => {
    it('invites a user with a temporary password by e-mail, forces a new password at first sign-in, then continues as normal', async () => {
      const email = uniqueEmail('invitee');
      const res = await api(app).post('/v1/users/invite').set(bearer(adminToken)).send({ email, fullName: 'New Person', roleCodes: ['SALES_STAFF'] }).expect(201);
      expect(res.body.emailSent).toBe(true);
      const msg = [...mail.outbox].reverse().find((m) => m.to === email)!;
      const temp = temporaryPassword('Makarifor Agriculture');
      expect(temp).toMatch(/^MA\d{4}$/);
      // everything the invitee needs is in the message: business, role, sign-in email, temporary password, expiry
      for (const needle of ['Makarifor Agriculture', 'Sales Staff', email, temp, '72 hours']) expect(msg.text).toContain(needle);
      expect(msg.html).toContain(temp);
      expect(msg.html).toContain('Welcome to Makarifor Agriculture');
      // the temporary password gives no session, only the right to choose a real password
      const first = await login(app, email, temp).expect(200);
      expect(first.body.status).toBe('password_change_required');
      expect(first.body.tokens).toBeUndefined();
      const passwordToken = first.body.passwordToken;
      await api(app).get('/v1/auth/me').set(bearer(passwordToken)).expect(401); // not an access token
      await api(app).post('/v1/auth/first-password').send({ passwordToken, newPassword: 'short' }).expect(400);
      await api(app).post('/v1/auth/first-password').send({ passwordToken, newPassword: temp }).expect(400);
      const done = await api(app).post('/v1/auth/first-password').send({ passwordToken, newPassword: PASSWORD }).expect(200);
      expect(done.body.status).toBe('authenticated');
      expect(done.body.user.roles).toEqual(['SALES_STAFF']);
      await api(app).post('/v1/auth/first-password').send({ passwordToken, newPassword: PASSWORD }).expect(401); // single purpose, single use
      await login(app, email, temp).expect(401); // the temporary password is gone
      expect((await signIn(app, email)).body.user.roles).toEqual(['SALES_STAFF']);
    });

    it('an expired temporary password is refused and a resent invitation issues a fresh one', async () => {
      const email = uniqueEmail('exp');
      const u = await api(app).post('/v1/users/invite').set(bearer(adminToken)).send({ email, fullName: 'Late Person', roleCodes: ['SALES_STAFF'] }).expect(201);
      const temp = temporaryPassword('Makarifor Agriculture');
      await prisma.user.update({ where: { id: u.body.id }, data: { tempPasswordExpiresAt: new Date(Date.now() - 1000) } });
      const late = await login(app, email, temp).expect(403);
      expect(late.body.message).toMatch(/expired/);
      const before = mail.outbox.length;
      const again = await api(app).post(`/v1/users/${u.body.id}/resend-invite`).set(bearer(adminToken)).expect(200);
      expect(again.body.emailSent).toBe(true);
      expect(mail.outbox.length).toBe(before + 1);
      expect((await login(app, email, temp).expect(200)).body.status).toBe('password_change_required');
    });

    it('a user who already set their own password cannot be re-invited, and wrong temporary passwords count toward lockout', async () => {
      const done = await makeUser(prisma, { roles: ['SALES_STAFF'] });
      await api(app).post(`/v1/users/${done.id}/resend-invite`).set(bearer(adminToken)).expect(400);
      const email = uniqueEmail('guess');
      await api(app).post('/v1/users/invite').set(bearer(adminToken)).send({ email, fullName: 'Guess Me', roleCodes: ['SALES_STAFF'] }).expect(201);
      for (let i = 0; i < 5; i++) await login(app, email, 'XX2026').expect(401);
      await login(app, email, temporaryPassword('Makarifor Agriculture')).expect(429); // locked out: guessing the pattern does not help
    });

    it('rejects duplicate e-mails (case-insensitively) and unknown roles', async () => {
      const email = uniqueEmail('dup');
      await api(app).post('/v1/users/invite').set(bearer(adminToken)).send({ email, fullName: 'Dup One', roleCodes: ['SALES_STAFF'] }).expect(201);
      await api(app).post('/v1/users/invite').set(bearer(adminToken)).send({ email: email.toUpperCase(), fullName: 'Dup Two', roleCodes: ['SALES_STAFF'] }).expect(409);
      await api(app).post('/v1/users/invite').set(bearer(adminToken)).send({ email: uniqueEmail(), fullName: 'No Role', roleCodes: ['NOPE'] }).expect(400);
    });

    it('prevents privilege escalation: an Owner cannot mint, promote, edit or disable a Super Admin', async () => {
      const owner = await makeUser(prisma, { roles: ['OWNER'] });
      await prisma.role.update({ where: { code: 'OWNER' }, data: { mfaRequired: false } });
      const o = await signIn(app, owner.email);
      await api(app).post('/v1/users/invite').set(bearer(o.accessToken)).send({ email: uniqueEmail(), fullName: 'Sneaky One', roleCodes: ['SUPER_ADMIN'] }).expect(403);
      const victim = await makeUser(prisma, { roles: ['SALES_STAFF'] });
      await api(app).put(`/v1/users/${victim.id}/roles`).set(bearer(o.accessToken)).send({ roleCodes: ['SUPER_ADMIN'], reason: 'promote please' }).expect(403);
      await api(app).put(`/v1/users/${owner.id}/roles`).set(bearer(o.accessToken)).send({ roleCodes: ['OWNER'], reason: 'self edit' }).expect(403);
      await api(app).post(`/v1/users/${admin.id}/disable`).set(bearer(o.accessToken)).send({ reason: 'coup attempt' }).expect(403);
      await api(app).post(`/v1/users/${admin.id}/reset-mfa`).set(bearer(o.accessToken)).send({ reason: 'coup attempt' }).expect(403);
      await api(app).delete(`/v1/users/${admin.id}/sessions`).set(bearer(o.accessToken)).send({ reason: 'coup attempt' }).expect(403);
      await api(app).put('/v1/roles/00000000-0000-4000-8000-000000000000/permissions').set(bearer(o.accessToken)).send({ permissionCodes: [], reason: 'nope nope' }).expect(403);
      await api(app).get('/v1/users/' + victim.id).set(bearer(o.accessToken)).expect(200); // legitimate access still works
    });

    it('rejects mass-assignment on admin endpoints', async () => {
      const victim = await makeUser(prisma, { roles: ['SALES_STAFF'] });
      await api(app).put(`/v1/users/${victim.id}/roles`).set(bearer(adminToken)).send({ roleCodes: ['SALES_STAFF'], reason: 'noop change', status: 'ACTIVE', passwordHash: 'x' }).expect(400);
      await api(app).post('/v1/users/invite').set(bearer(adminToken)).send({ email: uniqueEmail(), fullName: 'Mass Assign', roleCodes: ['SALES_STAFF'], emailVerified: true }).expect(400);
    });

    it('a disabled user loses access immediately and cannot refresh; reactivation restores sign-in', async () => {
      const u = await makeUser(prisma, { roles: ['SALES_STAFF'] });
      const s = await signIn(app, u.email);
      await api(app).get('/v1/auth/me').set(bearer(s.accessToken)).expect(200);
      await api(app).post(`/v1/users/${u.id}/disable`).set(bearer(adminToken)).send({ reason: 'left the company' }).expect(200);
      await api(app).get('/v1/auth/me').set(bearer(s.accessToken)).expect(401);
      await api(app).post('/v1/auth/refresh').send({ refreshToken: s.refreshToken }).expect(401);
      await login(app, u.email).expect(403);
      await api(app).post(`/v1/users/${u.id}/reactivate`).set(bearer(adminToken)).send({ reason: 'returned to work' }).expect(200);
      await login(app, u.email).expect(200);
      const audit = await prisma.auditLog.findMany({ where: { entityId: u.id, action: { in: ['user.disabled', 'user.reactivated'] } } });
      expect(audit.map((a) => a.action).sort()).toEqual(['user.disabled', 'user.reactivated']);
      expect(audit.every((a) => a.reason && a.userId === admin.id && a.userName === 'Super One')).toBe(true);
    });

    it('cannot disable yourself; a Super Admin can disable another, who is then locked out', async () => {
      await api(app).post(`/v1/users/${admin.id}/disable`).set(bearer(adminToken)).send({ reason: 'oops oops' }).expect(403);
      const other = await makeUser(prisma, { roles: ['SUPER_ADMIN'] });
      const o = await signIn(app, other.email);
      await api(app).post(`/v1/users/${other.id}/disable`).set(bearer(adminToken)).send({ reason: 'rotation' }).expect(200);
      await api(app).get('/v1/auth/me').set(bearer(o.accessToken)).expect(401);
    });

    it('never lets the last active Super Admin be removed (service-level invariant)', async () => {
      const svc = app.get(UsersService);
      const sole = await makeUser(prisma, { roles: ['SUPER_ADMIN'] });
      await prisma.user.updateMany({ where: { id: { not: sole.id }, roles: { some: { role: { code: 'SUPER_ADMIN' } } } }, data: { status: 'DISABLED' } });
      const actor = { id: 'x', email: 'x', fullName: 'X', familyId: 'f', roles: [], mfaEnabled: false, permissions: [...PERMISSIONS] };
      const meta = { ip: '127.0.0.1' };
      await expect(svc.disable(actor, sole.id, 'last admin test', meta)).rejects.toThrow(/At least one active Super Admin/);
      await expect(svc.setRoles(actor, sole.id, ['SALES_STAFF'], 'demote last admin', meta)).rejects.toThrow(/At least one active Super Admin/);
      await prisma.user.updateMany({ where: { id: admin.id }, data: { status: 'ACTIVE' } }); // restore shared admin
    });

    it('lets an admin list and revoke a user’s sessions', async () => {
      const u = await makeUser(prisma, { roles: ['SALES_STAFF'] });
      const s = await signIn(app, u.email);
      const list = await api(app).get(`/v1/users/${u.id}/sessions`).set(bearer(adminToken)).expect(200);
      expect(list.body).toHaveLength(1);
      await api(app).delete(`/v1/users/${u.id}/sessions`).set(bearer(adminToken)).send({ reason: 'lost phone' }).expect(200);
      await api(app).get('/v1/auth/me').set(bearer(s.accessToken)).expect(401);
    });

    it('paginates users and never returns credential material', async () => {
      const res = await api(app).get('/v1/users?limit=2&page=1').set(bearer(adminToken)).expect(200);
      expect(res.body.items.length).toBeLessThanOrEqual(2);
      expect(res.body.total).toBeGreaterThan(2);
      expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|argon2|refreshTokenHash|secretEncrypted/);
      await api(app).get('/v1/users?limit=1000').set(bearer(adminToken)).expect(400);
    });

    it('audits role-permission edits with before/after and keeps the Super Admin role immutable', async () => {
      const role = await prisma.role.findUniqueOrThrow({ where: { code: 'PRODUCTION_STAFF' } });
      const sa = await prisma.role.findUniqueOrThrow({ where: { code: 'SUPER_ADMIN' } });
      const before = (await prisma.rolePermission.findMany({ where: { roleId: role.id }, include: { permission: true } })).map((p) => p.permission.code);
      await api(app).put(`/v1/roles/${role.id}/permissions`).set(bearer(adminToken)).send({ permissionCodes: [...before, 'inventory.read'], reason: 'needs stock view' }).expect(200);
      const log = await prisma.auditLog.findFirstOrThrow({ where: { entityId: role.id, action: 'role.permissions_changed' } });
      expect(JSON.stringify(log.after)).toContain('inventory.read');
      expect(JSON.stringify(log.before)).not.toContain('inventory.read');
      await api(app).put(`/v1/roles/${role.id}/permissions`).set(bearer(adminToken)).send({ permissionCodes: before, reason: 'revert change' }).expect(200);
      await api(app).put(`/v1/roles/${sa.id}/permissions`).set(bearer(adminToken)).send({ permissionCodes: [], reason: 'strip admin' }).expect(403);
    });
  });

  // ───────────────────────── password flows ─────────────────────────
  describe('password reset and change', () => {
    it('answers forgot-password identically for known and unknown emails', async () => {
      const u = await makeUser(prisma, { roles: ['SALES_STAFF'] });
      const known = await api(app).post('/v1/auth/forgot-password').send({ email: u.email }).expect(202);
      const unknown = await api(app).post('/v1/auth/forgot-password').send({ email: uniqueEmail('nobody') }).expect(202);
      expect(known.body).toEqual(unknown.body);
    });

    /** Reads the 8-digit code out of the most recent reset e-mail (shown as two groups of four). */
    const codeFromMail = (to: string): string => {
      const m = [...mail.outbox].reverse().find((x) => x.to === to && x.subject.includes('reset code'));
      const c = m?.text.match(/Reset code: (\d{4} \d{4})/);
      if (!c) throw new Error(`no reset code mail for ${to}`);
      return c[1].replace(' ', '');
    };
    const resetPw = (email: string, code: string, newPassword: string) => api(app).post('/v1/auth/reset-password').send({ email, code, newPassword });
    const reset = (email: string) => api(app).post('/v1/auth/forgot-password').send({ email }).expect(202);
    const expireCooldown = (userId: string) => prisma.passwordResetCode.updateMany({ where: { userId }, data: { createdAt: new Date(Date.now() - 120_000) } });
    const newPw = 'meadow-gravel-orbit-58';

    it('resets the password with a single-use 8-digit code, signs out all devices, blocks the old password and remembers it', async () => {
      const u = await makeUser(prisma, { roles: ['SALES_STAFF'] });
      const s = await signIn(app, u.email);
      await reset(u.email);
      const code = codeFromMail(u.email);
      const msg = [...mail.outbox].reverse().find((x) => x.to === u.email)!;
      expect(msg.text).toMatch(/5 minutes/);
      expect(msg.html).toContain(u.email);
      await resetPw(u.email, code, newPw).expect(204);
      await resetPw(u.email, code, 'another-fine-pass-77').expect(400); // replay: the code is used up
      await api(app).get('/v1/auth/me').set(bearer(s.accessToken)).expect(401);
      await login(app, u.email, PASSWORD).expect(401);
      await login(app, u.email, newPw).expect(200);
      expect(await prisma.passwordHistory.count({ where: { userId: u.id } })).toBe(1);
      expect(await prisma.passwordResetCode.findFirstOrThrow({ where: { userId: u.id } }).then((r) => r.codeHash)).not.toContain(code); // only a keyed hash is stored
    });

    it('the code works only for the e-mail address it was sent to, and only while the account still has that address', async () => {
      const a = await makeUser(prisma, { roles: ['SALES_STAFF'] });
      const b = await makeUser(prisma, { roles: ['SALES_STAFF'] });
      await reset(a.email);
      const code = codeFromMail(a.email);
      await resetPw(b.email, code, newPw).expect(400); // someone else's address
      await resetPw(a.email.toUpperCase(), code, newPw).expect(204); // same address, case-insensitively
      await reset(b.email);
      const codeB = codeFromMail(b.email);
      await prisma.user.update({ where: { id: b.id }, data: { email: uniqueEmail('moved') } });
      await resetPw(b.email, codeB, newPw).expect(400); // the address changed after the code was sent
    });

    it('expires after 5 minutes, locks after 5 wrong tries, and a new code replaces the old one', async () => {
      const u = await makeUser(prisma, { roles: ['SALES_STAFF'] });
      await reset(u.email);
      const stale = codeFromMail(u.email);
      const row = await prisma.passwordResetCode.findFirstOrThrow({ where: { userId: u.id } });
      expect(Math.abs(row.expiresAt.getTime() - row.createdAt.getTime() - 5 * 60_000)).toBeLessThan(3000); // five minutes
      await prisma.passwordResetCode.update({ where: { id: row.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      await resetPw(u.email, stale, newPw).expect(400);

      await expireCooldown(u.id);
      await reset(u.email);
      const good = codeFromMail(u.email);
      expect(good).not.toBe(stale);
      const wrong = good === '00000000' ? '11111111' : '00000000';
      for (let i = 0; i < 5; i++) await resetPw(u.email, wrong, newPw).expect(400);
      await resetPw(u.email, good, newPw).expect(400); // locked even for the right code
      expect(await prisma.auditLog.count({ where: { userId: u.id, action: 'auth.password.reset_code_locked' } })).toBe(1);

      await expireCooldown(u.id);
      await reset(u.email);
      const fresh = codeFromMail(u.email);
      await resetPw(u.email, fresh, newPw).expect(204);
    });

    it('sends at most one code a minute per account and answers every request the same way', async () => {
      const u = await makeUser(prisma, { roles: ['SALES_STAFF'] });
      const before = mail.outbox.length;
      const first = await reset(u.email);
      const second = await reset(u.email);
      expect(first.body).toEqual(second.body);
      expect(mail.outbox.length).toBe(before + 1);
      await api(app).post('/v1/auth/reset-password').send({ email: uniqueEmail('nobody'), code: '12345678', newPassword: newPw }).expect(400); // unknown account: same generic error
    });

    it('rejects weak or recent passwords without using up the code, so it can be corrected within the 5 minutes', async () => {
      const u = await makeUser(prisma, { roles: ['SALES_STAFF'] });
      await reset(u.email);
      const code = codeFromMail(u.email);
      await resetPw(u.email, code, 'weak').expect(400);
      await resetPw(u.email, code, PASSWORD).expect(400); // the current password counts as recently used
      await resetPw(u.email, code, newPw).expect(204);
      await expireCooldown(u.id);
      await reset(u.email);
      await resetPw(u.email, codeFromMail(u.email), PASSWORD).expect(400); // an earlier password is remembered too
    });

    it('refuses passwords built from a common word, the business name, the person’s name or an obvious pattern', async () => {
      const u = await makeUser(prisma, { roles: ['SALES_STAFF'], fullName: 'Fatmata Kamara' });
      const s = await signIn(app, u.email);
      for (const bad of ['Welcome-2026-abc!', 'Makarifor-Agri-9x7!', 'fatmata-kamara-2026', 'abcdefgh-ijklmn', 'abcabcabcabcabc', 'Poultry2026!!']) {
        const r = await api(app).post('/v1/auth/change-password').set(bearer(s.accessToken)).send({ currentPassword: PASSWORD, newPassword: bad }).expect(400);
        expect(r.body.message).toBeTruthy();
      }
    });

    it('does not let the last five passwords be reused when changing the password', async () => {
      const u = await makeUser(prisma, { roles: ['SALES_STAFF'] });
      let s = await signIn(app, u.email);
      const first = 'orchard-violet-engine-41';
      await api(app).post('/v1/auth/change-password').set(bearer(s.accessToken)).send({ currentPassword: PASSWORD, newPassword: first }).expect(204);
      s = await signIn(app, u.email, first);
      const r = await api(app).post('/v1/auth/change-password').set(bearer(s.accessToken)).send({ currentPassword: first, newPassword: PASSWORD }).expect(400);
      expect(r.body.message).toMatch(/not used recently/);
    });

    it('does not send reset codes to disabled accounts', async () => {
      const u = await makeUser(prisma, { roles: ['SALES_STAFF'], status: 'DISABLED' });
      const before = mail.outbox.length;
      await api(app).post('/v1/auth/forgot-password').send({ email: u.email }).expect(202);
      expect(mail.outbox.length).toBe(before);
    });

    it('change-password verifies the current password, enforces policy, and signs out other devices but not this one', async () => {
      const u = await makeUser(prisma, { roles: ['SALES_STAFF'] });
      const a = await signIn(app, u.email, PASSWORD, { 'X-Device-Name': 'A' });
      const b = await signIn(app, u.email, PASSWORD, { 'X-Device-Name': 'B' });
      await api(app).post('/v1/auth/change-password').set(bearer(a.accessToken)).send({ currentPassword: 'wrong-current-123', newPassword: 'meadow-gravel-orbit-58' }).expect(403);
      await api(app).post('/v1/auth/change-password').set(bearer(a.accessToken)).send({ currentPassword: PASSWORD, newPassword: 'short' }).expect(400);
      await api(app).post('/v1/auth/change-password').set(bearer(a.accessToken)).send({ currentPassword: PASSWORD, newPassword: PASSWORD }).expect(400);
      await api(app).post('/v1/auth/change-password').set(bearer(a.accessToken)).send({ currentPassword: PASSWORD, newPassword: 'meadow-gravel-orbit-58' }).expect(204);
      await api(app).get('/v1/auth/me').set(bearer(a.accessToken)).expect(200);
      await api(app).get('/v1/auth/me').set(bearer(b.accessToken)).expect(401);
      expect(await prisma.auditLog.count({ where: { userId: u.id, action: 'auth.password.changed' } })).toBe(1);
    });

    it('verifies e-mail with a single-use token and resends without enumeration', async () => {
      const u = await makeUser(prisma, { roles: ['SALES_STAFF'], emailVerified: false });
      await login(app, u.email).expect(403);
      await api(app).post('/v1/auth/resend-verification').send({ email: u.email }).expect(202);
      await api(app).post('/v1/auth/resend-verification').send({ email: uniqueEmail('nobody') }).expect(202);
      const token = tokenFromMail(mail, u.email);
      await api(app).post('/v1/auth/verify-email').send({ token }).expect(204);
      await api(app).post('/v1/auth/verify-email').send({ token }).expect(400);
      await login(app, u.email).expect(200);
    });
  });

  // ───────────────────────── MFA ─────────────────────────
  describe('multi-factor authentication', () => {
    const realNow = Date.now;
    let clock = 0;
    const tick = () => { clock += 31_000; jest.spyOn(Date, 'now').mockImplementation(() => realNow() + clock); };
    afterEach(() => jest.restoreAllMocks());

    it('enrols with a QR/secret, requires a valid code at login, blocks TOTP replay, and supports single-use recovery codes', async () => {
      const u = await makeUser(prisma, { roles: ['SALES_STAFF'] });
      const s = await signIn(app, u.email);
      const enroll = await api(app).post('/v1/auth/mfa/enroll').set(bearer(s.accessToken)).expect(200);
      expect(enroll.body.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
      expect(enroll.body.qrCodeDataUrl).toMatch(/^data:image\/png;base64,/);
      const secret: string = enroll.body.secret;

      // stored encrypted, never in clear
      const stored = await prisma.mfaSecret.findUniqueOrThrow({ where: { userId: u.id } });
      expect(stored.secretEncrypted).not.toContain(secret);

      await api(app).post('/v1/auth/mfa/confirm').set(bearer(s.accessToken)).send({ code: '000000' }).expect(400);
      tick();
      const conf = await api(app).post('/v1/auth/mfa/confirm').set(bearer(s.accessToken)).send({ code: totpAt(secret, Date.now()) }).expect(200);
      expect(conf.body.recoveryCodes).toHaveLength(10);
      const dbCodes = await prisma.recoveryCode.findMany({ where: { userId: u.id } });
      expect(dbCodes.every((c) => !conf.body.recoveryCodes.includes(c.codeHash))).toBe(true); // hashed

      // login now needs the second factor
      const step1 = await login(app, u.email).expect(200);
      expect(step1.body.status).toBe('mfa_required');
      expect(step1.body.tokens).toBeUndefined();
      const mfaToken = step1.body.mfaToken;
      await api(app).post('/v1/auth/mfa/verify').send({ mfaToken, code: '111111' }).expect(401);
      await api(app).post('/v1/auth/mfa/verify').send({ mfaToken }).expect(400);
      await api(app).post('/v1/auth/mfa/verify').send({ mfaToken, code: '123456', recoveryCode: 'abcd-efgh-jkmn' }).expect(400);
      tick();
      const code = totpAt(secret, Date.now());
      const ok = await api(app).post('/v1/auth/mfa/verify').send({ mfaToken, code }).expect(200);
      expect(ok.body.status).toBe('authenticated');
      await api(app).get('/v1/auth/me').set(bearer(ok.body.tokens.accessToken)).expect(200);

      // replay of the same code is rejected
      const again = await login(app, u.email).expect(200);
      await api(app).post('/v1/auth/mfa/verify').send({ mfaToken: again.body.mfaToken, code }).expect(401);

      // recovery code works exactly once
      const rc = conf.body.recoveryCodes[0];
      const viaRecovery = await api(app).post('/v1/auth/mfa/verify').send({ mfaToken: again.body.mfaToken, recoveryCode: rc.toUpperCase() }).expect(200);
      expect(viaRecovery.body.status).toBe('authenticated');
      const third = await login(app, u.email).expect(200);
      await api(app).post('/v1/auth/mfa/verify').send({ mfaToken: third.body.mfaToken, recoveryCode: rc }).expect(401);
      expect(await prisma.auditLog.count({ where: { userId: u.id, action: 'auth.mfa.recovery_code_used' } })).toBe(1);
    });

    it('counts wrong MFA codes toward account lockout', async () => {
      const u = await makeUser(prisma, { roles: ['SALES_STAFF'] });
      const s = await signIn(app, u.email);
      const enroll = await api(app).post('/v1/auth/mfa/enroll').set(bearer(s.accessToken)).expect(200);
      tick();
      await api(app).post('/v1/auth/mfa/confirm').set(bearer(s.accessToken)).send({ code: totpAt(enroll.body.secret, Date.now()) }).expect(200);
      const step1 = await login(app, u.email).expect(200);
      for (let i = 0; i < 5; i++) await api(app).post('/v1/auth/mfa/verify').send({ mfaToken: step1.body.mfaToken, code: '000000' }).expect(401);
      await api(app).post('/v1/auth/mfa/verify').send({ mfaToken: step1.body.mfaToken, code: '000000' }).expect(429);
    });

    it('requires password + a fresh code to disable MFA, then allows plain login again', async () => {
      const u = await makeUser(prisma, { roles: ['SALES_STAFF'] });
      const s = await signIn(app, u.email);
      const enroll = await api(app).post('/v1/auth/mfa/enroll').set(bearer(s.accessToken)).expect(200);
      tick();
      await api(app).post('/v1/auth/mfa/confirm').set(bearer(s.accessToken)).send({ code: totpAt(enroll.body.secret, Date.now()) }).expect(200);
      await api(app).post('/v1/auth/mfa/disable').set(bearer(s.accessToken)).send({ password: 'wrong-password-123', code: '123456' }).expect(403);
      tick();
      await api(app).post('/v1/auth/mfa/disable').set(bearer(s.accessToken)).send({ password: PASSWORD, code: totpAt(enroll.body.secret, Date.now()) }).expect(204);
      expect((await login(app, u.email).expect(200)).body.status).toBe('authenticated');
      expect(await prisma.recoveryCode.count({ where: { userId: u.id } })).toBe(0);
    });

    it('ENFORCES MFA for privileged roles: no session until enrolled; the setup token is not an access token', async () => {
      await prisma.role.update({ where: { code: 'OWNER' }, data: { mfaRequired: true } });
      const u = await makeUser(prisma, { roles: ['OWNER'] });
      const first = await login(app, u.email).expect(200);
      expect(first.body.status).toBe('mfa_setup_required');
      expect(first.body.tokens).toBeUndefined();
      const setup = first.body.setupToken;
      await api(app).get('/v1/auth/me').set(bearer(setup)).expect(401);
      await api(app).get('/v1/users').set(bearer(setup)).expect(401);

      const enroll = await api(app).post('/v1/auth/mfa/enroll').set(bearer(setup)).expect(200);
      tick();
      const done = await api(app).post('/v1/auth/mfa/confirm').set(bearer(setup)).send({ code: totpAt(enroll.body.secret, Date.now()) }).expect(200);
      expect(done.body.status).toBe('authenticated');
      expect(done.body.recoveryCodes).toHaveLength(10);
      const at = done.body.tokens.accessToken;
      await api(app).get('/v1/users').set(bearer(at)).expect(200);

      // an Owner may not switch MFA off
      tick();
      await api(app).post('/v1/auth/mfa/disable').set(bearer(at)).send({ password: PASSWORD, code: totpAt(enroll.body.secret, Date.now()) }).expect(403);
      await prisma.role.update({ where: { code: 'OWNER' }, data: { mfaRequired: false } });
    });

    it('lets an authorised admin reset a colleague’s MFA (audited, signs them out), but not their own', async () => {
      const u = await makeUser(prisma, { roles: ['SALES_STAFF'] });
      const s = await signIn(app, u.email);
      const enroll = await api(app).post('/v1/auth/mfa/enroll').set(bearer(s.accessToken)).expect(200);
      tick();
      await api(app).post('/v1/auth/mfa/confirm').set(bearer(s.accessToken)).send({ code: totpAt(enroll.body.secret, Date.now()) }).expect(200);
      await api(app).post(`/v1/users/${u.id}/reset-mfa`).set(bearer(adminToken)).send({ reason: 'lost phone' }).expect(204);
      await api(app).get('/v1/auth/me').set(bearer(s.accessToken)).expect(401);
      expect((await login(app, u.email).expect(200)).body.status).toBe('authenticated');
      const log = await prisma.auditLog.findFirstOrThrow({ where: { entityId: u.id, action: 'auth.mfa.reset_by_admin' } });
      expect(log.userId).toBe(admin.id);
      expect(log.reason).toBe('lost phone');
      await api(app).post(`/v1/users/${admin.id}/reset-mfa`).set(bearer(adminToken)).send({ reason: 'self reset' }).expect(403);
    });

    it('refuses double enrolment and confirms nothing without a prior enroll', async () => {
      const u = await makeUser(prisma, { roles: ['SALES_STAFF'] });
      const s = await signIn(app, u.email);
      await api(app).post('/v1/auth/mfa/confirm').set(bearer(s.accessToken)).send({ code: '123456' }).expect(400);
      const enroll = await api(app).post('/v1/auth/mfa/enroll').set(bearer(s.accessToken)).expect(200);
      tick();
      await api(app).post('/v1/auth/mfa/confirm').set(bearer(s.accessToken)).send({ code: totpAt(enroll.body.secret, Date.now()) }).expect(200);
      await api(app).post('/v1/auth/mfa/enroll').set(bearer(s.accessToken)).expect(409);
      await api(app).post('/v1/auth/mfa/enroll').expect(401);
    });
  });

  // ───────────────────────── audit ─────────────────────────
  describe('audit trail', () => {
    it('records auth events without secrets and forms a verifiable hash chain', async () => {
      const u = await makeUser(prisma, { roles: ['SALES_STAFF'] });
      await login(app, u.email, 'wrong-password-123').expect(401);
      await signIn(app, u.email);
      const rows = await prisma.auditLog.findMany({ where: { userId: u.id } });
      expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(['auth.login.failed', 'auth.login.success']));
      expect(JSON.stringify(rows, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).not.toContain(PASSWORD);
      expect(rows.every((r) => r.hash && r.requestId && r.ip)).toBe(true);
      expect(await app.get(AuditService).verifyChain()).toBeNull();
    });

    it('detects tampering even if the append-only trigger were bypassed by a privileged actor', async () => {
      const u = await makeUser(prisma, { roles: ['SALES_STAFF'] });
      await signIn(app, u.email);
      const row = await prisma.auditLog.findFirstOrThrow({ where: { userId: u.id, action: 'auth.login.success' } });
      await expect(prisma.auditLog.update({ where: { id: row.id }, data: { action: 'nothing.to.see' } })).rejects.toThrow(/append-only/);
      await prisma.$executeRawUnsafe('ALTER TABLE "AuditLog" DISABLE TRIGGER audit_log_no_update_delete');
      try {
        await prisma.$executeRawUnsafe(`UPDATE "AuditLog" SET action = 'nothing.to.see' WHERE id = '${row.id}'::uuid`);
        expect(await app.get(AuditService).verifyChain()).toBe(row.id);
        await prisma.$executeRawUnsafe(`UPDATE "AuditLog" SET action = 'auth.login.success' WHERE id = '${row.id}'::uuid`);
      } finally {
        await prisma.$executeRawUnsafe('ALTER TABLE "AuditLog" ENABLE TRIGGER audit_log_no_update_delete');
      }
      expect(await app.get(AuditService).verifyChain()).toBeNull();
    });
  });

  // ───────────────────────── information disclosure ─────────────────────────
  describe('error handling', () => {
    it('never leaks stack traces, SQL or secrets in auth errors', async () => {
      const res = await api(app).post('/v1/auth/refresh').send({ refreshToken: 'bad'.repeat(10) });
      expect(JSON.stringify(res.body)).not.toMatch(/prisma|stack|node_modules|SELECT|secret/i);
      const bad = await api(app).get('/v1/users/not-a-uuid').set(bearer(adminToken)).expect(400);
      expect(JSON.stringify(bad.body)).not.toMatch(/prisma|SELECT/i);
    });
  });
});
