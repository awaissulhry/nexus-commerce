-- CreateEnum
CREATE TYPE "RecordSharePermission" AS ENUM ('VIEW', 'COMMENT', 'UPLOAD');

-- CreateEnum
CREATE TYPE "ApprovalKind" AS ENUM ('CONCESSION', 'SAMPLE', 'COLOUR', 'LEATHER', 'ARTWORK', 'PROOF', 'REVISED_ORDER', 'SIGNATURE');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('OPEN', 'APPROVED', 'APPROVED_WITH_CHANGES', 'REFUSED', 'WITHDRAWN', 'EXPIRED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "LinkEvidenceAction" ADD VALUE 'DOWNLOADED';
ALTER TYPE "LinkEvidenceAction" ADD VALUE 'RECEIVED';
ALTER TYPE "LinkEvidenceAction" ADD VALUE 'SUBMITTED';
ALTER TYPE "LinkEvidenceAction" ADD VALUE 'APPROVED';
ALTER TYPE "LinkEvidenceAction" ADD VALUE 'REFUSED';
ALTER TYPE "LinkEvidenceAction" ADD VALUE 'PAID';
ALTER TYPE "LinkEvidenceAction" ADD VALUE 'MOVED_DATE';
ALTER TYPE "LinkEvidenceAction" ADD VALUE 'POSTED';
ALTER TYPE "LinkEvidenceAction" ADD VALUE 'UPLOADED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "LinkPurpose" ADD VALUE 'SHIPMENT_TRACK';
ALTER TYPE "LinkPurpose" ADD VALUE 'MEASUREMENTS';
ALTER TYPE "LinkPurpose" ADD VALUE 'CLAIM';
ALTER TYPE "LinkPurpose" ADD VALUE 'PAYMENT';
ALTER TYPE "LinkPurpose" ADD VALUE 'SUPPLIER_ONBOARD';
ALTER TYPE "LinkPurpose" ADD VALUE 'JOB_ACCEPT';
ALTER TYPE "LinkPurpose" ADD VALUE 'APPROVAL';
ALTER TYPE "LinkPurpose" ADD VALUE 'RECORD_INVITE';
ALTER TYPE "LinkPurpose" ADD VALUE 'SECURE_FILE';

-- AlterTable
ALTER TABLE "NcrConcession" ADD COLUMN     "approvalRequestId" UUID;

-- AlterTable
ALTER TABLE "OneOffLink" ADD COLUMN     "contactId" UUID,
ADD COLUMN     "passwordHash" TEXT,
ADD COLUMN     "passwordHeldUntil" TIMESTAMPTZ(3),
ADD COLUMN     "passwordTries" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "receivedAt" TIMESTAMPTZ(3),
ADD COLUMN     "receivedName" TEXT,
ADD COLUMN     "renewalOfId" UUID;

-- CreateTable
CREATE TABLE "LinkFile" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "partyId" UUID NOT NULL,
    "linkId" UUID NOT NULL,
    "fileId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LinkFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LinkDraft" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "partyId" UUID NOT NULL,
    "linkId" UUID NOT NULL,
    "dataEnc" TEXT NOT NULL,
    "purgeAfter" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LinkDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecordShare" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "recordType" TEXT NOT NULL,
    "recordId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "contactId" UUID,
    "email" TEXT NOT NULL,
    "permissions" "RecordSharePermission"[] DEFAULT ARRAY['VIEW']::"RecordSharePermission"[],
    "notifyByEmail" BOOLEAN NOT NULL DEFAULT true,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),
    "revokedById" UUID,
    "linkId" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "RecordShare_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalRequest" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "recordType" TEXT NOT NULL,
    "recordId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "contactId" UUID,
    "kind" "ApprovalKind" NOT NULL,
    "question" TEXT NOT NULL,
    "dueAt" TIMESTAMPTZ(3) NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'OPEN',
    "answer" TEXT,
    "typedName" TEXT,
    "markupFileId" UUID,
    "answeredAt" TIMESTAMPTZ(3),
    "answeredByUserId" UUID,
    "answeredViaLinkId" UUID,
    "answerRequestId" TEXT,
    "answerIpHash" TEXT,
    "answerUserAgent" TEXT,
    "withdrawnAt" TIMESTAMPTZ(3),
    "withdrawnById" UUID,
    "withdrawReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "ApprovalRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LinkFile_tenantId_fileId_idx" ON "LinkFile"("tenantId", "fileId");

