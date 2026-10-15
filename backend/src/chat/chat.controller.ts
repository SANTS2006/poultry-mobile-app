import { Body, Controller, Delete, Get, Header, HttpCode, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Put, Query, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import type { AuthUser, RequestMeta } from '../auth/auth.types';
import { CurrentUser, Meta } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { PageQuery, paging } from '../common/pagination';
import {
  AddMembersDto, BlockDto, ChatSettingsDto, ConversationsQuery, CreateGroupDto, CreateUploadDto, EditMessageDto, MessagesQuery, MuteDto, OpenDirectDto, ReadDto,
  ReportDto, SendMessageDto, SetRoleDto, StartCallDto, UpdateGroupDto, UsersQuery,
} from './chat.dto';
import { CallService } from './call.service';
import { ChatService, dataUrlMime } from './chat.service';

const SEND = { default: { limit: 60, ttl: 60_000 } };
const UPLOAD = { default: { limit: 20, ttl: 60_000 } };
const CALLS = { default: { limit: 12, ttl: 60_000 } };

/** Every route needs `chat.use`. Membership and group-admin rights are checked in the service on every call, never trusted from the app. */
@RequirePermissions('chat.use')
@Controller('chat')
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @Get('config') config() { return this.chat.config(); }
  @Get('settings') settings(@CurrentUser() u: AuthUser) { return this.chat.settings(u.id); }
  @Put('settings') setSettings(@CurrentUser() u: AuthUser, @Body() dto: ChatSettingsDto) { return this.chat.setSettings(u.id, dto); }

  @Get('users') users(@CurrentUser() u: AuthUser, @Query() q: UsersQuery) { const p = paging(q); return this.chat.users(u, q.search, p.page, p.limit); }

  /** Profile picture bytes (JPEG/PNG/WebP). Private cache; the app sends its bearer token. */
  @Get('users/:id/avatar') @Header('Cache-Control', 'private, max-age=3600')
  async userAvatar(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const profileAvatar = await this.chat.userAvatar(id);
    if (!profileAvatar) throw new NotFoundException('No picture');
    res.type(sniff(profileAvatar)).send(profileAvatar);
  }

  @Get('conversations') list(@CurrentUser() u: AuthUser, @Query() q: ConversationsQuery) { const p = paging(q); return this.chat.listConversations(u.id, p.page, p.limit, q.search); }
  @Post('conversations/direct') @HttpCode(200) openDirect(@CurrentUser() u: AuthUser, @Body() dto: OpenDirectDto) { return this.chat.openDirect(u, dto.userId); }

  @RequirePermissions('chat.use', 'chat.groups.create') @Post('conversations/group')
  createGroup(@CurrentUser() u: AuthUser, @Body() dto: CreateGroupDto, @Meta() m: RequestMeta) { return this.chat.createGroup(u, dto, m); }

  @Get('conversations/:id') one(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.chat.getConversation(u.id, id); }
  @Patch('conversations/:id') update(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateGroupDto, @Meta() m: RequestMeta) { return this.chat.updateGroup(u, id, dto, m); }

  @Get('conversations/:id/avatar') @Header('Cache-Control', 'private, max-age=3600')
  async groupAvatar(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const b = await this.chat.conversationAvatar(u.id, id);
    if (!b) throw new NotFoundException('No picture');
    res.type(sniff(b)).send(b);
  }

  @Post('conversations/:id/members') addMembers(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AddMembersDto, @Meta() m: RequestMeta) { return this.chat.addMembers(u, id, dto.userIds, m); }
  @Delete('conversations/:id/members/:userId') removeMember(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('userId', ParseUUIDPipe) userId: string, @Meta() m: RequestMeta) { return this.chat.removeMember(u, id, userId, m); }
  @Put('conversations/:id/members/:userId/role') setRole(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('userId', ParseUUIDPipe) userId: string, @Body() dto: SetRoleDto, @Meta() m: RequestMeta) { return this.chat.setRole(u, id, userId, dto.role, m); }
  @Put('conversations/:id/mute') mute(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: MuteDto) { return this.chat.setMute(u.id, id, dto.muted, dto.hours); }
  @Post('conversations/:id/read') @HttpCode(200) read(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReadDto) { return this.chat.markRead(u.id, id, dto.upToSeq); }

  @Get('conversations/:id/messages') messages(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Query() q: MessagesQuery) { return this.chat.listMessages(u.id, id, q.before, q.limit ?? 30); }

  @Throttle(SEND) @Post('conversations/:id/messages') @HttpCode(200)
  send(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SendMessageDto) { return this.chat.send(u, id, dto); }

  @Patch('messages/:id') edit(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: EditMessageDto) { return this.chat.edit(u, id, dto.body); }
  @Delete('messages/:id') remove(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.chat.deleteMessage(u, id); }
  @Post('messages/:id/report') @HttpCode(200) report(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReportDto, @Meta() m: RequestMeta) { return this.chat.report(u, id, dto.reason, m); }

  @Throttle(UPLOAD) @Post('attachments') upload(@CurrentUser() u: AuthUser, @Body() dto: CreateUploadDto) { return this.chat.createUpload(u, dto.conversationId, dto.fileName, dto.mimeType, dto.sizeBytes); }
  @Throttle(UPLOAD) @Post('attachments/:id/complete') @HttpCode(200) complete(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.chat.completeUpload(u, id); }
  @Header('Cache-Control', 'no-store') @Get('attachments/:id/url') download(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.chat.downloadUrl(u, id); }

  @Get('blocks') blocks(@CurrentUser() u: AuthUser) { return this.chat.blocks(u); }
  @Post('blocks') @HttpCode(200) block(@CurrentUser() u: AuthUser, @Body() dto: BlockDto) { return this.chat.block(u, dto.userId); }
  @Delete('blocks/:userId') unblock(@CurrentUser() u: AuthUser, @Param('userId', ParseUUIDPipe) userId: string) { return this.chat.unblock(u, userId); }
}

/** Content type from the bytes themselves (the stored value was validated as jpeg/png/webp when it was saved). */
function sniff(b: Buffer): string {
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
  if (b[0] === 0x52 && b[1] === 0x49) return 'image/webp';
  return dataUrlMime('data:image/jpeg;base64,');
}

@RequirePermissions('chat.use')
@Controller('calls')
export class CallController {
  constructor(private readonly calls: CallService) {}

  @Get('ice') ice() { return this.calls.iceServers(); }
  @Get('current') current(@CurrentUser() u: AuthUser) { return this.calls.current(u.id); }
  @Get() history(@CurrentUser() u: AuthUser, @Query() q: PageQuery) { const p = paging(q); return this.calls.history(u.id, p.page, p.limit); }

  @Throttle(CALLS) @Post() @HttpCode(200) start(@CurrentUser() u: AuthUser, @Body() dto: StartCallDto) { return this.calls.start(u, dto.conversationId, dto.kind); }
  @Post(':id/accept') @HttpCode(200) accept(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.calls.act(u, id, 'accept'); }
  @Post(':id/reject') @HttpCode(200) reject(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.calls.act(u, id, 'reject'); }
  @Post(':id/cancel') @HttpCode(200) cancel(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.calls.act(u, id, 'cancel'); }
  @Post(':id/end') @HttpCode(200) end(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.calls.act(u, id, 'end'); }
}
