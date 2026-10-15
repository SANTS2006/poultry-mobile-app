import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PinoLogger } from 'nestjs-pino';
import { AuditService } from '../audit/audit.service';
import type { AuthUser, RequestMeta } from '../auth/auth.types';
import { RealtimeEmitter } from '../realtime/realtime-emitter.service';
import { PrismaService } from '../prisma/prisma.service';
import { ChatPush } from './chat-push.service';
import {
  ALLOWED_ATTACHMENT_TYPES, DOWNLOAD_URL_TTL_S, EDIT_WINDOW_MS, MAX_ATTACHMENT_BYTES, MAX_GROUP_MEMBERS, MAX_MESSAGE_CHARS, PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX,
  UPLOAD_URL_TTL_S, directKey, safeFileName,
} from './chat.constants';
import { MEDIA_STORAGE, type MediaStorage } from './media.storage';

type Tx = Prisma.TransactionClient;
const num = (b: bigint | number | null | undefined): number => Number(b ?? 0);

export interface MessageView {
  id: string; conversationId: string; seq: number; senderId: string | null; senderName: string | null; kind: string; body: string; clientId: string | null;
  replyTo: { id: string; senderId: string | null; senderName: string | null; kind: string; preview: string; deleted: boolean } | null;
  attachment: { id: string; fileName: string; mimeType: string; sizeBytes: number } | null;
  createdAt: string; editedAt: string | null; deleted: boolean;
}

const msgInclude = {
  sender: { select: { id: true, profile: { select: { fullName: true } } } },
  attachment: true,
  replyTo: { include: { sender: { select: { id: true, profile: { select: { fullName: true } } } } } },
} satisfies Prisma.MessageInclude;
type MsgRow = Prisma.MessageGetPayload<{ include: typeof msgInclude }>;

const previewOf = (m: { kind: string; body: string; deletedAt: Date | null }): string => {
  if (m.deletedAt) return 'Message deleted';
  if (m.kind === 'IMAGE') return m.body ? `Photo · ${m.body}`.slice(0, 80) : 'Photo';
  if (m.kind === 'FILE') return m.body ? `File · ${m.body}`.slice(0, 80) : 'File';
  if (m.kind === 'CALL') return callText(m.body);
  return m.body.slice(0, 80);
};

