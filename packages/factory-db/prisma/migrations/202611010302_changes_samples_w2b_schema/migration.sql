-- CreateEnum
CREATE TYPE "ChangeRequestSource" AS ENUM ('OFFICE', 'FLOOR', 'CUSTOMER', 'SAMPLE', 'SUPPLIER');

-- CreateEnum
CREATE TYPE "ChangeRequestStatus" AS ENUM ('OPEN', 'IN_REVIEW', 'ACCEPTED', 'REJECTED', 'DONE');

-- CreateEnum
CREATE TYPE "ChangePriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "ChangeEffect" AS ENUM ('NEXT_ORDER', 'DATE', 'AT_ONCE');

-- CreateEnum
CREATE TYPE "ChangeOrderStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'RELEASED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ChangeItemKind" AS ENUM ('CHANGE', 'WORK_IN_PROGRESS');

-- CreateEnum
CREATE TYPE "WipDisposition" AS ENUM ('FINISH_OLD', 'REWORK', 'SCRAP', 'HOLD');

-- CreateEnum
CREATE TYPE "ChangeDecision" AS ENUM ('APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "SampleKind" AS ENUM ('PROTO', 'FIT', 'SALESMAN', 'PRE_PRODUCTION', 'CERTIFICATION', 'BRAND');

-- CreateEnum
CREATE TYPE "SampleStage" AS ENUM ('REQUESTED', 'IN_MAKING', 'SENT', 'UNDER_REVIEW', 'DECIDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SampleDecision" AS ENUM ('APPROVED', 'APPROVED_WITH_COMMENTS', 'REJECTED');

-- CreateEnum
CREATE TYPE "SampleDecisionVia" AS ENUM ('OFFICE', 'PORTAL', 'LINK');

-- CreateEnum
CREATE TYPE "SampleTestResult" AS ENUM ('PASSED', 'FAILED');

-- CreateEnum
CREATE TYPE "SwatchKind" AS ENUM ('COLOUR', 'LEATHER');

-- CreateEnum
CREATE TYPE "SampleShipmentDirection" AS ENUM ('OUTBOUND', 'RETURN');

-- CreateEnum
CREATE TYPE "GateKind" AS ENUM ('SAMPLE_APPROVED', 'LEATHER_APPROVED', 'TRIMS_IN', 'PP_SAMPLE', 'LAB_PASSED', 'OTHER');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NumberKind" ADD VALUE 'CHANGE_REQUEST';
ALTER TYPE "NumberKind" ADD VALUE 'CHANGE_ORDER';
ALTER TYPE "NumberKind" ADD VALUE 'SAMPLE_ROUND';

-- AlterEnum
ALTER TYPE "WorkOrderKind" ADD VALUE 'SAMPLE';

-- AlterTable
ALTER TABLE "StyleRevision" ADD COLUMN     "completenessPct" DECIMAL(5,2),
ADD COLUMN     "releasedColourwayIds" UUID[] DEFAULT ARRAY[]::UUID[],
ADD COLUMN     "releasedSizes" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "WorkOrder" ADD COLUMN     "sampleRoundId" UUID;

-- CreateTable
CREATE TABLE "ChangeRequest" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID,
    "number" TEXT,
    "source" "ChangeRequestSource" NOT NULL,
    "partyId" UUID,
    "sampleRoundId" UUID,
    "styleId" UUID NOT NULL,
    "revisionId" UUID,
    "workOrderId" UUID,
    "title" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "priority" "ChangePriority" NOT NULL DEFAULT 'NORMAL',
    "status" "ChangeRequestStatus" NOT NULL DEFAULT 'OPEN',
    "decidedAt" TIMESTAMPTZ(3),
    "decidedById" UUID,
    "decisionNote" TEXT,
    "changeOrderId" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "ChangeRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChangeOrder" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "styleId" UUID NOT NULL,
    "fromRevisionId" UUID NOT NULL,
    "toRevisionId" UUID,
    "title" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "description" TEXT,
    "priority" "ChangePriority" NOT NULL DEFAULT 'NORMAL',
    "effect" "ChangeEffect" NOT NULL DEFAULT 'NEXT_ORDER',
    "effectiveDate" DATE,
    "status" "ChangeOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "authorId" UUID NOT NULL,
    "submittedAt" TIMESTAMPTZ(3),
    "decidedAt" TIMESTAMPTZ(3),
    "releasedAt" TIMESTAMPTZ(3),
    "releasedById" UUID,
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "ChangeOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChangeOrderItem" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "changeOrderId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" "ChangeItemKind" NOT NULL,
    "recordType" TEXT,
    "recordId" UUID,
    "field" TEXT,
    "before" JSONB,
    "after" JSONB,
    "siteId" UUID,
    "workOrderId" UUID,
    "disposition" "WipDisposition",
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "ChangeOrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChangeApproval" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "changeOrderId" UUID NOT NULL,
    "stage" INTEGER NOT NULL DEFAULT 1,
    "approverId" UUID NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "decision" "ChangeDecision",
    "decidedAt" TIMESTAMPTZ(3),
    "reason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "ChangeApproval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SampleRound" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "styleId" UUID NOT NULL,
    "revisionId" UUID NOT NULL,
    "kind" "SampleKind" NOT NULL,
    "roundNo" INTEGER NOT NULL DEFAULT 1,
    "partyId" UUID,
    "cells" JSONB NOT NULL,
    "dueDate" DATE,
    "stage" "SampleStage" NOT NULL DEFAULT 'REQUESTED',
    "instructions" TEXT,
    "chargeAmountMinor" INTEGER,
    "chargeCurrency" TEXT,
    "decision" "SampleDecision",
    "decisionComments" TEXT,
    "decidedAt" TIMESTAMPTZ(3),
    "decidedVia" "SampleDecisionVia",
    "decidedById" UUID,
    "approvalRequestId" UUID,
    "testZones" TEXT,
    "testResult" "SampleTestResult",
    "certificateId" UUID,
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "SampleRound_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SampleMeasurement" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "roundId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "pointOfMeasureId" UUID,
    "pomCode" TEXT NOT NULL,
    "pomName" TEXT,
    "size" TEXT NOT NULL,
    "nominal" DECIMAL(8,2) NOT NULL,
    "toleranceMinus" DECIMAL(8,2) NOT NULL,
    "tolerancePlus" DECIMAL(8,2) NOT NULL,
    "uom" "Uom" NOT NULL,
    "measured" DECIMAL(8,2),
    "measuredAt" TIMESTAMPTZ(3),
    "pass" BOOLEAN,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "SampleMeasurement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SampleComment" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "roundId" UUID NOT NULL,
    "pointOfMeasureId" UUID,
    "pomCode" TEXT,
    "bodyArea" TEXT,
    "text" TEXT NOT NULL,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "resolvedAt" TIMESTAMPTZ(3),
    "resolvedById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "SampleComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SampleSwatch" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "styleId" UUID NOT NULL,
    "roundId" UUID,
    "partyId" UUID NOT NULL,
    "kind" "SwatchKind" NOT NULL,
    "itemId" UUID NOT NULL,
    "itemColourId" UUID,
    "lotSiteId" UUID,
    "lotId" UUID,
    "note" TEXT,
    "sentAt" TIMESTAMPTZ(3),
    "approvalRequestId" UUID,
    "decision" "SampleDecision",
    "decisionComments" TEXT,
    "decidedAt" TIMESTAMPTZ(3),
    "decidedVia" "SampleDecisionVia",
    "decidedById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "SampleSwatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SampleShipment" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "roundId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "direction" "SampleShipmentDirection" NOT NULL DEFAULT 'OUTBOUND',
    "shipToAddressId" UUID,
    "carrierName" TEXT,
    "trackingNumber" TEXT,
    "trackingUrl" TEXT,
    "sentAt" TIMESTAMPTZ(3),
    "receivedAt" TIMESTAMPTZ(3),
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "SampleShipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderGate" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "salesOrderId" UUID NOT NULL,
    "kind" "GateKind" NOT NULL,
    "label" TEXT,
    "targetDate" DATE,
    "sampleRoundId" UUID,
    "ownerId" UUID,
    "passedAt" TIMESTAMPTZ(3),
    "passedById" UUID,
    "overriddenAt" TIMESTAMPTZ(3),
    "overriddenById" UUID,
    "overrideReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "OrderGate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChangeRequest_tenantId_companyId_status_idx" ON "ChangeRequest"("tenantId", "companyId", "status");

-- CreateIndex
CREATE INDEX "ChangeRequest_tenantId_styleId_idx" ON "ChangeRequest"("tenantId", "styleId");

-- CreateIndex
CREATE INDEX "ChangeRequest_tenantId_changeOrderId_idx" ON "ChangeRequest"("tenantId", "changeOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "ChangeRequest_tenantId_companyId_number_key" ON "ChangeRequest"("tenantId", "companyId", "number");

-- CreateIndex
CREATE INDEX "ChangeOrder_tenantId_companyId_status_idx" ON "ChangeOrder"("tenantId", "companyId", "status");

-- CreateIndex
CREATE INDEX "ChangeOrder_tenantId_styleId_idx" ON "ChangeOrder"("tenantId", "styleId");

-- CreateIndex
CREATE UNIQUE INDEX "ChangeOrder_tenantId_companyId_number_key" ON "ChangeOrder"("tenantId", "companyId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "ChangeOrder_tenantId_id_key" ON "ChangeOrder"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ChangeOrder_tenantId_styleId_id_key" ON "ChangeOrder"("tenantId", "styleId", "id");

-- CreateIndex
CREATE INDEX "ChangeOrderItem_tenantId_workOrderId_idx" ON "ChangeOrderItem"("tenantId", "workOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "ChangeOrderItem_tenantId_changeOrderId_seq_key" ON "ChangeOrderItem"("tenantId", "changeOrderId", "seq");

-- CreateIndex
CREATE INDEX "ChangeApproval_tenantId_approverId_idx" ON "ChangeApproval"("tenantId", "approverId");

-- CreateIndex
CREATE UNIQUE INDEX "ChangeApproval_tenantId_changeOrderId_stage_approverId_key" ON "ChangeApproval"("tenantId", "changeOrderId", "stage", "approverId");

-- CreateIndex
CREATE INDEX "SampleRound_tenantId_stage_dueDate_idx" ON "SampleRound"("tenantId", "stage", "dueDate");

-- CreateIndex
CREATE INDEX "SampleRound_tenantId_partyId_idx" ON "SampleRound"("tenantId", "partyId");

-- CreateIndex
CREATE INDEX "SampleRound_tenantId_styleId_idx" ON "SampleRound"("tenantId", "styleId");

-- CreateIndex
CREATE UNIQUE INDEX "SampleRound_tenantId_companyId_number_key" ON "SampleRound"("tenantId", "companyId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "SampleRound_tenantId_id_key" ON "SampleRound"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SampleRound_tenantId_styleId_id_key" ON "SampleRound"("tenantId", "styleId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SampleMeasurement_tenantId_roundId_pomCode_size_key" ON "SampleMeasurement"("tenantId", "roundId", "pomCode", "size");

-- CreateIndex
CREATE INDEX "SampleComment_tenantId_roundId_idx" ON "SampleComment"("tenantId", "roundId");

-- CreateIndex
CREATE INDEX "SampleSwatch_tenantId_styleId_idx" ON "SampleSwatch"("tenantId", "styleId");

-- CreateIndex
CREATE INDEX "SampleSwatch_tenantId_roundId_idx" ON "SampleSwatch"("tenantId", "roundId");

-- CreateIndex
CREATE INDEX "SampleSwatch_tenantId_partyId_idx" ON "SampleSwatch"("tenantId", "partyId");

-- CreateIndex
CREATE INDEX "SampleShipment_tenantId_roundId_idx" ON "SampleShipment"("tenantId", "roundId");

-- CreateIndex
CREATE INDEX "SampleShipment_tenantId_partyId_idx" ON "SampleShipment"("tenantId", "partyId");

-- CreateIndex
CREATE INDEX "OrderGate_tenantId_salesOrderId_idx" ON "OrderGate"("tenantId", "salesOrderId");

-- CreateIndex
CREATE INDEX "OrderGate_tenantId_sampleRoundId_idx" ON "OrderGate"("tenantId", "sampleRoundId");

-- AddForeignKey
ALTER TABLE "ChangeRequest" ADD CONSTRAINT "ChangeRequest_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ChangeRequest" ADD CONSTRAINT "ChangeRequest_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ChangeRequest" ADD CONSTRAINT "ChangeRequest_tenantId_partyId_fkey" FOREIGN KEY ("tenantId", "partyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ChangeRequest" ADD CONSTRAINT "ChangeRequest_tenantId_styleId_sampleRoundId_fkey" FOREIGN KEY ("tenantId", "styleId", "sampleRoundId") REFERENCES "SampleRound"("tenantId", "styleId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ChangeRequest" ADD CONSTRAINT "ChangeRequest_tenantId_styleId_fkey" FOREIGN KEY ("tenantId", "styleId") REFERENCES "Style"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ChangeRequest" ADD CONSTRAINT "ChangeRequest_tenantId_styleId_revisionId_fkey" FOREIGN KEY ("tenantId", "styleId", "revisionId") REFERENCES "StyleRevision"("tenantId", "styleId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ChangeRequest" ADD CONSTRAINT "ChangeRequest_tenantId_siteId_workOrderId_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId") REFERENCES "WorkOrder"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ChangeRequest" ADD CONSTRAINT "ChangeRequest_tenantId_styleId_changeOrderId_fkey" FOREIGN KEY ("tenantId", "styleId", "changeOrderId") REFERENCES "ChangeOrder"("tenantId", "styleId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ChangeOrder" ADD CONSTRAINT "ChangeOrder_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ChangeOrder" ADD CONSTRAINT "ChangeOrder_tenantId_styleId_fkey" FOREIGN KEY ("tenantId", "styleId") REFERENCES "Style"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ChangeOrder" ADD CONSTRAINT "ChangeOrder_tenantId_styleId_fromRevisionId_fkey" FOREIGN KEY ("tenantId", "styleId", "fromRevisionId") REFERENCES "StyleRevision"("tenantId", "styleId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ChangeOrder" ADD CONSTRAINT "ChangeOrder_tenantId_styleId_toRevisionId_fkey" FOREIGN KEY ("tenantId", "styleId", "toRevisionId") REFERENCES "StyleRevision"("tenantId", "styleId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ChangeOrderItem" ADD CONSTRAINT "ChangeOrderItem_tenantId_changeOrderId_fkey" FOREIGN KEY ("tenantId", "changeOrderId") REFERENCES "ChangeOrder"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ChangeOrderItem" ADD CONSTRAINT "ChangeOrderItem_tenantId_siteId_workOrderId_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId") REFERENCES "WorkOrder"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ChangeApproval" ADD CONSTRAINT "ChangeApproval_tenantId_changeOrderId_fkey" FOREIGN KEY ("tenantId", "changeOrderId") REFERENCES "ChangeOrder"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkOrder" ADD CONSTRAINT "WorkOrder_tenantId_styleId_sampleRoundId_fkey" FOREIGN KEY ("tenantId", "styleId", "sampleRoundId") REFERENCES "SampleRound"("tenantId", "styleId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SampleRound" ADD CONSTRAINT "SampleRound_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SampleRound" ADD CONSTRAINT "SampleRound_tenantId_styleId_fkey" FOREIGN KEY ("tenantId", "styleId") REFERENCES "Style"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SampleRound" ADD CONSTRAINT "SampleRound_tenantId_styleId_revisionId_fkey" FOREIGN KEY ("tenantId", "styleId", "revisionId") REFERENCES "StyleRevision"("tenantId", "styleId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SampleRound" ADD CONSTRAINT "SampleRound_tenantId_partyId_fkey" FOREIGN KEY ("tenantId", "partyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SampleRound" ADD CONSTRAINT "SampleRound_tenantId_partyId_approvalRequestId_fkey" FOREIGN KEY ("tenantId", "partyId", "approvalRequestId") REFERENCES "ApprovalRequest"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SampleRound" ADD CONSTRAINT "SampleRound_tenantId_certificateId_fkey" FOREIGN KEY ("tenantId", "certificateId") REFERENCES "Certificate"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SampleMeasurement" ADD CONSTRAINT "SampleMeasurement_tenantId_roundId_fkey" FOREIGN KEY ("tenantId", "roundId") REFERENCES "SampleRound"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SampleComment" ADD CONSTRAINT "SampleComment_tenantId_roundId_fkey" FOREIGN KEY ("tenantId", "roundId") REFERENCES "SampleRound"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SampleSwatch" ADD CONSTRAINT "SampleSwatch_tenantId_styleId_fkey" FOREIGN KEY ("tenantId", "styleId") REFERENCES "Style"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SampleSwatch" ADD CONSTRAINT "SampleSwatch_tenantId_styleId_roundId_fkey" FOREIGN KEY ("tenantId", "styleId", "roundId") REFERENCES "SampleRound"("tenantId", "styleId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SampleSwatch" ADD CONSTRAINT "SampleSwatch_tenantId_partyId_fkey" FOREIGN KEY ("tenantId", "partyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SampleSwatch" ADD CONSTRAINT "SampleSwatch_tenantId_itemId_fkey" FOREIGN KEY ("tenantId", "itemId") REFERENCES "Item"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SampleSwatch" ADD CONSTRAINT "SampleSwatch_tenantId_itemId_itemColourId_fkey" FOREIGN KEY ("tenantId", "itemId", "itemColourId") REFERENCES "ItemColour"("tenantId", "itemId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SampleSwatch" ADD CONSTRAINT "SampleSwatch_tenantId_lotSiteId_itemId_lotId_fkey" FOREIGN KEY ("tenantId", "lotSiteId", "itemId", "lotId") REFERENCES "Lot"("tenantId", "siteId", "itemId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SampleSwatch" ADD CONSTRAINT "SampleSwatch_tenantId_partyId_approvalRequestId_fkey" FOREIGN KEY ("tenantId", "partyId", "approvalRequestId") REFERENCES "ApprovalRequest"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SampleShipment" ADD CONSTRAINT "SampleShipment_tenantId_roundId_fkey" FOREIGN KEY ("tenantId", "roundId") REFERENCES "SampleRound"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SampleShipment" ADD CONSTRAINT "SampleShipment_tenantId_partyId_fkey" FOREIGN KEY ("tenantId", "partyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SampleShipment" ADD CONSTRAINT "SampleShipment_tenantId_partyId_shipToAddressId_fkey" FOREIGN KEY ("tenantId", "partyId", "shipToAddressId") REFERENCES "PartyAddress"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OrderGate" ADD CONSTRAINT "OrderGate_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OrderGate" ADD CONSTRAINT "OrderGate_tenantId_partyId_fkey" FOREIGN KEY ("tenantId", "partyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OrderGate" ADD CONSTRAINT "OrderGate_tenantId_companyId_partyId_salesOrderId_fkey" FOREIGN KEY ("tenantId", "companyId", "partyId", "salesOrderId") REFERENCES "SalesOrder"("tenantId", "companyId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OrderGate" ADD CONSTRAINT "OrderGate_tenantId_sampleRoundId_fkey" FOREIGN KEY ("tenantId", "sampleRoundId") REFERENCES "SampleRound"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

