-- Insertion order for the audit hash chain (created_at can tie within a millisecond).
ALTER TABLE "AuditLog" ADD COLUMN "seq" BIGSERIAL NOT NULL;
CREATE UNIQUE INDEX "AuditLog_seq_key" ON "AuditLog"("seq");
