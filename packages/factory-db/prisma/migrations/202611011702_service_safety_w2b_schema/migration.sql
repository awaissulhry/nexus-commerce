-- CreateEnum
CREATE TYPE "ReturnPolicyChannel" AS ENUM ('B2B', 'CONSUMER_DISTANCE');

-- CreateEnum
CREATE TYPE "ReturnFeeKind" AS ENUM ('PERCENT', 'AMOUNT');

-- CreateEnum
CREATE TYPE "ReturnFinishReason" AS ENUM ('COMPLETED', 'CREDITED_WITHOUT_RETURN', 'RETURNED_UNCHANGED', 'GOODS_NOT_RECEIVED', 'CUSTOMER_WITHDREW', 'OTHER');

-- CreateEnum
CREATE TYPE "RepairEstimateStatus" AS ENUM ('DRAFT', 'SENT', 'ACCEPTED', 'DECLINED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "RepairEstimateAnswerVia" AS ENUM ('LINK', 'PORTAL', 'OFFICE');

-- CreateEnum
CREATE TYPE "RepairEstimateLineKind" AS ENUM ('PART', 'LABOUR');

-- CreateEnum
CREATE TYPE "ServiceCaseKind" AS ENUM ('WARRANTY', 'COMPLAINT', 'REPAIR', 'QUESTION', 'SAFETY');

-- CreateEnum
CREATE TYPE "ServiceCaseChannel" AS ENUM ('OFFICE', 'MAIL', 'PHONE', 'PORTAL', 'LINK');

-- CreateEnum
CREATE TYPE "ServiceCaseWish" AS ENUM ('REPAIR', 'REPLACE', 'CREDIT', 'ANSWER');

-- CreateEnum
CREATE TYPE "ServiceCasePriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "ServiceCaseStatus" AS ENUM ('NEW', 'OPEN', 'WAITING_CUSTOMER', 'WAITING_PART', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "ServiceCover" AS ENUM ('LEGAL_GUARANTEE', 'FACTORY_GUARANTEE', 'NONE');

-- CreateEnum
CREATE TYPE "ServiceCoverDecision" AS ENUM ('COVERED', 'PARTLY', 'NOT_COVERED');

-- CreateEnum
CREATE TYPE "ProductSafetySource" AS ENUM ('PUBLIC_LINK', 'PORTAL', 'OFFICE', 'MAIL');

-- CreateEnum
CREATE TYPE "ProductSafetyReportStatus" AS ENUM ('NEW', 'ASSESSING', 'CLOSED');

-- CreateEnum
CREATE TYPE "AccidentOutcome" AS ENUM ('NO_HARM', 'MINOR_HARM', 'SERIOUS_HARM', 'DEATH', 'NOT_KNOWN');

-- AlterEnum
ALTER TYPE "FileCategory" ADD VALUE 'DAMAGE_PHOTO';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NumberKind" ADD VALUE 'SERVICE_CASE';
ALTER TYPE "NumberKind" ADD VALUE 'SAFETY_REPORT';

-- AlterEnum
ALTER TYPE "ReturnDisposition" ADD VALUE 'SIZE_EXCHANGE';

-- AlterTable
ALTER TABLE "RepairOrder" ADD COLUMN     "channel" "ReturnRequestChannel" NOT NULL DEFAULT 'OFFICE',
ADD COLUMN     "garmentSerial" TEXT,
ADD COLUMN     "workWanted" TEXT;

-- AlterTable
ALTER TABLE "ReturnAuthorisation" ADD COLUMN     "finishReason" "ReturnFinishReason",
ADD COLUMN     "policyId" UUID,
ADD COLUMN     "scanCode" TEXT,
ADD COLUMN     "withdrawal" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "ReturnLine" ADD COLUMN     "creditWithoutReturn" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "exchangeSize" TEXT,
ADD COLUMN     "feeAmount" INTEGER,
ADD COLUMN     "feeRuleId" UUID,
ADD COLUMN     "garmentBatch" TEXT,
ADD COLUMN     "garmentSerial" TEXT,
ADD COLUMN     "parentLineId" UUID;

-- CreateTable
CREATE TABLE "ReturnPolicy" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "channel" "ReturnPolicyChannel" NOT NULL,
    "name" TEXT NOT NULL,
    "windowDays" INTEGER NOT NULL,
    "goodsDueDays" INTEGER,
    "freightPaidBy" "ReturnFreightPayer" NOT NULL,
    "conditions" TEXT,
    "withdrawalWords" TEXT,
    "effectiveFrom" DATE NOT NULL,
    "retiredAt" TIMESTAMPTZ(3),
    "retiredById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,
    "updatedById" UUID,

    CONSTRAINT "ReturnPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReturnFeeRule" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "channel" "ReturnPolicyChannel",
    "name" TEXT NOT NULL,
    "reasonCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "kind" "ReturnFeeKind" NOT NULL,
    "percent" DECIMAL(7,4),
    "amount" INTEGER,
    "currency" TEXT,
    "sequence" INTEGER NOT NULL DEFAULT 100,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,
    "updatedById" UUID,

    CONSTRAINT "ReturnFeeRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RepairEstimate" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "repairId" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "status" "RepairEstimateStatus" NOT NULL DEFAULT 'DRAFT',
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "validUntil" DATE,
    "customerNote" TEXT,
    "internalNote" TEXT,
    "sentAt" TIMESTAMPTZ(3),
    "sentById" UUID,
    "answeredAt" TIMESTAMPTZ(3),
    "answeredVia" "RepairEstimateAnswerVia",
    "answeredByName" TEXT,
    "recordedById" UUID,
    "declineReason" TEXT,
    "withdrawnAt" TIMESTAMPTZ(3),
    "withdrawnById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "RepairEstimate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RepairEstimateLine" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "partyId" UUID NOT NULL,
    "estimateId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" "RepairEstimateLineKind" NOT NULL,
    "itemId" UUID,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "minutes" INTEGER,
    "unitPrice" DECIMAL(18,6) NOT NULL,
    "amount" INTEGER NOT NULL,
    "unitCost" DECIMAL(18,6),
    "costAmount" INTEGER,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "RepairEstimateLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceCase" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "kind" "ServiceCaseKind" NOT NULL,
    "channel" "ServiceCaseChannel" NOT NULL DEFAULT 'OFFICE',
    "partyId" UUID,
    "contactId" UUID,
    "serial" TEXT,
    "garmentSerial" TEXT,
    "batchNumber" TEXT,
    "garmentBatch" TEXT,
    "styleId" UUID,
    "colourwayId" UUID,
    "size" TEXT,
    "problem" TEXT NOT NULL,
    "customerWants" "ServiceCaseWish",
    "priority" "ServiceCasePriority" NOT NULL DEFAULT 'NORMAL',
    "status" "ServiceCaseStatus" NOT NULL DEFAULT 'NEW',
    "deliveredOn" DATE,
    "legalGuaranteeEndsOn" DATE,
    "factoryGuaranteeEndsOn" DATE,
    "cover" "ServiceCover",
    "coverDecision" "ServiceCoverDecision",
    "coverNote" TEXT,
    "coverDecidedAt" TIMESTAMPTZ(3),
    "coverDecidedById" UUID,
    "notifyCustomer" BOOLEAN NOT NULL DEFAULT false,
    "ownerId" UUID,
    "resolvedAt" TIMESTAMPTZ(3),
    "resolution" TEXT,
    "closedAt" TIMESTAMPTZ(3),
    "closedById" UUID,
    "closeReason" TEXT,
    "internalNote" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "ServiceCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceCaseLink" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "caseId" UUID NOT NULL,
    "recordType" TEXT NOT NULL,
    "recordId" UUID NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "ServiceCaseLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductSafetyReport" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "source" "ProductSafetySource" NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL,
    "partyId" UUID,
    "contactId" UUID,
    "reporterName" TEXT,
    "reporterEmail" TEXT,
    "reporterPhone" TEXT,
    "styleId" UUID,
    "colourwayId" UUID,
    "size" TEXT,
    "serial" TEXT,
    "garmentSerial" TEXT,
    "batchNumber" TEXT,
    "garmentBatch" TEXT,
    "occurredOn" DATE,
    "whatHappened" TEXT NOT NULL,
    "wornAsIntended" BOOLEAN,
    "status" "ProductSafetyReportStatus" NOT NULL DEFAULT 'NEW',
    "seenAt" TIMESTAMPTZ(3),
    "seenById" UUID,
    "ownerId" UUID,
    "serviceCaseId" UUID,
    "registerEntryId" UUID,
    "closedAt" TIMESTAMPTZ(3),
    "closedById" UUID,
    "closeNote" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "ProductSafetyReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductSafetyInjury" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "reportId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "injured" BOOLEAN NOT NULL,
    "consentAt" TIMESTAMPTZ(3),
    "injuryWords" TEXT,
    "erasedAt" TIMESTAMPTZ(3),
    "erasedById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "ProductSafetyInjury_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccidentLogEntry" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "reportId" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "occurredOn" DATE NOT NULL,
    "place" TEXT NOT NULL,
    "styleId" UUID,
    "serial" TEXT,
    "batchNumber" TEXT,
    "outcome" "AccidentOutcome" NOT NULL,
    "authorityToldAt" TIMESTAMPTZ(3),
    "authorityToldById" UUID,
    "authorityReference" TEXT,
    "authorityNoticeId" UUID,
    "note" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "AccidentLogEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReturnPolicy_tenantId_companyId_channel_idx" ON "ReturnPolicy"("tenantId", "companyId", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "ReturnPolicy_tenantId_companyId_id_key" ON "ReturnPolicy"("tenantId", "companyId", "id");

-- CreateIndex
CREATE INDEX "ReturnFeeRule_tenantId_companyId_active_idx" ON "ReturnFeeRule"("tenantId", "companyId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "ReturnFeeRule_tenantId_id_key" ON "ReturnFeeRule"("tenantId", "id");

-- CreateIndex
CREATE INDEX "RepairEstimate_tenantId_status_idx" ON "RepairEstimate"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "RepairEstimate_tenantId_repairId_revision_key" ON "RepairEstimate"("tenantId", "repairId", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "RepairEstimate_tenantId_partyId_id_key" ON "RepairEstimate"("tenantId", "partyId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "RepairEstimateLine_tenantId_estimateId_seq_key" ON "RepairEstimateLine"("tenantId", "estimateId", "seq");

-- CreateIndex
CREATE INDEX "ServiceCase_tenantId_status_idx" ON "ServiceCase"("tenantId", "status");

-- CreateIndex
CREATE INDEX "ServiceCase_tenantId_partyId_idx" ON "ServiceCase"("tenantId", "partyId");

-- CreateIndex
CREATE INDEX "ServiceCase_tenantId_garmentSerial_idx" ON "ServiceCase"("tenantId", "garmentSerial");

-- CreateIndex
CREATE INDEX "ServiceCase_tenantId_garmentBatch_idx" ON "ServiceCase"("tenantId", "garmentBatch");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceCase_tenantId_companyId_number_key" ON "ServiceCase"("tenantId", "companyId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceCase_tenantId_id_key" ON "ServiceCase"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceCase_tenantId_companyId_id_key" ON "ServiceCase"("tenantId", "companyId", "id");

-- CreateIndex
CREATE INDEX "ServiceCaseLink_tenantId_caseId_idx" ON "ServiceCaseLink"("tenantId", "caseId");

-- CreateIndex
CREATE INDEX "ServiceCaseLink_tenantId_recordType_recordId_idx" ON "ServiceCaseLink"("tenantId", "recordType", "recordId");

-- CreateIndex
CREATE INDEX "ProductSafetyReport_tenantId_status_idx" ON "ProductSafetyReport"("tenantId", "status");

-- CreateIndex
CREATE INDEX "ProductSafetyReport_tenantId_garmentSerial_idx" ON "ProductSafetyReport"("tenantId", "garmentSerial");

-- CreateIndex
CREATE INDEX "ProductSafetyReport_tenantId_garmentBatch_idx" ON "ProductSafetyReport"("tenantId", "garmentBatch");

-- CreateIndex
CREATE INDEX "ProductSafetyReport_tenantId_styleId_idx" ON "ProductSafetyReport"("tenantId", "styleId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductSafetyReport_tenantId_companyId_number_key" ON "ProductSafetyReport"("tenantId", "companyId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "ProductSafetyReport_tenantId_companyId_id_key" ON "ProductSafetyReport"("tenantId", "companyId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ProductSafetyInjury_tenantId_key_key" ON "ProductSafetyInjury"("tenantId", "key");

-- CreateIndex
CREATE INDEX "AccidentLogEntry_tenantId_occurredOn_idx" ON "AccidentLogEntry"("tenantId", "occurredOn");

-- CreateIndex
CREATE UNIQUE INDEX "AccidentLogEntry_tenantId_reportId_revision_key" ON "AccidentLogEntry"("tenantId", "reportId", "revision");

-- CreateIndex
CREATE INDEX "RepairOrder_tenantId_garmentSerial_idx" ON "RepairOrder"("tenantId", "garmentSerial");

-- CreateIndex
CREATE UNIQUE INDEX "ReturnAuthorisation_tenantId_scanCode_key" ON "ReturnAuthorisation"("tenantId", "scanCode");

-- CreateIndex
CREATE INDEX "ReturnLine_tenantId_garmentSerial_idx" ON "ReturnLine"("tenantId", "garmentSerial");

-- CreateIndex
CREATE INDEX "ReturnLine_tenantId_garmentBatch_idx" ON "ReturnLine"("tenantId", "garmentBatch");

-- CreateIndex
CREATE UNIQUE INDEX "ReturnLine_tenantId_returnId_id_key" ON "ReturnLine"("tenantId", "returnId", "id");

-- AddForeignKey
ALTER TABLE "ReturnAuthorisation" ADD CONSTRAINT "ReturnAuthorisation_tenantId_companyId_policyId_fkey" FOREIGN KEY ("tenantId", "companyId", "policyId") REFERENCES "ReturnPolicy"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ReturnLine" ADD CONSTRAINT "ReturnLine_tenantId_garmentSerial_fkey" FOREIGN KEY ("tenantId", "garmentSerial") REFERENCES "GarmentSerial"("tenantId", "serial") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ReturnLine" ADD CONSTRAINT "ReturnLine_tenantId_garmentBatch_fkey" FOREIGN KEY ("tenantId", "garmentBatch") REFERENCES "WorkOrder"("tenantId", "batchNumber") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ReturnLine" ADD CONSTRAINT "ReturnLine_tenantId_returnId_parentLineId_fkey" FOREIGN KEY ("tenantId", "returnId", "parentLineId") REFERENCES "ReturnLine"("tenantId", "returnId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ReturnLine" ADD CONSTRAINT "ReturnLine_tenantId_feeRuleId_fkey" FOREIGN KEY ("tenantId", "feeRuleId") REFERENCES "ReturnFeeRule"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RepairOrder" ADD CONSTRAINT "RepairOrder_tenantId_garmentSerial_fkey" FOREIGN KEY ("tenantId", "garmentSerial") REFERENCES "GarmentSerial"("tenantId", "serial") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ReturnPolicy" ADD CONSTRAINT "ReturnPolicy_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ReturnFeeRule" ADD CONSTRAINT "ReturnFeeRule_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RepairEstimate" ADD CONSTRAINT "RepairEstimate_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RepairEstimate" ADD CONSTRAINT "RepairEstimate_tenantId_partyId_fkey" FOREIGN KEY ("tenantId", "partyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RepairEstimate" ADD CONSTRAINT "RepairEstimate_tenantId_siteId_repairId_fkey" FOREIGN KEY ("tenantId", "siteId", "repairId") REFERENCES "RepairOrder"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RepairEstimateLine" ADD CONSTRAINT "RepairEstimateLine_tenantId_partyId_estimateId_fkey" FOREIGN KEY ("tenantId", "partyId", "estimateId") REFERENCES "RepairEstimate"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RepairEstimateLine" ADD CONSTRAINT "RepairEstimateLine_tenantId_itemId_fkey" FOREIGN KEY ("tenantId", "itemId") REFERENCES "Item"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ServiceCase" ADD CONSTRAINT "ServiceCase_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ServiceCase" ADD CONSTRAINT "ServiceCase_tenantId_partyId_fkey" FOREIGN KEY ("tenantId", "partyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ServiceCase" ADD CONSTRAINT "ServiceCase_tenantId_partyId_contactId_fkey" FOREIGN KEY ("tenantId", "partyId", "contactId") REFERENCES "PartyContact"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ServiceCase" ADD CONSTRAINT "ServiceCase_tenantId_styleId_fkey" FOREIGN KEY ("tenantId", "styleId") REFERENCES "Style"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ServiceCase" ADD CONSTRAINT "ServiceCase_tenantId_styleId_colourwayId_fkey" FOREIGN KEY ("tenantId", "styleId", "colourwayId") REFERENCES "Colourway"("tenantId", "styleId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ServiceCase" ADD CONSTRAINT "ServiceCase_tenantId_garmentSerial_fkey" FOREIGN KEY ("tenantId", "garmentSerial") REFERENCES "GarmentSerial"("tenantId", "serial") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ServiceCase" ADD CONSTRAINT "ServiceCase_tenantId_garmentBatch_fkey" FOREIGN KEY ("tenantId", "garmentBatch") REFERENCES "WorkOrder"("tenantId", "batchNumber") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ServiceCaseLink" ADD CONSTRAINT "ServiceCaseLink_tenantId_caseId_fkey" FOREIGN KEY ("tenantId", "caseId") REFERENCES "ServiceCase"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ProductSafetyReport" ADD CONSTRAINT "ProductSafetyReport_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ProductSafetyReport" ADD CONSTRAINT "ProductSafetyReport_tenantId_partyId_fkey" FOREIGN KEY ("tenantId", "partyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ProductSafetyReport" ADD CONSTRAINT "ProductSafetyReport_tenantId_partyId_contactId_fkey" FOREIGN KEY ("tenantId", "partyId", "contactId") REFERENCES "PartyContact"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ProductSafetyReport" ADD CONSTRAINT "ProductSafetyReport_tenantId_styleId_fkey" FOREIGN KEY ("tenantId", "styleId") REFERENCES "Style"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ProductSafetyReport" ADD CONSTRAINT "ProductSafetyReport_tenantId_styleId_colourwayId_fkey" FOREIGN KEY ("tenantId", "styleId", "colourwayId") REFERENCES "Colourway"("tenantId", "styleId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ProductSafetyReport" ADD CONSTRAINT "ProductSafetyReport_tenantId_garmentSerial_fkey" FOREIGN KEY ("tenantId", "garmentSerial") REFERENCES "GarmentSerial"("tenantId", "serial") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ProductSafetyReport" ADD CONSTRAINT "ProductSafetyReport_tenantId_garmentBatch_fkey" FOREIGN KEY ("tenantId", "garmentBatch") REFERENCES "WorkOrder"("tenantId", "batchNumber") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ProductSafetyReport" ADD CONSTRAINT "ProductSafetyReport_tenantId_companyId_serviceCaseId_fkey" FOREIGN KEY ("tenantId", "companyId", "serviceCaseId") REFERENCES "ServiceCase"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ProductSafetyReport" ADD CONSTRAINT "ProductSafetyReport_tenantId_companyId_registerEntryId_fkey" FOREIGN KEY ("tenantId", "companyId", "registerEntryId") REFERENCES "PpeRegisterEntry"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ProductSafetyInjury" ADD CONSTRAINT "ProductSafetyInjury_tenantId_companyId_reportId_fkey" FOREIGN KEY ("tenantId", "companyId", "reportId") REFERENCES "ProductSafetyReport"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AccidentLogEntry" ADD CONSTRAINT "AccidentLogEntry_tenantId_companyId_reportId_fkey" FOREIGN KEY ("tenantId", "companyId", "reportId") REFERENCES "ProductSafetyReport"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AccidentLogEntry" ADD CONSTRAINT "AccidentLogEntry_tenantId_styleId_fkey" FOREIGN KEY ("tenantId", "styleId") REFERENCES "Style"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

