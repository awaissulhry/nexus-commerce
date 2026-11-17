-- CreateEnum
CREATE TYPE "InquiryProductionAnswer" AS ENUM ('OK', 'NOT_BEFORE');

-- AlterEnum
ALTER TYPE "InquiryStatus" ADD VALUE 'WITHDRAWN';

-- AlterTable
ALTER TABLE "Inquiry" ADD COLUMN     "productionAnswer" "InquiryProductionAnswer",
ADD COLUMN     "productionAnsweredAt" TIMESTAMPTZ(3),
ADD COLUMN     "productionAnsweredById" UUID,
ADD COLUMN     "productionNotBefore" DATE;

-- AlterTable
ALTER TABLE "Thread" ADD COLUMN     "doneAt" TIMESTAMPTZ(3),
ADD COLUMN     "doneById" UUID;

-- CreateTable
CREATE TABLE "ComposerDraft" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "userId" UUID NOT NULL,
    "partyId" UUID,
    "recordType" TEXT,
    "recordId" UUID,
    "key" TEXT NOT NULL,
    "audience" "MessageAudience",
    "bodyText" TEXT NOT NULL DEFAULT '',
    "fields" JSONB NOT NULL DEFAULT '{}',
    "attachmentFileIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ComposerDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ThreadPin" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "threadId" UUID NOT NULL,
    "messageId" UUID NOT NULL,
    "partyId" UUID,
    "key" TEXT NOT NULL,
    "pinnedById" UUID NOT NULL,
    "pinnedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ThreadPin_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ComposerDraft_tenantId_userId_idx" ON "ComposerDraft"("tenantId", "userId");

-- CreateIndex
CREATE INDEX "ComposerDraft_tenantId_partyId_idx" ON "ComposerDraft"("tenantId", "partyId");

-- CreateIndex
CREATE UNIQUE INDEX "ComposerDraft_tenantId_key_key" ON "ComposerDraft"("tenantId", "key");

-- CreateIndex
CREATE INDEX "ThreadPin_tenantId_threadId_idx" ON "ThreadPin"("tenantId", "threadId");

-- CreateIndex
CREATE INDEX "ThreadPin_tenantId_partyId_idx" ON "ThreadPin"("tenantId", "partyId");

-- CreateIndex
CREATE UNIQUE INDEX "ThreadPin_tenantId_key_key" ON "ThreadPin"("tenantId", "key");

-- AddForeignKey
ALTER TABLE "ComposerDraft" ADD CONSTRAINT "ComposerDraft_tenantId_userId_fkey" FOREIGN KEY ("tenantId", "userId") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Thread" ADD CONSTRAINT "Thread_tenantId_doneById_fkey" FOREIGN KEY ("tenantId", "doneById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ThreadPin" ADD CONSTRAINT "ThreadPin_tenantId_threadId_fkey" FOREIGN KEY ("tenantId", "threadId") REFERENCES "Thread"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ThreadPin" ADD CONSTRAINT "ThreadPin_tenantId_threadId_messageId_fkey" FOREIGN KEY ("tenantId", "threadId", "messageId") REFERENCES "Message"("tenantId", "threadId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ThreadPin" ADD CONSTRAINT "ThreadPin_tenantId_pinnedById_fkey" FOREIGN KEY ("tenantId", "pinnedById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