/** "AUDIO|COMPLETED|93" → "Voice call · 1:33" */
export function callText(body: string): string {
  const [kind, reason, secs] = body.split('|');
  const label = kind === 'VIDEO' ? 'Video call' : 'Voice call';
  if (reason === 'COMPLETED') { const s = Number(secs) || 0; return `${label} · ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
  return { MISSED: `Missed ${label.toLowerCase()}`, REJECTED: `${label} declined`, CANCELLED: `Cancelled ${label.toLowerCase()}`, BUSY: `${label} (busy)`, FAILED: `${label} failed` }[reason ?? ''] ?? label;
}

export const toMessageView = (m: MsgRow): MessageView => ({
  id: m.id, conversationId: m.conversationId, seq: num(m.seq), senderId: m.senderId, senderName: m.sender?.profile?.fullName ?? null, kind: m.kind,
  body: m.deletedAt ? '' : m.body, clientId: m.clientId,
  replyTo: m.replyTo ? { id: m.replyTo.id, senderId: m.replyTo.senderId, senderName: m.replyTo.sender?.profile?.fullName ?? null, kind: m.replyTo.kind, preview: previewOf(m.replyTo), deleted: !!m.replyTo.deletedAt } : null,
  attachment: m.attachment && !m.deletedAt ? { id: m.attachment.id, fileName: m.attachment.fileName, mimeType: m.attachment.mimeType, sizeBytes: m.attachment.sizeBytes } : null,
  createdAt: m.createdAt.toISOString(), editedAt: m.editedAt?.toISOString() ?? null, deleted: !!m.deletedAt,
});

export interface SendInput { clientId: string; kind: 'TEXT' | 'IMAGE' | 'FILE'; body?: string; replyToId?: string; attachmentId?: string }

@Injectable()
export class ChatService {
  constructor(
    private readonly prisma: PrismaService, private readonly emitter: RealtimeEmitter, private readonly push: ChatPush, private readonly audit: AuditService,
    private readonly logger: PinoLogger, @Inject(MEDIA_STORAGE) private readonly media: MediaStorage,
  ) { this.logger.setContext(ChatService.name); }

  // ───────────── access helpers ─────────────

  /** The caller's ACTIVE membership, or 404 (the same answer whether the conversation exists or not, so ids cannot be probed). */
  async membership(userId: string, conversationId: string, db: Tx | PrismaService = this.prisma) {
    const m = await db.conversationMember.findUnique({ where: { conversationId_userId: { conversationId, userId } }, include: { conversation: true } });
    if (!m || m.leftAt) throw new NotFoundException('Conversation not found');
    return m;
  }

  async activeMemberIds(conversationId: string): Promise<string[]> {
    return (await this.prisma.conversationMember.findMany({ where: { conversationId, leftAt: null }, select: { userId: true } })).map((m) => m.userId);
  }

  private async blockedBetween(a: string, b: string): Promise<boolean> {
    return (await this.prisma.userBlock.count({ where: { OR: [{ blockerId: a, blockedId: b }, { blockerId: b, blockedId: a }] } })) > 0;
  }

  private async avatarFlags(ids: string[]): Promise<Set<string>> {
    if (!ids.length) return new Set();
    const rows = await this.prisma.$queryRaw<{ userId: string }[]>`SELECT "userId" FROM "Profile" WHERE "userId" = ANY(${ids}::uuid[]) AND "avatar" IS NOT NULL`;
    return new Set(rows.map((r) => r.userId));
  }

  config() {
    return { attachments: this.media.configured, maxAttachmentBytes: MAX_ATTACHMENT_BYTES, maxMessageChars: MAX_MESSAGE_CHARS, maxGroupMembers: MAX_GROUP_MEMBERS, allowedTypes: Object.keys(ALLOWED_ATTACHMENT_TYPES), editWindowMinutes: EDIT_WINDOW_MS / 60_000 };
  }

  // ───────────── people ─────────────

  async users(me: AuthUser, search: string | undefined, page: number, limit: number) {
    const q = search?.trim();
    const where: Prisma.UserWhereInput = {
      id: { not: me.id }, status: 'ACTIVE', deletedAt: null,
      roles: { some: { role: { permissions: { some: { permission: { code: 'chat.use' } } } } } },
      NOT: { OR: [{ blocksMade: { some: { blockedId: me.id } } }, { blocksReceived: { some: { blockerId: me.id } } }] },
      ...(q ? { OR: [{ profile: { fullName: { contains: q, mode: 'insensitive' } } }, { email: { contains: q, mode: 'insensitive' } }] } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.user.findMany({ where, orderBy: { profile: { fullName: 'asc' } }, skip: (page - 1) * limit, take: limit, select: { id: true, profile: { select: { fullName: true, updatedAt: true } }, roles: { select: { role: { select: { name: true } } } } } }),
      this.prisma.user.count({ where }),
    ]);
    const flags = await this.avatarFlags(rows.map((r) => r.id));
    return { items: rows.map((r) => ({ id: r.id, name: r.profile?.fullName ?? 'User', role: r.roles[0]?.role.name ?? null, hasAvatar: flags.has(r.id), avatarVersion: r.profile?.updatedAt.getTime() ?? 0, online: this.emitter.isOnline(r.id) })), page, limit, total };
  }

  async userAvatar(userId: string): Promise<Buffer | null> {
    const p = await this.prisma.profile.findUnique({ where: { userId }, select: { avatar: true } });
    return dataUrlToBuffer(p?.avatar);
  }
  async conversationAvatar(me: string, conversationId: string): Promise<Buffer | null> {
    await this.membership(me, conversationId);
    const c = await this.prisma.conversation.findUnique({ where: { id: conversationId }, select: { avatar: true } });
    return dataUrlToBuffer(c?.avatar);
  }

  // ───────────── conversations ─────────────

  private async view(me: string, rows: { conversationId: string; lastReadSeq: bigint; visibleFromSeq: bigint; muted: boolean; mutedUntil: Date | null; role: string; conversation: Prisma.ConversationGetPayload<{ include: { members: { include: { user: { select: { id: true; profile: { select: { fullName: true; updatedAt: true } } } } } } } }> }[]) {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.conversationId);
    const [last, unread, flags] = await Promise.all([
      this.prisma.message.findMany({ where: { OR: rows.map((r) => ({ conversationId: r.conversationId, seq: r.conversation.lastSeq })) }, include: msgInclude }),
      this.prisma.$queryRaw<{ conversationId: string; n: bigint }[]>`
        SELECT m."conversationId", count(*)::bigint AS n FROM "Message" m
        JOIN "ConversationMember" cm ON cm."conversationId" = m."conversationId" AND cm."userId" = ${me}::uuid
        WHERE m."conversationId" = ANY(${ids}::uuid[]) AND m."seq" > cm."lastReadSeq" AND m."seq" > cm."visibleFromSeq"
          AND m."senderId" IS DISTINCT FROM ${me}::uuid AND m."deletedAt" IS NULL AND m."kind" <> 'SYSTEM'
        GROUP BY m."conversationId"`,
      this.avatarFlags(rows.flatMap((r) => r.conversation.members.map((m) => m.userId))),
    ]);
    const lastBy = new Map(last.map((m) => [m.conversationId, m]));
    const unreadBy = new Map(unread.map((u) => [u.conversationId, Number(u.n)]));
    return rows.map((r) => {
      const c = r.conversation;
      const active = c.members.filter((m) => !m.leftAt);
      const other = c.type === 'DIRECT' ? active.find((m) => m.userId !== me) ?? c.members.find((m) => m.userId !== me) : null;
      const lm = lastBy.get(c.id);
      const visible = lm && num(lm.seq) > num(r.visibleFromSeq) ? lm : null;
      return {
        id: c.id, type: c.type, title: c.type === 'GROUP' ? c.title : other?.user.profile?.fullName ?? 'User', description: c.description,
        hasAvatar: c.type === 'GROUP' ? !!c.avatar : !!other && flags.has(other.userId), avatarVersion: c.type === 'GROUP' ? c.avatarVersion : other?.user.profile?.updatedAt.getTime() ?? 0,
        peerId: other?.userId ?? null, peerOnline: other ? this.emitter.isOnline(other.userId) : false,
        memberCount: active.length, myRole: r.role, muted: r.muted || (!!r.mutedUntil && r.mutedUntil > new Date()),
        unread: unreadBy.get(c.id) ?? 0, lastMessageAt: c.lastMessageAt?.toISOString() ?? null,
        lastMessage: visible ? { id: visible.id, kind: visible.kind, preview: previewOf(visible), senderId: visible.senderId, senderName: visible.sender?.profile?.fullName ?? null, createdAt: visible.createdAt.toISOString(), deleted: !!visible.deletedAt } : null,
        lastSeq: num(c.lastSeq), createdAt: c.createdAt.toISOString(),
      };
    });
  }

  private readonly convInclude = { members: { include: { user: { select: { id: true, profile: { select: { fullName: true, updatedAt: true } } } } } } } as const;

  async listConversations(me: string, page: number, limit: number, search?: string) {
    const q = search?.trim();
    const where: Prisma.ConversationMemberWhereInput = {
      userId: me, leftAt: null,
      ...(q ? { conversation: { OR: [{ title: { contains: q, mode: 'insensitive' } }, { members: { some: { userId: { not: me }, user: { profile: { fullName: { contains: q, mode: 'insensitive' } } } } } }] } } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.conversationMember.findMany({ where, orderBy: [{ conversation: { lastMessageAt: { sort: 'desc', nulls: 'last' } } }, { joinedAt: 'desc' }], skip: (page - 1) * limit, take: limit, include: { conversation: { include: this.convInclude } } }),
      this.prisma.conversationMember.count({ where }),
    ]);
    return { items: await this.view(me, rows), page, limit, total };
  }

  async getConversation(me: string, id: string) {
    await this.membership(me, id);
    const row = await this.prisma.conversationMember.findUniqueOrThrow({ where: { conversationId_userId: { conversationId: id, userId: me } }, include: { conversation: { include: this.convInclude } } });
    const [item] = await this.view(me, [row]);
    const flags = await this.avatarFlags(row.conversation.members.map((m) => m.userId));
    return {
      ...item,
      members: row.conversation.members.filter((m) => !m.leftAt).map((m) => ({
        userId: m.userId, name: m.user.profile?.fullName ?? 'User', role: m.role, joinedAt: m.joinedAt.toISOString(), online: this.emitter.isOnline(m.userId),
        hasAvatar: flags.has(m.userId), avatarVersion: m.user.profile?.updatedAt.getTime() ?? 0, lastReadSeq: num(m.lastReadSeq), lastDeliveredSeq: num(m.lastDeliveredSeq),
      })),
    };
  }

  /** Opens (or returns) the one DM between two people. The unique `directKey` makes concurrent calls land on the same conversation. */
  async openDirect(me: AuthUser, otherId: string) {
    if (otherId === me.id) throw new BadRequestException('You cannot start a conversation with yourself.');
    const other = await this.prisma.user.findFirst({ where: { id: otherId, status: 'ACTIVE', deletedAt: null }, select: { id: true } });
    if (!other) throw new NotFoundException('That person is not available.');
    if (await this.blockedBetween(me.id, otherId)) throw new ForbiddenException('You cannot message this person.');
    const key = directKey(me.id, otherId);
    let convId = (await this.prisma.conversation.findUnique({ where: { directKey: key }, select: { id: true } }))?.id;
    if (!convId) {
      try {
        convId = (await this.prisma.conversation.create({ data: { type: 'DIRECT', directKey: key, createdById: me.id, members: { create: [{ userId: me.id }, { userId: otherId }] } } })).id;
      } catch (e) {
        if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
        convId = (await this.prisma.conversation.findUniqueOrThrow({ where: { directKey: key }, select: { id: true } })).id;
      }
    }
    // either side may have left in the past (not possible for DMs today) — make sure both are active
    await this.prisma.conversationMember.updateMany({ where: { conversationId: convId, userId: { in: [me.id, otherId] }, leftAt: { not: null } }, data: { leftAt: null } });
    return this.getConversation(me.id, convId);
  }

  async createGroup(me: AuthUser, dto: { title: string; description?: string; avatar?: string; memberIds: string[] }, meta: RequestMeta) {
    const ids = [...new Set(dto.memberIds.filter((x) => x !== me.id))];
    if (ids.length === 0) throw new BadRequestException('Add at least one other person.');
    if (ids.length + 1 > MAX_GROUP_MEMBERS) throw new BadRequestException(`A group can have at most ${MAX_GROUP_MEMBERS} people.`);
    await this.requireEligible(me.id, ids);
    const conv = await this.prisma.$transaction(async (tx) => {
      const c = await tx.conversation.create({ data: { type: 'GROUP', title: dto.title.trim(), description: dto.description?.trim() || null, avatar: dto.avatar ?? null, avatarVersion: dto.avatar ? 1 : 0, createdById: me.id, members: { create: [{ userId: me.id, role: 'ADMIN' }, ...ids.map((userId) => ({ userId }))] } } });
      await this.systemMessage(tx, c.id, `${me.fullName} created the group "${c.title}"`);
      return c;
    });
    await this.audit.record({ action: 'chat.group_created', userId: me.id, userName: me.fullName, entityType: 'Conversation', entityId: conv.id, after: { members: ids.length + 1 }, ip: meta.ip, requestId: meta.requestId });
    await this.broadcastConversation(conv.id, 'created');
    return this.getConversation(me.id, conv.id);
  }

  private async requireEligible(me: string, ids: string[]): Promise<void> {
    const ok = await this.prisma.user.findMany({
      where: { id: { in: ids }, status: 'ACTIVE', deletedAt: null, roles: { some: { role: { permissions: { some: { permission: { code: 'chat.use' } } } } } }, blocksMade: { none: { blockedId: me } } },
      select: { id: true },
    });
    if (ok.length !== ids.length) throw new BadRequestException('Some of the people you chose cannot be added.');
  }

  /** Writes a SYSTEM message ("Ama added Kofi") inside the caller's transaction and returns it. */
  private async systemMessage(tx: Tx, conversationId: string, body: string, kind: 'SYSTEM' | 'CALL' = 'SYSTEM', senderId: string | null = null) {
    const seq = await this.nextSeq(tx, conversationId);
    return tx.message.create({ data: { conversationId, seq, senderId, kind, body: body.slice(0, 500), clientId: null }, include: msgInclude });
  }

  /** Atomically takes the next sequence number for a conversation (row lock held until the surrounding transaction commits). */
  private async nextSeq(tx: Tx, conversationId: string): Promise<bigint> {
    const r = await tx.$queryRaw<{ lastSeq: bigint }[]>`UPDATE "Conversation" SET "lastSeq" = "lastSeq" + 1, "lastMessageAt" = now() WHERE "id" = ${conversationId}::uuid RETURNING "lastSeq"`;
    return r[0].lastSeq;
  }

  async updateGroup(me: AuthUser, id: string, dto: { title?: string; description?: string | null; avatar?: string | null }, meta: RequestMeta) {
    const m = await this.requireGroupAdmin(me.id, id);
    const data: Prisma.ConversationUpdateInput = {};
    if (dto.title !== undefined) data.title = dto.title.trim();
    if (dto.description !== undefined) data.description = dto.description?.trim() || null;
    if (dto.avatar !== undefined) { data.avatar = dto.avatar; data.avatarVersion = { increment: 1 }; }
    if (!Object.keys(data).length) throw new BadRequestException('Nothing to change.');
    await this.prisma.$transaction(async (tx) => {
      await tx.conversation.update({ where: { id }, data });
      if (dto.title !== undefined && dto.title.trim() !== m.conversation.title) await this.systemMessage(tx, id, `${me.fullName} changed the group name to "${dto.title.trim()}"`);
    });
    await this.audit.record({ action: 'chat.group_updated', userId: me.id, userName: me.fullName, entityType: 'Conversation', entityId: id, after: { fields: Object.keys(dto) }, ip: meta.ip, requestId: meta.requestId });
    await this.broadcastConversation(id, 'updated');
    await this.broadcastNewestSystem(id);
    return this.getConversation(me.id, id);
  }

  private async requireGroupAdmin(userId: string, id: string) {
    const m = await this.membership(userId, id);
    if (m.conversation.type !== 'GROUP') throw new BadRequestException('This is not a group.');
    if (m.role !== 'ADMIN') throw new ForbiddenException('Only group admins can do this.');
    return m;
  }

  async addMembers(me: AuthUser, id: string, userIds: string[], meta: RequestMeta) {
    await this.requireGroupAdmin(me.id, id);
    const ids = [...new Set(userIds)].filter((x) => x !== me.id);
    if (!ids.length) throw new BadRequestException('Choose at least one person.');
    await this.requireEligible(me.id, ids);
    const names = new Map((await this.prisma.profile.findMany({ where: { userId: { in: ids } }, select: { userId: true, fullName: true } })).map((p) => [p.userId, p.fullName]));
    const added: string[] = [];
    await this.prisma.$transaction(async (tx) => {
      const c = await tx.conversation.findUniqueOrThrow({ where: { id }, select: { lastSeq: true } });
      const current = await tx.conversationMember.findMany({ where: { conversationId: id } });
      const active = current.filter((m) => !m.leftAt).length;
      if (active + ids.length > MAX_GROUP_MEMBERS) throw new BadRequestException(`A group can have at most ${MAX_GROUP_MEMBERS} people.`);
      for (const uid of ids) {
        const existing = current.find((m) => m.userId === uid);
        if (existing && !existing.leftAt) continue;
        // people who join later do not see the history from before they joined
        const visible = c.lastSeq;
        if (existing) await tx.conversationMember.update({ where: { conversationId_userId: { conversationId: id, userId: uid } }, data: { leftAt: null, joinedAt: new Date(), role: 'MEMBER', visibleFromSeq: visible, lastReadSeq: visible, lastDeliveredSeq: visible } });
        else await tx.conversationMember.create({ data: { conversationId: id, userId: uid, visibleFromSeq: visible, lastReadSeq: visible, lastDeliveredSeq: visible } });
        added.push(uid);
        await this.systemMessage(tx, id, `${me.fullName} added ${names.get(uid) ?? 'someone'}`);
      }
    });
    if (added.length) await this.audit.record({ action: 'chat.members_added', userId: me.id, userName: me.fullName, entityType: 'Conversation', entityId: id, after: { count: added.length }, ip: meta.ip, requestId: meta.requestId });
    await this.broadcastConversation(id, 'updated', added);
    await this.broadcastNewestSystem(id);
    return this.getConversation(me.id, id);
  }

  /** Admin removes someone, or a person leaves (userId === me). If the last admin leaves, the longest-standing member becomes admin. */
  async removeMember(me: AuthUser, id: string, userId: string, meta: RequestMeta) {
    const mine = await this.membership(me.id, id);
    if (mine.conversation.type !== 'GROUP') throw new BadRequestException('You cannot leave a one-to-one conversation. Block the person instead.');
    const leaving = userId === me.id;
    if (!leaving && mine.role !== 'ADMIN') throw new ForbiddenException('Only group admins can remove people.');
    const target = await this.prisma.conversationMember.findUnique({ where: { conversationId_userId: { conversationId: id, userId } }, include: { user: { select: { profile: { select: { fullName: true } } } } } });
    if (!target || target.leftAt) throw new NotFoundException('That person is not in the group.');
    let promoted: string | null = null;
    await this.prisma.$transaction(async (tx) => {
      await tx.conversationMember.update({ where: { conversationId_userId: { conversationId: id, userId } }, data: { leftAt: new Date() } });
      await this.systemMessage(tx, id, leaving ? `${me.fullName} left` : `${me.fullName} removed ${target.user.profile?.fullName ?? 'someone'}`);
      const admins = await tx.conversationMember.count({ where: { conversationId: id, leftAt: null, role: 'ADMIN' } });
      if (admins === 0) {
        const next = await tx.conversationMember.findFirst({ where: { conversationId: id, leftAt: null }, orderBy: { joinedAt: 'asc' } });
        if (next) { await tx.conversationMember.update({ where: { conversationId_userId: { conversationId: id, userId: next.userId } }, data: { role: 'ADMIN' } }); promoted = next.userId; await this.systemMessage(tx, id, 'A new group admin was assigned'); }
      }
    });
    await this.audit.record({ action: leaving ? 'chat.group_left' : 'chat.member_removed', userId: me.id, userName: me.fullName, entityType: 'Conversation', entityId: id, after: { target: userId, promoted }, ip: meta.ip, requestId: meta.requestId });
    this.emitter.toUsers([userId], 'chat.conversation', { id, change: 'removed' }); // the removed person's phone drops it from the list
    await this.broadcastConversation(id, 'updated');
    await this.broadcastNewestSystem(id);
    return { ok: true };
  }

  async setRole(me: AuthUser, id: string, userId: string, role: 'ADMIN' | 'MEMBER', meta: RequestMeta) {
    await this.requireGroupAdmin(me.id, id);
    const target = await this.prisma.conversationMember.findUnique({ where: { conversationId_userId: { conversationId: id, userId } }, include: { user: { select: { profile: { select: { fullName: true } } } } } });
    if (!target || target.leftAt) throw new NotFoundException('That person is not in the group.');
    if (target.role === role) return this.getConversation(me.id, id);
    await this.prisma.$transaction(async (tx) => {
      if (role === 'MEMBER') {
        const admins = await tx.conversationMember.count({ where: { conversationId: id, leftAt: null, role: 'ADMIN' } });
        if (admins <= 1) throw new ConflictException('A group needs at least one admin. Make someone else an admin first.');
      }
      await tx.conversationMember.update({ where: { conversationId_userId: { conversationId: id, userId } }, data: { role } });
      await this.systemMessage(tx, id, role === 'ADMIN' ? `${me.fullName} made ${target.user.profile?.fullName ?? 'someone'} an admin` : `${me.fullName} removed ${target.user.profile?.fullName ?? 'someone'} as admin`);
    });
    await this.audit.record({ action: 'chat.role_changed', userId: me.id, userName: me.fullName, entityType: 'Conversation', entityId: id, after: { target: userId, role }, ip: meta.ip, requestId: meta.requestId });
    await this.broadcastConversation(id, 'updated');
    await this.broadcastNewestSystem(id);
    return this.getConversation(me.id, id);
  }

  async setMute(me: string, id: string, muted: boolean, hours?: number) {
    await this.membership(me, id);
    await this.prisma.conversationMember.update({ where: { conversationId_userId: { conversationId: id, userId: me } }, data: { muted: muted && !hours, mutedUntil: muted && hours ? new Date(Date.now() + hours * 3_600_000) : null } });
    return { ok: true };
  }

  /** Tells every active member's phones that the list entry changed (they refetch it through the authorised API). */
  private async broadcastConversation(id: string, change: 'created' | 'updated', extra: string[] = []) {
    this.emitter.toUsers([...(await this.activeMemberIds(id)), ...extra], 'chat.conversation', { id, change });
  }
  private async broadcastNewestSystem(id: string) {
    const m = await this.prisma.message.findFirst({ where: { conversationId: id }, orderBy: { seq: 'desc' }, include: msgInclude });
    if (m) this.emitter.toUsers(await this.activeMemberIds(id), 'chat.message', toMessageView(m));
  }

  // ───────────── messages ─────────────

  async listMessages(me: string, conversationId: string, before: number | undefined, limit: number) {
    const m = await this.membership(me, conversationId);
    const take = Math.min(Math.max(limit || PAGE_SIZE_DEFAULT, 1), PAGE_SIZE_MAX);
    const rows = await this.prisma.message.findMany({
      where: { conversationId, seq: { gt: m.visibleFromSeq, ...(before ? { lt: BigInt(before) } : {}) } },
      orderBy: { seq: 'desc' }, take: take + 1, include: msgInclude,
    });
    const more = rows.length > take;
    const items = rows.slice(0, take).map(toMessageView).reverse();
    return { items, hasMore: more, nextBefore: items.length ? items[0].seq : null };
  }

  async send(me: AuthUser, conversationId: string, input: SendInput): Promise<MessageView> {
    const existing = await this.prisma.message.findUnique({ where: { senderId_clientId: { senderId: me.id, clientId: input.clientId } }, include: msgInclude });
    if (existing) {
      if (existing.conversationId !== conversationId) throw new ConflictException('That message id was already used.');
      return toMessageView(existing); // an identical retry returns the original, never a second message
    }
    const mem = await this.membership(me.id, conversationId);
    const conv = mem.conversation;
    if (conv.type === 'DIRECT') {
      const other = await this.prisma.conversationMember.findFirst({ where: { conversationId, userId: { not: me.id } }, include: { user: { select: { status: true, deletedAt: true } } } });
      if (!other || other.user.status !== 'ACTIVE' || other.user.deletedAt) throw new ConflictException('This person is not available.');
      if (await this.blockedBetween(me.id, other.userId)) throw new ForbiddenException('You cannot message this person.');
    }
    const body = (input.body ?? '').trim();
    if (input.kind === 'TEXT' && !body) throw new BadRequestException('Write a message first.');
    if (body.length > MAX_MESSAGE_CHARS) throw new BadRequestException(`Messages can have at most ${MAX_MESSAGE_CHARS} characters.`);
    if (input.kind !== 'TEXT' && !input.attachmentId) throw new BadRequestException('Attach a file first.');
    if (input.kind === 'TEXT' && input.attachmentId) throw new BadRequestException('A text message cannot have an attachment.');
    if (input.replyToId) {
      const target = await this.prisma.message.findFirst({ where: { id: input.replyToId, conversationId, seq: { gt: mem.visibleFromSeq } }, select: { id: true } });
      if (!target) throw new BadRequestException('The message you are replying to no longer exists.');
    }
    let created: MsgRow;
    try {
      created = await this.prisma.$transaction(async (tx) => {
        if (input.attachmentId) {
          const claimed = await tx.chatAttachment.updateMany({ where: { id: input.attachmentId, uploaderId: me.id, conversationId, status: 'READY' }, data: { status: 'ATTACHED' } });
          if (claimed.count !== 1) throw new BadRequestException('That file is not ready to send.');
          const a = await tx.chatAttachment.findUniqueOrThrow({ where: { id: input.attachmentId } });
          const wantsImage = input.kind === 'IMAGE';
          if ((ALLOWED_ATTACHMENT_TYPES[a.mimeType] === 'IMAGE') !== wantsImage) throw new BadRequestException('The file type does not match the message type.');
        }
        const seq = await this.nextSeq(tx, conversationId);
        const row = await tx.message.create({ data: { conversationId, seq, senderId: me.id, kind: input.kind, body, clientId: input.clientId, replyToId: input.replyToId ?? null, attachmentId: input.attachmentId ?? null }, include: msgInclude });
        await tx.conversationMember.update({ where: { conversationId_userId: { conversationId, userId: me.id } }, data: { lastReadSeq: seq, lastDeliveredSeq: seq } });
        return row;
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') { // a concurrent retry with the same clientId won the race
        const again = await this.prisma.message.findUnique({ where: { senderId_clientId: { senderId: me.id, clientId: input.clientId } }, include: msgInclude });
        if (again) return toMessageView(again);
      }
      throw e;
    }
    const view = toMessageView(created);
    const members = await this.activeMemberIds(conversationId);
    this.emitter.toUsers(members, 'chat.message', view);
    this.push.notifyNewMessage({ conversationId, messageId: created.id, seq: created.seq, senderId: me.id, senderName: me.fullName, groupTitle: conv.type === 'GROUP' ? conv.title : null, preview: previewOf(created), recipients: members.filter((u) => u !== me.id) });
    return view;
  }

  async edit(me: AuthUser, messageId: string, body: string): Promise<MessageView> {
    const m = await this.prisma.message.findUnique({ where: { id: messageId } });
    if (!m) throw new NotFoundException('Message not found');
    await this.membership(me.id, m.conversationId);
    if (m.senderId !== me.id) throw new ForbiddenException('You can only edit your own messages.');
    if (m.kind !== 'TEXT' || m.deletedAt) throw new BadRequestException('This message cannot be edited.');
    if (Date.now() - m.createdAt.getTime() > EDIT_WINDOW_MS) throw new BadRequestException(`Messages can only be edited for ${EDIT_WINDOW_MS / 60_000} minutes.`);
    const text = body.trim();
    if (!text || text.length > MAX_MESSAGE_CHARS) throw new BadRequestException('Write a message of 1 to 4000 characters.');
    const row = await this.prisma.message.update({ where: { id: messageId }, data: { body: text, editedAt: new Date() }, include: msgInclude });
    const view = toMessageView(row);
    this.emitter.toUsers(await this.activeMemberIds(m.conversationId), 'chat.message.updated', view);
    return view;
  }

  async deleteMessage(me: AuthUser, messageId: string): Promise<MessageView> {
    const m = await this.prisma.message.findUnique({ where: { id: messageId }, include: { attachment: true } });
    if (!m) throw new NotFoundException('Message not found');
    const mem = await this.membership(me.id, m.conversationId);
    const admin = mem.conversation.type === 'GROUP' && mem.role === 'ADMIN';
    if (m.senderId !== me.id && !admin) throw new ForbiddenException('You can only delete your own messages.');
    if (m.kind === 'SYSTEM' || m.kind === 'CALL') throw new BadRequestException('This message cannot be deleted.');
    if (m.deletedAt) return toMessageView(await this.prisma.message.findUniqueOrThrow({ where: { id: messageId }, include: msgInclude }));
    const row = await this.prisma.message.update({ where: { id: messageId }, data: { deletedAt: new Date(), body: '' }, include: msgInclude });
    if (m.attachment && this.media.configured) void this.media.delete(m.attachment.storageKey).catch((e) => this.logger.warn({ err: e }, 'Could not delete a chat file'));
    const view = toMessageView(row);
    this.emitter.toUsers(await this.activeMemberIds(m.conversationId), 'chat.message.updated', view);
    return view;
  }

  async report(me: AuthUser, messageId: string, reason: string, meta: RequestMeta) {
    const m = await this.prisma.message.findUnique({ where: { id: messageId }, select: { id: true, conversationId: true, senderId: true } });
    if (!m) throw new NotFoundException('Message not found');
    await this.membership(me.id, m.conversationId);
    if (m.senderId === me.id) throw new BadRequestException('You cannot report your own message.');
    await this.prisma.messageReport.upsert({ where: { messageId_reporterId: { messageId, reporterId: me.id } }, create: { messageId, reporterId: me.id, reason: reason.slice(0, 500) }, update: { reason: reason.slice(0, 500) } });
    await this.audit.record({ action: 'chat.message_reported', userId: me.id, userName: me.fullName, entityType: 'Message', entityId: messageId, reason: reason.slice(0, 200), ip: meta.ip, requestId: meta.requestId }); // the message text is NOT copied into the audit log
    return { ok: true };
  }

  // ───────────── receipts ─────────────

  /** Monotonic (never goes backwards): GREATEST() in SQL, so concurrent or late acknowledgements cannot lower the marker. */
  async markRead(me: string, conversationId: string, upToSeq: number) {
    const mem = await this.membership(me, conversationId);
    const cap = BigInt(Math.min(Math.max(0, Math.floor(upToSeq)), num(mem.conversation.lastSeq)));
    await this.prisma.$executeRaw`UPDATE "ConversationMember" SET "lastReadSeq" = GREATEST("lastReadSeq", ${cap}), "lastDeliveredSeq" = GREATEST("lastDeliveredSeq", ${cap}) WHERE "conversationId" = ${conversationId}::uuid AND "userId" = ${me}::uuid`;
    this.emitter.toUsers(await this.activeMemberIds(conversationId), 'chat.receipt', { conversationId, userId: me, read: Number(cap), delivered: Number(cap) });
    return { ok: true };
  }

  /** Called by the realtime gateway when a phone acknowledges that it has received messages up to `upToSeq`. Returns false if the caller is not a member. */
  async markDelivered(me: string, conversationId: string, upToSeq: number): Promise<boolean> {
    const mem = await this.prisma.conversationMember.findUnique({ where: { conversationId_userId: { conversationId, userId: me } }, include: { conversation: { select: { lastSeq: true } } } });
    if (!mem || mem.leftAt) return false;
    const cap = BigInt(Math.min(Math.max(0, Math.floor(upToSeq)), num(mem.conversation.lastSeq)));
    await this.prisma.$executeRaw`UPDATE "ConversationMember" SET "lastDeliveredSeq" = GREATEST("lastDeliveredSeq", ${cap}) WHERE "conversationId" = ${conversationId}::uuid AND "userId" = ${me}::uuid`;
    this.emitter.toUsers(await this.activeMemberIds(conversationId), 'chat.receipt', { conversationId, userId: me, delivered: Number(cap) });
    return true;
  }

  // ───────────── attachments ─────────────

  private requireMedia(): void { if (!this.media.configured) throw new ServiceUnavailableException('File sharing is not set up on this server yet.'); }

  async createUpload(me: AuthUser, conversationId: string, fileName: string, mimeType: string, sizeBytes: number) {
    this.requireMedia();
    await this.membership(me.id, conversationId);
    if (!ALLOWED_ATTACHMENT_TYPES[mimeType]) throw new BadRequestException('This type of file cannot be shared.');
    if (sizeBytes < 1 || sizeBytes > MAX_ATTACHMENT_BYTES) throw new BadRequestException(`Files can be at most ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`);
    const id = randomUUID();
    const storageKey = `chat/${conversationId}/${id}`; // random key: the file name never appears in the storage path
    await this.prisma.chatAttachment.create({ data: { id, conversationId, uploaderId: me.id, storageKey, fileName: safeFileName(fileName), mimeType, sizeBytes } });
    return { attachmentId: id, uploadUrl: await this.media.presignPut(storageKey, mimeType, sizeBytes, UPLOAD_URL_TTL_S), headers: { 'Content-Type': mimeType }, expiresInSeconds: UPLOAD_URL_TTL_S };
  }

  /** Confirms the object really exists with the promised size, then marks the attachment READY. */
  async completeUpload(me: AuthUser, attachmentId: string) {
    this.requireMedia();
    const a = await this.prisma.chatAttachment.findUnique({ where: { id: attachmentId } });
    if (!a || a.uploaderId !== me.id) throw new NotFoundException('Attachment not found');
    await this.membership(me.id, a.conversationId);
    if (a.status !== 'PENDING') return { attachmentId, status: a.status };
    const head = await this.media.head(a.storageKey);
    if (!head) throw new BadRequestException('The upload did not arrive. Try again.');
    if (head.sizeBytes !== a.sizeBytes || head.sizeBytes > MAX_ATTACHMENT_BYTES) {
      await this.media.delete(a.storageKey).catch(() => undefined);
      await this.prisma.chatAttachment.delete({ where: { id: a.id } });
      throw new BadRequestException('The uploaded file does not match what was announced.');
    }
    await this.prisma.chatAttachment.update({ where: { id: a.id }, data: { status: 'READY' } });
    return { attachmentId, status: 'READY' };
  }

  async downloadUrl(me: AuthUser, attachmentId: string) {
    this.requireMedia();
    const a = await this.prisma.chatAttachment.findUnique({ where: { id: attachmentId }, include: { message: { select: { deletedAt: true, seq: true } } } });
    if (!a) throw new NotFoundException('Attachment not found');
    const mem = await this.membership(me.id, a.conversationId); // 404 for outsiders, like every other route
    if (a.status !== 'ATTACHED' && a.uploaderId !== me.id) throw new NotFoundException('Attachment not found');
    if (a.message?.deletedAt || (a.message && num(a.message.seq) <= num(mem.visibleFromSeq))) throw new NotFoundException('Attachment not found');
    return { url: await this.media.presignGet(a.storageKey, a.fileName, a.mimeType, DOWNLOAD_URL_TTL_S), fileName: a.fileName, mimeType: a.mimeType, sizeBytes: a.sizeBytes, expiresInSeconds: DOWNLOAD_URL_TTL_S };
  }

  // ───────────── blocks and settings ─────────────

  async block(me: AuthUser, userId: string) {
    if (userId === me.id) throw new BadRequestException('You cannot block yourself.');
    if (!(await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } }))) throw new NotFoundException('User not found');
    await this.prisma.userBlock.upsert({ where: { blockerId_blockedId: { blockerId: me.id, blockedId: userId } }, create: { blockerId: me.id, blockedId: userId }, update: {} });
    return { ok: true };
  }
  async unblock(me: AuthUser, userId: string) { await this.prisma.userBlock.deleteMany({ where: { blockerId: me.id, blockedId: userId } }); return { ok: true }; }
  async blocks(me: AuthUser) {
    const rows = await this.prisma.userBlock.findMany({ where: { blockerId: me.id }, include: { blocked: { select: { id: true, profile: { select: { fullName: true } } } } }, orderBy: { createdAt: 'desc' } });
    return rows.map((r) => ({ userId: r.blockedId, name: r.blocked.profile?.fullName ?? 'User' }));
  }

  async settings(me: string) {
    const s = await this.prisma.chatSetting.findUnique({ where: { userId: me } });
    return { showPreviews: s?.showPreviews ?? false, pushMessages: s?.pushMessages ?? true, pushCalls: s?.pushCalls ?? true };
  }
  async setSettings(me: string, dto: { showPreviews?: boolean; pushMessages?: boolean; pushCalls?: boolean }) {
    await this.prisma.chatSetting.upsert({ where: { userId: me }, create: { userId: me, ...dto }, update: dto });
    return this.settings(me);
  }

  /** Optional retention: removes messages (and their files) older than CHAT_RETENTION_DAYS. */
  async purgeOlderThan(days: number, now = new Date()): Promise<{ messages: number; files: number }> {
    if (days <= 0) return { messages: 0, files: 0 };
    const cutoff = new Date(now.getTime() - days * 86_400_000);
    const old = await this.prisma.message.findMany({ where: { createdAt: { lt: cutoff } }, select: { id: true, attachment: { select: { id: true, storageKey: true } } }, take: 500 });
    let files = 0;
    for (const m of old) {
      if (m.attachment && this.media.configured) { await this.media.delete(m.attachment.storageKey).then(() => { files++; }).catch(() => undefined); }
    }
    const r = await this.prisma.message.deleteMany({ where: { id: { in: old.map((m) => m.id) } } });
    await this.prisma.chatAttachment.deleteMany({ where: { id: { in: old.flatMap((m) => (m.attachment ? [m.attachment.id] : [])) } } });
    return { messages: r.count, files };
  }

  /** Abandoned uploads (never completed or never sent) are cleaned up after a day. */
  async purgeOrphanUploads(now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - 24 * 3_600_000);
    const stale = await this.prisma.chatAttachment.findMany({ where: { status: { in: ['PENDING', 'READY'] }, createdAt: { lt: cutoff } }, select: { id: true, storageKey: true }, take: 200 });
    for (const a of stale) if (this.media.configured) await this.media.delete(a.storageKey).catch(() => undefined);
    return (await this.prisma.chatAttachment.deleteMany({ where: { id: { in: stale.map((a) => a.id) } } })).count;
  }

  /** Used by call handling to leave "Missed call" / "Voice call · 1:33" entries in the conversation. */
  async recordCall(conversationId: string, callerId: string, kind: string, reason: string, seconds: number): Promise<void> {
    const msg = await this.prisma.$transaction((tx) => this.systemMessage(tx, conversationId, `${kind}|${reason}|${seconds}`, 'CALL', callerId));
    this.emitter.toUsers(await this.activeMemberIds(conversationId), 'chat.message', toMessageView(msg));
  }
}

export function dataUrlToBuffer(dataUrl: string | null | undefined): Buffer | null {
  if (!dataUrl) return null;
  const m = /^data:image\/(jpeg|png|webp);base64,(.+)$/s.exec(dataUrl);
  return m ? Buffer.from(m[2], 'base64') : null;
}
export const dataUrlMime = (dataUrl: string): string => /^data:(image\/[a-z]+);/.exec(dataUrl)?.[1] ?? 'image/jpeg';
