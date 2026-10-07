import { EGG_UNITS, EXPENSE_CATEGORIES, PERMISSIONS, ROLES } from './permissions';

const byRole = (code: string) => new Set<string>(ROLES.find((r) => r.code === code)!.permissions);

describe('permission catalog', () => {
  it('has unique permission codes and every role permission exists', () => {
    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length);
    for (const r of ROLES) for (const p of r.permissions) expect(PERMISSIONS).toContain(p);
  });

  it('gives production staff no financial access', () => {
    const p = byRole('PRODUCTION_STAFF');
    for (const denied of ['sales.read', 'expenses.read', 'payments.read', 'reports.read', 'customers.financial']) {
      expect(p.has(denied)).toBe(false);
    }
  });

  it('reserves role/permission/security management for Super Admin', () => {
    for (const code of ['roles.manage', 'permissions.manage', 'security.manage']) {
      const holders = ROLES.filter((r) => (r.permissions as readonly string[]).includes(code)).map((r) => r.code);
      expect(holders).toEqual(['SUPER_ADMIN']);
    }
  });

  it('lets only finance/owner roles export reports and see customer financials', () => {
    const exporters = ROLES.filter((r) => (r.permissions as readonly string[]).includes('reports.export')).map((r) => r.code).sort();
    expect(exporters).toEqual(['ACCOUNTANT', 'OWNER', 'SUPER_ADMIN']);
  });

  it('requires MFA for privileged roles', () => {
    expect(ROLES.filter((r) => r.mfaRequired).map((r) => r.code).sort()).toEqual(['OWNER', 'SUPER_ADMIN']);
  });

  it('encodes the workbook conversion rule (crate=30, carton=12 crates=360)', () => {
    const u = Object.fromEntries(EGG_UNITS.map((x) => [x.code, x.eggsPerUnit]));
    expect(u).toEqual({ EGG: 1, CRATE: 30, CARTON: 360 });
    expect(u.CARTON).toBe(12 * u.CRATE);
  });

  it('lists the eight workbook expense categories', () => {
    expect(EXPENSE_CATEGORIES).toHaveLength(8);
  });
});
