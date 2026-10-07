import type { IconName } from '../ui/icon';

export const CATEGORY_ICON: Record<string, IconName> = {
  PRODUCTION: 'egg-outline', INVENTORY: 'cube-outline', SALES: 'receipt-outline', EXPENSES: 'wallet-outline', PAYMENTS: 'cash-outline',
  SECURITY: 'shield-checkmark-outline', SYNC: 'sync-outline', ADMIN: 'people-outline', SYSTEM: 'settings-outline', DAILY_SUMMARY: 'stats-chart-outline',
};

/** What each category is called, and what turning it on gets you. */
export const CATEGORY_INFO: Record<string, { name: string; hint: string }> = {
  PRODUCTION: { name: 'Production', hint: 'Reminders to record eggs and notes about unusual days.' },
  INVENTORY: { name: 'Stock alerts', hint: 'When egg stock runs low or a count looks wrong.' },
  SALES: { name: 'Sales', hint: 'Large sales and sales that need attention.' },
  EXPENSES: { name: 'Expenses', hint: 'When monthly spending passes your limit.' },
  PAYMENTS: { name: 'Payments', hint: 'Payments received and customers who owe money.' },
  SYNC: { name: 'Sync results', hint: 'When records saved offline were accepted or refused.' },
  DAILY_SUMMARY: { name: 'Daily summary', hint: 'One short recap of the day.' },
  SECURITY: { name: 'Security alerts', hint: 'New sign-ins, password changes and locked accounts.' },
  ADMIN: { name: 'Administration', hint: 'Account and user changes that need an administrator.' },
  SYSTEM: { name: 'System notices', hint: 'Service messages from Makarifor.' },
};

export const categoryName = (c: string) => CATEGORY_INFO[c]?.name ?? c.toLowerCase().replace(/_/g, ' ').replace(/^./, (x) => x.toUpperCase());
