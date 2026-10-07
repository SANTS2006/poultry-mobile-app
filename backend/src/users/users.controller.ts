import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Delete } from '@nestjs/common';
import type { AuthUser, RequestMeta } from '../auth/auth.types';
import { CurrentUser, Meta } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { InviteUserDto, ListUsersQuery, ReasonDto, SetRolesDto } from './users.dto';
import { UsersService } from './users.service';

@RequirePermissions('users.manage')
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get() list(@Query() q: ListUsersQuery) { return this.users.list(q); }

  @Get(':id') get(@Param('id', ParseUUIDPipe) id: string) { return this.users.get(id); }

  @Post('invite')
  invite(@CurrentUser() actor: AuthUser, @Body() dto: InviteUserDto, @Meta() meta: RequestMeta) { return this.users.invite(actor, dto, meta); }

  @HttpCode(204) @Post(':id/resend-invite')
  async resend(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Meta() meta: RequestMeta): Promise<void> {
    await this.users.resendInvite(actor, id, meta);
  }

  @Put(':id/roles')
  setRoles(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SetRolesDto, @Meta() meta: RequestMeta) {
    return this.users.setRoles(actor, id, dto.roleCodes, dto.reason, meta);
  }

  @HttpCode(200) @Post(':id/disable')
  disable(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto, @Meta() meta: RequestMeta) {
    return this.users.disable(actor, id, dto.reason, meta);
  }

  @HttpCode(200) @Post(':id/reactivate')
  reactivate(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto, @Meta() meta: RequestMeta) {
    return this.users.reactivate(actor, id, dto.reason, meta);
  }

  @Get(':id/sessions') sessions(@Param('id', ParseUUIDPipe) id: string) { return this.users.listSessions(id); }

  @Delete(':id/sessions')
  revoke(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto, @Meta() meta: RequestMeta) {
    return this.users.revokeSessions(actor, id, dto.reason, meta);
  }

  @HttpCode(204) @Post(':id/reset-mfa')
  async resetMfa(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto, @Meta() meta: RequestMeta): Promise<void> {
    await this.users.resetMfa(actor, id, dto.reason, meta);
  }
}
