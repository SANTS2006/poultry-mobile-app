import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsObject, IsOptional, IsString, IsUUID, MaxLength, ValidateNested } from 'class-validator';

/** Operations a device may queue while offline. Corrections/voids/price changes are deliberately online-only. */
export const OFFLINE_OPERATIONS = ['production.create', 'sale.create', 'expense.create', 'customer.create', 'payment.create'] as const;
export type OfflineOperation = (typeof OFFLINE_OPERATIONS)[number];

export class SyncOperationDto {
  /** client-generated UUID: the idempotency key for this operation */
  @IsUUID() clientId!: string;
  @IsIn(OFFLINE_OPERATIONS) type!: OfflineOperation;
  @IsObject() payload!: Record<string, unknown>;
}

export class SyncPushDto {
  @IsOptional() @IsString() @MaxLength(100) deviceId?: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => SyncOperationDto) operations!: SyncOperationDto[];
}

export class ReferenceQuery {
  /** ISO timestamp returned as `cursor` by a previous call: only customers changed since then are returned */
  @IsOptional() @IsString() @MaxLength(40) since?: string;
}

export type OperationStatus = 'accepted' | 'duplicate' | 'rejected' | 'conflict' | 'error';

export interface OperationResult {
  clientId: string;
  status: OperationStatus;
  entityType: string;
  entityId?: string;
  /** machine-readable reason for non-success outcomes */
  code?: string;
  /** safe, user-presentable text */
  message?: string;
  /** true = the same request may succeed later without a human decision (transient server problem) */
  retryable: boolean;
  detail?: Record<string, unknown>;
}
