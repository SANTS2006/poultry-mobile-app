import { IsBoolean, IsIn, IsOptional, IsString, IsUUID, Matches } from 'class-validator';
import { Transform } from 'class-transformer';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const bool = ({ value }: { value: unknown }) => (value === 'true' ? true : value === 'false' ? false : value);

export class RangeQuery {
  @Matches(DATE, { message: 'from must be YYYY-MM-DD' }) from!: string;
  @Matches(DATE, { message: 'to must be YYYY-MM-DD' }) to!: string;
  @IsOptional() @IsIn(['day', 'week', 'month']) groupBy?: 'day' | 'week' | 'month';
  /** include the row-level detail table (always included in exports) */
  @IsOptional() @Transform(bool) @IsBoolean() detail?: boolean;
}

export class ProductionQuery extends RangeQuery {
  @IsOptional() @IsUUID() coopId?: string;
  @IsOptional() @IsIn(['MORNING', 'AFTERNOON', 'EVENING']) shift?: string;
}

export class SalesQuery extends RangeQuery {
  @IsOptional() @IsUUID() customerId?: string;
  @IsOptional() @IsIn(['UNPAID', 'PARTIAL', 'PAID']) paymentStatus?: string;
  @IsOptional() @IsIn(['EGG', 'CRATE', 'CARTON']) unit?: string;
  @IsOptional() @IsUUID() createdById?: string;
  @IsOptional() @Transform(bool) @IsBoolean() walkIn?: boolean;
}

export class ExpensesQuery extends RangeQuery {
  @IsOptional() @IsString() @Matches(/^[A-Z_]{2,40}$/) categoryCode?: string;
  @IsOptional() @IsUUID() supplierId?: string;
  @IsOptional() @IsUUID() recordedById?: string;
  @IsOptional() @Transform(bool) @IsBoolean() needsReview?: boolean;
}

/** Download options shared by every export route (each export DTO repeats them so validation stays declarative). */
const FORMAT = ['csv', 'pdf'];
const TABLE = /^[A-Za-z]{2,30}$/;

export class ProductionExportQuery extends ProductionQuery {
  @IsIn(FORMAT) format!: 'csv' | 'pdf';
  /** CSV only: a single table instead of all sections */
  @IsOptional() @Matches(TABLE) table?: string;
}
export class SalesExportQuery extends SalesQuery {
  @IsIn(FORMAT) format!: 'csv' | 'pdf';
  @IsOptional() @Matches(TABLE) table?: string;
}
export class ExpensesExportQuery extends ExpensesQuery {
  @IsIn(FORMAT) format!: 'csv' | 'pdf';
  @IsOptional() @Matches(TABLE) table?: string;
}
export class RangeExportQuery extends RangeQuery {
  @IsIn(FORMAT) format!: 'csv' | 'pdf';
  @IsOptional() @Matches(TABLE) table?: string;
}
