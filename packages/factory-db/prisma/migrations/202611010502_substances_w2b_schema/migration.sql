-- CreateEnum
CREATE TYPE "RestrictedSubstanceList" AS ENUM ('REACH_ANNEX_XVII', 'SVHC', 'POPS', 'AFIRM_RSL', 'CUSTOMER_RSL');

-- CreateEnum
CREATE TYPE "SubstanceRuleCode" AS ENUM ('AZO', 'NICKEL', 'PAH', 'DMFU', 'NPE', 'CMR', 'PFAS', 'CR6', 'OTHER');

-- CreateEnum
CREATE TYPE "SubstanceRuleSource" AS ENUM ('LAW', 'INDUSTRY', 'CUSTOMER');

-- CreateEnum
CREATE TYPE "SubstanceUnit" AS ENUM ('MG_KG', 'UG_KG', 'PERCENT_WW', 'UG_CM2_WEEK', 'UG_M2');

-- CreateEnum
CREATE TYPE "SubstanceLimitBound" AS ENUM ('BELOW', 'AT_MOST');

-- CreateEnum
CREATE TYPE "SubstanceEvidence" AS ENUM ('TEST', 'DECLARATION', 'EITHER');

-- CreateEnum
CREATE TYPE "MaterialComplianceState" AS ENUM ('INCOMPLETE', 'COMPLETE', 'BLOCKED');

-- CreateEnum
CREATE TYPE "SupplierDeclarationKind" AS ENUM ('REACH_SVHC', 'RSL', 'PFAS', 'NICKEL', 'CR6', 'OTHER');

-- CreateEnum
CREATE TYPE "SupplierDeclarationChannel" AS ENUM ('PORTAL', 'LINK', 'OFFICE');

