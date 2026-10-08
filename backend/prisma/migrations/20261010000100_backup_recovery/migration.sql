-- CreateEnum
CREATE TYPE "BackupKind" AS ENUM ('SCHEDULED', 'MANUAL', 'PRE_RESTORE');

-- CreateEnum
CREATE TYPE "BackupStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCESSFUL', 'FAILED');

-- CreateEnum
CREATE TYPE "BackupVerification" AS ENUM ('NOT_VERIFIED', 'VERIFIED', 'FAILED');

-- CreateEnum
CREATE TYPE "RecoveryStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "BackupJob" (
    "id" UUID NOT NULL,
    "kind" "BackupKind" NOT NULL,
    "status" "BackupStatus" NOT NULL DEFAULT 'PENDING',
    "windowKey" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "nextAttemptAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "sizeBytes" BIGINT,
    "sha256" TEXT,
    "format" TEXT,
    "encrypted" BOOLEAN NOT NULL DEFAULT false,
    "destination" TEXT,
    "storageKey" TEXT,
    "environment" TEXT,
    "dbName" TEXT,
    "serverVersion" TEXT,
    "retentionUntil" TIMESTAMP(3),
    "verification" "BackupVerification" NOT NULL DEFAULT 'NOT_VERIFIED',
    "verifiedAt" TIMESTAMP(3),
    "verificationDetail" JSONB,
    "error" TEXT,
    "triggeredById" UUID,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BackupJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecoveryOperation" (
    "id" UUID NOT NULL,
    "backupId" UUID NOT NULL,
    "requestedById" UUID NOT NULL,
    "requestedByName" TEXT NOT NULL,
    "status" "RecoveryStatus" NOT NULL DEFAULT 'RUNNING',
    "target" TEXT NOT NULL,
    "preSnapshotId" UUID,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "report" JSONB,
    "error" TEXT,

    CONSTRAINT "RecoveryOperation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BackupSetting" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "scheduleTime" TEXT NOT NULL DEFAULT '02:00',
    "retentionDays" INTEGER NOT NULL DEFAULT 14,
    "keepMonthly" INTEGER NOT NULL DEFAULT 6,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BackupSetting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BackupJob_windowKey_key" ON "BackupJob"("windowKey");

-- CreateIndex
CREATE INDEX "BackupJob_status_createdAt_idx" ON "BackupJob"("status", "createdAt");

-- CreateIndex
CREATE INDEX "BackupJob_createdAt_idx" ON "BackupJob"("createdAt");

-- CreateIndex
CREATE INDEX "RecoveryOperation_startedAt_idx" ON "RecoveryOperation"("startedAt");

-- AddForeignKey
ALTER TABLE "RecoveryOperation" ADD CONSTRAINT "RecoveryOperation_backupId_fkey" FOREIGN KEY ("backupId") REFERENCES "BackupJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Single settings row, and the new permission (Super Admin only) for databases that were seeded before it existed.
INSERT INTO "BackupSetting" ("id", "updatedAt") VALUES (1, CURRENT_TIMESTAMP) ON CONFLICT ("id") DO NOTHING;
INSERT INTO "Permission" ("id", "code") VALUES (gen_random_uuid(), 'backups.manage') ON CONFLICT ("code") DO NOTHING;
INSERT INTO "RolePermission" ("roleId", "permissionId")
  SELECT r."id", p."id" FROM "Role" r, "Permission" p WHERE r."code" = 'SUPER_ADMIN' AND p."code" = 'backups.manage'
  ON CONFLICT DO NOTHING;
