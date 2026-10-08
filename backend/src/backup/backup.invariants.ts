/** Business invariants checked on every restored database (same checks as scripts/restore-verify.sh). Each query returns one boolean: true = healthy. */
export const INVARIANTS: { name: string; sql: string }[] = [
  { name: 'Users table present and populated', sql: 'SELECT count(*) > 0 AS ok FROM "User"' },
  { name: 'Stock balance equals the ledger sum', sql: 'SELECT coalesce(bool_and(b."quantityEggs" = coalesce(t.s,0)), true) AS ok FROM "InventoryBalance" b LEFT JOIN (SELECT "farmId","productId", sum("quantityEggs") s FROM "InventoryTransaction" GROUP BY 1,2) t USING ("farmId","productId")' },
  { name: 'No negative stock', sql: 'SELECT NOT EXISTS (SELECT 1 FROM "InventoryBalance" WHERE "quantityEggs" < 0) AS ok' },
  { name: 'Sale totals equal item lines minus discount', sql: `SELECT NOT EXISTS (SELECT 1 FROM "Sale" s WHERE s.status = 'ACTIVE' AND s.total <> (SELECT coalesce(sum(i."lineTotal"),0) FROM "SaleItem" i WHERE i."saleId" = s.id) - s.discount) AS ok` },
  { name: 'Audit log is append-only (triggers restored)', sql: `SELECT count(*) >= 1 AS ok FROM pg_trigger WHERE tgname = 'audit_log_no_update_delete'` },
  { name: 'Audit chain has no gaps in prevHash linkage', sql: 'SELECT NOT EXISTS (SELECT 1 FROM (SELECT hash, lag(hash) OVER (ORDER BY seq) AS prev, "prevHash" FROM "AuditLog") a WHERE a."prevHash" IS DISTINCT FROM a.prev) AS ok' },
];
