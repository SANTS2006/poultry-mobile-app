import { Body, Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, Res } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, Length, MaxLength } from 'class-validator';
import type { Response } from 'express';
import { AuditService } from '../audit/audit.service';
import type { AuthUser, RequestMeta } from '../auth/auth.types';
import { CurrentUser, Meta } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { CreateExpenseDto, ExpensesService, ListExpensesQuery, UpdateExpenseDto, VoidExpenseDto } from './expenses.service';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

class SupplierDto {
  @Transform(trim) @IsString() @Length(2, 100) name!: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(30) phone?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(500) notes?: string;
}
class UpdateSupplierDto {
  @IsOptional() @Transform(trim) @IsString() @Length(2, 100) name?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(30) phone?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(500) notes?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

@Controller('expenses')
export class ExpensesController {
  constructor(private readonly expenses: ExpensesService) {}

  @RequirePermissions('expenses.create') @Post()
  async create(@CurrentUser() user: AuthUser, @Body() dto: CreateExpenseDto, @Meta() meta: RequestMeta, @Res({ passthrough: true }) res: Response) {
    const { expense, created } = await this.expenses.create(user, dto, meta);
    res.status(created ? 201 : 200);
    return expense;
  }

  @RequirePermissions('expenses.read') @Get()
  list(@Query() q: ListExpensesQuery) { return this.expenses.list(q); }

  @RequirePermissions('expenses.read') @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) { return this.expenses.get(id); }

  @RequirePermissions('expenses.update') @Patch(':id')
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateExpenseDto, @Meta() meta: RequestMeta) {
    return this.expenses.update(user, id, dto, meta);
  }

  @RequirePermissions('expenses.delete') @HttpCode(200) @Post(':id/void')
  voidExpense(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: VoidExpenseDto, @Meta() meta: RequestMeta) {
    return this.expenses.voidExpense(user, id, dto.reason, meta);
  }
}

@Controller()
export class SuppliersController {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  @RequirePermissions('expenses.read') @Get('expense-categories')
  categories() {
    return this.prisma.expenseCategory.findMany({ where: { active: true }, orderBy: { sortOrder: 'asc' }, select: { code: true, name: true } });
  }

  @RequirePermissions('suppliers.read') @Get('suppliers')
  suppliers() {
    return this.prisma.supplier.findMany({ where: { deletedAt: null }, orderBy: { name: 'asc' }, select: { id: true, name: true, phone: true, notes: true, active: true } });
  }

  @RequirePermissions('suppliers.manage') @Post('suppliers')
  async createSupplier(@CurrentUser() user: AuthUser, @Body() dto: SupplierDto, @Meta() meta: RequestMeta) {
    const s = await this.prisma.supplier.create({ data: dto, select: { id: true, name: true, phone: true, notes: true, active: true } });
    await this.audit.record({ action: 'supplier.created', userId: user.id, userName: user.fullName, entityType: 'supplier', entityId: s.id, after: { name: s.name }, ip: meta.ip, requestId: meta.requestId });
    return s;
  }

  @RequirePermissions('suppliers.manage') @Patch('suppliers/:id')
  async updateSupplier(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateSupplierDto, @Meta() meta: RequestMeta) {
    const before = await this.prisma.supplier.findFirst({ where: { id, deletedAt: null }, select: { id: true, name: true, phone: true, notes: true, active: true } });
    if (!before) throw new NotFoundException('Supplier not found.');
    const after = await this.prisma.supplier.update({ where: { id }, data: dto, select: { id: true, name: true, phone: true, notes: true, active: true } });
    await this.audit.record({ action: 'supplier.updated', userId: user.id, userName: user.fullName, entityType: 'supplier', entityId: id, before, after, ip: meta.ip, requestId: meta.requestId });
    return after;
  }
}
