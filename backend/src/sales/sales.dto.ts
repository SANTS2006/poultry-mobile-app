import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, Min, ValidateNested } from 'class-validator';
import { PageQuery } from '../common/pagination';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const MONEY = /^\d{1,12}(\.\d{1,2})?$/;
export const METHODS = ['CASH', 'MOBILE_MONEY', 'BANK_TRANSFER', 'OTHER'] as const;

/**
 * NOTE: there is deliberately NO price, subtotal, total or line-total field. The client sends what was sold; the server looks up
 * the authoritative price and computes every amount. Unknown properties (e.g. a client-supplied `total`) are rejected by the
 * global validation pipe.
 */
export class SaleItemDto {
  @IsIn(['EGG', 'CRATE', 'CARTON']) unit!: 'EGG' | 'CRATE' | 'CARTON';
  @IsInt() @Min(1) @Max(100_000) quantity!: number;
}

export class CreateSaleDto {
  /** omit for a walk-in customer */
  @IsOptional() @IsUUID() customerId?: string;
  @IsOptional() @Matches(DATE, { message: 'saleDate must be YYYY-MM-DD' }) saleDate?: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => SaleItemDto) items!: SaleItemDto[];
  /** decimal string; needs sales.update (manager) */
  @IsOptional() @Matches(MONEY, { message: 'discount must be a decimal with at most 2 decimal places' }) discount?: string;
  @IsOptional() @IsIn(METHODS) paymentMethod?: (typeof METHODS)[number];
  /** omitted = paid in full; "0" = on credit; less than the total = partial payment (credit rules apply) */
  @IsOptional() @Matches(MONEY, { message: 'amountPaid must be a decimal with at most 2 decimal places' }) amountPaid?: string;
  @IsOptional() @Transform(trim) @IsString() @Length(1, 500) notes?: string;
  @IsOptional() @IsUUID() clientId?: string;
  @IsOptional() @IsUUID() farmId?: string;
}

export class VoidSaleDto {
  @Transform(trim) @IsString() @Length(5, 300) reason!: string;
}

export class ListSalesQuery extends PageQuery {
  @IsOptional() @Matches(DATE) from?: string;
  @IsOptional() @Matches(DATE) to?: string;
  @IsOptional() @IsUUID() customerId?: string;
  @IsOptional() @IsIn(['UNPAID', 'PARTIAL', 'PAID']) paymentStatus?: string;
  @IsOptional() @IsUUID() createdById?: string;
  @IsOptional() @IsIn(['ACTIVE', 'VOIDED']) status?: 'ACTIVE' | 'VOIDED';
  @IsOptional() @IsIn(['true', 'false']) needsReview?: 'true' | 'false';
  @IsOptional() @IsIn(['true']) walkIn?: 'true';
}
