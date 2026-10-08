/** Response shapes of the backend REST API (money is always a decimal string). */
export interface Page<T> { items: T[]; page: number; limit: number; total: number }

export type Unit = 'EGG' | 'CRATE' | 'CARTON';
export type Shift = 'MORNING' | 'AFTERNOON' | 'EVENING';
export type PayMethod = 'CASH' | 'MOBILE_MONEY' | 'BANK_TRANSFER' | 'OTHER';
export type PaymentStatus = 'UNPAID' | 'PARTIAL' | 'PAID';

export interface ProductionRecord {
  id: string; coop: { id: string; name: string }; shift: Shift; productionDate: string; totalEggs: number;
  entries: { unit: Unit; quantity: number; baseEggs: number }[]; status: 'ACTIVE' | 'VOIDED'; version: number; notes: string | null; needsReview: boolean;
  recordedById: string | null; createdAt: string;
}

export interface SaleItem { unit: Unit; quantity: number; baseEggs: number; unitPrice: string; lineTotal: string }
export interface Sale {
  id: string; number: string; saleDate: string; customer: { id: string; name: string } | null; items: SaleItem[];
  subtotal: string; discount: string; total: string; paidAmount: string; outstanding: string; paymentStatus: PaymentStatus; status: 'ACTIVE' | 'VOIDED';
  payments: { id: string; amount: string; method: PayMethod; paidAt: string; status: string }[]; notes: string | null; needsReview: boolean; createdAt: string;
  voidedAt: string | null; voidReason: string | null;
}

export interface Customer {
  id: string; name: string; phone: string | null; email: string | null; address: string | null; type: 'REGULAR' | 'WHOLESALE'; notes: string | null; version: number;
  /** present only with customers.financial */
  creditAllowed?: boolean; creditLimit?: string; outstandingBalance?: string;
}

export interface Expense {
  id: string; category: { code: string; name: string }; description: string; quantity: string | null; unitCost: string | null; total: string; expenseDate: string | null;
  supplier: { id: string; name: string } | null; paymentMethod: PayMethod; notes: string | null; status: 'ACTIVE' | 'VOIDED'; needsReview: boolean; version: number; createdAt: string;
}

export interface InventorySnapshot { farmId: string; productId: string; quantityEggs: number; lowStock: boolean; lowStockThresholdEggs: number | null }
export interface InventoryTxDetail extends InventoryTx { recordedAt: string; sourceId: string | null; createdById: string | null; createdByName: string | null; balanceAfterEggs: number }
export interface InventoryTx { id: string; type: string; quantityEggs: number; occurredAt: string; sourceType: string | null; reason: string | null; needsReview: boolean }

export interface Dashboard {
  businessDate: string; currency: string; generatedAt: string;
  production?: {
    yesterdayEggs: number; weekEggs: number; averagePerDay7: number; monthEggs: number; recordsToday: number; recordsMonth: number; activeCoops: number; bestDay14: { date: string; eggs: number } | null;
    todayEggs: number; byCoop: { coopId: string; name: string; eggs: number }[]; byShift: { shift: Shift; eggs: number }[]; notRecordedToday: { coopId: string; coop: string; shift: Shift }[]; last14Days: { date: string; eggs: number }[];
  };
  inventory?: InventorySnapshot;
  sales?: {
    todayRevenue: string; todayCount: number; todayEggsSold: number; weekRevenue: string; weekCount: number; monthRevenue: string; monthCount: number; monthEggsSold: number;
    averageSaleMonth: string; unpaidSales: number; topCustomersMonth: { name: string; total: string }[]; last14Days: { date: string; revenue: string }[];
  };
  customers?: { total: number; regular: number; wholesale: number; addedThisMonth: number };
  expenses?: { todayTotal: string; todayCount: number; monthToDateTotal: string; byCategoryToday: { category: string; total: string }[]; last14Days: { date: string; total: string }[] };
  cash?: { receivedToday: string; expensesToday: string; netCashFlowToday: string; basis: string };
  receivables?: { outstandingTotal: string; customersWithBalance: number };
  needsReview: { production?: number; sales?: number; expenses?: number };
}

export interface AppNotification {
  id: string; category: string; type: string; title: string; body: string; entityType: string | null; entityId: string | null; readAt: string | null; createdAt: string;
}
export interface NotificationPage extends Page<AppNotification> { unread: number }
export interface NotificationPreference { category: string; mutable: boolean; enabled: boolean }

export interface AdminUser {
  id: string; email: string; fullName: string | null; phone: string | null; status: string; emailVerified: boolean; mfaEnabled: boolean; lastLoginAt: string | null; createdAt: string; roles: string[];
}
export interface Role { code: string; name: string; description?: string | null; mfaRequired?: boolean; permissions?: string[] }

export interface SessionInfo { id: string; familyId?: string; deviceName?: string | null; platform?: string | null; ip?: string | null; createdAt: string; lastUsedAt?: string | null; current?: boolean }

export interface AuditEntry {
  id: string; seq: string; at: string; action: string; userId: string | null; userName: string | null; entityType: string | null; entityId: string | null;
  before: unknown; after: unknown; reason: string | null; ip: string | null; deviceInfo: string | null; requestId: string | null;
}

export type Cell = string | number | boolean | null;
export interface ReportTable { name: string; title: string; columns: { key: string; label: string; type: string }[]; rows: Record<string, Cell>[]; totals?: Record<string, Cell> }
export interface ReportResult {
  meta: { report: string; title: string; from: string; to: string; groupBy: string; generatedAt: string; currency: string; timezone: string; notes: string[] };
  summary: Record<string, Cell>;
  tables: ReportTable[];
}

export interface Coop { id: string; name: string; active?: boolean; capacity?: number | null; notes?: string | null }
export interface UnitInfo { code: Unit; name?: string; eggsPerUnit: number }
export interface Supplier { id: string; name: string; phone: string | null; notes: string | null; active: boolean }
export interface PriceRow { id: string; unit: Unit; amount: string; effectiveFrom: string; effectiveTo: string | null; reason: string | null }
