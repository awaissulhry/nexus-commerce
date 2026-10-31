-- CreateEnum
CREATE TYPE "FileCategory" AS ENUM ('DDT_PHOTO', 'POD', 'CMR', 'CARRIER_INVOICE', 'CLAIM_PHOTO', 'OTHER');

-- CreateEnum
CREATE TYPE "GeneratedDocumentKind" AS ENUM ('PACKING_LIST', 'CLAIM_LETTER', 'JOB_SHEET', 'RMA_SHEET');

-- CreateEnum
CREATE TYPE "TransportMode" AS ENUM ('SEA', 'RAIL', 'ROAD', 'AIR', 'POST', 'FIXED_INSTALLATION', 'INLAND_WATERWAY', 'OWN_PROPULSION');

-- CreateEnum
CREATE TYPE "FreightBasis" AS ENUM ('RULE', 'MANUAL');

-- AlterEnum
ALTER TYPE "HideState" ADD VALUE 'RETURNED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "StockMoveReason" ADD VALUE 'CUSTOMER_RETURN';
ALTER TYPE "StockMoveReason" ADD VALUE 'SUPPLIER_RETURN';
ALTER TYPE "StockMoveReason" ADD VALUE 'SHIPMENT';

-- AlterTable
ALTER TABLE "Bundle" ADD COLUMN     "splitReason" TEXT;

-- AlterTable
ALTER TABLE "Ddt" ADD COLUMN     "language" TEXT,
ADD COLUMN     "transportMode" "TransportMode";

-- AlterTable
ALTER TABLE "GoodsReceipt" ADD COLUMN     "supplierDdtCorrectedAt" TIMESTAMPTZ(3),
ADD COLUMN     "supplierDdtCorrectedById" UUID,
ADD COLUMN     "supplierDdtCorrectionReason" TEXT;

-- AlterTable
ALTER TABLE "Hide" ADD COLUMN     "previousState" "HideState";

-- AlterTable
ALTER TABLE "OperationScan" ADD COLUMN     "subcontractReceiptLineId" UUID;

-- AlterTable
ALTER TABLE "ReceiptDiscrepancy" ADD COLUMN     "reasonCode" TEXT;

-- AlterTable
ALTER TABLE "ScrapReason" ADD COLUMN     "colour" TEXT,
ADD COLUMN     "icon" TEXT,
ADD COLUMN     "labelI18n" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "needsDetail" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Shipment" ADD COLUMN     "freightBasis" "FreightBasis",
ADD COLUMN     "freightCost" INTEGER,
ADD COLUMN     "freightCostCurrency" TEXT,
ADD COLUMN     "transportMode" "TransportMode";

-- AlterTable
ALTER TABLE "StockMove" ADD COLUMN     "reasonCode" TEXT,
ADD COLUMN     "returnLineId" UUID,
ADD COLUMN     "returnPartyId" UUID,
ADD COLUMN     "shipmentLineId" UUID;

-- AlterTable
ALTER TABLE "StoredFile" ADD COLUMN     "category" "FileCategory";

-- AlterTable
ALTER TABLE "SupplierClaim" ADD COLUMN     "ncrId" UUID,
ADD COLUMN     "reasonCode" TEXT;

-- CreateTable
CREATE TABLE "GeneratedDocument" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "recordType" TEXT NOT NULL,
    "recordId" UUID NOT NULL,
    "kind" "GeneratedDocumentKind" NOT NULL,
    "version" INTEGER NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "layout" TEXT,
    "number" TEXT,
    "fileId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "GeneratedDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkOrderKit" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "workOrderId" UUID NOT NULL,
    "stagingLocationId" UUID,
    "completedAt" TIMESTAMPTZ(3),
    "completedById" UUID,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "WorkOrderKit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubcontractBundle" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "workOrderId" UUID NOT NULL,
    "subcontractOrderId" UUID NOT NULL,
    "bundleId" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "sentAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "SubcontractBundle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubcontractReceipt" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "workOrderId" UUID NOT NULL,
    "subcontractOrderId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL,
    "workshopDdtNumber" TEXT,
    "workshopDdtDate" DATE,
    "returnMoveIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "note" TEXT,
    "deviceId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "SubcontractReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubcontractReceiptLine" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "workOrderId" UUID NOT NULL,
    "receiptId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "subcontractOperationId" UUID NOT NULL,
    "bundleId" UUID,
    "goodQuantity" INTEGER NOT NULL DEFAULT 0,
    "defectiveQuantity" INTEGER NOT NULL DEFAULT 0,
    "scrappedQuantity" INTEGER NOT NULL DEFAULT 0,
    "reasonCode" TEXT,
    "reasonNote" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "SubcontractReceiptLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GeneratedDocument_tenantId_recordType_recordId_idx" ON "GeneratedDocument"("tenantId", "recordType", "recordId");

-- CreateIndex
CREATE UNIQUE INDEX "GeneratedDocument_tenantId_recordId_kind_version_key" ON "GeneratedDocument"("tenantId", "recordId", "kind", "version");

-- CreateIndex
CREATE INDEX "WorkOrderKit_tenantId_workOrderId_idx" ON "WorkOrderKit"("tenantId", "workOrderId");

