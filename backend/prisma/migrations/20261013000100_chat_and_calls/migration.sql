-- CreateEnum
CREATE TYPE "ConversationType" AS ENUM ('DIRECT', 'GROUP');

-- CreateEnum
CREATE TYPE "MemberRole" AS ENUM ('ADMIN', 'MEMBER');

-- CreateEnum
CREATE TYPE "MessageKind" AS ENUM ('TEXT', 'IMAGE', 'FILE', 'SYSTEM', 'CALL');

-- CreateEnum
CREATE TYPE "CallKind" AS ENUM ('AUDIO', 'VIDEO');

-- CreateEnum
CREATE TYPE "CallStatus" AS ENUM ('RINGING', 'ACCEPTED', 'ENDED');

-- CreateEnum
CREATE TYPE "CallEndReason" AS ENUM ('COMPLETED', 'CANCELLED', 'REJECTED', 'MISSED', 'BUSY', 'FAILED');

-- AlterTable
ALTER TABLE "Profile" ADD COLUMN     "lastSeenAt" TIMESTAMPTZ;

-- CreateTable
CREATE TABLE "Conversation" (
    "id" UUID NOT NULL,
    "type" "ConversationType" NOT NULL,
    "directKey" TEXT,
    "title" TEXT,
    "description" TEXT,
    "avatar" TEXT,
    "avatarVersion" INTEGER NOT NULL DEFAULT 0,
    "createdById" UUID NOT NULL,
    "lastSeq" BIGINT NOT NULL DEFAULT 0,
    "lastMessageAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversationMember" (
    "conversationId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" "MemberRole" NOT NULL DEFAULT 'MEMBER',
    "joinedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leftAt" TIMESTAMPTZ,
    "visibleFromSeq" BIGINT NOT NULL DEFAULT 0,
    "lastReadSeq" BIGINT NOT NULL DEFAULT 0,
    "lastDeliveredSeq" BIGINT NOT NULL DEFAULT 0,
    "mutedUntil" TIMESTAMPTZ,
    "muted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ConversationMember_pkey" PRIMARY KEY ("conversationId","userId")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "seq" BIGINT NOT NULL,
    "senderId" UUID,
    "kind" "MessageKind" NOT NULL DEFAULT 'TEXT',
    "body" TEXT NOT NULL DEFAULT '',
    "replyToId" UUID,
    "attachmentId" UUID,
    "clientId" UUID,
    "editedAt" TIMESTAMPTZ,
    "deletedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatAttachment" (
    "id" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "uploaderId" UUID NOT NULL,
    "storageKey" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserBlock" (
    "blockerId" UUID NOT NULL,
    "blockedId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserBlock_pkey" PRIMARY KEY ("blockerId","blockedId")
);

-- CreateTable
CREATE TABLE "MessageReport" (
    "id" UUID NOT NULL,
    "messageId" UUID NOT NULL,
    "reporterId" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatSetting" (
    "userId" UUID NOT NULL,
    "showPreviews" BOOLEAN NOT NULL DEFAULT false,
    "pushMessages" BOOLEAN NOT NULL DEFAULT true,
    "pushCalls" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "ChatSetting_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "CallSession" (
    "id" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "callerId" UUID NOT NULL,
    "calleeId" UUID NOT NULL,
    "kind" "CallKind" NOT NULL,
    "status" "CallStatus" NOT NULL DEFAULT 'RINGING',
    "endReason" "CallEndReason",
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "answeredAt" TIMESTAMPTZ,
    "endedAt" TIMESTAMPTZ,

    CONSTRAINT "CallSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_directKey_key" ON "Conversation"("directKey");

-- CreateIndex
CREATE INDEX "Conversation_lastMessageAt_idx" ON "Conversation"("lastMessageAt");

-- CreateIndex
CREATE INDEX "ConversationMember_userId_leftAt_idx" ON "ConversationMember"("userId", "leftAt");

-- CreateIndex
CREATE UNIQUE INDEX "Message_attachmentId_key" ON "Message"("attachmentId");

-- CreateIndex
CREATE INDEX "Message_createdAt_idx" ON "Message"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Message_conversationId_seq_key" ON "Message"("conversationId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "Message_senderId_clientId_key" ON "Message"("senderId", "clientId");

-- CreateIndex
CREATE UNIQUE INDEX "ChatAttachment_storageKey_key" ON "ChatAttachment"("storageKey");

-- CreateIndex
CREATE INDEX "ChatAttachment_conversationId_idx" ON "ChatAttachment"("conversationId");

-- CreateIndex
CREATE INDEX "ChatAttachment_status_createdAt_idx" ON "ChatAttachment"("status", "createdAt");

-- CreateIndex
CREATE INDEX "UserBlock_blockedId_idx" ON "UserBlock"("blockedId");

-- CreateIndex
CREATE UNIQUE INDEX "MessageReport_messageId_reporterId_key" ON "MessageReport"("messageId", "reporterId");

-- CreateIndex
CREATE INDEX "CallSession_callerId_createdAt_idx" ON "CallSession"("callerId", "createdAt");

-- CreateIndex
CREATE INDEX "CallSession_calleeId_createdAt_idx" ON "CallSession"("calleeId", "createdAt");

-- CreateIndex
CREATE INDEX "CallSession_status_createdAt_idx" ON "CallSession"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "ConversationMember" ADD CONSTRAINT "ConversationMember_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationMember" ADD CONSTRAINT "ConversationMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_replyToId_fkey" FOREIGN KEY ("replyToId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_attachmentId_fkey" FOREIGN KEY ("attachmentId") REFERENCES "ChatAttachment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatAttachment" ADD CONSTRAINT "ChatAttachment_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatAttachment" ADD CONSTRAINT "ChatAttachment_uploaderId_fkey" FOREIGN KEY ("uploaderId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserBlock" ADD CONSTRAINT "UserBlock_blockerId_fkey" FOREIGN KEY ("blockerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserBlock" ADD CONSTRAINT "UserBlock_blockedId_fkey" FOREIGN KEY ("blockedId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageReport" ADD CONSTRAINT "MessageReport_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageReport" ADD CONSTRAINT "MessageReport_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatSetting" ADD CONSTRAINT "ChatSetting_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallSession" ADD CONSTRAINT "CallSession_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallSession" ADD CONSTRAINT "CallSession_callerId_fkey" FOREIGN KEY ("callerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallSession" ADD CONSTRAINT "CallSession_calleeId_fkey" FOREIGN KEY ("calleeId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Database-level guarantees (hold for every client, not just the API) -------------------------------
ALTER TABLE "Message" ADD CONSTRAINT "Message_body_length_chk" CHECK (char_length("body") <= 4000);
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_direct_key_chk" CHECK (("type" = 'DIRECT') = ("directKey" IS NOT NULL));
ALTER TABLE "CallSession" ADD CONSTRAINT "CallSession_distinct_parties_chk" CHECK ("callerId" <> "calleeId");
ALTER TABLE "ChatAttachment" ADD CONSTRAINT "ChatAttachment_size_chk" CHECK ("sizeBytes" > 0 AND "sizeBytes" <= 15728640);
ALTER TABLE "ChatAttachment" ADD CONSTRAINT "ChatAttachment_status_chk" CHECK ("status" IN ('PENDING', 'READY', 'ATTACHED'));
-- hot path: newest messages of a conversation / unread counting
CREATE INDEX "Message_conversationId_createdAt_idx" ON "Message"("conversationId", "createdAt");
-- one live call per person, enforced by the database (a user cannot be in two RINGING/ACCEPTED calls at once)
CREATE UNIQUE INDEX "CallSession_one_live_call_caller" ON "CallSession"("callerId") WHERE "status" IN ('RINGING', 'ACCEPTED');
CREATE UNIQUE INDEX "CallSession_one_live_call_callee" ON "CallSession"("calleeId") WHERE "status" IN ('RINGING', 'ACCEPTED');

-- Permissions: everyone may chat; creating groups is for Super Admin, Owner and Farm Manager.
INSERT INTO "Permission" ("id", "code") VALUES (gen_random_uuid(), 'chat.use'), (gen_random_uuid(), 'chat.groups.create') ON CONFLICT ("code") DO NOTHING;
INSERT INTO "RolePermission" ("roleId", "permissionId")
  SELECT r."id", p."id" FROM "Role" r, "Permission" p WHERE p."code" = 'chat.use' ON CONFLICT DO NOTHING;
INSERT INTO "RolePermission" ("roleId", "permissionId")
  SELECT r."id", p."id" FROM "Role" r, "Permission" p WHERE p."code" = 'chat.groups.create' AND r."code" IN ('SUPER_ADMIN', 'OWNER', 'FARM_MANAGER') ON CONFLICT DO NOTHING;
