-- CreateEnum
CREATE TYPE "AuthorityChannel" AS ENUM ('SAFETY_BUSINESS_GATEWAY', 'AUTHORITY_SITE', 'PEC', 'EMAIL', 'POST', 'INSPECTION', 'OTHER');

-- CreateEnum
CREATE TYPE "AuthorityNoticeDecision" AS ENUM ('NOT_CONFORMING', 'RISK');

-- CreateEnum
CREATE TYPE "AuthorityNoticeStatus" AS ENUM ('DRAFT', 'SENT', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RecallKind" AS ENUM ('RECALL', 'WITHDRAWAL');

-- CreateEnum
CREATE TYPE "RecallStatus" AS ENUM ('DRAFT', 'ACTIVE', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DistributorNoticeChannel" AS ENUM ('EMAIL', 'PORTAL', 'LINK', 'PHONE');

-- CreateEnum
CREATE TYPE "DistributorNoticeStatus" AS ENUM ('DRAFT', 'SENT', 'ANSWERED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AuthorityRequestStatus" AS ENUM ('OPEN', 'ANSWERED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SustainabilityClaimKind" AS ENUM ('RECYCLED_CONTENT', 'ORGANIC_CONTENT', 'BIO_BASED', 'RESPONSIBLE_SOURCING', 'SUBSTANCE_FREE', 'DURABILITY', 'REPAIRABILITY', 'CARBON', 'SOCIAL', 'CERTIFICATION_LABEL', 'OTHER');

-- CreateEnum
CREATE TYPE "SustainabilityClaimScope" AS ENUM ('COMPANY', 'STYLE', 'MATERIAL');

-- CreateEnum
CREATE TYPE "SustainabilityClaimStatus" AS ENUM ('DRAFT', 'APPROVED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "ClaimUseKind" AS ENUM ('LABEL', 'STYLE', 'CATALOGUE', 'WEB_SHOP', 'OTHER');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NumberKind" ADD VALUE 'RECALL';
ALTER TYPE "NumberKind" ADD VALUE 'AUTHORITY_REQUEST';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PpeRegisterKind" ADD VALUE 'WITHDRAWAL';
ALTER TYPE "PpeRegisterKind" ADD VALUE 'AUTHORITY_REQUEST';

-- CreateTable
CREATE TABLE "AuthorityNotice" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "registerEntryId" UUID NOT NULL,
    "marketCode" TEXT NOT NULL,
    "authorityName" TEXT NOT NULL,
    "channel" "AuthorityChannel" NOT NULL,
    "decision" "AuthorityNoticeDecision" NOT NULL,
    "words" JSONB NOT NULL,
    "status" "AuthorityNoticeStatus" NOT NULL DEFAULT 'DRAFT',
    "sentAt" TIMESTAMPTZ(3),
    "sentById" UUID,
    "reference" TEXT,
    "fileId" UUID,
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelReason" TEXT,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "AuthorityNotice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecallAction" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "registerEntryId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "kind" "RecallKind" NOT NULL,
    "styleId" UUID NOT NULL,
    "wholeStyle" BOOLEAN NOT NULL DEFAULT false,
    "batchNumbers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "serials" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "workOrderIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "shipmentIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "publicNotice" JSONB,
    "noticePublishedAt" TIMESTAMPTZ(3),
    "noticePublishedById" UUID,
    "noticeWithdrawnAt" TIMESTAMPTZ(3),
    "status" "RecallStatus" NOT NULL DEFAULT 'DRAFT',
    "startedAt" TIMESTAMPTZ(3),
    "startedById" UUID,
    "closedAt" TIMESTAMPTZ(3),
    "closedById" UUID,
    "closeNote" TEXT,
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelReason" TEXT,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "RecallAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecallProgress" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "recallActionId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "shipmentId" UUID,
    "unitsSent" INTEGER NOT NULL,
    "unitsReturned" INTEGER NOT NULL DEFAULT 0,
    "unitsRepaired" INTEGER NOT NULL DEFAULT 0,
    "unitsDestroyed" INTEGER NOT NULL DEFAULT 0,
    "unitsStillOut" INTEGER NOT NULL,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "RecallProgress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DistributorNotice" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "registerEntryId" UUID NOT NULL,
    "recallActionId" UUID,
    "partyId" UUID NOT NULL,
    "channel" "DistributorNoticeChannel" NOT NULL,
    "contactName" TEXT,
    "contact" TEXT,
    "language" TEXT NOT NULL,
    "subject" TEXT,
    "message" TEXT NOT NULL,
    "linkId" UUID,
    "status" "DistributorNoticeStatus" NOT NULL DEFAULT 'DRAFT',
    "sentAt" TIMESTAMPTZ(3),
    "sentById" UUID,
    "answeredAt" TIMESTAMPTZ(3),
    "answer" TEXT,
    "answeredByName" TEXT,
    "failedAt" TIMESTAMPTZ(3),
    "failureReason" TEXT,
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelReason" TEXT,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "DistributorNotice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthorityRequest" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "authorityName" TEXT NOT NULL,
    "marketCode" TEXT NOT NULL,
    "authorityReference" TEXT,
    "channel" "AuthorityChannel" NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL,
    "styleId" UUID,
    "batchNumbers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "request" TEXT NOT NULL,
    "dueOn" DATE NOT NULL,
    "status" "AuthorityRequestStatus" NOT NULL DEFAULT 'OPEN',
    "answeredAt" TIMESTAMPTZ(3),
    "answeredById" UUID,
    "answerSummary" TEXT,
    "evidenceType" TEXT,
    "evidenceId" UUID,
    "registerEntryId" UUID,
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelReason" TEXT,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "AuthorityRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SustainabilityClaim" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "kind" "SustainabilityClaimKind" NOT NULL,
    "wording" JSONB NOT NULL,
    "phraseKey" TEXT,
    "scope" "SustainabilityClaimScope" NOT NULL,
    "styleId" UUID,
    "itemId" UUID,
    "scopeNote" TEXT,
    "evidenceFileIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "validUntil" DATE,
    "status" "SustainabilityClaimStatus" NOT NULL DEFAULT 'DRAFT',
    "approvedAt" TIMESTAMPTZ(3),
    "approvedById" UUID,
    "withdrawnAt" TIMESTAMPTZ(3),
    "withdrawnById" UUID,
    "withdrawReason" TEXT,
    "supersedesId" UUID,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "SustainabilityClaim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClaimUse" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "claimId" UUID NOT NULL,
    "kind" "ClaimUseKind" NOT NULL,
    "recordType" TEXT NOT NULL,
    "recordId" UUID NOT NULL,
    "label" TEXT,
    "endedAt" TIMESTAMPTZ(3),
    "endedById" UUID,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "ClaimUse_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuthorityNotice_tenantId_registerEntryId_idx" ON "AuthorityNotice"("tenantId", "registerEntryId");

-- CreateIndex
CREATE INDEX "AuthorityNotice_tenantId_status_idx" ON "AuthorityNotice"("tenantId", "status");

-- CreateIndex
CREATE INDEX "RecallAction_tenantId_styleId_idx" ON "RecallAction"("tenantId", "styleId");

-- CreateIndex
CREATE INDEX "RecallAction_tenantId_status_idx" ON "RecallAction"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "RecallAction_tenantId_companyId_number_key" ON "RecallAction"("tenantId", "companyId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "RecallAction_tenantId_id_key" ON "RecallAction"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "RecallAction_tenantId_registerEntryId_id_key" ON "RecallAction"("tenantId", "registerEntryId", "id");

-- CreateIndex
CREATE INDEX "RecallProgress_tenantId_partyId_idx" ON "RecallProgress"("tenantId", "partyId");

-- CreateIndex
CREATE UNIQUE INDEX "RecallProgress_tenantId_recallActionId_partyId_shipmentId_key" ON "RecallProgress"("tenantId", "recallActionId", "partyId", "shipmentId");

-- CreateIndex
CREATE INDEX "DistributorNotice_tenantId_registerEntryId_status_idx" ON "DistributorNotice"("tenantId", "registerEntryId", "status");

-- CreateIndex
CREATE INDEX "DistributorNotice_tenantId_partyId_idx" ON "DistributorNotice"("tenantId", "partyId");

-- CreateIndex
CREATE INDEX "AuthorityRequest_tenantId_status_dueOn_idx" ON "AuthorityRequest"("tenantId", "status", "dueOn");

-- CreateIndex
CREATE INDEX "AuthorityRequest_tenantId_registerEntryId_idx" ON "AuthorityRequest"("tenantId", "registerEntryId");

-- CreateIndex
CREATE UNIQUE INDEX "AuthorityRequest_tenantId_companyId_number_key" ON "AuthorityRequest"("tenantId", "companyId", "number");

-- CreateIndex
CREATE INDEX "SustainabilityClaim_tenantId_status_validUntil_idx" ON "SustainabilityClaim"("tenantId", "status", "validUntil");

-- CreateIndex
CREATE INDEX "SustainabilityClaim_tenantId_styleId_idx" ON "SustainabilityClaim"("tenantId", "styleId");

-- CreateIndex
CREATE INDEX "SustainabilityClaim_tenantId_itemId_idx" ON "SustainabilityClaim"("tenantId", "itemId");

-- CreateIndex
CREATE UNIQUE INDEX "SustainabilityClaim_tenantId_companyId_code_key" ON "SustainabilityClaim"("tenantId", "companyId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "SustainabilityClaim_tenantId_id_key" ON "SustainabilityClaim"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SustainabilityClaim_tenantId_companyId_id_key" ON "SustainabilityClaim"("tenantId", "companyId", "id");

-- CreateIndex
CREATE INDEX "ClaimUse_tenantId_claimId_idx" ON "ClaimUse"("tenantId", "claimId");

-- CreateIndex
CREATE INDEX "ClaimUse_tenantId_recordType_recordId_idx" ON "ClaimUse"("tenantId", "recordType", "recordId");

-- CreateIndex
CREATE UNIQUE INDEX "PpeRegisterEntry_tenantId_companyId_id_key" ON "PpeRegisterEntry"("tenantId", "companyId", "id");

-- AddForeignKey
ALTER TABLE "AuthorityNotice" ADD CONSTRAINT "AuthorityNotice_tenantId_companyId_registerEntryId_fkey" FOREIGN KEY ("tenantId", "companyId", "registerEntryId") REFERENCES "PpeRegisterEntry"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AuthorityNotice" ADD CONSTRAINT "AuthorityNotice_tenantId_fileId_fkey" FOREIGN KEY ("tenantId", "fileId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RecallAction" ADD CONSTRAINT "RecallAction_tenantId_companyId_registerEntryId_fkey" FOREIGN KEY ("tenantId", "companyId", "registerEntryId") REFERENCES "PpeRegisterEntry"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RecallAction" ADD CONSTRAINT "RecallAction_tenantId_styleId_fkey" FOREIGN KEY ("tenantId", "styleId") REFERENCES "Style"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RecallProgress" ADD CONSTRAINT "RecallProgress_tenantId_recallActionId_fkey" FOREIGN KEY ("tenantId", "recallActionId") REFERENCES "RecallAction"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RecallProgress" ADD CONSTRAINT "RecallProgress_tenantId_partyId_fkey" FOREIGN KEY ("tenantId", "partyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DistributorNotice" ADD CONSTRAINT "DistributorNotice_tenantId_companyId_registerEntryId_fkey" FOREIGN KEY ("tenantId", "companyId", "registerEntryId") REFERENCES "PpeRegisterEntry"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DistributorNotice" ADD CONSTRAINT "DistributorNotice_tenantId_registerEntryId_recallActionId_fkey" FOREIGN KEY ("tenantId", "registerEntryId", "recallActionId") REFERENCES "RecallAction"("tenantId", "registerEntryId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DistributorNotice" ADD CONSTRAINT "DistributorNotice_tenantId_partyId_fkey" FOREIGN KEY ("tenantId", "partyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DistributorNotice" ADD CONSTRAINT "DistributorNotice_tenantId_partyId_linkId_fkey" FOREIGN KEY ("tenantId", "partyId", "linkId") REFERENCES "OneOffLink"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AuthorityRequest" ADD CONSTRAINT "AuthorityRequest_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AuthorityRequest" ADD CONSTRAINT "AuthorityRequest_tenantId_styleId_fkey" FOREIGN KEY ("tenantId", "styleId") REFERENCES "Style"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AuthorityRequest" ADD CONSTRAINT "AuthorityRequest_tenantId_companyId_registerEntryId_fkey" FOREIGN KEY ("tenantId", "companyId", "registerEntryId") REFERENCES "PpeRegisterEntry"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SustainabilityClaim" ADD CONSTRAINT "SustainabilityClaim_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SustainabilityClaim" ADD CONSTRAINT "SustainabilityClaim_tenantId_styleId_fkey" FOREIGN KEY ("tenantId", "styleId") REFERENCES "Style"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SustainabilityClaim" ADD CONSTRAINT "SustainabilityClaim_tenantId_itemId_fkey" FOREIGN KEY ("tenantId", "itemId") REFERENCES "Item"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SustainabilityClaim" ADD CONSTRAINT "SustainabilityClaim_tenantId_companyId_supersedesId_fkey" FOREIGN KEY ("tenantId", "companyId", "supersedesId") REFERENCES "SustainabilityClaim"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ClaimUse" ADD CONSTRAINT "ClaimUse_tenantId_claimId_fkey" FOREIGN KEY ("tenantId", "claimId") REFERENCES "SustainabilityClaim"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

