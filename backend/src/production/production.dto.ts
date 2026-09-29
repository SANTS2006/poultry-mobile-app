import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, Min, ValidateNested,
} from 'class-validator';
import { PageQuery } from '../common/pagination';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export class ProductionEntryDto {
  @IsIn(['EGG', 'CRATE', 'CARTON']) unit!: 'EGG' | 'CRATE' | 'CARTON';
  @IsInt() @Min(0) @Max(1_000_000) quantity!: number;
}

export class CreateProductionDto {
  @IsUUID() coopId!: string;
  @IsIn(['MORNING', 'AFTERNOON', 'EVENING']) shift!: 'MORNING' | 'AFTERNOON' | 'EVENING';
  @IsOptional() @Matches(DATE, { message: 'productionDate must be YYYY-MM-DD' }) productionDate?: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(3) @ValidateNested({ each: true }) @Type(() => ProductionEntryDto) entries!: ProductionEntryDto[];
  @IsOptional() @Transform(trim) @IsString() @Length(1, 500) notes?: string;
  /** client-generated id: makes offline re-sends idempotent */
  @IsOptional() @IsUUID() clientId?: string;
  @IsOptional() @IsUUID() farmId?: string;
}

export class UpdateProductionDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(3) @ArrayUnique((e: ProductionEntryDto) => e.unit) @ValidateNested({ each: true }) @Type(() => ProductionEntryDto) entries!: ProductionEntryDto[];
  @IsOptional() @Transform(trim) @IsString() @Length(1, 500) notes?: string;
  @IsInt() @Min(1) version!: number;
  @Transform(trim) @IsString() @Length(5, 300) reason!: string;
}

export class VoidDto {
  @Transform(trim) @IsString() @Length(5, 300) reason!: string;
}

export class ListProductionQuery extends PageQuery {
  @IsOptional() @Matches(DATE) from?: string;
  @IsOptional() @Matches(DATE) to?: string;
  @IsOptional() @IsUUID() coopId?: string;
  @IsOptional() @IsIn(['MORNING', 'AFTERNOON', 'EVENING']) shift?: string;
  @IsOptional() @IsUUID() recordedById?: string;
  @IsOptional() @IsIn(['ACTIVE', 'VOIDED']) status?: 'ACTIVE' | 'VOIDED';
  @IsOptional() @IsIn(['true', 'false']) needsReview?: 'true' | 'false';
}
