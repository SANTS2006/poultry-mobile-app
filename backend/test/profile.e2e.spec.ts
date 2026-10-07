import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { MailService } from '../src/mail/mail.service';
import { api, bearer, createApp, login, makeUser, PASSWORD, seed, signIn, uniqueEmail } from './helpers';

const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

describe('Own profile: name, picture, email (e2e, real PostgreSQL)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let mail: MailService;

  beforeAll(async () => {
    process.env.THROTTLE_OFF = '1';
    ({ app, mail, prisma } = await createApp());
    await seed(prisma);
  });
  afterAll(async () => { await prisma.$disconnect(); await app.close(); });

  it('updates name and picture, returns them from /auth/me and at login, and audits without storing the image', async () => {
    const u = await makeUser(prisma, { roles: ['SALES_STAFF'], fullName: 'Old Name' });
    const { accessToken } = await signIn(app, u.email);
    const res = await api(app).patch('/v1/auth/profile').set(bearer(accessToken)).send({ fullName: '  New Name  ', avatar: PIXEL }).expect(200);
    expect(res.body).toMatchObject({ fullName: 'New Name', avatar: PIXEL });
    const me = await api(app).get('/v1/auth/me').set(bearer(accessToken)).expect(200);
    expect(me.body).toMatchObject({ fullName: 'New Name', avatar: PIXEL });
    expect((await login(app, u.email).expect(200)).body.user.avatar).toBe(PIXEL);
    const log = await prisma.auditLog.findFirstOrThrow({ where: { userId: u.id, action: 'auth.profile.updated' }, orderBy: { seq: 'desc' } });
    expect(JSON.stringify({ a: log.action, b: log.before, c: log.after })).not.toContain('base64');
    await api(app).patch('/v1/auth/profile').set(bearer(accessToken)).send({ avatar: null }).expect(200).expect((r) => expect(r.body.avatar).toBeNull());
  });

  it('refuses non-image data, oversized images, and empty updates', async () => {
    const u = await makeUser(prisma, { roles: ['SALES_STAFF'] });
    const { accessToken } = await signIn(app, u.email);
    const patch = (b: object) => api(app).patch('/v1/auth/profile').set(bearer(accessToken)).send(b);
    await patch({ avatar: 'data:text/html;base64,PHNjcmlwdD4=' }).expect(400);
    await patch({ avatar: 'https://example.com/a.png' }).expect(400);
    await patch({ avatar: `data:image/png;base64,${'A'.repeat(210_000)}` }).expect(400);
    await patch({}).expect(400);
    await patch({ fullName: 'x' }).expect(400);
    await api(app).patch('/v1/auth/profile').send({ fullName: 'No Auth' }).expect(401);
  });

  it('changes the email only with the right password, needs re-verification, tells the old address, and refuses duplicates', async () => {
    const u = await makeUser(prisma, { roles: ['SALES_STAFF'] });
    const other = await makeUser(prisma, { roles: ['SALES_STAFF'] });
    const { accessToken } = await signIn(app, u.email);
    const post = (b: object) => api(app).post('/v1/auth/change-email').set(bearer(accessToken)).send(b);
    const next = uniqueEmail('changed');
    await post({ newEmail: next, currentPassword: 'wrong-password-123' }).expect(403);
    await post({ newEmail: other.email, currentPassword: PASSWORD }).expect(400);
    await post({ newEmail: u.email, currentPassword: PASSWORD }).expect(400);
    const ok = await post({ newEmail: next.toUpperCase(), currentPassword: PASSWORD }).expect(200);
    expect(ok.body).toMatchObject({ email: u.email, pendingEmail: next }); // nothing changes until the new mailbox confirms
    await login(app, u.email).expect(200);
    const msg = [...mail.outbox].reverse().find((m) => m.to === next);
    const token = decodeURIComponent(msg!.text.match(/token=([A-Za-z0-9_%-]+)/)![1]);
    await api(app).post('/v1/auth/verify-email').send({ token }).expect(204);
    expect(mail.outbox.some((m) => m.to === u.email && m.subject.includes('email address was changed'))).toBe(true);
    await login(app, next).expect(200);
    await login(app, u.email).expect(401);
    await api(app).post('/v1/auth/verify-email').send({ token }).expect(400); // single use
  });
});