-- CreateEnum
CREATE TYPE "SupplierDeclarationStatus" AS ENUM ('SENT', 'ANSWERED', 'ACCEPTED', 'REFUSED', 'OVERDUE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TestFrequency" AS ENUM ('EVERY_LOT', 'FIRST_LOT', 'YEARLY', 'ON_CHANGE');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "LabTest" ADD VALUE 'AZO';
ALTER TYPE "LabTest" ADD VALUE 'NICKEL';
ALTER TYPE "LabTest" ADD VALUE 'PAH';
ALTER TYPE "LabTest" ADD VALUE 'DMFU';
ALTER TYPE "LabTest" ADD VALUE 'NPE';
ALTER TYPE "LabTest" ADD VALUE 'PFAS';

-- AlterEnum
ALTER TYPE "NumberKind" ADD VALUE 'SUPPLIER_DECLARATION';

-- CreateTable
CREATE TABLE "RestrictedSubstance" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID,
    "casNumber" TEXT,
    "ecNumber" TEXT,
    "name" TEXT NOT NULL,
    "nameI18n" JSONB,
    "groupCode" TEXT,
    "lists" "RestrictedSubstanceList"[],
    "annexXviiEntries" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "svhcListVersionId" UUID,
    "note" TEXT,
    "status" "MasterStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "RestrictedSubstance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubstanceRule" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID,
    "key" TEXT NOT NULL,
    "code" "SubstanceRuleCode" NOT NULL,
    "name" TEXT NOT NULL,
    "nameI18n" JSONB,
    "substanceId" UUID,
    "substanceGroup" TEXT,
    "materialKinds" "ItemKind"[] DEFAULT ARRAY[]::"ItemKind"[],
    "productTypes" "ProductType"[] DEFAULT ARRAY[]::"ProductType"[],
    "marketCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "scopeNote" TEXT,
    "limitValue" DECIMAL(18,6),
    "limitUnit" "SubstanceUnit",
    "limitBound" "SubstanceLimitBound",
    "testMethod" TEXT,
    "evidence" "SubstanceEvidence" NOT NULL,
    "exemptPpe" BOOLEAN NOT NULL DEFAULT false,
    "exemptNaturalLeather" BOOLEAN NOT NULL DEFAULT false,
    "source" "SubstanceRuleSource" NOT NULL DEFAULT 'LAW',
    "customerPartyId" UUID,
    "legalReference" TEXT NOT NULL,
    "legalUrl" TEXT,
    "switchedOn" BOOLEAN NOT NULL DEFAULT true,
    "offReason" TEXT,
    "switchedAt" TIMESTAMPTZ(3),
    "switchedById" UUID,
    "note" TEXT,
    "status" "MasterStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "SubstanceRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SvhcListVersion" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "publishedOn" DATE NOT NULL,
    "entryCount" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "SvhcListVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaterialComplianceProfile" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "itemId" UUID NOT NULL,
    "compositionConfirmedAt" TIMESTAMPTZ(3),
    "compositionConfirmedById" UUID,
    "tannageConfirmedAt" TIMESTAMPTZ(3),
    "tannageConfirmedById" UUID,
    "originCountry" TEXT,
    "svhcAboveThreshold" BOOLEAN,
    "svhcListVersionId" UUID,
    "svhcSubstanceIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "applicableRuleIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "testsNeeded" "LabTest"[] DEFAULT ARRAY[]::"LabTest"[],
    "declarationsNeeded" "SupplierDeclarationKind"[] DEFAULT ARRAY[]::"SupplierDeclarationKind"[],
    "evaluatedAt" TIMESTAMPTZ(3),
    "state" "MaterialComplianceState" NOT NULL DEFAULT 'INCOMPLETE',
    "stateReason" TEXT,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "MaterialComplianceProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierDeclarationRequest" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "partyId" UUID NOT NULL,
    "kind" "SupplierDeclarationKind" NOT NULL,
    "svhcListVersionId" UUID,
    "channel" "SupplierDeclarationChannel" NOT NULL,
    "partnerTaskId" UUID,
    "linkId" UUID,
    "message" TEXT,
    "sentAt" TIMESTAMPTZ(3) NOT NULL,
    "dueOn" DATE NOT NULL,
    "reminderEveryDays" INTEGER,
    "remindersSent" INTEGER NOT NULL DEFAULT 0,
    "lastRemindedAt" TIMESTAMPTZ(3),
    "status" "SupplierDeclarationStatus" NOT NULL DEFAULT 'SENT',
    "answeredAt" TIMESTAMPTZ(3),
    "uploadId" UUID,
    "answerFileId" UUID,
    "answeredListVersionId" UUID,
    "validTo" DATE,
    "decidedAt" TIMESTAMPTZ(3),
    "decidedById" UUID,
    "decidedByName" TEXT,
    "refuseReason" TEXT,
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelReason" TEXT,
    "supersedesId" UUID,
    "internalNote" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "SupplierDeclarationRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierDeclarationLine" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "partyId" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "itemId" UUID NOT NULL,
    "articleLabel" TEXT NOT NULL,
    "contains" BOOLEAN,
    "aboveThreshold" BOOLEAN,
    "substanceId" UUID,
    "substanceName" TEXT,
    "concentration" DECIMAL(18,6),
    "concentrationUnit" "SubstanceUnit",
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "SupplierDeclarationLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TestPlanRule" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID,
    "itemKind" "ItemKind",
    "itemId" UUID,
    "test" "LabTest" NOT NULL,
    "frequency" "TestFrequency" NOT NULL,
    "marketCode" TEXT,
    "substanceRuleId" UUID,
    "method" TEXT,
    "switchedOn" BOOLEAN NOT NULL DEFAULT true,
    "offReason" TEXT,
    "switchedAt" TIMESTAMPTZ(3),
    "switchedById" UUID,
    "note" TEXT,
    "status" "MasterStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "TestPlanRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RestrictedSubstance_tenantId_groupCode_idx" ON "RestrictedSubstance"("tenantId", "groupCode");

-- CreateIndex
CREATE UNIQUE INDEX "RestrictedSubstance_tenantId_id_key" ON "RestrictedSubstance"("tenantId", "id");

-- CreateIndex
CREATE INDEX "SubstanceRule_tenantId_code_idx" ON "SubstanceRule"("tenantId", "code");

-- CreateIndex
CREATE INDEX "SubstanceRule_tenantId_customerPartyId_idx" ON "SubstanceRule"("tenantId", "customerPartyId");

-- CreateIndex
CREATE UNIQUE INDEX "SubstanceRule_tenantId_key_key" ON "SubstanceRule"("tenantId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "SubstanceRule_tenantId_id_key" ON "SubstanceRule"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SvhcListVersion_tenantId_publishedOn_key" ON "SvhcListVersion"("tenantId", "publishedOn");

-- CreateIndex
CREATE UNIQUE INDEX "SvhcListVersion_tenantId_id_key" ON "SvhcListVersion"("tenantId", "id");

-- CreateIndex
CREATE INDEX "MaterialComplianceProfile_tenantId_state_idx" ON "MaterialComplianceProfile"("tenantId", "state");

-- CreateIndex
CREATE INDEX "MaterialComplianceProfile_tenantId_itemId_idx" ON "MaterialComplianceProfile"("tenantId", "itemId");

-- CreateIndex
CREATE INDEX "SupplierDeclarationRequest_tenantId_partyId_status_idx" ON "SupplierDeclarationRequest"("tenantId", "partyId", "status");

-- CreateIndex
CREATE INDEX "SupplierDeclarationRequest_tenantId_status_dueOn_idx" ON "SupplierDeclarationRequest"("tenantId", "status", "dueOn");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierDeclarationRequest_tenantId_companyId_number_key" ON "SupplierDeclarationRequest"("tenantId", "companyId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierDeclarationRequest_tenantId_partyId_id_key" ON "SupplierDeclarationRequest"("tenantId", "partyId", "id");

-- CreateIndex
CREATE INDEX "SupplierDeclarationLine_tenantId_itemId_idx" ON "SupplierDeclarationLine"("tenantId", "itemId");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierDeclarationLine_tenantId_requestId_seq_key" ON "SupplierDeclarationLine"("tenantId", "requestId", "seq");

-- CreateIndex
CREATE INDEX "TestPlanRule_tenantId_itemKind_test_idx" ON "TestPlanRule"("tenantId", "itemKind", "test");

-- CreateIndex
CREATE INDEX "TestPlanRule_tenantId_itemId_idx" ON "TestPlanRule"("tenantId", "itemId");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierDocumentUpload_tenantId_partyId_id_key" ON "SupplierDocumentUpload"("tenantId", "partyId", "id");

-- AddForeignKey
ALTER TABLE "RestrictedSubstance" ADD CONSTRAINT "RestrictedSubstance_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RestrictedSubstance" ADD CONSTRAINT "RestrictedSubstance_tenantId_svhcListVersionId_fkey" FOREIGN KEY ("tenantId", "svhcListVersionId") REFERENCES "SvhcListVersion"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SubstanceRule" ADD CONSTRAINT "SubstanceRule_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SubstanceRule" ADD CONSTRAINT "SubstanceRule_tenantId_substanceId_fkey" FOREIGN KEY ("tenantId", "substanceId") REFERENCES "RestrictedSubstance"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SubstanceRule" ADD CONSTRAINT "SubstanceRule_tenantId_customerPartyId_fkey" FOREIGN KEY ("tenantId", "customerPartyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MaterialComplianceProfile" ADD CONSTRAINT "MaterialComplianceProfile_tenantId_itemId_fkey" FOREIGN KEY ("tenantId", "itemId") REFERENCES "Item"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MaterialComplianceProfile" ADD CONSTRAINT "MaterialComplianceProfile_tenantId_svhcListVersionId_fkey" FOREIGN KEY ("tenantId", "svhcListVersionId") REFERENCES "SvhcListVersion"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierDeclarationRequest" ADD CONSTRAINT "SupplierDeclarationRequest_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierDeclarationRequest" ADD CONSTRAINT "SupplierDeclarationRequest_tenantId_partyId_fkey" FOREIGN KEY ("tenantId", "partyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierDeclarationRequest" ADD CONSTRAINT "SupplierDeclarationRequest_tenantId_svhcListVersionId_fkey" FOREIGN KEY ("tenantId", "svhcListVersionId") REFERENCES "SvhcListVersion"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierDeclarationRequest" ADD CONSTRAINT "SupplierDeclarationRequest_tenantId_answeredListVersionId_fkey" FOREIGN KEY ("tenantId", "answeredListVersionId") REFERENCES "SvhcListVersion"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierDeclarationRequest" ADD CONSTRAINT "SupplierDeclarationRequest_tenantId_partyId_partnerTaskId_fkey" FOREIGN KEY ("tenantId", "partyId", "partnerTaskId") REFERENCES "PartnerTask"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierDeclarationRequest" ADD CONSTRAINT "SupplierDeclarationRequest_tenantId_partyId_linkId_fkey" FOREIGN KEY ("tenantId", "partyId", "linkId") REFERENCES "OneOffLink"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierDeclarationRequest" ADD CONSTRAINT "SupplierDeclarationRequest_tenantId_partyId_uploadId_fkey" FOREIGN KEY ("tenantId", "partyId", "uploadId") REFERENCES "SupplierDocumentUpload"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierDeclarationRequest" ADD CONSTRAINT "SupplierDeclarationRequest_tenantId_answerFileId_fkey" FOREIGN KEY ("tenantId", "answerFileId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierDeclarationRequest" ADD CONSTRAINT "SupplierDeclarationRequest_tenantId_partyId_supersedesId_fkey" FOREIGN KEY ("tenantId", "partyId", "supersedesId") REFERENCES "SupplierDeclarationRequest"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierDeclarationLine" ADD CONSTRAINT "SupplierDeclarationLine_tenantId_partyId_requestId_fkey" FOREIGN KEY ("tenantId", "partyId", "requestId") REFERENCES "SupplierDeclarationRequest"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierDeclarationLine" ADD CONSTRAINT "SupplierDeclarationLine_tenantId_itemId_fkey" FOREIGN KEY ("tenantId", "itemId") REFERENCES "Item"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierDeclarationLine" ADD CONSTRAINT "SupplierDeclarationLine_tenantId_substanceId_fkey" FOREIGN KEY ("tenantId", "substanceId") REFERENCES "RestrictedSubstance"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TestPlanRule" ADD CONSTRAINT "TestPlanRule_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TestPlanRule" ADD CONSTRAINT "TestPlanRule_tenantId_itemId_fkey" FOREIGN KEY ("tenantId", "itemId") REFERENCES "Item"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TestPlanRule" ADD CONSTRAINT "TestPlanRule_tenantId_substanceRuleId_fkey" FOREIGN KEY ("tenantId", "substanceRuleId") REFERENCES "SubstanceRule"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

