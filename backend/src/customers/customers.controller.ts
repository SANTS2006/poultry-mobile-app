import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthUser, RequestMeta } from '../auth/auth.types';
import { CurrentUser, Meta } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { CreateCustomerDto, CustomersService, ListCustomersQuery, UpdateCustomerDto } from './customers.service';

@Controller('customers')
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @RequirePermissions('customers.create') @Post()
  async create(@CurrentUser() user: AuthUser, @Body() dto: CreateCustomerDto, @Meta() meta: RequestMeta, @Res({ passthrough: true }) res: Response) {
    const { customer, created } = await this.customers.create(user, dto, meta);
    res.status(created ? 201 : 200);
    return customer;
  }

  @RequirePermissions('customers.read') @Get()
  list(@CurrentUser() user: AuthUser, @Query() q: ListCustomersQuery) { return this.customers.list(user, q); }

  @RequirePermissions('customers.read') @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.customers.get(user, id); }

  @RequirePermissions('customers.financial') @Get(':id/statement')
  statement(@Param('id', ParseUUIDPipe) id: string) { return this.customers.statement(id); }

  @RequirePermissions('customers.update') @Patch(':id')
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCustomerDto, @Meta() meta: RequestMeta) {
    return this.customers.update(user, id, dto, meta);
  }
}
