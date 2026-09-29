import { Controller, Get, Query } from '@nestjs/common';
import { IsOptional, IsUUID } from 'class-validator';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { DashboardService } from './dashboard.service';

class DashboardQuery { @IsOptional() @IsUUID() farmId?: string; }

@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  /** Sections are included only where the caller holds the matching permission. */
  @RequirePermissions('dashboard.read') @Get()
  get(@CurrentUser() user: AuthUser, @Query() q: DashboardQuery) { return this.dashboard.build(user, q.farmId); }
}
