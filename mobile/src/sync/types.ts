/** Operations that can be queued while offline. Corrections, voids, price changes and stock adjustments are online-only by design. */
export type OperationType = 'production.create' | 'sale.create' | 'expense.create' | 'customer.create' | 'payment.create';

export type OutboxStatus =
  | 'pending' // waiting for a connection or its turn
  | 'syncing' // in flight (recovered to pending after a crash: the server is idempotent)
  | 'synced' // server accepted it (kept briefly for history)
  | 'conflict' // server needs a human decision (e.g. not enough stock, slot already recorded)
  | 'rejected' // server refused it permanently (validation / permission / business rule)
  | 'blocked'; // depends on another record that failed

export interface OutboxError { code?: string; message?: string; detail?: Record<string, unknown> }

export interface OutboxItem {
  /** client-generated UUID = idempotency key sent with the operation; also the server-side record's client id */
  clientId: string;
  type: OperationType;
  payload: Record<string, unknown>;
  status: OutboxStatus;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  nextAttemptAt: string | null;
  lastError: OutboxError | null;
  entityId: string | null;
  syncedAt: string | null;
  /** strictly increasing local order; operations are sent in this order */
  seq: number;
}

export interface OperationResult {
  clientId: string;
  status: 'accepted' | 'duplicate' | 'rejected' | 'conflict' | 'error';
  entityType: string;
  entityId?: string;
  code?: string;
  message?: string;
  retryable: boolean;
  detail?: Record<string, unknown>;
}

export interface PushRequest { deviceId?: string; operations: { clientId: string; type: OperationType; payload: Record<string, unknown> }[] }
export interface PushResponse { serverTime: string; results: OperationResult[] }

export interface ReferenceData {
  serverTime: string;
  cursor: string;
  incremental: boolean;
  farmId: string;
  businessDate: string;
  settings: Record<string, unknown>;
  coops?: { id: string; name: string }[];
  shifts?: { code: string; name: string }[];
  units?: { code: string; eggsPerUnit: number }[];
  prices?: { unit: string; amount: string }[];
  inventory?: { quantityEggs: number; lowStock: boolean; lowStockThresholdEggs: number | null };
  customers?: ({ id: string; name: string; phone: string | null; type: string; version: number; clientId: string | null } | { id: string; deleted: true })[];
  expenseCategories?: { code: string; name: string }[];
  suppliers?: { id: string; name: string }[];
}

export interface SyncTransport {
  push(req: PushRequest): Promise<PushResponse>;
  reference(since?: string): Promise<ReferenceData>;
}

/** Thrown by transports. The engine reacts differently to each (retry silently / stop and ask for login / back off). */
export class NetworkError extends Error { constructor(message = 'network unavailable') { super(message); this.name = 'NetworkError'; } }
export class AuthRequiredError extends Error { constructor(message = 'sign-in required') { super(message); this.name = 'AuthRequiredError'; } }
export class HttpError extends Error {
  constructor(readonly status: number, readonly body: unknown) { super(`HTTP ${status}`); this.name = 'HttpError'; }
}

export interface NetworkMonitor {
  isOnline(): boolean;
  subscribe(listener: (online: boolean) => void): () => void;
}

export interface SyncSummary {
  pending: number; syncing: number; conflict: number; rejected: number; blocked: number; synced: number;
  /** everything that still needs attention or a connection */
  unsynced: number;
  lastSyncedAt: string | null;
  online: boolean;
  syncing_now: boolean;
}

export type SyncEvent =
  | { type: 'summary'; summary: SyncSummary }
  | { type: 'auth_required' }
  | { type: 'synced'; item: OutboxItem }
  | { type: 'needs_attention'; item: OutboxItem };
