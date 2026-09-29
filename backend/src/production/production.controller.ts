import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthUser, RequestMeta } from '../auth/auth.types';
import { CurrentUser, Meta } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { CreateProductionDto, ListProductionQuery, UpdateProductionDto, VoidDto } from './production.dto';
import { ProductionService } from './production.service';

@Controller('production')
export class ProductionController {
  constructor(private readonly production: ProductionService) {}

  /** 201 when created, 200 when an identical client-generated id was already accepted (idempotent replay). */
  @RequirePermissions('production.create') @Post()
  async create(@CurrentUser() user: AuthUser, @Body() dto: CreateProductionDto, @Meta() meta: RequestMeta, @Res({ passthrough: true }) res: Response) {
    const { record, created } = await this.production.create(user, dto, meta);
    res.status(created ? 201 : 200);
    return record;
  }

  @RequirePermissions('production.read') @Get()
  list(@Query() q: ListProductionQuery) { return this.production.list(q); }

  @RequirePermissions('production.read') @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) { return this.production.get(id); }

  @RequirePermissions('production.update') @Patch(':id')
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateProductionDto, @Meta() meta: RequestMeta) {
    return this.production.update(user, id, dto, meta);
  }

  @RequirePermissions('production.delete') @HttpCode(200) @Post(':id/void')
  voidRecord(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: VoidDto, @Meta() meta: RequestMeta) {
    return this.production.voidRecord(user, id, dto.reason, meta);
  }
}
