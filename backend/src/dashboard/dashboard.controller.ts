import { Controller, Get, Query } from '@nestjs/common';
import { IsOptional, IsUUID } from 'class-validator';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AnyAuthenticated } from '../auth/decorators/permissions.decorator';
import { DashboardService } from './dashboard.service';

class DashboardQuery { @IsOptional() @IsUUID() farmId?: string; }

@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  /**
   * Open to every signed-in user: each section is included only where the caller holds the permission for the data in it, so production
   * staff get production figures, sales staff get sales and customer figures, and neither sees money they have no access to.
   */
  @AnyAuthenticated() @Get()
  get(@CurrentUser() user: AuthUser, @Query() q: DashboardQuery) { return this.dashboard.build(user, q.farmId); }
}
