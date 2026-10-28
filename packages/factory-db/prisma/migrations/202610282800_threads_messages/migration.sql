-- CreateEnum
CREATE TYPE "ThreadStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('INTERNAL_NOTE', 'OUTBOUND', 'INBOUND');

-- CreateEnum
CREATE TYPE "MessageAudience" AS ENUM ('OFFICE', 'PARTNER');

-- CreateEnum
CREATE TYPE "MessageChannel" AS ENUM ('APP', 'EMAIL', 'PORTAL');

-- CreateEnum
CREATE TYPE "MessageAuthorKind" AS ENUM ('USER', 'WORKER', 'PARTY', 'SYSTEM');

-- CreateTable
CREATE TABLE "Thread" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID,
    "siteId" UUID,
    "partyId" UUID,
    "recordType" TEXT NOT NULL,
    "recordId" UUID NOT NULL,
    "replyToken" TEXT NOT NULL,
    "status" "ThreadStatus" NOT NULL DEFAULT 'OPEN',
    "lastMessageAt" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "Thread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "threadId" UUID NOT NULL,
    "partyId" UUID,
    "direction" "MessageDirection" NOT NULL,
    "audience" "MessageAudience" NOT NULL,
    "channel" "MessageChannel" NOT NULL,
    "authorKind" "MessageAuthorKind" NOT NULL,
    "authorId" UUID,
    "authorName" TEXT,
    "bodyText" TEXT NOT NULL,
    "bodyHtml" TEXT,
    "mentionedUserIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "attachmentFileIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "emailMessageId" TEXT,
    "at" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Thread_tenantId_partyId_idx" ON "Thread"("tenantId", "partyId");

-- CreateIndex
CREATE UNIQUE INDEX "Thread_tenantId_recordType_recordId_key" ON "Thread"("tenantId", "recordType", "recordId");

-- CreateIndex
CREATE UNIQUE INDEX "Thread_replyToken_key" ON "Thread"("replyToken");

-- CreateIndex
CREATE UNIQUE INDEX "Thread_tenantId_id_key" ON "Thread"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Thread_tenantId_id_partyId_key" ON "Thread"("tenantId", "id", "partyId");

-- CreateIndex
CREATE INDEX "Message_tenantId_threadId_at_idx" ON "Message"("tenantId", "threadId", "at");

-- CreateIndex
CREATE INDEX "Message_tenantId_partyId_idx" ON "Message"("tenantId", "partyId");

-- CreateIndex
CREATE UNIQUE INDEX "Message_tenantId_emailMessageId_key" ON "Message"("tenantId", "emailMessageId");

-- AddForeignKey
ALTER TABLE "Thread" ADD CONSTRAINT "Thread_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Thread" ADD CONSTRAINT "Thread_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_tenantId_threadId_fkey" FOREIGN KEY ("tenantId", "threadId") REFERENCES "Thread"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_tenantId_threadId_partyId_fkey" FOREIGN KEY ("tenantId", "threadId", "partyId") REFERENCES "Thread"("tenantId", "id", "partyId") ON DELETE RESTRICT ON UPDATE RESTRICT;

