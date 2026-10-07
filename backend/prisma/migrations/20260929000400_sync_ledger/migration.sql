-- Sync ledger: track retries and last change so a device retrying a conflicted/rejected operation is visible.
ALTER TABLE "SyncOperation" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "SyncOperation" ADD COLUMN "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now();
