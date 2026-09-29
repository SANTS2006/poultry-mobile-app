/**
 * Permission catalog and default role mapping. Seeded into the database; the database is the
 * runtime source of truth (admins can adjust role_permissions), enforcement is backend-only.
 */
export const PERMISSIONS = [
  'dashboard.read',
  'production.read', 'production.create', 'production.update', 'production.delete',
  'inventory.read', 'inventory.adjust',
  'sales.read', 'sales.create', 'sales.update', 'sales.delete',
  'payments.read', 'payments.create',
  'expenses.read', 'expenses.create', 'expenses.update', 'expenses.delete',
  'customers.read', 'customers.create', 'customers.update', 'customers.financial',
  'suppliers.read', 'suppliers.manage',
  'reports.read', 'reports.export',
  'prices.manage', 'catalog.manage', 'farms.manage',
  'users.manage', 'roles.manage', 'permissions.manage',
  'settings.manage', 'security.manage',
  'audit.read',
  'notifications.manage',
] as const;

export type PermissionCode = (typeof PERMISSIONS)[number];

export interface RoleDefinition {
  code: string;
  name: string;
  description: string;
  mfaRequired: boolean;
  permissions: readonly PermissionCode[];
}

const all = PERMISSIONS;

export const ROLES: readonly RoleDefinition[] = [
  {
    code: 'SUPER_ADMIN', name: 'Super Admin', description: 'Full system control', mfaRequired: true,
    permissions: all,
  },
  {
    code: 'OWNER', name: 'Owner / Admin', description: 'Business owner: operations, finance, staff, settings', mfaRequired: true,
    permissions: all.filter((p) => !['roles.manage', 'permissions.manage', 'security.manage'].includes(p)),
  },
  {
    code: 'FARM_MANAGER', name: 'Farm Manager', description: 'Runs daily operations', mfaRequired: false,
    permissions: [
      'dashboard.read', 'production.read', 'production.create', 'production.update',
      'inventory.read', 'inventory.adjust', 'sales.read', 'sales.create',
      'expenses.read', 'expenses.create', 'customers.read', 'customers.create', 'customers.update',
      'suppliers.read', 'reports.read',
    ],
  },
  {
    code: 'PRODUCTION_STAFF', name: 'Production Staff', description: 'Records egg production; no financial access', mfaRequired: false,
    permissions: ['production.read', 'production.create'],
  },
  {
    code: 'SALES_STAFF', name: 'Sales Staff', description: 'Records sales and manages customers', mfaRequired: false,
    permissions: ['inventory.read', 'sales.read', 'sales.create', 'payments.create', 'customers.read', 'customers.create', 'customers.update'],
  },
  {
    code: 'ACCOUNTANT', name: 'Accountant / Finance', description: 'Financial visibility and payments', mfaRequired: false,
    permissions: [
      'dashboard.read', 'sales.read', 'expenses.read', 'payments.read', 'payments.create',
      'customers.read', 'customers.financial', 'suppliers.read', 'reports.read', 'reports.export',
    ],
  },
];

export const SHIFTS = [
  { code: 'MORNING', name: 'Morning', sortOrder: 1 },
  { code: 'AFTERNOON', name: 'Afternoon', sortOrder: 2 },
  { code: 'EVENING', name: 'Evening', sortOrder: 3 },
] as const;

// Categories exactly as found in the workbook (Sheet1 column pairs).
export const EXPENSE_CATEGORIES = [
  { code: 'FEED', name: 'Feed' },
  { code: 'TRANSPORT', name: 'Transportation' },
  { code: 'LABOUR', name: 'Labour' },
  { code: 'MEDICATION', name: 'Medication' },
  { code: 'PACKAGING', name: 'Packaging' },
  { code: 'UTILITIES', name: 'Utilities' },
  { code: 'LOANS_DEBTS', name: 'Loans/Debts' },
  { code: 'MISC', name: 'Miscellaneous' },
] as const;

// Workbook rule: 1 crate = 30 eggs, 1 carton = 12 crates = 360 eggs. Stored as data, not code constants.
export const EGG_UNITS = [
  { code: 'EGG', name: 'Single egg', eggsPerUnit: 1 },
  { code: 'CRATE', name: 'Crate', eggsPerUnit: 30 },
  { code: 'CARTON', name: 'Carton', eggsPerUnit: 360 },
] as const;

export const DEFAULT_SETTINGS: Record<string, unknown> = {
  'business.currency': 'NLe', // Q1 pending confirmation
  'business.timezone': 'Africa/Freetown',
  'production.maxEggsPerRecord': 50000, // sanity limit for one coop/shift entry
  'production.backdateDays': 7, // older entries need production.update
  'sales.backdateDays': 31,
  'inventory.lowStockThresholdEggs': 1000,
  'sales.creditEnabled': false,
  'expenses.approvalThreshold': null,
  'notifications.dailySummaryTime': '18:00',
  'notifications.productionReminderTime': '10:00',
};
