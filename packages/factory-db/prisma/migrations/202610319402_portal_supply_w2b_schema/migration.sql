-- CreateEnum
CREATE TYPE "ShipNoticeStatus" AS ENUM ('DRAFT', 'SENT', 'RECEIVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SubcontractReturnNoticeStatus" AS ENUM ('ANNOUNCED', 'RECEIVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SupplierQuestionnaireDecision" AS ENUM ('ACCEPTED', 'QUESTIONS');

-- AlterEnum
ALTER TYPE "NumberKind" ADD VALUE 'ASN';

-- AlterTable
ALTER TABLE "GoodsReceipt" ADD COLUMN     "shipNoticeId" UUID;

-- AlterTable
ALTER TABLE "PurchaseOrderLine" ADD COLUMN     "proposalNeedsBuyer" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "proposedSubstituteItemId" UUID,
ADD COLUMN     "proposedSubstituteNote" TEXT;

-- AlterTable
ALTER TABLE "SubcontractKitLine" ADD COLUMN     "receivedByWorkshopAt" TIMESTAMPTZ(3),
ADD COLUMN     "receivedByWorkshopNote" TEXT,
ADD COLUMN     "receivedByWorkshopQuantity" DECIMAL(18,4);

-- AlterTable
ALTER TABLE "SubcontractOrder" ADD COLUMN     "acceptedAt" TIMESTAMPTZ(3),
ADD COLUMN     "acceptedByName" TEXT,
ADD COLUMN     "declineReason" TEXT,
ADD COLUMN     "declinedAt" TIMESTAMPTZ(3),
ADD COLUMN     "declinedByName" TEXT,
ADD COLUMN     "proposedDate" DATE,
ADD COLUMN     "proposedDateDecidedAt" TIMESTAMPTZ(3),
ADD COLUMN     "proposedDateDecidedById" UUID,
ADD COLUMN     "proposedDateDecision" "PurchaseProposalDecision",
ADD COLUMN     "proposedDateReason" TEXT;

-- CreateTable
CREATE TABLE "ShipNotice" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "purchaseOrderId" UUID NOT NULL,
    "number" TEXT,
    "status" "ShipNoticeStatus" NOT NULL DEFAULT 'DRAFT',
    "supplierRef" TEXT,
    "ddtNumber" TEXT,
    "ddtDate" DATE,
    "shipDate" DATE,
    "expectedDate" DATE,
    "carrier" TEXT,
    "trackingNumber" TEXT,
    "parcels" INTEGER,
    "note" TEXT,
    "internalNote" TEXT,
    "sentAt" TIMESTAMPTZ(3),
    "receivedAt" TIMESTAMPTZ(3),
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "ShipNotice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShipNoticeLine" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "shipNoticeId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "purchaseOrderLineId" UUID NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "uom" "Uom" NOT NULL,
    "supplierLot" TEXT,
    "dyeBatch" TEXT,
    "note" TEXT,
    "receivedQuantity" DECIMAL(18,4),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "ShipNoticeLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShipNoticeHide" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "shipNoticeId" UUID NOT NULL,
    "shipNoticeLineId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "hideNumber" TEXT NOT NULL,
    "area" DECIMAL(18,4) NOT NULL,
    "areaUom" "Uom" NOT NULL,
    "grade" TEXT,
    "thicknessMm" DECIMAL(6,2),
    "dyeBatch" TEXT,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "ShipNoticeHide_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubcontractProgressReport" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "workOrderId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "subcontractOrderId" UUID NOT NULL,
    "subcontractOperationId" UUID NOT NULL,
    "bundleId" UUID,
    "workOrderSizeId" UUID,
    "finishedQuantity" INTEGER NOT NULL,
    "finishBy" DATE,
    "reportedAt" TIMESTAMPTZ(3) NOT NULL,
    "reportedByName" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "SubcontractProgressReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubcontractReturnNotice" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "workOrderId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "subcontractOrderId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "status" "SubcontractReturnNoticeStatus" NOT NULL DEFAULT 'ANNOUNCED',
    "quantities" JSONB NOT NULL,
    "materialBack" JSONB NOT NULL DEFAULT '[]',
    "parcels" INTEGER NOT NULL,
    "expectedDate" DATE NOT NULL,
    "weCollect" BOOLEAN NOT NULL DEFAULT false,
    "workshopDdtNumber" TEXT,
    "workshopDdtDate" DATE,
    "announcedByName" TEXT NOT NULL,
    "note" TEXT,
    "receiptId" UUID,
    "receivedAt" TIMESTAMPTZ(3),
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "SubcontractReturnNotice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierQuestionnaire" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "questions" JSONB NOT NULL,
    "publishedAt" TIMESTAMPTZ(3),
    "publishedById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "SupplierQuestionnaire_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierQuestionnaireResponse" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "questionnaireId" UUID NOT NULL,
    "linkId" UUID,
    "answers" JSONB NOT NULL,
    "sites" JSONB NOT NULL DEFAULT '[]',
    "subTierSites" JSONB NOT NULL DEFAULT '[]',
    "signedName" TEXT NOT NULL,
    "signedRole" TEXT,
    "submittedAt" TIMESTAMPTZ(3) NOT NULL,
    "decision" "SupplierQuestionnaireDecision",
    "reviewedAt" TIMESTAMPTZ(3),
    "reviewedById" UUID,
    "reviewNote" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "SupplierQuestionnaireResponse_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ShipNotice_tenantId_purchaseOrderId_idx" ON "ShipNotice"("tenantId", "purchaseOrderId");

-- CreateIndex
CREATE INDEX "ShipNotice_tenantId_siteId_status_expectedDate_idx" ON "ShipNotice"("tenantId", "siteId", "status", "expectedDate");

-- CreateIndex
CREATE UNIQUE INDEX "ShipNotice_tenantId_companyId_number_key" ON "ShipNotice"("tenantId", "companyId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "ShipNotice_tenantId_siteId_partyId_id_key" ON "ShipNotice"("tenantId", "siteId", "partyId", "id");

-- CreateIndex
CREATE INDEX "ShipNoticeLine_tenantId_purchaseOrderLineId_idx" ON "ShipNoticeLine"("tenantId", "purchaseOrderLineId");

-- CreateIndex
CREATE UNIQUE INDEX "ShipNoticeLine_tenantId_shipNoticeId_seq_key" ON "ShipNoticeLine"("tenantId", "shipNoticeId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "ShipNoticeLine_tenantId_siteId_partyId_shipNoticeId_id_key" ON "ShipNoticeLine"("tenantId", "siteId", "partyId", "shipNoticeId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ShipNoticeHide_tenantId_shipNoticeLineId_seq_key" ON "ShipNoticeHide"("tenantId", "shipNoticeLineId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "ShipNoticeHide_tenantId_shipNoticeId_hideNumber_key" ON "ShipNoticeHide"("tenantId", "shipNoticeId", "hideNumber");

-- CreateIndex
CREATE INDEX "SubcontractProgressReport_tenantId_subcontractOrderId_repor_idx" ON "SubcontractProgressReport"("tenantId", "subcontractOrderId", "reportedAt");

-- CreateIndex
CREATE INDEX "SubcontractProgressReport_tenantId_subcontractOperationId_idx" ON "SubcontractProgressReport"("tenantId", "subcontractOperationId");

-- CreateIndex
CREATE UNIQUE INDEX "SubcontractReturnNotice_tenantId_subcontractOrderId_seq_key" ON "SubcontractReturnNotice"("tenantId", "subcontractOrderId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierQuestionnaire_tenantId_companyId_revision_key" ON "SupplierQuestionnaire"("tenantId", "companyId", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierQuestionnaire_tenantId_companyId_id_key" ON "SupplierQuestionnaire"("tenantId", "companyId", "id");

-- CreateIndex
CREATE INDEX "SupplierQuestionnaireResponse_tenantId_partyId_submittedAt_idx" ON "SupplierQuestionnaireResponse"("tenantId", "partyId", "submittedAt");

-- CreateIndex
CREATE INDEX "SupplierQuestionnaireResponse_tenantId_questionnaireId_idx" ON "SupplierQuestionnaireResponse"("tenantId", "questionnaireId");

-- CreateIndex
CREATE INDEX "GoodsReceipt_tenantId_shipNoticeId_idx" ON "GoodsReceipt"("tenantId", "shipNoticeId");

-- CreateIndex
CREATE UNIQUE INDEX "SubcontractOperation_tenantId_siteId_workOrderId_subcontrac_key" ON "SubcontractOperation"("tenantId", "siteId", "workOrderId", "subcontractOrderId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SubcontractOrder_tenantId_siteId_workOrderId_partyId_id_key" ON "SubcontractOrder"("tenantId", "siteId", "workOrderId", "partyId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SubcontractReceipt_tenantId_siteId_workOrderId_subcontractO_key" ON "SubcontractReceipt"("tenantId", "siteId", "workOrderId", "subcontractOrderId", "id");

-- AddForeignKey
ALTER TABLE "GoodsReceipt" ADD CONSTRAINT "GoodsReceipt_tenantId_siteId_supplierId_shipNoticeId_fkey" FOREIGN KEY ("tenantId", "siteId", "supplierId", "shipNoticeId") REFERENCES "ShipNotice"("tenantId", "siteId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ShipNotice" ADD CONSTRAINT "ShipNotice_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ShipNotice" ADD CONSTRAINT "ShipNotice_tenantId_partyId_siteId_purchaseOrderId_fkey" FOREIGN KEY ("tenantId", "partyId", "siteId", "purchaseOrderId") REFERENCES "PurchaseOrder"("tenantId", "partyId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ShipNoticeLine" ADD CONSTRAINT "ShipNoticeLine_tenantId_siteId_partyId_shipNoticeId_fkey" FOREIGN KEY ("tenantId", "siteId", "partyId", "shipNoticeId") REFERENCES "ShipNotice"("tenantId", "siteId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ShipNoticeLine" ADD CONSTRAINT "ShipNoticeLine_tenantId_siteId_purchaseOrderLineId_fkey" FOREIGN KEY ("tenantId", "siteId", "purchaseOrderLineId") REFERENCES "PurchaseOrderLine"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ShipNoticeHide" ADD CONSTRAINT "ShipNoticeHide_tenantId_siteId_partyId_shipNoticeId_shipNo_fkey" FOREIGN KEY ("tenantId", "siteId", "partyId", "shipNoticeId", "shipNoticeLineId") REFERENCES "ShipNoticeLine"("tenantId", "siteId", "partyId", "shipNoticeId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SubcontractProgressReport" ADD CONSTRAINT "SubcontractProgressReport_tenantId_siteId_workOrderId_part_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId", "partyId", "subcontractOrderId") REFERENCES "SubcontractOrder"("tenantId", "siteId", "workOrderId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SubcontractProgressReport" ADD CONSTRAINT "SubcontractProgressReport_tenantId_siteId_workOrderId_subc_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId", "subcontractOrderId", "subcontractOperationId") REFERENCES "SubcontractOperation"("tenantId", "siteId", "workOrderId", "subcontractOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SubcontractProgressReport" ADD CONSTRAINT "SubcontractProgressReport_tenantId_siteId_workOrderId_bund_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId", "bundleId") REFERENCES "Bundle"("tenantId", "siteId", "workOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SubcontractProgressReport" ADD CONSTRAINT "SubcontractProgressReport_tenantId_siteId_workOrderId_work_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId", "workOrderSizeId") REFERENCES "WorkOrderSize"("tenantId", "siteId", "workOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SubcontractReturnNotice" ADD CONSTRAINT "SubcontractReturnNotice_tenantId_siteId_workOrderId_partyI_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId", "partyId", "subcontractOrderId") REFERENCES "SubcontractOrder"("tenantId", "siteId", "workOrderId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SubcontractReturnNotice" ADD CONSTRAINT "SubcontractReturnNotice_tenantId_siteId_workOrderId_subcon_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId", "subcontractOrderId", "receiptId") REFERENCES "SubcontractReceipt"("tenantId", "siteId", "workOrderId", "subcontractOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierQuestionnaire" ADD CONSTRAINT "SupplierQuestionnaire_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierQuestionnaireResponse" ADD CONSTRAINT "SupplierQuestionnaireResponse_tenantId_companyId_questionn_fkey" FOREIGN KEY ("tenantId", "companyId", "questionnaireId") REFERENCES "SupplierQuestionnaire"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierQuestionnaireResponse" ADD CONSTRAINT "SupplierQuestionnaireResponse_tenantId_partyId_fkey" FOREIGN KEY ("tenantId", "partyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierQuestionnaireResponse" ADD CONSTRAINT "SupplierQuestionnaireResponse_tenantId_partyId_linkId_fkey" FOREIGN KEY ("tenantId", "partyId", "linkId") REFERENCES "OneOffLink"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_tenantId_proposedSubstituteItemId_fkey" FOREIGN KEY ("tenantId", "proposedSubstituteItemId") REFERENCES "Item"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

