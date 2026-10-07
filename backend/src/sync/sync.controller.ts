import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { AuthUser, RequestMeta } from '../auth/auth.types';
import { CurrentUser, Meta } from '../auth/decorators/current-user.decorator';
import { AnyAuthenticated } from '../auth/decorators/permissions.decorator';
import { ReferenceService } from './reference.service';
import { ReferenceQuery, SyncPushDto } from './sync.dto';
import { SyncService } from './sync.service';

@Controller('sync')
export class SyncController {
  constructor(private readonly sync: SyncService, private readonly reference: ReferenceService) {}

  /**
   * Applies a batch of offline operations in order. Always answers 200 with one result per operation; each operation is
   * authorised against the caller's permissions individually (a forbidden or invalid one never blocks the others).
   */
  @AnyAuthenticated() @Throttle({ default: { limit: 60, ttl: 60_000 } }) @HttpCode(200) @Post('push')
  async push(@CurrentUser() user: AuthUser, @Body() dto: SyncPushDto, @Meta() meta: RequestMeta) {
    return { serverTime: new Date().toISOString(), results: await this.sync.push(user, dto.deviceId, dto.operations, meta) };
  }

  /** Reference data for offline use, filtered by permissions. Pass the previous `cursor` as `since` for an incremental refresh. */
  @AnyAuthenticated() @Get('reference')
  get(@CurrentUser() user: AuthUser, @Query() q: ReferenceQuery) { return this.reference.build(user, q.since); }
}