-- CreateIndex
CREATE UNIQUE INDEX "LinkFile_tenantId_linkId_position_key" ON "LinkFile"("tenantId", "linkId", "position");

-- CreateIndex
CREATE INDEX "LinkDraft_tenantId_linkId_idx" ON "LinkDraft"("tenantId", "linkId");

-- CreateIndex
CREATE INDEX "LinkDraft_tenantId_purgeAfter_idx" ON "LinkDraft"("tenantId", "purgeAfter");

-- CreateIndex
CREATE INDEX "RecordShare_tenantId_recordType_recordId_idx" ON "RecordShare"("tenantId", "recordType", "recordId");

-- CreateIndex
CREATE UNIQUE INDEX "RecordShare_tenantId_partyId_linkId_key" ON "RecordShare"("tenantId", "partyId", "linkId");

-- CreateIndex
CREATE INDEX "ApprovalRequest_tenantId_recordType_recordId_idx" ON "ApprovalRequest"("tenantId", "recordType", "recordId");

-- CreateIndex
CREATE INDEX "ApprovalRequest_tenantId_partyId_status_idx" ON "ApprovalRequest"("tenantId", "partyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ApprovalRequest_tenantId_partyId_id_key" ON "ApprovalRequest"("tenantId", "partyId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "NcrConcession_tenantId_partyId_approvalRequestId_key" ON "NcrConcession"("tenantId", "partyId", "approvalRequestId");

-- AddForeignKey
ALTER TABLE "LinkFile" ADD CONSTRAINT "LinkFile_tenantId_partyId_linkId_fkey" FOREIGN KEY ("tenantId", "partyId", "linkId") REFERENCES "OneOffLink"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LinkFile" ADD CONSTRAINT "LinkFile_tenantId_fileId_fkey" FOREIGN KEY ("tenantId", "fileId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LinkDraft" ADD CONSTRAINT "LinkDraft_tenantId_partyId_linkId_fkey" FOREIGN KEY ("tenantId", "partyId", "linkId") REFERENCES "OneOffLink"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RecordShare" ADD CONSTRAINT "RecordShare_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RecordShare" ADD CONSTRAINT "RecordShare_tenantId_partyId_fkey" FOREIGN KEY ("tenantId", "partyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RecordShare" ADD CONSTRAINT "RecordShare_tenantId_partyId_contactId_fkey" FOREIGN KEY ("tenantId", "partyId", "contactId") REFERENCES "PartyContact"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RecordShare" ADD CONSTRAINT "RecordShare_tenantId_partyId_linkId_fkey" FOREIGN KEY ("tenantId", "partyId", "linkId") REFERENCES "OneOffLink"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ApprovalRequest" ADD CONSTRAINT "ApprovalRequest_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ApprovalRequest" ADD CONSTRAINT "ApprovalRequest_tenantId_partyId_fkey" FOREIGN KEY ("tenantId", "partyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ApprovalRequest" ADD CONSTRAINT "ApprovalRequest_tenantId_partyId_contactId_fkey" FOREIGN KEY ("tenantId", "partyId", "contactId") REFERENCES "PartyContact"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ApprovalRequest" ADD CONSTRAINT "ApprovalRequest_tenantId_markupFileId_fkey" FOREIGN KEY ("tenantId", "markupFileId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ApprovalRequest" ADD CONSTRAINT "ApprovalRequest_tenantId_answeredByUserId_fkey" FOREIGN KEY ("tenantId", "answeredByUserId") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ApprovalRequest" ADD CONSTRAINT "ApprovalRequest_tenantId_partyId_answeredViaLinkId_fkey" FOREIGN KEY ("tenantId", "partyId", "answeredViaLinkId") REFERENCES "OneOffLink"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OneOffLink" ADD CONSTRAINT "OneOffLink_tenantId_partyId_contactId_fkey" FOREIGN KEY ("tenantId", "partyId", "contactId") REFERENCES "PartyContact"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OneOffLink" ADD CONSTRAINT "OneOffLink_tenantId_partyId_renewalOfId_fkey" FOREIGN KEY ("tenantId", "partyId", "renewalOfId") REFERENCES "OneOffLink"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "NcrConcession" ADD CONSTRAINT "NcrConcession_tenantId_partyId_approvalRequestId_fkey" FOREIGN KEY ("tenantId", "partyId", "approvalRequestId") REFERENCES "ApprovalRequest"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

