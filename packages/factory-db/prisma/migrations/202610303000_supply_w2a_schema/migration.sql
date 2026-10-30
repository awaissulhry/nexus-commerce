-- CreateEnum
CREATE TYPE "ReceiptDiscrepancyKind" AS ENUM ('SHORT', 'OVER', 'DAMAGED', 'WRONG_ITEM', 'WRONG_COLOUR', 'MISSING_DOCUMENT', 'OTHER');

-- CreateEnum
CREATE TYPE "ReceiptDiscrepancyStatus" AS ENUM ('OPEN', 'SENT', 'AGREED', 'CREDITED', 'CLOSED');

-- CreateEnum
CREATE TYPE "SupplierClaimKind" AS ENUM ('RETURN', 'CLAIM');

-- CreateEnum
CREATE TYPE "ClaimFoundAt" AS ENUM ('RECEIPT', 'STOCK', 'CUTTING', 'PRODUCTION', 'INSPECTION');

-- CreateEnum
CREATE TYPE "ClaimRemedy" AS ENUM ('CREDIT', 'REPLACEMENT');

-- CreateEnum
CREATE TYPE "SupplierClaimStatus" AS ENUM ('DRAFT', 'SENT', 'ACCEPTED', 'REJECTED', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TypeChangeReviewStatus" AS ENUM ('OPEN', 'NOTIFIED', 'APPROVED', 'REFUSED', 'NOT_NEEDED');

-- CreateEnum
CREATE TYPE "SupplierItemPreference" AS ENUM ('PRIMARY', 'BACKUP');

-- CreateEnum
CREATE TYPE "PurchaseReminderKind" AS ENUM ('CONFIRMATION');

-- CreateEnum
CREATE TYPE "SubcontractOrderStatus" AS ENUM ('DRAFT', 'ISSUED', 'AT_WORKSHOP', 'PARTLY_RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SubcontractKitLineStatus" AS ENUM ('PLANNED', 'SENT', 'CANCELLED');

-- AlterEnum
ALTER TYPE "LocationKind" ADD VALUE 'SUBCONTRACTOR';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NumberKind" ADD VALUE 'CLAIM';
ALTER TYPE "NumberKind" ADD VALUE 'SUBCONTRACT';

-- AlterTable
ALTER TABLE "Certificate" ADD COLUMN     "successorId" UUID;

-- AlterTable
ALTER TABLE "GoodsReceiptLine" ADD COLUMN     "receivedFactor" DECIMAL(18,8),
ADD COLUMN     "receivedQuantity" DECIMAL(18,4),
ADD COLUMN     "receivedUom" "Uom";

-- AlterTable
ALTER TABLE "Location" ADD COLUMN     "partyId" UUID;

-- AlterTable
ALTER TABLE "PurchaseOrder" ADD COLUMN     "confirmBy" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "PurchaseOrderLine" ADD COLUMN     "cancelReason" TEXT,
ADD COLUMN     "cancelledAt" TIMESTAMPTZ(3),
ADD COLUMN     "cancelledById" UUID,
ADD COLUMN     "closeShortReason" TEXT,
ADD COLUMN     "closedShortAt" TIMESTAMPTZ(3),
ADD COLUMN     "closedShortById" UUID;

-- AlterTable
ALTER TABLE "RoutingOperation" ADD COLUMN     "pricePerPiece" DECIMAL(18,6),
ADD COLUMN     "supplierId" UUID,
ADD COLUMN     "transitDays" INTEGER;

-- AlterTable
ALTER TABLE "Style" ADD COLUMN     "hsCode" TEXT,
ADD COLUMN     "netMassKg" DECIMAL(10,3),
ADD COLUMN     "originCountry" TEXT;

-- CreateTable
CREATE TABLE "ReceiptDiscrepancy" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "receiptId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "receiptLineId" UUID,
    "supplierId" UUID NOT NULL,
    "kind" "ReceiptDiscrepancyKind" NOT NULL,
    "quantity" DECIMAL(18,4),
    "uom" "Uom",
    "note" TEXT,
    "status" "ReceiptDiscrepancyStatus" NOT NULL DEFAULT 'OPEN',
    "sentAt" TIMESTAMPTZ(3),
    "sentById" UUID,
    "closedAt" TIMESTAMPTZ(3),
    "resolutionNote" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "ReceiptDiscrepancy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierClaim" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "partyId" UUID NOT NULL,
    "kind" "SupplierClaimKind" NOT NULL,
    "goodsReceiptId" UUID,
    "purchaseOrderId" UUID,
    "foundAt" "ClaimFoundAt" NOT NULL,
    "reason" TEXT NOT NULL,
    "remedy" "ClaimRemedy",
    "status" "SupplierClaimStatus" NOT NULL DEFAULT 'DRAFT',
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "expectedCreditAmount" INTEGER,
    "sentAt" TIMESTAMPTZ(3),
    "sentById" UUID,
    "supplierAnswer" TEXT,
    "answeredAt" TIMESTAMPTZ(3),
    "closedAt" TIMESTAMPTZ(3),
    "closeNote" TEXT,
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelReason" TEXT,
    "internalNote" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "SupplierClaim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierClaimLine" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "claimId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "discrepancyId" UUID,
    "receiptLineId" UUID,
    "itemId" UUID NOT NULL,
    "itemColourId" UUID,
    "lotId" UUID,
    "hideId" UUID,
    "quantity" DECIMAL(18,4) NOT NULL,
    "uom" "Uom" NOT NULL,
    "baseQuantity" DECIMAL(18,4) NOT NULL,
    "reason" TEXT,
    "unitCost" DECIMAL(18,6),
    "creditAmount" INTEGER,
    "moveId" UUID,
    "ddtId" UUID,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "SupplierClaimLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TypeChangeReview" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "styleId" UUID NOT NULL,
    "revisionId" UUID NOT NULL,
    "certificateId" UUID NOT NULL,
    "comparedRevisionId" UUID,
    "changes" JSONB NOT NULL DEFAULT '[]',
    "status" "TypeChangeReviewStatus" NOT NULL DEFAULT 'OPEN',
    "notifiedAt" TIMESTAMPTZ(3),
    "answeredAt" DATE,
    "answerReference" TEXT,
    "decidedAt" TIMESTAMPTZ(3),
    "decidedById" UUID,
    "decisionNote" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "TypeChangeReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierItem" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID,
    "partyId" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "itemColourId" UUID,
    "supplierArticleCode" TEXT,
    "supplierColourCode" TEXT,
    "description" TEXT,
    "purchaseUom" "Uom" NOT NULL,
    "purchaseFactor" DECIMAL(18,8) NOT NULL DEFAULT 1,
    "unitPrice" DECIMAL(18,6),
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "minOrderQty" DECIMAL(18,4),
    "orderMultiple" DECIMAL(18,4),
    "leadTimeDays" INTEGER,
    "preference" "SupplierItemPreference" NOT NULL DEFAULT 'PRIMARY',
    "status" "MasterStatus" NOT NULL DEFAULT 'ACTIVE',
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "SupplierItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrderRevision" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "purchaseOrderId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "sentAt" TIMESTAMPTZ(3) NOT NULL,
    "sentById" UUID,
    "before" JSONB,
    "after" JSONB NOT NULL,
    "beforePrices" JSONB,
    "afterPrices" JSONB NOT NULL,
    "changeNote" TEXT,
    "documentFileId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "PurchaseOrderRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrderReminder" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "purchaseOrderId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "kind" "PurchaseReminderKind" NOT NULL,
    "sentAt" TIMESTAMPTZ(3) NOT NULL,
    "sentById" UUID,
    "toAddress" TEXT,
    "emailOutboundId" UUID,
    "note" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "PurchaseOrderReminder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubcontractOrder" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "partyId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "workOrderId" UUID NOT NULL,
    "status" "SubcontractOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "orderDate" DATE NOT NULL,
    "expectedBackDate" DATE,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "netAmount" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "internalNote" TEXT,
    "issuedAt" TIMESTAMPTZ(3),
    "issuedById" UUID,
    "closedAt" TIMESTAMPTZ(3),
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "SubcontractOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubcontractOperation" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "workOrderId" UUID NOT NULL,
    "subcontractOrderId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "workOrderOperationId" UUID NOT NULL,
    "pieces" INTEGER NOT NULL,
    "sizes" JSONB NOT NULL DEFAULT '[]',
    "pricePerPiece" DECIMAL(18,6) NOT NULL,
    "netAmount" INTEGER NOT NULL,
    "expectedBackDate" DATE,
    "piecesSent" INTEGER NOT NULL DEFAULT 0,
    "piecesBackGood" INTEGER NOT NULL DEFAULT 0,
    "piecesBackDefective" INTEGER NOT NULL DEFAULT 0,
    "piecesScrapped" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "SubcontractOperation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubcontractKitLine" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "subcontractOrderId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "itemId" UUID NOT NULL,
    "itemColourId" UUID,
    "lotId" UUID,
    "hideId" UUID,
    "quantity" DECIMAL(18,4) NOT NULL,
    "uom" "Uom" NOT NULL,
    "baseQuantity" DECIMAL(18,4) NOT NULL,
    "status" "SubcontractKitLineStatus" NOT NULL DEFAULT 'PLANNED',
    "sentAt" TIMESTAMPTZ(3),
    "moveId" UUID,
    "ddtId" UUID,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "SubcontractKitLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReceiptDiscrepancy_tenantId_receiptId_seq_key" ON "ReceiptDiscrepancy"("tenantId", "receiptId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "ReceiptDiscrepancy_tenantId_siteId_id_key" ON "ReceiptDiscrepancy"("tenantId", "siteId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierClaim_tenantId_companyId_number_key" ON "SupplierClaim"("tenantId", "companyId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierClaim_tenantId_siteId_partyId_id_key" ON "SupplierClaim"("tenantId", "siteId", "partyId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierClaimLine_tenantId_claimId_seq_key" ON "SupplierClaimLine"("tenantId", "claimId", "seq");

-- CreateIndex
CREATE INDEX "TypeChangeReview_tenantId_revisionId_idx" ON "TypeChangeReview"("tenantId", "revisionId");

-- CreateIndex
CREATE INDEX "TypeChangeReview_tenantId_certificateId_idx" ON "TypeChangeReview"("tenantId", "certificateId");

-- CreateIndex
CREATE INDEX "SupplierItem_tenantId_itemId_idx" ON "SupplierItem"("tenantId", "itemId");

-- CreateIndex
CREATE INDEX "SupplierItem_tenantId_partyId_idx" ON "SupplierItem"("tenantId", "partyId");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrderRevision_tenantId_purchaseOrderId_revision_key" ON "PurchaseOrderRevision"("tenantId", "purchaseOrderId", "revision");

-- CreateIndex
CREATE INDEX "PurchaseOrderReminder_tenantId_purchaseOrderId_sentAt_idx" ON "PurchaseOrderReminder"("tenantId", "purchaseOrderId", "sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "SubcontractOrder_tenantId_companyId_number_key" ON "SubcontractOrder"("tenantId", "companyId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "SubcontractOrder_tenantId_siteId_workOrderId_id_key" ON "SubcontractOrder"("tenantId", "siteId", "workOrderId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SubcontractOrder_tenantId_siteId_partyId_id_key" ON "SubcontractOrder"("tenantId", "siteId", "partyId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SubcontractOperation_tenantId_subcontractOrderId_seq_key" ON "SubcontractOperation"("tenantId", "subcontractOrderId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "SubcontractKitLine_tenantId_subcontractOrderId_seq_key" ON "SubcontractKitLine"("tenantId", "subcontractOrderId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "Certificate_tenantId_successorId_key" ON "Certificate"("tenantId", "successorId");

-- AddForeignKey
ALTER TABLE "ReceiptDiscrepancy" ADD CONSTRAINT "ReceiptDiscrepancy_tenantId_siteId_receiptId_fkey" FOREIGN KEY ("tenantId", "siteId", "receiptId") REFERENCES "GoodsReceipt"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ReceiptDiscrepancy" ADD CONSTRAINT "ReceiptDiscrepancy_tenantId_siteId_receiptLineId_fkey" FOREIGN KEY ("tenantId", "siteId", "receiptLineId") REFERENCES "GoodsReceiptLine"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ReceiptDiscrepancy" ADD CONSTRAINT "ReceiptDiscrepancy_tenantId_supplierId_fkey" FOREIGN KEY ("tenantId", "supplierId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierClaim" ADD CONSTRAINT "SupplierClaim_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierClaim" ADD CONSTRAINT "SupplierClaim_tenantId_partyId_fkey" FOREIGN KEY ("tenantId", "partyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierClaim" ADD CONSTRAINT "SupplierClaim_tenantId_siteId_goodsReceiptId_fkey" FOREIGN KEY ("tenantId", "siteId", "goodsReceiptId") REFERENCES "GoodsReceipt"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierClaim" ADD CONSTRAINT "SupplierClaim_tenantId_siteId_purchaseOrderId_fkey" FOREIGN KEY ("tenantId", "siteId", "purchaseOrderId") REFERENCES "PurchaseOrder"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierClaimLine" ADD CONSTRAINT "SupplierClaimLine_tenantId_siteId_partyId_claimId_fkey" FOREIGN KEY ("tenantId", "siteId", "partyId", "claimId") REFERENCES "SupplierClaim"("tenantId", "siteId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierClaimLine" ADD CONSTRAINT "SupplierClaimLine_tenantId_siteId_discrepancyId_fkey" FOREIGN KEY ("tenantId", "siteId", "discrepancyId") REFERENCES "ReceiptDiscrepancy"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierClaimLine" ADD CONSTRAINT "SupplierClaimLine_tenantId_siteId_receiptLineId_fkey" FOREIGN KEY ("tenantId", "siteId", "receiptLineId") REFERENCES "GoodsReceiptLine"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierClaimLine" ADD CONSTRAINT "SupplierClaimLine_tenantId_itemId_fkey" FOREIGN KEY ("tenantId", "itemId") REFERENCES "Item"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierClaimLine" ADD CONSTRAINT "SupplierClaimLine_tenantId_itemId_itemColourId_fkey" FOREIGN KEY ("tenantId", "itemId", "itemColourId") REFERENCES "ItemColour"("tenantId", "itemId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierClaimLine" ADD CONSTRAINT "SupplierClaimLine_tenantId_siteId_itemId_lotId_fkey" FOREIGN KEY ("tenantId", "siteId", "itemId", "lotId") REFERENCES "Lot"("tenantId", "siteId", "itemId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierClaimLine" ADD CONSTRAINT "SupplierClaimLine_tenantId_siteId_lotId_hideId_fkey" FOREIGN KEY ("tenantId", "siteId", "lotId", "hideId") REFERENCES "Hide"("tenantId", "siteId", "lotId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierClaimLine" ADD CONSTRAINT "SupplierClaimLine_tenantId_siteId_moveId_fkey" FOREIGN KEY ("tenantId", "siteId", "moveId") REFERENCES "StockMove"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierClaimLine" ADD CONSTRAINT "SupplierClaimLine_tenantId_siteId_partyId_ddtId_fkey" FOREIGN KEY ("tenantId", "siteId", "partyId", "ddtId") REFERENCES "Ddt"("tenantId", "siteId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Certificate" ADD CONSTRAINT "Certificate_tenantId_successorId_fkey" FOREIGN KEY ("tenantId", "successorId") REFERENCES "Certificate"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TypeChangeReview" ADD CONSTRAINT "TypeChangeReview_tenantId_styleId_fkey" FOREIGN KEY ("tenantId", "styleId") REFERENCES "Style"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TypeChangeReview" ADD CONSTRAINT "TypeChangeReview_tenantId_styleId_revisionId_fkey" FOREIGN KEY ("tenantId", "styleId", "revisionId") REFERENCES "StyleRevision"("tenantId", "styleId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TypeChangeReview" ADD CONSTRAINT "TypeChangeReview_tenantId_styleId_comparedRevisionId_fkey" FOREIGN KEY ("tenantId", "styleId", "comparedRevisionId") REFERENCES "StyleRevision"("tenantId", "styleId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TypeChangeReview" ADD CONSTRAINT "TypeChangeReview_tenantId_certificateId_fkey" FOREIGN KEY ("tenantId", "certificateId") REFERENCES "Certificate"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Location" ADD CONSTRAINT "Location_tenantId_partyId_fkey" FOREIGN KEY ("tenantId", "partyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RoutingOperation" ADD CONSTRAINT "RoutingOperation_tenantId_supplierId_fkey" FOREIGN KEY ("tenantId", "supplierId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierItem" ADD CONSTRAINT "SupplierItem_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierItem" ADD CONSTRAINT "SupplierItem_tenantId_partyId_fkey" FOREIGN KEY ("tenantId", "partyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierItem" ADD CONSTRAINT "SupplierItem_tenantId_itemId_fkey" FOREIGN KEY ("tenantId", "itemId") REFERENCES "Item"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierItem" ADD CONSTRAINT "SupplierItem_tenantId_itemId_itemColourId_fkey" FOREIGN KEY ("tenantId", "itemId", "itemColourId") REFERENCES "ItemColour"("tenantId", "itemId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PurchaseOrderRevision" ADD CONSTRAINT "PurchaseOrderRevision_tenantId_partyId_siteId_purchaseOrde_fkey" FOREIGN KEY ("tenantId", "partyId", "siteId", "purchaseOrderId") REFERENCES "PurchaseOrder"("tenantId", "partyId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PurchaseOrderRevision" ADD CONSTRAINT "PurchaseOrderRevision_tenantId_documentFileId_fkey" FOREIGN KEY ("tenantId", "documentFileId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PurchaseOrderReminder" ADD CONSTRAINT "PurchaseOrderReminder_tenantId_partyId_siteId_purchaseOrde_fkey" FOREIGN KEY ("tenantId", "partyId", "siteId", "purchaseOrderId") REFERENCES "PurchaseOrder"("tenantId", "partyId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SubcontractOrder" ADD CONSTRAINT "SubcontractOrder_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SubcontractOrder" ADD CONSTRAINT "SubcontractOrder_tenantId_partyId_fkey" FOREIGN KEY ("tenantId", "partyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SubcontractOrder" ADD CONSTRAINT "SubcontractOrder_tenantId_siteId_locationId_fkey" FOREIGN KEY ("tenantId", "siteId", "locationId") REFERENCES "Location"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SubcontractOrder" ADD CONSTRAINT "SubcontractOrder_tenantId_siteId_workOrderId_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId") REFERENCES "WorkOrder"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SubcontractOperation" ADD CONSTRAINT "SubcontractOperation_tenantId_siteId_workOrderId_subcontra_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId", "subcontractOrderId") REFERENCES "SubcontractOrder"("tenantId", "siteId", "workOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SubcontractOperation" ADD CONSTRAINT "SubcontractOperation_tenantId_siteId_workOrderId_workOrder_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId", "workOrderOperationId") REFERENCES "WorkOrderOperation"("tenantId", "siteId", "workOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SubcontractKitLine" ADD CONSTRAINT "SubcontractKitLine_tenantId_siteId_partyId_subcontractOrde_fkey" FOREIGN KEY ("tenantId", "siteId", "partyId", "subcontractOrderId") REFERENCES "SubcontractOrder"("tenantId", "siteId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SubcontractKitLine" ADD CONSTRAINT "SubcontractKitLine_tenantId_itemId_fkey" FOREIGN KEY ("tenantId", "itemId") REFERENCES "Item"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SubcontractKitLine" ADD CONSTRAINT "SubcontractKitLine_tenantId_itemId_itemColourId_fkey" FOREIGN KEY ("tenantId", "itemId", "itemColourId") REFERENCES "ItemColour"("tenantId", "itemId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SubcontractKitLine" ADD CONSTRAINT "SubcontractKitLine_tenantId_siteId_itemId_lotId_fkey" FOREIGN KEY ("tenantId", "siteId", "itemId", "lotId") REFERENCES "Lot"("tenantId", "siteId", "itemId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SubcontractKitLine" ADD CONSTRAINT "SubcontractKitLine_tenantId_siteId_lotId_hideId_fkey" FOREIGN KEY ("tenantId", "siteId", "lotId", "hideId") REFERENCES "Hide"("tenantId", "siteId", "lotId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SubcontractKitLine" ADD CONSTRAINT "SubcontractKitLine_tenantId_siteId_moveId_fkey" FOREIGN KEY ("tenantId", "siteId", "moveId") REFERENCES "StockMove"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SubcontractKitLine" ADD CONSTRAINT "SubcontractKitLine_tenantId_siteId_partyId_ddtId_fkey" FOREIGN KEY ("tenantId", "siteId", "partyId", "ddtId") REFERENCES "Ddt"("tenantId", "siteId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

