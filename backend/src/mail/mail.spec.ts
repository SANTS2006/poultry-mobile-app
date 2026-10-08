import type { ConfigService } from '@nestjs/config';
import type { PinoLogger } from 'nestjs-pino';
import { renderEmail } from './email-template';
import { MailComposer } from './mail-composer.service';
import { MailService } from './mail.service';

const logger = { setContext: jest.fn(), warn: jest.fn(), error: jest.fn() } as unknown as PinoLogger;
const config = (o: Record<string, string>) => ({ get: (k: string) => o[k] ?? '' }) as unknown as ConfigService<never, true>;
const brand = { businessName: 'Makarifor Agriculture', systemName: 'Poultry Management System' };

describe('MailService (Brevo)', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  it('captures messages in memory when no API key is set (development/test only)', async () => {
    const m = new MailService(config({}), logger);
    expect(m.enabled).toBe(false);
    expect(await m.send({ to: 'a@b.co', subject: 'S', text: 'T' })).toBe(true);
    expect(m.outbox).toHaveLength(1);
  });

  it('posts to the Brevo transactional API with the key in a header and the sender from configuration', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 201, text: async () => '' });
    global.fetch = fetchMock as never;
    const m = new MailService(config({ BREVO_API_KEY: 'xkeysib-secret', EMAIL_FROM: 'no-reply@farm.com', EMAIL_FROM_NAME: 'Farm' }), logger);
    expect(await m.send({ to: 'user@x.com', subject: 'Hi', text: 'plain', html: '<p>rich</p>' })).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string>; body: string }];
    expect(url).toBe('https://api.brevo.com/v3/smtp/email');
    expect(init.headers['api-key']).toBe('xkeysib-secret');
    expect(JSON.parse(init.body)).toEqual({ sender: { name: 'Farm', email: 'no-reply@farm.com' }, to: [{ email: 'user@x.com' }], subject: 'Hi', textContent: 'plain', htmlContent: '<p>rich</p>' });
    expect(m.outbox).toHaveLength(0);
  });

  it('reports failure (never throws) when Brevo rejects or the network fails, and never logs the message body', async () => {
    const m = new MailService(config({ BREVO_API_KEY: 'k', EMAIL_FROM: 'a@b.co' }), logger);
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 401, text: async () => '{"message":"Key not found"}' }) as never;
    expect(await m.send({ to: 'u@x.com', subject: 'S', text: 'secret-temp-password' })).toBe(false);
    global.fetch = jest.fn().mockRejectedValue(new Error('offline')) as never;
    expect(await m.send({ to: 'u@x.com', subject: 'S', text: 'secret-temp-password' })).toBe(false);
    expect(JSON.stringify((logger.error as jest.Mock).mock.calls)).not.toContain('secret-temp-password');
  });
});

describe('renderEmail', () => {
  it('shows the business name, details and steps in HTML and in the plain-text twin', () => {
    const { html, text } = renderEmail(brand, {
      preheader: 'Pre', heading: 'Welcome', greeting: 'Hello Ada,', paragraphs: ['Body line.'],
      details: [{ label: 'Role', value: 'Sales Staff' }, { label: 'Temporary password', value: 'MA2026', emphasis: true }], steps: ['Sign in.', 'Choose a password.'],
      button: { label: 'Open the app', url: 'makarifor://x?token=abc' }, note: 'Ignore if unexpected.',
    });
    for (const needle of ['Makarifor Agriculture', 'Poultry Management System', 'Sales Staff', 'MA2026', 'Sign in.', 'Open the app']) expect(html).toContain(needle);
    for (const needle of ['Welcome', 'Hello Ada,', 'Role: Sales Staff', 'Temporary password: MA2026', '1. Sign in.', '2. Choose a password.', 'Open the app: makarifor://x?token=abc', 'Ignore if unexpected.']) expect(text).toContain(needle);
    expect(html).toContain('lang="en"');
    expect(html).not.toMatch(/<img/); // no remote images: many mail apps block them
  });

  it('escapes anything a person typed (names, business name) so it cannot inject markup', () => {
    const { html, text } = renderEmail({ businessName: '<b>Farm</b>', systemName: 'S' }, { preheader: 'p', heading: 'Hi "<script>alert(1)</script>"', paragraphs: ['a & b'] });
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>Farm</b>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('a &amp; b');
    expect(text).toContain('<script>'); // the text part is plain text, shown literally
  });
});

describe('MailComposer', () => {
  it('uses the farm record for the business name, caches it, and falls back to a default', async () => {
    const findFirst = jest.fn().mockResolvedValueOnce({ name: '  Green Valley Farm ' }).mockResolvedValue(null);
    const send = jest.fn().mockResolvedValue(true);
    const c = new MailComposer({ send } as never, { farm: { findFirst } } as never);
    expect(await c.businessName()).toBe('Green Valley Farm');
    expect(await c.businessName()).toBe('Green Valley Farm');
    expect(findFirst).toHaveBeenCalledTimes(1);
    await c.send('to@x.com', 'Subj', { preheader: 'p', heading: 'H', paragraphs: ['b'] });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: 'to@x.com', subject: 'Subj', html: expect.stringContaining('Green Valley Farm'), text: expect.stringContaining('Green Valley Farm') }));
    const fresh = new MailComposer({ send } as never, { farm: { findFirst } } as never);
    expect(await fresh.businessName()).toBe('Makarifor Agriculture');
  });
});
