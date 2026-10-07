import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthUser, RequestMeta } from '../auth/auth.types';
import { CurrentUser, Meta } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { CreateSaleDto, ListSalesQuery, VoidSaleDto } from './sales.dto';
import { SalesService } from './sales.service';

@Controller('sales')
export class SalesController {
  constructor(private readonly sales: SalesService) {}

  /** 201 created; 200 when the same client id was already accepted (idempotent offline replay). */
  @RequirePermissions('sales.create') @Post()
  async create(@CurrentUser() user: AuthUser, @Body() dto: CreateSaleDto, @Meta() meta: RequestMeta, @Res({ passthrough: true }) res: Response) {
    const { sale, created } = await this.sales.create(user, dto, meta);
    res.status(created ? 201 : 200);
    return sale;
  }

  @RequirePermissions('sales.read') @Get()
  list(@Query() q: ListSalesQuery) { return this.sales.list(q); }

  @RequirePermissions('sales.read') @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) { return this.sales.get(id); }

  @RequirePermissions('sales.delete') @HttpCode(200) @Post(':id/void')
  voidSale(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: VoidSaleDto, @Meta() meta: RequestMeta) {
    return this.sales.voidSale(user, id, dto.reason, meta);
  }
}
