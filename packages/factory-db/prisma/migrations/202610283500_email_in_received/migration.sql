-- CreateEnum
CREATE TYPE "InboundEmailStatus" AS ENUM ('RECEIVED', 'FETCHED', 'MATCHED', 'TRIAGE', 'HELD', 'REJECTED', 'FAILED');

-- CreateEnum
CREATE TYPE "InboundVerdict" AS ENUM ('PASS', 'FAIL', 'GRAY', 'PROCESSING_FAILED', 'DISABLED');

-- CreateEnum
CREATE TYPE "InboundMatchedBy" AS ENUM ('TOKEN', 'HEADERS', 'SENDER', 'MANUAL');

-- CreateEnum
CREATE TYPE "InboundHeldReason" AS ENUM ('DMARC_FAIL', 'SPAM', 'UNKNOWN_SENDER', 'THREAD_CLOSED');

-- CreateEnum
CREATE TYPE "InboundRejectReason" AS ENUM ('VIRUS', 'DUPLICATE', 'MARKED_SPAM', 'DISCARDED');

-- CreateTable
CREATE TABLE "InboundEmail" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID,
    "accountId" UUID NOT NULL,
    "receiptId" UUID NOT NULL,
    "sesMessageId" TEXT NOT NULL,
    "s3Bucket" TEXT NOT NULL,
    "s3Key" TEXT NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL,
    "envelopeFrom" TEXT,
    "envelopeTo" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "fromAddress" TEXT,
    "fromName" TEXT,
    "to" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "cc" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "subject" TEXT,
    "emailMessageId" TEXT,
    "inReplyTo" TEXT,
    "referenceIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "spfVerdict" "InboundVerdict" NOT NULL,
    "dkimVerdict" "InboundVerdict" NOT NULL,
    "dmarcVerdict" "InboundVerdict" NOT NULL,
    "dmarcPolicy" TEXT,
    "spamVerdict" "InboundVerdict" NOT NULL,
    "virusVerdict" "InboundVerdict" NOT NULL,
    "sizeBytes" INTEGER,
    "bodyText" TEXT,
    "bodyHtml" TEXT,
    "attachments" JSONB NOT NULL DEFAULT '[]',
    "status" "InboundEmailStatus" NOT NULL DEFAULT 'RECEIVED',
    "threadId" UUID,
    "messageId" UUID,
    "matchedBy" "InboundMatchedBy",
    "senderPartyId" UUID,
    "senderContactId" UUID,
    "heldReason" "InboundHeldReason",
    "rejectReason" "InboundRejectReason",
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "fetchedAt" TIMESTAMPTZ(3),
    "sortedAt" TIMESTAMPTZ(3),
    "sortedById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "InboundEmail_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InboundEmail_tenantId_status_receivedAt_idx" ON "InboundEmail"("tenantId", "status", "receivedAt");

-- CreateIndex
CREATE INDEX "InboundEmail_tenantId_threadId_idx" ON "InboundEmail"("tenantId", "threadId");

-- CreateIndex
CREATE UNIQUE INDEX "InboundEmail_tenantId_sesMessageId_key" ON "InboundEmail"("tenantId", "sesMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "InboundEmail_tenantId_emailMessageId_key" ON "InboundEmail"("tenantId", "emailMessageId");

-- AddForeignKey
ALTER TABLE "InboundEmail" ADD CONSTRAINT "InboundEmail_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InboundEmail" ADD CONSTRAINT "InboundEmail_tenantId_accountId_fkey" FOREIGN KEY ("tenantId", "accountId") REFERENCES "IntegrationAccount"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InboundEmail" ADD CONSTRAINT "InboundEmail_tenantId_threadId_fkey" FOREIGN KEY ("tenantId", "threadId") REFERENCES "Thread"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InboundEmail" ADD CONSTRAINT "InboundEmail_tenantId_senderPartyId_fkey" FOREIGN KEY ("tenantId", "senderPartyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InboundEmail" ADD CONSTRAINT "InboundEmail_tenantId_senderPartyId_senderContactId_fkey" FOREIGN KEY ("tenantId", "senderPartyId", "senderContactId") REFERENCES "PartyContact"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

