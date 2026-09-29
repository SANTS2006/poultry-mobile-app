import type { Prisma } from '@prisma/client';

export type Severity = 'INFO' | 'WARNING' | 'ERROR';

/** One finding about the source workbook. Nothing questionable is dropped silently: it is either imported+flagged or listed here. */
export interface Issue {
  severity: Severity;
  sheet: string;
  cell?: string;
  code: string;
  message: string;
  original?: string;
  /** true when a person must decide something before the record can be trusted */
  needsManualReview: boolean;
}

export type Money = Prisma.Decimal;

export interface PlannedProductionEntry { unit: 'EGG' | 'CRATE' | 'CARTON'; quantity: number; baseEggs: number }

export interface PlannedProduction {
  sourceRef: string;
  date: string; // YYYY-MM-DD (business date, no time zone)
  coop: string;
  shift: 'MORNING' | 'AFTERNOON' | 'EVENING';
  entries: PlannedProductionEntry[];
  totalEggs: number;
  needsReview: boolean;
}

export interface PlannedSale {
  sourceRef: string;
  date: string;
  items: { unit: 'CRATE' | 'CARTON'; quantity: number; baseEggs: number; unitPrice: Money; lineTotal: Money }[];
  total: Money;
  needsReview: boolean;
  note?: string;
}

export interface PlannedExpense {
  sourceRef: string;
  date: string;
  categoryCode: string;
  description: string;
  quantity: number | null;
  unitCost: Money | null;
  total: Money;
  originalText: string | null;
  needsReview: boolean;
  notes?: string;
}

export interface PlannedPrice { unit: 'CARTON'; amount: Money; effectiveFrom: string; effectiveTo: string | null }

export interface ImportPlan {
  coops: string[];
  production: PlannedProduction[];
  sales: PlannedSale[];
  expenses: PlannedExpense[];
  prices: PlannedPrice[];
  issues: Issue[];
  stats: {
    productionRowsRead: number;
    productionShiftsSkippedBlank: number;
    productionEggs: number;
    salesEggs: number;
    salesRevenue: Money;
    expenseTotal: Money;
    ledgerBalanceEggs: number; // production − sales, before any opening stock
    sheet1ExpenseTotalAsStored: Money;
    expenditureLinesTotal: number;
    expenditureMatchedDuplicates: number;
    expenditureQueuedForReview: number;
  };
}