-- CreateIndex
CREATE INDEX "SubcontractBundle_tenantId_subcontractOrderId_idx" ON "SubcontractBundle"("tenantId", "subcontractOrderId");

-- CreateIndex
CREATE INDEX "SubcontractBundle_tenantId_bundleId_idx" ON "SubcontractBundle"("tenantId", "bundleId");

-- CreateIndex
CREATE UNIQUE INDEX "SubcontractReceipt_tenantId_subcontractOrderId_seq_key" ON "SubcontractReceipt"("tenantId", "subcontractOrderId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "SubcontractReceipt_tenantId_siteId_workOrderId_id_key" ON "SubcontractReceipt"("tenantId", "siteId", "workOrderId", "id");

-- CreateIndex
CREATE INDEX "SubcontractReceiptLine_tenantId_bundleId_idx" ON "SubcontractReceiptLine"("tenantId", "bundleId");

-- CreateIndex
CREATE UNIQUE INDEX "SubcontractReceiptLine_tenantId_receiptId_seq_key" ON "SubcontractReceiptLine"("tenantId", "receiptId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "SubcontractReceiptLine_tenantId_siteId_workOrderId_id_key" ON "SubcontractReceiptLine"("tenantId", "siteId", "workOrderId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ShipmentLine_tenantId_siteId_id_key" ON "ShipmentLine"("tenantId", "siteId", "id");

-- CreateIndex
CREATE INDEX "StockMove_tenantId_returnLineId_idx" ON "StockMove"("tenantId", "returnLineId");

-- CreateIndex
CREATE INDEX "StockMove_tenantId_shipmentLineId_idx" ON "StockMove"("tenantId", "shipmentLineId");

-- CreateIndex
CREATE UNIQUE INDEX "SubcontractOperation_tenantId_siteId_workOrderId_id_key" ON "SubcontractOperation"("tenantId", "siteId", "workOrderId", "id");

-- AddForeignKey
ALTER TABLE "SupplierClaim" ADD CONSTRAINT "SupplierClaim_tenantId_siteId_ncrId_fkey" FOREIGN KEY ("tenantId", "siteId", "ncrId") REFERENCES "Nonconformance"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "GeneratedDocument" ADD CONSTRAINT "GeneratedDocument_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "GeneratedDocument" ADD CONSTRAINT "GeneratedDocument_tenantId_fileId_fkey" FOREIGN KEY ("tenantId", "fileId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StockMove" ADD CONSTRAINT "StockMove_tenantId_returnPartyId_returnLineId_fkey" FOREIGN KEY ("tenantId", "returnPartyId", "returnLineId") REFERENCES "ReturnLine"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StockMove" ADD CONSTRAINT "StockMove_tenantId_siteId_shipmentLineId_fkey" FOREIGN KEY ("tenantId", "siteId", "shipmentLineId") REFERENCES "ShipmentLine"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkOrderKit" ADD CONSTRAINT "WorkOrderKit_tenantId_siteId_workOrderId_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId") REFERENCES "WorkOrder"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkOrderKit" ADD CONSTRAINT "WorkOrderKit_tenantId_siteId_stagingLocationId_fkey" FOREIGN KEY ("tenantId", "siteId", "stagingLocationId") REFERENCES "Location"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OperationScan" ADD CONSTRAINT "OperationScan_tenantId_siteId_workOrderId_subcontractRecei_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId", "subcontractReceiptLineId") REFERENCES "SubcontractReceiptLine"("tenantId", "siteId", "workOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SubcontractBundle" ADD CONSTRAINT "SubcontractBundle_tenantId_siteId_workOrderId_subcontractO_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId", "subcontractOrderId") REFERENCES "SubcontractOrder"("tenantId", "siteId", "workOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SubcontractBundle" ADD CONSTRAINT "SubcontractBundle_tenantId_siteId_workOrderId_bundleId_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId", "bundleId") REFERENCES "Bundle"("tenantId", "siteId", "workOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SubcontractReceipt" ADD CONSTRAINT "SubcontractReceipt_tenantId_siteId_workOrderId_subcontract_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId", "subcontractOrderId") REFERENCES "SubcontractOrder"("tenantId", "siteId", "workOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SubcontractReceipt" ADD CONSTRAINT "SubcontractReceipt_tenantId_siteId_deviceId_fkey" FOREIGN KEY ("tenantId", "siteId", "deviceId") REFERENCES "Device"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SubcontractReceiptLine" ADD CONSTRAINT "SubcontractReceiptLine_tenantId_siteId_workOrderId_receipt_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId", "receiptId") REFERENCES "SubcontractReceipt"("tenantId", "siteId", "workOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SubcontractReceiptLine" ADD CONSTRAINT "SubcontractReceiptLine_tenantId_siteId_workOrderId_subcont_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId", "subcontractOperationId") REFERENCES "SubcontractOperation"("tenantId", "siteId", "workOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SubcontractReceiptLine" ADD CONSTRAINT "SubcontractReceiptLine_tenantId_siteId_workOrderId_bundleI_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId", "bundleId") REFERENCES "Bundle"("tenantId", "siteId", "workOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

