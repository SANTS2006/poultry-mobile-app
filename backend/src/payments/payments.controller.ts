import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthUser, RequestMeta } from '../auth/auth.types';
import { CurrentUser, Meta } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { CreatePaymentDto, ListPaymentsQuery, PaymentsService, VoidPaymentDto } from './payments.service';

@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @RequirePermissions('payments.create') @Post()
  async create(@CurrentUser() user: AuthUser, @Body() dto: CreatePaymentDto, @Meta() meta: RequestMeta, @Res({ passthrough: true }) res: Response) {
    const { created, ...body } = await this.payments.create(user, dto, meta);
    res.status(created ? 201 : 200);
    return body;
  }

  @RequirePermissions('payments.read') @Get()
  list(@Query() q: ListPaymentsQuery) { return this.payments.list(q); }

  /** Reversing money received is restricted to those who may void sales. */
  @RequirePermissions('sales.delete') @HttpCode(200) @Post(':id/void')
  voidPayment(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: VoidPaymentDto, @Meta() meta: RequestMeta) {
    return this.payments.voidPayment(user, id, dto.reason, meta);
  }
}
