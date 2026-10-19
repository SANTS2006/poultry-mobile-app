import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { GoogleIdentityService } from '../src/auth/google-identity.service';
import { api, createApp, makeUser, seed, uniqueEmail } from './helpers';

/** The real service checks Google's signature; here a stand-in reads the e-mail out of the token so the account rules can be tested. */
const fake = { enabled: true, verify: async (t: string) => { const [email, verified] = t.split('|').slice(-2); return { email, emailVerified: verified !== 'unverified' }; } };
const token = (email: string, verified = 'verified') => `${'x'.repeat(120)}|${email}|${verified}`;

describe('Sign in with Google (e2e, real PostgreSQL)', () => {
  let app: INestApplication; let prisma: PrismaClient;
  beforeAll(async () => {
    process.env.THROTTLE_OFF = '1';
    ({ app, prisma } = await createApp((b) => b.overrideProvider(GoogleIdentityService).useValue(fake)));
    await seed(prisma);
    await prisma.role.updateMany({ data: { mfaRequired: false } });
  });
  afterAll(async () => { await prisma.$disconnect(); await app.close(); });
  const google = (email: string, verified?: string) => api(app).post('/v1/auth/google').send({ idToken: token(email, verified) });

  it('signs in an account the administrator already created', async () => {
    const u = await makeUser(prisma, { roles: ['SALES_STAFF'] });
    const res = await google(u.email).expect(200);
    expect(res.body.status).toBe('authenticated');
    expect(res.body.user.email).toBe(u.email);
    await api(app).get('/v1/auth/me').set({ Authorization: `Bearer ${res.body.tokens.accessToken}` }).expect(200);
  });

  it('refuses an unknown account with the contact-admin message and creates nothing', async () => {
    const email = uniqueEmail('stranger');
    const res = await google(email).expect(404);
    expect(JSON.stringify(res.body)).toContain('Account not found. Please contact your administrator.');
    expect(await prisma.user.count({ where: { email } })).toBe(0);
  });

  it('refuses an e-mail address Google has not verified, and a disabled account', async () => {
    const u = await makeUser(prisma, { roles: ['SALES_STAFF'] });
    await google(u.email, 'unverified').expect(404);
    const d = await makeUser(prisma, { roles: ['SALES_STAFF'], status: 'DISABLED' });
    await google(d.email).expect(403);
  });

  it('accepts an invitation that has not been activated yet', async () => {
    const u = await makeUser(prisma, { roles: ['SALES_STAFF'], status: 'INVITED', emailVerified: false });
    await google(u.email).expect(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).status).toBe('ACTIVE');
  });

  it('still asks for the second step when the account has one', async () => {
    const u = await makeUser(prisma, { roles: ['SALES_STAFF'] });
    await prisma.user.update({ where: { id: u.id }, data: { mfaEnabled: true } });
    expect((await google(u.email).expect(200)).body.status).toBe('mfa_required');
  });

  it('rejects a malformed request', async () => {
    await api(app).post('/v1/auth/google').send({ idToken: 'short' }).expect(400);
  });
});
