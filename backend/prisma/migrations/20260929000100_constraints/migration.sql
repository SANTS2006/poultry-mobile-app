-- Database-level integrity rules that Prisma's schema language cannot express.

-- Emails are stored lower-case by the application; enforce case-insensitive uniqueness regardless.
CREATE UNIQUE INDEX "User_email_lower_key" ON "User" (lower("email"));

-- Non-negative / sane quantities and money.
ALTER TABLE "ProductUnit"      ADD CONSTRAINT "ProductUnit_eggs_positive"   CHECK ("eggsPerUnit" > 0);
ALTER TABLE "Price"            ADD CONSTRAINT "Price_amount_nonneg"         CHECK ("amount" >= 0);
ALTER TABLE "Price"            ADD CONSTRAINT "Price_period_valid"          CHECK ("effectiveTo" IS NULL OR "effectiveTo" > "effectiveFrom");
ALTER TABLE "ProductionRecord" ADD CONSTRAINT "ProductionRecord_total_nonneg" CHECK ("totalEggs" >= 0);
ALTER TABLE "ProductionRecord" ADD CONSTRAINT "ProductionRecord_version_pos"  CHECK ("version" >= 1);
ALTER TABLE "ProductionEntry"  ADD CONSTRAINT "ProductionEntry_qty_nonneg"    CHECK ("quantity" >= 0 AND "baseEggs" >= 0);
ALTER TABLE "InventoryBalance" ADD CONSTRAINT "InventoryBalance_nonneg"       CHECK ("quantityEggs" >= 0);
ALTER TABLE "InventoryTransaction" ADD CONSTRAINT "InventoryTransaction_nonzero" CHECK ("quantityEggs" <> 0);
ALTER TABLE "InventoryTransaction" ADD CONSTRAINT "InventoryTransaction_sign" CHECK (
  ("type" IN ('SALE','USAGE','DAMAGE','LOSS') AND "quantityEggs" < 0)
  OR ("type" IN ('OPENING','PRODUCTION') AND "quantityEggs" > 0)
  OR "type" IN ('ADJUSTMENT','TRANSFER','CORRECTION')
);
ALTER TABLE "Customer"         ADD CONSTRAINT "Customer_credit_nonneg"      CHECK ("creditLimit" >= 0);
ALTER TABLE "Sale"             ADD CONSTRAINT "Sale_amounts_valid"          CHECK (
  "subtotal" >= 0 AND "discount" >= 0 AND "discount" <= "subtotal"
  AND "total" = "subtotal" - "discount" AND "paidAmount" >= 0 AND "paidAmount" <= "total");
ALTER TABLE "SaleItem"         ADD CONSTRAINT "SaleItem_amounts_valid"      CHECK (
  "quantity" > 0 AND "baseEggs" > 0 AND "unitPrice" >= 0 AND "lineTotal" >= 0);
ALTER TABLE "Payment"          ADD CONSTRAINT "Payment_amount_positive"     CHECK ("amount" > 0);
ALTER TABLE "Payment"          ADD CONSTRAINT "Payment_has_target"          CHECK ("saleId" IS NOT NULL OR "customerId" IS NOT NULL);
ALTER TABLE "Expense"          ADD CONSTRAINT "Expense_total_nonneg"        CHECK ("total" >= 0);
ALTER TABLE "Expense"          ADD CONSTRAINT "Expense_qty_nonneg"          CHECK (("quantity" IS NULL OR "quantity" >= 0) AND ("unitCost" IS NULL OR "unitCost" >= 0));
-- Undated expenses are only allowed for rows imported from the workbook and flagged for review.
ALTER TABLE "Expense"          ADD CONSTRAINT "Expense_date_required"       CHECK ("expenseDate" IS NOT NULL OR "needsReview" = true);
ALTER TABLE "CashCount"        ADD CONSTRAINT "CashCount_amount_nonneg"     CHECK ("amount" >= 0);
ALTER TABLE "Attachment"       ADD CONSTRAINT "Attachment_size_pos"         CHECK ("sizeBytes" > 0);
ALTER TABLE "User"             ADD CONSTRAINT "User_failed_nonneg"          CHECK ("failedAttempts" >= 0);

-- One ACTIVE production record per coop/date/shift (voided records may coexist).
CREATE UNIQUE INDEX "ProductionRecord_active_unique"
  ON "ProductionRecord" ("coopId", "productionDate", "shiftId") WHERE "status" = 'ACTIVE';

-- Only one open price per unit at a time.
CREATE UNIQUE INDEX "Price_one_open_per_unit" ON "Price" ("productUnitId") WHERE "effectiveTo" IS NULL;

-- Audit log is append-only: block UPDATE and DELETE (TRUNCATE also blocked).
CREATE FUNCTION audit_log_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AuditLog is append-only (% blocked)', TG_OP USING ERRCODE = '42501';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_no_update_delete
  BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON "AuditLog"
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_immutable();

-- The inventory ledger is append-only as well (corrections are new rows).
CREATE FUNCTION inventory_ledger_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'InventoryTransaction is append-only (% blocked)', TG_OP USING ERRCODE = '42501';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER inventory_ledger_no_update_delete
  BEFORE UPDATE OR DELETE ON "InventoryTransaction"
  FOR EACH ROW EXECUTE FUNCTION inventory_ledger_immutable();
