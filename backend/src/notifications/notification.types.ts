import type { NotificationCategory } from '@prisma/client';

/** Categories a user may mute. Security, administration and system notices can never be switched off. */
export const MUTABLE_CATEGORIES: readonly NotificationCategory[] = ['PRODUCTION', 'INVENTORY', 'SALES', 'EXPENSES', 'PAYMENTS', 'SYNC', 'DAILY_SUMMARY'];
export const ALWAYS_ON_CATEGORIES: readonly NotificationCategory[] = ['SECURITY', 'ADMIN', 'SYSTEM'];
export const ALL_CATEGORIES: readonly NotificationCategory[] = [...MUTABLE_CATEGORIES, ...ALWAYS_ON_CATEGORIES];

export interface NotifySpec {
  category: NotificationCategory;
  /** stable machine type, e.g. "sale.created" */
  type: string;
  recipients: string[];
  /** in-app text (inside the authenticated app, so it may contain details) */
  title: string;
  body: string;
  /** lock-screen text: deliberately generic. `false` = in-app only (no push) */
  push?: { title: string; body: string } | false;
  entityType?: string;
  entityId?: string;
  /** skip a recipient who already got this type within N hours */
  dedupeHours?: number;
  /** allow delivery to a user who is not ACTIVE (only for "your account was disabled") */
  allowInactive?: boolean;
}

export const CHANNEL: Record<NotificationCategory, string> = {
  PRODUCTION: 'production', INVENTORY: 'inventory', SALES: 'sales', EXPENSES: 'expenses', PAYMENTS: 'payments',
  SECURITY: 'security', SYNC: 'sync', ADMIN: 'admin', SYSTEM: 'system', DAILY_SUMMARY: 'summary',
};
