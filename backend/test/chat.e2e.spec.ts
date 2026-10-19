import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { io, Socket } from 'socket.io-client';
import { CallService } from '../src/chat/call.service';
import { ChatPush } from '../src/chat/chat-push.service';
import { ChatScheduler } from '../src/chat/chat.scheduler';
import { ChatService } from '../src/chat/chat.service';
import { MEDIA_STORAGE } from '../src/chat/media.storage';
import { PUSH_PROVIDER } from '../src/notifications/push/push.provider';
import { api, bearer, createApp, makeUser, seed, signIn, useIsolatedSchema } from './helpers';
import { CapturePush, FakeMedia } from './chat-support';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Who = 'owner' | 'mgr' | 'sales' | 'prod' | 'acct' | 'nochat';
type Ev = { name: string; payload: Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any

describe('Chat, groups, attachments, push and calls (e2e: real PostgreSQL, real sockets)', () => {
  let app: INestApplication; let prisma: PrismaClient; let url: string;
  let media: FakeMedia; let push: CapturePush; let chat: ChatService; let calls: CallService; let scheduler: ChatScheduler; let chatPush: ChatPush;
  const users = {} as Record<Who, { id: string; token: string; name: string }>;
  const open: Socket[] = [];

  const req = (m: 'get' | 'post' | 'put' | 'patch' | 'delete', path: string, who: Who, body?: object) =>
    (api(app) as never as Record<string, (u: string) => import('supertest').Test>)[m](`/v1${path}`).set(bearer(users[who].token)).send(body ?? {});
  const get = (p: string, w: Who) => api(app).get(`/v1${p}`).set(bearer(users[w].token));
  const until = async (cond: () => boolean | Promise<boolean>, ms = 4000) => { const t = Date.now(); while (!(await cond())) { if (Date.now() - t > ms) throw new Error('timed out'); await sleep(20); } };

  const connect = (who: Who): Promise<{ s: Socket; ev: Ev[] }> => new Promise((resolve, reject) => {
    const s = io(url, { path: '/realtime', transports: ['websocket'], auth: { token: users[who].token }, reconnection: false, timeout: 4000 });
    open.push(s);
    const ev: Ev[] = [];
    for (const n of ['chat.message', 'chat.message.updated', 'chat.receipt', 'chat.typing', 'chat.conversation', 'presence', 'call.incoming', 'call.updated', 'call.signal']) s.on(n, (payload) => ev.push({ name: n, payload }));
    s.once('ready', () => resolve({ s, ev }));
    s.once('connect_error', (e) => { s.close(); reject(e); });
  });
  const emit = (s: Socket, name: string, body: unknown): Promise<{ ok: boolean; error?: string }> => new Promise((r) => s.emit(name, body, r));
  const named = (ev: Ev[], n: string) => ev.filter((e) => e.name === n);

  const dm = async (a: Who, b: Who): Promise<string> => (await req('post', '/chat/conversations/direct', a, { userId: users[b].id })).body.id;
  const say = async (who: Who, conv: string, body = 'hello', extra: object = {}) =>
    (await req('post', `/chat/conversations/${conv}/messages`, who, { clientId: randomUUID(), kind: 'TEXT', body, ...extra })).body;

  beforeAll(async () => {
    process.env.THROTTLE_OFF = '1';
    await useIsolatedSchema('chat');
    media = new FakeMedia(); push = new CapturePush();
    ({ app, prisma } = await createApp((b) => b.overrideProvider(MEDIA_STORAGE).useValue(media).overrideProvider(PUSH_PROVIDER).useValue(push)));
    await app.listen(0);
    url = `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}`;
    await seed(prisma);
    await prisma.role.updateMany({ data: { mfaRequired: false } });
    await prisma.role.create({ data: { code: 'NOCHAT', name: 'No chat', description: 'x', isSystem: false } });
    chat = app.get(ChatService); calls = app.get(CallService); scheduler = app.get(ChatScheduler); chatPush = app.get(ChatPush);
    for (const [k, role] of [['owner', 'OWNER'], ['mgr', 'FARM_MANAGER'], ['sales', 'SALES_STAFF'], ['prod', 'PRODUCTION_STAFF'], ['acct', 'ACCOUNTANT'], ['nochat', 'NOCHAT']] as const) {
      const u = await makeUser(prisma, { roles: [role], fullName: `${k} person` });
      users[k] = { id: u.id, token: (await signIn(app, u.email)).accessToken, name: `${k} person` };
    }
  });
  afterAll(async () => {
    for (const s of open) s.close();
    await chatPush.drain();
    await prisma.$disconnect(); await app.close();
  });

  describe('access', () => {
    it('needs a signed-in user holding chat.use (401 / 403); every role gets chat.use, only managers+ may create groups', async () => {
      await api(app).get('/v1/chat/conversations').expect(401);
      await get('/chat/conversations', 'nochat').expect(403);
      await api(app).post('/v1/calls').set(bearer(users.nochat.token)).send({}).expect(403);
      for (const w of ['owner', 'mgr', 'sales', 'prod', 'acct'] as Who[]) await get('/chat/conversations', w).expect(200);
      const perm = async (code: string) => (await prisma.rolePermission.findMany({ where: { permission: { code } }, include: { role: true } })).map((r) => r.role.code).sort();
      expect(await perm('chat.groups.create')).toEqual(['FARM_MANAGER', 'OWNER', 'SUPER_ADMIN']);
    });
    it('lists only eligible people (not me, not blocked, searchable, paged)', async () => {
      const r = (await get('/chat/users?search=sales', 'owner').expect(200)).body;
      expect(r.items.map((i: { name: string }) => i.name)).toEqual(['sales person']);
      const all = (await get('/chat/users', 'owner')).body.items.map((i: { id: string }) => i.id);
      expect(all).not.toContain(users.owner.id);
      expect(all).not.toContain(users.nochat.id); // no chat.use
    });
  });

  describe('private conversations and messages', () => {
    let conv: string;
    it('opens exactly one conversation per pair, even when both people open it at the same moment', async () => {
      const ids = await Promise.all([dm('owner', 'sales'), dm('sales', 'owner'), dm('owner', 'sales'), dm('sales', 'owner'), dm('owner', 'sales')]);
      expect(new Set(ids).size).toBe(1);
      conv = ids[0];
      expect(await prisma.conversation.count({ where: { type: 'DIRECT', members: { every: { userId: { in: [users.owner.id, users.sales.id] } } } } })).toBe(1);
      await req('post', '/chat/conversations/direct', 'owner', { userId: users.owner.id }).expect(400);
      await req('post', '/chat/conversations/direct', 'owner', { userId: randomUUID() }).expect(404);
      const c = (await get(`/chat/conversations/${conv}`, 'owner')).body;
      expect(c).toMatchObject({ type: 'DIRECT', title: 'sales person', memberCount: 2 });
    });
    it('delivers in real time to the recipient (and the sender\'s other phone), never to outsiders, with the right order', async () => {
      const recipient = await connect('sales'); const senderOther = await connect('owner'); const outsider = await connect('prod');
      const m = await say('owner', conv, 'first message');
      await until(() => named(recipient.ev, 'chat.message').length === 1 && named(senderOther.ev, 'chat.message').length === 1);
      expect(named(recipient.ev, 'chat.message')[0].payload).toMatchObject({ id: m.id, body: 'first message', conversationId: conv, seq: m.seq });
      await sleep(150);
      expect(named(outsider.ev, 'chat.message')).toHaveLength(0);
      for (const c of [recipient, senderOther, outsider]) c.s.close();
    });
    it('is idempotent: a retry of the same send (also 5 in parallel) creates one message', async () => {
      const clientId = randomUUID();
      const results = await Promise.all([1, 2, 3, 4, 5].map(() => req('post', `/chat/conversations/${conv}/messages`, 'owner', { clientId, kind: 'TEXT', body: 'only once' })));
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
      expect(await prisma.message.count({ where: { clientId } })).toBe(1);
    });
    it('assigns a gapless, unique order under 25 simultaneous senders', async () => {
      const before = Number((await prisma.conversation.findUniqueOrThrow({ where: { id: conv } })).lastSeq);
      const rs = await Promise.all(Array.from({ length: 25 }, (_, i) => say(i % 2 ? 'owner' : 'sales', conv, `burst ${i}`)));
      const seqs = rs.map((r) => r.seq).sort((a, b) => a - b);
      expect(seqs).toEqual(Array.from({ length: 25 }, (_, i) => before + i + 1));
    });
    it('validates messages and refuses non-members (404, the same as a missing conversation)', async () => {
      await req('post', `/chat/conversations/${conv}/messages`, 'owner', { clientId: randomUUID(), kind: 'TEXT', body: '   ' }).expect(400);
      await req('post', `/chat/conversations/${conv}/messages`, 'owner', { clientId: randomUUID(), kind: 'TEXT', body: 'x'.repeat(4001) }).expect(400);
      await req('post', `/chat/conversations/${conv}/messages`, 'owner', { clientId: 'nope', kind: 'TEXT', body: 'x' }).expect(400);
      await req('post', `/chat/conversations/${conv}/messages`, 'owner', { clientId: randomUUID(), kind: 'EXE', body: 'x' }).expect(400);
      await req('post', `/chat/conversations/${conv}/messages`, 'owner', { clientId: randomUUID(), kind: 'IMAGE', body: 'x' }).expect(400);
      await req('post', `/chat/conversations/${conv}/messages`, 'owner', { clientId: randomUUID(), kind: 'TEXT', body: 'x', role: 'ADMIN' }).expect(400); // unknown field
      await get(`/chat/conversations/${conv}/messages`, 'prod').expect(404);
      await get(`/chat/conversations/${conv}`, 'prod').expect(404);
      await req('post', `/chat/conversations/${conv}/messages`, 'prod', { clientId: randomUUID(), kind: 'TEXT', body: 'hi' }).expect(404);
      await get(`/chat/conversations/${randomUUID()}/messages`, 'prod').expect(404);
    });
    it('pages history newest-first without gaps or repeats, and the list shows last message, time and unread count', async () => {
      const p1 = (await get(`/chat/conversations/${conv}/messages?limit=10`, 'owner')).body;
      expect(p1.items).toHaveLength(10); expect(p1.hasMore).toBe(true);
      const p2 = (await get(`/chat/conversations/${conv}/messages?limit=10&before=${p1.nextBefore}`, 'owner')).body;
      expect(p2.items[p2.items.length - 1].seq).toBe(p1.items[0].seq - 1);
      await say('owner', conv, 'final word of the day');
      const list = (await get('/chat/conversations', 'sales')).body.items.find((c: { id: string }) => c.id === conv);
      expect(list.lastMessage).toMatchObject({ preview: 'final word of the day', senderName: 'owner person' });
      expect(list.unread).toBeGreaterThan(0);
      expect(list.lastMessageAt).toBeTruthy();
    });
    it('keeps messages after the app is reopened (they are in the database, not in the socket)', async () => {
      const total = await prisma.message.count({ where: { conversationId: conv, kind: 'TEXT' } });
      const all = (await get(`/chat/conversations/${conv}/messages?limit=60`, 'sales')).body.items.filter((m: { kind: string }) => m.kind === 'TEXT');
      expect(all.length).toBe(Math.min(total, 60));
    });
  });

  describe('typing, delivery and read receipts', () => {
    it('shows typing only to the other members; delivered only after the phone acknowledges; read only when read', async () => {
      const conv = await dm('mgr', 'acct');
      const a = await connect('mgr'); const b = await connect('acct'); const x = await connect('prod');
      expect((await emit(a.s, 'chat.typing', { conversationId: conv })).ok).toBe(true);
      await until(() => named(b.ev, 'chat.typing').length === 1);
      expect(named(b.ev, 'chat.typing')[0].payload).toMatchObject({ conversationId: conv, userId: users.mgr.id });
      expect(named(a.ev, 'chat.typing')).toHaveLength(0);
      expect(await emit(x.s, 'chat.typing', { conversationId: conv })).toMatchObject({ ok: false, error: 'forbidden' });
      expect(await emit(x.s, 'chat.typing', { conversationId: 'not-a-uuid' })).toMatchObject({ ok: false });

      const m = await say('mgr', conv, 'did you get it?');
      let members = (await get(`/chat/conversations/${conv}`, 'mgr')).body.members;
      const peer = () => members.find((x: { userId: string }) => x.userId === users.acct.id);
      expect(peer().lastDeliveredSeq).toBeLessThan(m.seq); // sent, NOT delivered yet
      expect(peer().lastReadSeq).toBeLessThan(m.seq);
      expect(await emit(b.s, 'chat.delivered', { conversationId: conv, upToSeq: m.seq })).toEqual({ ok: true });
      await until(() => named(a.ev, 'chat.receipt').some((e) => e.payload.userId === users.acct.id && e.payload.delivered >= m.seq));
      members = (await get(`/chat/conversations/${conv}`, 'mgr')).body.members;
      expect(peer().lastDeliveredSeq).toBe(m.seq); expect(peer().lastReadSeq).toBeLessThan(m.seq); // delivered, NOT read
      expect(await emit(x.s, 'chat.delivered', { conversationId: conv, upToSeq: m.seq })).toMatchObject({ ok: false }); // an outsider cannot fake a receipt

      await req('post', `/chat/conversations/${conv}/read`, 'acct', { upToSeq: m.seq }).expect(200);
      await until(() => named(a.ev, 'chat.receipt').some((e) => e.payload.read >= m.seq));
      members = (await get(`/chat/conversations/${conv}`, 'mgr')).body.members;
      expect(peer().lastReadSeq).toBe(m.seq);
      expect((await get('/chat/conversations', 'acct')).body.items.find((c: { id: string }) => c.id === conv).unread).toBe(0);
      // markers never go backwards, and cannot run ahead of the real last message
      await req('post', `/chat/conversations/${conv}/read`, 'acct', { upToSeq: 1 }).expect(200);
      await req('post', `/chat/conversations/${conv}/read`, 'acct', { upToSeq: 99999 }).expect(200);
      members = (await get(`/chat/conversations/${conv}`, 'mgr')).body.members;
      expect(peer().lastReadSeq).toBe(m.seq);
      for (const c of [a, b, x]) c.s.close();
    });
  });

  describe('replies, editing, deleting, blocking, reporting', () => {
    let conv: string;
    beforeAll(async () => { conv = await dm('owner', 'prod'); });
    it('replies to a message in the same conversation only', async () => {
      const first = await say('owner', conv, 'original');
      const r = await say('prod', conv, 'answer', { replyToId: first.id });
      expect(r.replyTo).toMatchObject({ id: first.id, preview: 'original' });
      const other = await say('owner', await dm('owner', 'mgr'), 'elsewhere');
      await req('post', `/chat/conversations/${conv}/messages`, 'prod', { clientId: randomUUID(), kind: 'TEXT', body: 'x', replyToId: other.id }).expect(400);
    });
    it('lets only the author edit (within 24 hours) and shows the edit live', async () => {
      const listener = await connect('prod');
      const m = await say('owner', conv, 'typo');
      await req('patch', `/chat/messages/${m.id}`, 'prod', { body: 'hacked' }).expect(403);
      const e = (await req('patch', `/chat/messages/${m.id}`, 'owner', { body: 'fixed' }).expect(200)).body;
      expect(e).toMatchObject({ body: 'fixed' }); expect(e.editedAt).toBeTruthy();
      await until(() => named(listener.ev, 'chat.message.updated').length === 1);
      await prisma.message.update({ where: { id: m.id }, data: { createdAt: new Date(Date.now() - 25 * 3_600_000) } });
      await req('patch', `/chat/messages/${m.id}`, 'owner', { body: 'too late' }).expect(400);
      listener.s.close();
    });
    it('deletes softly: the text disappears for everyone, only the author may delete in a private chat', async () => {
      const m = await say('owner', conv, 'secret');
      await req('delete', `/chat/messages/${m.id}`, 'prod').expect(403);
      const d = (await req('delete', `/chat/messages/${m.id}`, 'owner').expect(200)).body;
      expect(d).toMatchObject({ deleted: true, body: '' });
      const listed = (await get(`/chat/conversations/${conv}/messages?limit=60`, 'prod')).body.items.find((x: { id: string }) => x.id === m.id);
      expect(listed).toMatchObject({ deleted: true, body: '' });
      expect(JSON.stringify(listed)).not.toContain('secret');
    });
    it('reports a message (audited without copying its text); not your own', async () => {
      const m = await say('owner', conv, 'rude words');
      await req('post', `/chat/messages/${m.id}/report`, 'owner', { reason: 'testing' }).expect(400);
      await req('post', `/chat/messages/${m.id}/report`, 'prod', { reason: 'abusive language' }).expect(200);
      await req('post', `/chat/messages/${m.id}/report`, 'prod', { reason: 'again' }).expect(200); // idempotent per reporter
      expect(await prisma.messageReport.count({ where: { messageId: m.id } })).toBe(1);
      const a = await prisma.auditLog.findFirstOrThrow({ where: { action: 'chat.message_reported', entityId: m.id } });
      expect(JSON.stringify(a, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).not.toContain('rude words');
    });
    it('blocking stops messages, calls and discovery in both directions and can be undone', async () => {
      await req('post', '/chat/blocks', 'prod', { userId: users.owner.id }).expect(200);
      await req('post', `/chat/conversations/${conv}/messages`, 'owner', { clientId: randomUUID(), kind: 'TEXT', body: 'hi' }).expect(403);
      await req('post', `/chat/conversations/${conv}/messages`, 'prod', { clientId: randomUUID(), kind: 'TEXT', body: 'hi' }).expect(403);
      await req('post', '/calls', 'owner', { conversationId: conv, kind: 'AUDIO' }).expect(403);
      expect((await get('/chat/users', 'owner')).body.items.map((i: { id: string }) => i.id)).not.toContain(users.prod.id);
      expect((await get('/chat/blocks', 'prod')).body).toEqual([{ userId: users.owner.id, name: 'owner person' }]);
      await req('delete', `/chat/blocks/${users.owner.id}`, 'prod').expect(200);
      await say('owner', conv, 'friends again');
      await req('post', '/chat/blocks', 'prod', { userId: users.prod.id }).expect(400);
    });
  });

  describe('groups', () => {
    let g: string;
    it('only Farm Manager / Owner / Super Admin may create groups; members are validated', async () => {
      await req('post', '/chat/conversations/group', 'sales', { title: 'Nope', memberIds: [users.prod.id] }).expect(403);
      await req('post', '/chat/conversations/group', 'owner', { title: '', memberIds: [users.prod.id] }).expect(400);
      await req('post', '/chat/conversations/group', 'owner', { title: 'Empty', memberIds: [] }).expect(400);
      await req('post', '/chat/conversations/group', 'owner', { title: 'Bad', memberIds: [users.nochat.id] }).expect(400); // no chat.use
      await req('post', '/chat/conversations/group', 'owner', { title: 'Bad', memberIds: [randomUUID()] }).expect(400);
      const watcher = await connect('sales');
      const res = await req('post', '/chat/conversations/group', 'owner', { title: 'Farm team', description: 'Daily coordination', memberIds: [users.sales.id, users.prod.id, users.mgr.id, users.sales.id] }).expect(201);
      g = res.body.id;
      expect(res.body).toMatchObject({ type: 'GROUP', title: 'Farm team', memberCount: 4, myRole: 'ADMIN' });
      expect(res.body.members.find((m: { userId: string }) => m.userId === users.sales.id).role).toBe('MEMBER');
      await until(() => named(watcher.ev, 'chat.conversation').some((e) => e.payload.id === g));
      watcher.s.close();
    });
    it('delivers group messages to every member and to nobody else', async () => {
      const ms = await Promise.all((['sales', 'prod', 'mgr', 'acct'] as Who[]).map(connect));
      const m = await say('owner', g, 'good morning team');
      await until(() => [0, 1, 2].every((i) => named(ms[i].ev, 'chat.message').some((e) => e.payload.id === m.id)));
      await sleep(150);
      expect(named(ms[3].ev, 'chat.message').some((e) => e.payload.id === m.id)).toBe(false);
      await get(`/chat/conversations/${g}/messages`, 'acct').expect(404);
      ms.forEach((c) => c.s.close());
    });
    it('lets only admins rename, add, remove and assign roles; others get 403', async () => {
      await req('patch', `/chat/conversations/${g}`, 'sales', { title: 'Hijack' }).expect(403);
      await req('post', `/chat/conversations/${g}/members`, 'sales', { userIds: [users.acct.id] }).expect(403);
      await req('delete', `/chat/conversations/${g}/members/${users.prod.id}`, 'sales').expect(403);
      await req('put', `/chat/conversations/${g}/members/${users.sales.id}/role`, 'sales', { role: 'ADMIN' }).expect(403);
      expect((await req('patch', `/chat/conversations/${g}`, 'owner', { title: 'Farm crew', description: null }).expect(200)).body).toMatchObject({ title: 'Farm crew', description: null });
      await req('patch', `/chat/conversations/${g}`, 'owner', {}).expect(400);
    });
    it('hides earlier history from people added later, and shows system events', async () => {
      await req('post', `/chat/conversations/${g}/members`, 'owner', { userIds: [users.acct.id] }).expect(201);
      const before = (await get(`/chat/conversations/${g}/messages?limit=60`, 'acct')).body.items;
      expect(before.some((m: { body: string }) => m.body === 'good morning team')).toBe(false);
      const later = await say('owner', g, 'welcome acct');
      expect((await get(`/chat/conversations/${g}/messages?limit=60`, 'acct')).body.items.map((m: { id: string }) => m.id)).toContain(later.id);
      const sys = (await get(`/chat/conversations/${g}/messages?limit=60`, 'owner')).body.items.filter((m: { kind: string }) => m.kind === 'SYSTEM').map((m: { body: string }) => m.body);
      expect(sys.some((b: string) => /created the group/.test(b))).toBe(true);
      expect(sys.some((b: string) => /added acct person/.test(b))).toBe(true);
    });
    it('lets a group admin delete others\' messages but not a plain member', async () => {
      const m = await say('prod', g, 'off topic');
      await req('delete', `/chat/messages/${m.id}`, 'sales').expect(403);
      await req('delete', `/chat/messages/${m.id}`, 'owner').expect(200);
    });
    it('promotes, demotes (never the last admin), removes and lets people leave; removed people lose access at once', async () => {
      await req('put', `/chat/conversations/${g}/members/${users.mgr.id}/role`, 'owner', { role: 'ADMIN' }).expect(200);
      const gone = await connect('prod');
      await req('delete', `/chat/conversations/${g}/members/${users.prod.id}`, 'mgr').expect(200);
      await get(`/chat/conversations/${g}/messages`, 'prod').expect(404);
      await req('post', `/chat/conversations/${g}/messages`, 'prod', { clientId: randomUUID(), kind: 'TEXT', body: 'still here?' }).expect(404);
      await until(() => named(gone.ev, 'chat.conversation').some((e) => e.payload.change === 'removed'));
      gone.s.close();
      await req('put', `/chat/conversations/${g}/members/${users.owner.id}/role`, 'mgr', { role: 'MEMBER' }).expect(200);
      await req('put', `/chat/conversations/${g}/members/${users.mgr.id}/role`, 'mgr', { role: 'MEMBER' }).expect(409); // would leave no admin
      await req('delete', `/chat/conversations/${g}/members/${users.mgr.id}`, 'mgr').expect(200); // the last admin leaves…
      const after = (await get(`/chat/conversations/${g}`, 'owner')).body;
      expect(after.members.filter((m: { role: string }) => m.role === 'ADMIN')).toHaveLength(1); // …so someone else is promoted automatically
      await req('delete', `/chat/conversations/${g}/members/${users.sales.id}`, 'sales').expect(200);
      await req('delete', `/chat/conversations/${await dm('owner', 'sales')}/members/${users.sales.id}`, 'sales').expect(400); // one-to-one chats cannot be left
      expect(await prisma.auditLog.count({ where: { action: { startsWith: 'chat.' }, entityId: g } })).toBeGreaterThanOrEqual(4);
    });
    it('caps the group size at 100 people', async () => {
      const ids = Array.from({ length: 100 }, () => randomUUID());
      await req('post', '/chat/conversations/group', 'owner', { title: 'Too big', memberIds: ids }).expect(400);
    });
  });

  describe('attachments (Cloudflare R2, pre-signed URLs)', () => {
    let conv: string;
    beforeAll(async () => { conv = await dm('owner', 'acct'); });
    const prepare = async (who: Who, mime = 'image/png', size = 5000, name = 'photo.png') => (await req('post', '/chat/attachments', who, { conversationId: conv, fileName: name, mimeType: mime, sizeBytes: size })).body;
    const uploaded = async (id: string) => { const a = await prisma.chatAttachment.findUniqueOrThrow({ where: { id } }); media.objects.set(a.storageKey, { sizeBytes: a.sizeBytes, mimeType: a.mimeType }); return a; };

    it('reports that file sharing is available, and lists limits', async () => {
      expect((await get('/chat/config', 'owner')).body).toMatchObject({ attachments: true, maxAttachmentBytes: 15 * 1024 * 1024 });
    });
    it('rejects bad types and sizes, and non-members, before any URL is issued', async () => {
      await req('post', '/chat/attachments', 'owner', { conversationId: conv, fileName: 'virus.exe', mimeType: 'application/x-msdownload', sizeBytes: 100 }).expect(400);
      await req('post', '/chat/attachments', 'owner', { conversationId: conv, fileName: 'a.png', mimeType: 'image/png', sizeBytes: 16 * 1024 * 1024 }).expect(400);
      await req('post', '/chat/attachments', 'owner', { conversationId: conv, fileName: 'a.png', mimeType: 'image/png', sizeBytes: 0 }).expect(400);
      await req('post', '/chat/attachments', 'prod', { conversationId: conv, fileName: 'a.png', mimeType: 'image/png', sizeBytes: 100 }).expect(404);
    });
    it('uploads, confirms the object, sends an image message, and lets only members download (short-lived URL, no file name in the key)', async () => {
      const up = await prepare('owner');
      expect(up.uploadUrl).toMatch(/^https:\/\/r2\.invalid\/put\/chat\//);
      const a = await prisma.chatAttachment.findUniqueOrThrow({ where: { id: up.attachmentId } });
      expect(a.storageKey).not.toContain('photo'); expect(a.status).toBe('PENDING');
      await req('post', `/chat/attachments/${up.attachmentId}/complete`, 'owner').expect(400); // nothing uploaded yet
      await req('post', '/chat/conversations/' + conv + '/messages', 'owner', { clientId: randomUUID(), kind: 'IMAGE', attachmentId: up.attachmentId }).expect(400); // not ready
      await uploaded(up.attachmentId);
      await req('post', `/chat/attachments/${up.attachmentId}/complete`, 'acct').expect(404); // only the uploader completes
      expect((await req('post', `/chat/attachments/${up.attachmentId}/complete`, 'owner').expect(200)).body.status).toBe('READY');
      const m = (await req('post', `/chat/conversations/${conv}/messages`, 'owner', { clientId: randomUUID(), kind: 'IMAGE', body: 'the new coop', attachmentId: up.attachmentId }).expect(200)).body;
      expect(m).toMatchObject({ kind: 'IMAGE', body: 'the new coop', attachment: { fileName: 'photo.png', mimeType: 'image/png', sizeBytes: 5000 } });
      await req('post', `/chat/conversations/${conv}/messages`, 'owner', { clientId: randomUUID(), kind: 'IMAGE', attachmentId: up.attachmentId }).expect(400); // one file, one message
      const dl = (await get(`/chat/attachments/${up.attachmentId}/url`, 'acct').expect(200)).body;
      expect(dl).toMatchObject({ fileName: 'photo.png', expiresInSeconds: 300 }); expect(dl.url).toMatch(/^https:\/\/r2\.invalid\/get\//);
      await get(`/chat/attachments/${up.attachmentId}/url`, 'prod').expect(404);
      await get(`/chat/attachments/${up.attachmentId}/url`, 'nochat').expect(403);
      // deleting the message deletes the file
      await req('delete', `/chat/messages/${m.id}`, 'owner').expect(200);
      expect(media.deleted).toContain(a.storageKey);
      await get(`/chat/attachments/${up.attachmentId}/url`, 'acct').expect(404);
    });
    it('refuses an uploaded file whose size differs from what was announced (and removes it)', async () => {
      const up = await prepare('owner', 'application/pdf', 2000, 'report.pdf');
      const a = await prisma.chatAttachment.findUniqueOrThrow({ where: { id: up.attachmentId } });
      media.objects.set(a.storageKey, { sizeBytes: 999999, mimeType: 'application/pdf' });
      await req('post', `/chat/attachments/${up.attachmentId}/complete`, 'owner').expect(400);
      expect(media.deleted).toContain(a.storageKey);
      expect(await prisma.chatAttachment.count({ where: { id: up.attachmentId } })).toBe(0);
    });
    it('checks that the file type matches the message type, that files belong to this conversation, and cleans abandoned uploads', async () => {
      const pdf = await prepare('owner', 'application/pdf', 1500, 'p.pdf'); await uploaded(pdf.attachmentId);
      await req('post', `/chat/attachments/${pdf.attachmentId}/complete`, 'owner').expect(200);
      await req('post', `/chat/conversations/${conv}/messages`, 'owner', { clientId: randomUUID(), kind: 'IMAGE', attachmentId: pdf.attachmentId }).expect(400);
      expect((await req('post', `/chat/conversations/${conv}/messages`, 'owner', { clientId: randomUUID(), kind: 'FILE', attachmentId: pdf.attachmentId }).expect(200)).body.kind).toBe('FILE');
      const otherConv = await dm('owner', 'mgr');
      const img = await prepare('owner'); await uploaded(img.attachmentId); await req('post', `/chat/attachments/${img.attachmentId}/complete`, 'owner').expect(200);
      await req('post', `/chat/conversations/${otherConv}/messages`, 'owner', { clientId: randomUUID(), kind: 'IMAGE', attachmentId: img.attachmentId }).expect(400);
      await prisma.chatAttachment.update({ where: { id: img.attachmentId }, data: { createdAt: new Date(Date.now() - 25 * 3_600_000) } });
      expect(await chat.purgeOrphanUploads()).toBeGreaterThanOrEqual(1);
    });
    it('profile pictures are served only to signed-in chat users, as images', async () => {
      const px = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
      await prisma.profile.update({ where: { userId: users.sales.id }, data: { avatar: px } });
      const r = await get(`/chat/users/${users.sales.id}/avatar`, 'owner').expect(200);
      expect(r.headers['content-type']).toMatch(/image\/png/); expect(r.headers['cache-control']).toMatch(/private/);
      await get(`/chat/users/${users.owner.id}/avatar`, 'owner').expect(404);
      await api(app).get(`/v1/chat/users/${users.sales.id}/avatar`).expect(401);
      expect((await get('/chat/users?search=sales', 'owner')).body.items[0].hasAvatar).toBe(true);
    });
  });

  describe('push notifications and privacy', () => {
    let conv: string;
    const token = (c: string) => `ExponentPushToken[${c.repeat(22)}]`;
    beforeAll(async () => {
      conv = await dm('mgr', 'sales');
      await prisma.notificationDevice.create({ data: { userId: users.sales.id, pushToken: token('a'), platform: 'android' } });
    });
    const settle = async () => { await sleep(120); await chatPush.drain(); };
    it('pushes only when the phone did not confirm delivery, and says just "New message" by default (no sender, no text)', async () => {
      push.reset();
      await say('mgr', conv, 'my salary is 5000');
      await settle();
      expect(push.sent).toHaveLength(1);
      expect(push.sent[0]).toMatchObject({ to: token('a'), body: 'New message', title: 'Makarifor', data: { type: 'chat', conversationId: conv } });
      expect(JSON.stringify(push.sent)).not.toMatch(/salary|mgr person/);
      expect(Object.keys(push.sent[0].data).sort()).toEqual(['conversationId', 'type']);
    });
    it('shows sender and text only when the recipient turned previews on', async () => {
      await req('put', '/chat/settings', 'sales', { showPreviews: true }).expect(200);
      push.reset(); await say('mgr', conv, 'eggs are ready'); await settle();
      expect(push.sent[0]).toMatchObject({ title: 'mgr person', body: 'eggs are ready' });
      await req('put', '/chat/settings', 'sales', { showPreviews: false }).expect(200);
    });
    it('does not push when delivery was confirmed in time, when muted, or when pushes are off', async () => {
      push.reset();
      const live = await connect('sales');
      const m = await say('mgr', conv, 'acknowledged quickly');
      await emit(live.s, 'chat.delivered', { conversationId: conv, upToSeq: m.seq });
      await settle(); expect(push.sent).toHaveLength(0);
      live.s.close();
      await req('put', `/chat/conversations/${conv}/mute`, 'sales', { muted: true }).expect(200);
      await say('mgr', conv, 'muted one'); await settle(); expect(push.sent).toHaveLength(0);
      await req('put', `/chat/conversations/${conv}/mute`, 'sales', { muted: false }).expect(200);
      await req('put', '/chat/settings', 'sales', { pushMessages: false }).expect(200);
      await say('mgr', conv, 'pushes off'); await settle(); expect(push.sent).toHaveLength(0);
      await req('put', '/chat/settings', 'sales', { pushMessages: true }).expect(200);
      await say('mgr', conv, 'back on'); await settle(); expect(push.sent).toHaveLength(1);
    });
  });

  describe('voice and video calls', () => {
    let conv: string;
    beforeAll(async () => { conv = await dm('owner', 'mgr'); });
    const start = (who: Who, kind: 'AUDIO' | 'VIDEO' = 'AUDIO', c = conv) => req('post', '/calls', who, { conversationId: c, kind });
    const act = (who: Who, id: string, a: string) => req('post', `/calls/${id}/${a}`, who);
    afterEach(async () => { await prisma.callSession.updateMany({ where: { status: { in: ['RINGING', 'ACCEPTED'] } }, data: { status: 'ENDED', endReason: 'FAILED', endedAt: new Date() } }); });

    it('rings the other person, lets them accept, relays signaling only between the two, and ends with a duration in the chat', async () => {
      const caller = await connect('owner'); const callee = await connect('mgr'); const spy = await connect('prod');
      const st = (await start('owner', 'VIDEO').expect(200)).body;
      expect(st).toMatchObject({ busy: false, call: { status: 'RINGING', kind: 'VIDEO', direction: 'outgoing', peerName: 'mgr person' }, turn: false });
      expect(st.iceServers[0].urls[0]).toMatch(/^stun:/);
      await until(() => named(callee.ev, 'call.incoming').length === 1);
      expect(named(callee.ev, 'call.incoming')[0].payload).toMatchObject({ id: st.call.id, callerName: 'owner person', kind: 'VIDEO', direction: 'incoming' });
      // the callee cannot send media signals before answering; the caller can (it sends the offer)
      expect(await emit(callee.s, 'call.signal', { callId: st.call.id, data: { type: 'x' } })).toMatchObject({ ok: false });
      expect(await emit(caller.s, 'call.signal', { callId: st.call.id, data: { type: 'offer', sdp: 'v=0' } })).toEqual({ ok: true });
      await until(() => named(callee.ev, 'call.signal').length === 1);
      const acc = (await act('mgr', st.call.id, 'accept').expect(200)).body;
      expect(acc.call.status).toBe('ACCEPTED'); expect(acc.iceServers).toBeTruthy();
      await until(() => named(caller.ev, 'call.updated').some((e) => e.payload.status === 'ACCEPTED'));
      expect(await emit(callee.s, 'call.signal', { callId: st.call.id, data: { type: 'answer', sdp: 'v=0' } })).toEqual({ ok: true });
      await until(() => named(caller.ev, 'call.signal').length === 1);
      expect(await emit(spy.s, 'call.signal', { callId: st.call.id, data: { type: 'x' } })).toMatchObject({ ok: false }); // not a participant
      expect(await emit(caller.s, 'call.signal', { callId: st.call.id, data: { big: 'x'.repeat(30000) } })).toMatchObject({ ok: false }); // size limit
      await sleep(100);
      expect(named(spy.ev, 'call.signal')).toHaveLength(0);
      await prisma.callSession.update({ where: { id: st.call.id }, data: { answeredAt: new Date(Date.now() - 93_000) } });
      const end = (await act('owner', st.call.id, 'end').expect(200)).body;
      expect(end.call).toMatchObject({ status: 'ENDED', endReason: 'COMPLETED' }); expect(end.call.durationSeconds).toBeGreaterThanOrEqual(93);
      expect((await act('mgr', st.call.id, 'end').expect(200)).body.changed).toBe(false); // ending twice is harmless
      expect(await emit(caller.s, 'call.signal', { callId: st.call.id, data: { type: 'late' } })).toMatchObject({ ok: false }); // ended calls relay nothing
      const msgs = (await get(`/chat/conversations/${conv}/messages?limit=5`, 'mgr')).body.items;
      expect(msgs[msgs.length - 1]).toMatchObject({ kind: 'CALL' }); expect(msgs[msgs.length - 1].body).toMatch(/^VIDEO\|COMPLETED\|9\d$/);
      for (const c of [caller, callee, spy]) c.s.close();
    });
    it('supports rejecting, cancelling and refuses strangers (404) and wrong-role actions', async () => {
      const a = (await start('owner').expect(200)).body.call;
      await act('prod', a.id, 'reject').expect(404);
      await act('owner', a.id, 'accept').expect(409); // the caller cannot answer their own call
      expect((await act('mgr', a.id, 'reject').expect(200)).body.call).toMatchObject({ status: 'ENDED', endReason: 'REJECTED' });
      const b = (await start('owner').expect(200)).body.call;
      await act('mgr', b.id, 'cancel').expect(409);
      expect((await act('owner', b.id, 'cancel').expect(200)).body.call).toMatchObject({ endReason: 'CANCELLED' });
      await act('mgr', b.id, 'accept').expect(409); // too late
    });
    it('handles busy people: a second caller is told "busy" and is not connected; you cannot start two calls', async () => {
      const first = (await start('owner').expect(200)).body.call;
      await act('mgr', first.id, 'accept').expect(200);
      const c2 = await dm('acct', 'mgr');
      const busy = (await start('acct', 'AUDIO', c2).expect(200)).body;
      expect(busy).toMatchObject({ busy: true, call: { status: 'ENDED', endReason: 'BUSY' } });
      await start('owner', 'AUDIO', await dm('owner', 'sales')).expect(409); // already in a call
      await act('owner', first.id, 'end').expect(200);
    });
    it('resolves a simultaneous accept and cancel to exactly one winner, and the loser is told', async () => {
      const call = (await start('owner').expect(200)).body.call;
      const [a, c] = await Promise.all([act('mgr', call.id, 'accept'), act('owner', call.id, 'cancel')]);
      const final = await prisma.callSession.findUniqueOrThrow({ where: { id: call.id } });
      expect([a.status, c.status].filter((s) => s === 200).length).toBeGreaterThanOrEqual(1);
      if (final.status === 'ACCEPTED') { expect(a.status).toBe(200); expect(c.status).toBe(409); } else { expect(final.endReason).toBe('CANCELLED'); expect(a.status).toBe(409); }
    });
    it('marks unanswered calls as missed after the ring time, tells the callee, and pushes a "Missed call"', async () => {
      await prisma.notificationDevice.create({ data: { userId: users.mgr.id, pushToken: `ExponentPushToken[${'m'.repeat(22)}]`, platform: 'ios' } });
      push.reset();
      const call = (await start('owner').expect(200)).body.call;
      await sleep(80); expect(push.sent.some((p) => p.data.type === 'call' && p.priority === 'high' && p.channelId === 'calls' && p.title === 'Makarifor')).toBe(true);
      await prisma.callSession.update({ where: { id: call.id }, data: { createdAt: new Date(Date.now() - 60_000) } });
      expect((await calls.sweep()).missed).toBe(1);
      expect(await prisma.callSession.findUniqueOrThrow({ where: { id: call.id } })).toMatchObject({ status: 'ENDED', endReason: 'MISSED' });
      await sleep(80); expect(push.sent.some((p) => p.data.type === 'missed_call')).toBe(true);
      expect((await calls.sweep()).missed).toBe(0); // idempotent
      const last = (await get(`/chat/conversations/${conv}/messages?limit=3`, 'mgr')).body.items.pop();
      expect(last.body).toBe('AUDIO|MISSED|0');
    });
    it('ends an accepted call as failed when someone stays disconnected, but not for a short drop', async () => {
      const caller = await connect('owner'); const callee = await connect('mgr');
      const call = (await start('owner').expect(200)).body.call;
      await act('mgr', call.id, 'accept').expect(200);
      callee.s.close(); await sleep(60); // brief drop…
      const back = await connect('mgr'); await sleep(450); // …they reconnect inside the grace period
      expect((await prisma.callSession.findUniqueOrThrow({ where: { id: call.id } })).status).toBe('ACCEPTED');
      back.s.close(); await sleep(900); // gone for good
      expect(await prisma.callSession.findUniqueOrThrow({ where: { id: call.id } })).toMatchObject({ status: 'ENDED', endReason: 'FAILED' });
      caller.s.close();
    });
    it('only works in one-to-one chats; history lists calls for both people', async () => {
      const grp = (await req('post', '/chat/conversations/group', 'owner', { title: 'Crew', memberIds: [users.mgr.id] })).body.id;
      await start('owner', 'AUDIO', grp).expect(400);
      await start('prod', 'AUDIO', conv).expect(404);
      const h = (await get('/calls?limit=50', 'mgr')).body;
      expect(h.total).toBeGreaterThan(3);
      expect(h.items.some((c: { peerName: string }) => c.peerName === 'owner person')).toBe(true);
      expect(h.items.every((c: { peerName: string }) => c.peerName !== 'mgr person')).toBe(true); // history shows the OTHER person
      expect(h.items.some((c: { direction: string }) => c.direction === 'incoming')).toBe(true);
      expect((await get('/calls/current', 'mgr')).body.call).toBeNull();
    });
    it('gets TURN credentials from Cloudflare on the server side without leaking the API token', async () => {
      const ice = app.get(CallService)['ice'] as unknown as { turnConfigured: boolean; servers(): Promise<{ iceServers: { urls: string[]; credential?: string }[]; turn: boolean }>; cache?: unknown; config: { get: (k: string) => string } };
      const cfg = ice.config; const realGet = cfg.get.bind(cfg);
      jest.spyOn(cfg, 'get').mockImplementation(((k: string, o?: unknown) => (k === 'CF_TURN_KEY_ID' ? 'key123' : k === 'CF_TURN_API_TOKEN' ? 'super-secret-token' : (realGet as (k: string, o?: unknown) => string)(k, o))) as never);
      let seen: { url: string; auth: string; body: string } | undefined;
      const realFetch = global.fetch;
      global.fetch = (async (u: string, init: { headers: Record<string, string>; body: string }) => { seen = { url: u, auth: init.headers.Authorization, body: init.body }; return { ok: true, json: async () => ({ iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }, { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:5349?transport=tcp'], username: 'u1', credential: 'c1' }, { urls: ['http://evil.example'], username: 'x' }] }) }; }) as never;
      try {
        const r = (await get('/calls/ice', 'owner').expect(200)).body;
        expect(r.turn).toBe(true);
        expect(r.iceServers).toHaveLength(2); // the malformed entry was dropped
        expect(r.iceServers[1]).toMatchObject({ username: 'u1', credential: 'c1' });
        expect(seen?.url).toBe('https://rtc.live.cloudflare.com/v1/turn/keys/key123/credentials/generate-ice-servers');
        expect(seen?.auth).toBe('Bearer super-secret-token');
        expect(JSON.stringify(r)).not.toContain('super-secret-token');
      } finally { global.fetch = realFetch; jest.restoreAllMocks(); }
    });
  });

  describe('presence and housekeeping', () => {
    it('tells people you chat with when you come online / go offline, and remembers last seen', async () => {
      const watcher = await connect('owner');
      const other = await connect('acct'); // shares a conversation with owner (see attachments)
      await until(() => named(watcher.ev, 'presence').some((e) => e.payload.userId === users.acct.id && e.payload.online === true));
      other.s.close();
      await until(() => named(watcher.ev, 'presence').some((e) => e.payload.userId === users.acct.id && e.payload.online === false));
      expect((await prisma.profile.findUniqueOrThrow({ where: { userId: users.acct.id } })).lastSeenAt).not.toBeNull();
      expect((await get('/chat/users?search=acct', 'owner')).body.items[0].online).toBe(false);
      watcher.s.close();
    });
    it('optionally deletes old messages and their files (retention), and the scheduler tick is safe to repeat', async () => {
      const conv = await dm('prod', 'acct');
      const m = await say('prod', conv, 'ancient');
      await prisma.message.update({ where: { id: m.id }, data: { createdAt: new Date(Date.now() - 400 * 86_400_000) } });
      expect(await chat.purgeOlderThan(0)).toEqual({ messages: 0, files: 0 }); // off by default
      expect((await chat.purgeOlderThan(365)).messages).toBeGreaterThanOrEqual(1);
      expect(await prisma.message.count({ where: { id: m.id } })).toBe(0);
      await scheduler.tick(); await scheduler.tick();
    });
  });
});
