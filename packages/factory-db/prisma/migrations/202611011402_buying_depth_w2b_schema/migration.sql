-- CreateEnum
CREATE TYPE "PurchaseOrderKind" AS ENUM ('STANDARD', 'SAMPLE');

-- CreateEnum
CREATE TYPE "PoDateChangeSource" AS ENUM ('SUPPLIER', 'BUYER');

-- CreateEnum
CREATE TYPE "DeliveryToleranceAction" AS ENUM ('BLOCK', 'APPROVAL');

-- CreateEnum
CREATE TYPE "PurchaseRequestStatus" AS ENUM ('OPEN', 'PENDING_APPROVAL', 'CONVERTED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PurchaseRequestSource" AS ENUM ('OFFICE', 'SHORTAGE');

-- CreateEnum
CREATE TYPE "SubcontractConsumptionKind" AS ENUM ('DECLARED', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "SubcontractCostKind" AS ENUM ('FEE', 'TRANSPORT', 'MATERIAL', 'OTHER');

-- AlterEnum
ALTER TYPE "PurchaseOrderStatus" ADD VALUE 'PENDING_APPROVAL';

-- AlterTable
ALTER TABLE "Lot" ADD COLUMN     "variantCode" TEXT;

-- AlterTable
ALTER TABLE "PurchaseOrder" ADD COLUMN     "approvalTaskId" UUID,
ADD COLUMN     "companyNetAmount" INTEGER,
ADD COLUMN     "developmentStyleId" UUID,
ADD COLUMN     "kind" "PurchaseOrderKind" NOT NULL DEFAULT 'STANDARD',
ADD COLUMN     "rateAtOrder" DECIMAL(18,8),
ADD COLUMN     "sampleRoundId" UUID,
ADD COLUMN     "shipToAddressId" UUID,
ADD COLUMN     "shipToLocationId" UUID,
ADD COLUMN     "shipToPartyId" UUID;

-- AlterTable
ALTER TABLE "PurchaseOrderLine" ADD COLUMN     "certificateId" UUID,
ADD COLUMN     "rollLengthM" DECIMAL(10,2),
ADD COLUMN     "rollWidthCm" DECIMAL(10,2),
ADD COLUMN     "rolls" INTEGER,
ADD COLUMN     "variantCode" TEXT;

-- CreateTable
CREATE TABLE "PurchaseOrderLineDelivery" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "purchaseOrderLineId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "baseQuantity" DECIMAL(18,4) NOT NULL,
    "needDate" DATE NOT NULL,
    "confirmedDate" DATE,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "PurchaseOrderLineDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PoDateChange" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "purchaseOrderLineId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "deliveryId" UUID,
    "seq" INTEGER NOT NULL,
    "fromDate" DATE NOT NULL,
    "toDate" DATE NOT NULL,
    "source" "PoDateChangeSource" NOT NULL,
    "changedAt" TIMESTAMPTZ(3) NOT NULL,
    "supplierContactName" TEXT,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "PoDateChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryTolerance" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID,
    "supplierId" UUID,
    "itemId" UUID,
    "itemKind" "ItemKind",
    "overPct" DECIMAL(7,4) NOT NULL,
    "underPct" DECIMAL(7,4) NOT NULL,
    "whenBeyond" "DeliveryToleranceAction" NOT NULL DEFAULT 'BLOCK',
    "status" "MasterStatus" NOT NULL DEFAULT 'ACTIVE',
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,
    "updatedById" UUID,

    CONSTRAINT "DeliveryTolerance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ItemVariant" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "itemId" UUID NOT NULL,
    "itemColourId" UUID,
    "size" TEXT,
    "code" TEXT NOT NULL,
    "supplierCode" TEXT,
    "status" "MasterStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "ItemVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseRequest" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "requestedById" UUID NOT NULL,
    "requestedAt" TIMESTAMPTZ(3) NOT NULL,
    "source" "PurchaseRequestSource" NOT NULL DEFAULT 'OFFICE',
    "itemId" UUID,
    "itemColourId" UUID,
    "description" TEXT,
    "quantity" DECIMAL(18,4) NOT NULL,
    "uom" "Uom" NOT NULL,
    "needDate" DATE NOT NULL,
    "reason" TEXT NOT NULL,
    "workOrderId" UUID,
    "shortage" JSONB,
    "status" "PurchaseRequestStatus" NOT NULL DEFAULT 'OPEN',
    "approvalTaskId" UUID,
    "rejectedAt" TIMESTAMPTZ(3),
    "rejectedById" UUID,
    "rejectReason" TEXT,
    "convertedAt" TIMESTAMPTZ(3),
    "convertedById" UUID,
    "purchaseOrderLineId" UUID,
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "PurchaseRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubcontractConsumption" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "workOrderId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "subcontractOrderId" UUID NOT NULL,
    "kitLineId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" "SubcontractConsumptionKind" NOT NULL,
    "receiptId" UUID,
    "usedQuantity" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "returnedQuantity" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "scrappedQuantity" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "reportedAt" TIMESTAMPTZ(3) NOT NULL,
    "reasonCode" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "SubcontractConsumption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubcontractCostEntry" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "workOrderId" UUID NOT NULL,
    "subcontractOrderId" UUID NOT NULL,
    "kind" "SubcontractCostKind" NOT NULL,
    "subcontractOperationId" UUID,
    "receiptId" UUID,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unitPrice" DECIMAL(18,6) NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "reversalOfId" UUID,
    "reason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "SubcontractCostEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrderLineDelivery_tenantId_purchaseOrderLineId_seq_key" ON "PurchaseOrderLineDelivery"("tenantId", "purchaseOrderLineId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrderLineDelivery_tenantId_purchaseOrderLineId_id_key" ON "PurchaseOrderLineDelivery"("tenantId", "purchaseOrderLineId", "id");

-- CreateIndex
CREATE INDEX "PoDateChange_tenantId_deliveryId_idx" ON "PoDateChange"("tenantId", "deliveryId");

-- CreateIndex
CREATE UNIQUE INDEX "PoDateChange_tenantId_purchaseOrderLineId_seq_key" ON "PoDateChange"("tenantId", "purchaseOrderLineId", "seq");

-- CreateIndex
CREATE INDEX "DeliveryTolerance_tenantId_supplierId_idx" ON "DeliveryTolerance"("tenantId", "supplierId");

-- CreateIndex
CREATE INDEX "DeliveryTolerance_tenantId_itemId_idx" ON "DeliveryTolerance"("tenantId", "itemId");

-- CreateIndex
CREATE UNIQUE INDEX "ItemVariant_tenantId_itemId_code_key" ON "ItemVariant"("tenantId", "itemId", "code");

-- CreateIndex
CREATE INDEX "PurchaseRequest_tenantId_status_needDate_idx" ON "PurchaseRequest"("tenantId", "status", "needDate");

-- CreateIndex
CREATE INDEX "PurchaseRequest_tenantId_requestedById_idx" ON "PurchaseRequest"("tenantId", "requestedById");

-- CreateIndex
CREATE INDEX "PurchaseRequest_tenantId_workOrderId_idx" ON "PurchaseRequest"("tenantId", "workOrderId");

-- CreateIndex
CREATE INDEX "SubcontractConsumption_tenantId_subcontractOrderId_idx" ON "SubcontractConsumption"("tenantId", "subcontractOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "SubcontractConsumption_tenantId_kitLineId_seq_key" ON "SubcontractConsumption"("tenantId", "kitLineId", "seq");

-- CreateIndex
CREATE INDEX "SubcontractCostEntry_tenantId_subcontractOrderId_occurredAt_idx" ON "SubcontractCostEntry"("tenantId", "subcontractOrderId", "occurredAt");

-- CreateIndex
CREATE INDEX "SubcontractCostEntry_tenantId_workOrderId_idx" ON "SubcontractCostEntry"("tenantId", "workOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "SubcontractCostEntry_tenantId_reversalOfId_key" ON "SubcontractCostEntry"("tenantId", "reversalOfId");

-- CreateIndex
CREATE UNIQUE INDEX "SubcontractCostEntry_tenantId_subcontractOrderId_id_key" ON "SubcontractCostEntry"("tenantId", "subcontractOrderId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrderLine_tenantId_partyId_siteId_id_key" ON "PurchaseOrderLine"("tenantId", "partyId", "siteId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SubcontractKitLine_tenantId_siteId_partyId_subcontractOrder_key" ON "SubcontractKitLine"("tenantId", "siteId", "partyId", "subcontractOrderId", "id");

-- AddForeignKey
ALTER TABLE "PurchaseOrderLineDelivery" ADD CONSTRAINT "PurchaseOrderLineDelivery_tenantId_partyId_siteId_purchase_fkey" FOREIGN KEY ("tenantId", "partyId", "siteId", "purchaseOrderLineId") REFERENCES "PurchaseOrderLine"("tenantId", "partyId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PoDateChange" ADD CONSTRAINT "PoDateChange_tenantId_partyId_siteId_purchaseOrderLineId_fkey" FOREIGN KEY ("tenantId", "partyId", "siteId", "purchaseOrderLineId") REFERENCES "PurchaseOrderLine"("tenantId", "partyId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PoDateChange" ADD CONSTRAINT "PoDateChange_tenantId_purchaseOrderLineId_deliveryId_fkey" FOREIGN KEY ("tenantId", "purchaseOrderLineId", "deliveryId") REFERENCES "PurchaseOrderLineDelivery"("tenantId", "purchaseOrderLineId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DeliveryTolerance" ADD CONSTRAINT "DeliveryTolerance_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DeliveryTolerance" ADD CONSTRAINT "DeliveryTolerance_tenantId_supplierId_fkey" FOREIGN KEY ("tenantId", "supplierId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DeliveryTolerance" ADD CONSTRAINT "DeliveryTolerance_tenantId_itemId_fkey" FOREIGN KEY ("tenantId", "itemId") REFERENCES "Item"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ItemVariant" ADD CONSTRAINT "ItemVariant_tenantId_itemId_fkey" FOREIGN KEY ("tenantId", "itemId") REFERENCES "Item"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ItemVariant" ADD CONSTRAINT "ItemVariant_tenantId_itemId_itemColourId_fkey" FOREIGN KEY ("tenantId", "itemId", "itemColourId") REFERENCES "ItemColour"("tenantId", "itemId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PurchaseRequest" ADD CONSTRAINT "PurchaseRequest_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PurchaseRequest" ADD CONSTRAINT "PurchaseRequest_tenantId_itemId_fkey" FOREIGN KEY ("tenantId", "itemId") REFERENCES "Item"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PurchaseRequest" ADD CONSTRAINT "PurchaseRequest_tenantId_itemId_itemColourId_fkey" FOREIGN KEY ("tenantId", "itemId", "itemColourId") REFERENCES "ItemColour"("tenantId", "itemId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PurchaseRequest" ADD CONSTRAINT "PurchaseRequest_tenantId_siteId_workOrderId_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId") REFERENCES "WorkOrder"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PurchaseRequest" ADD CONSTRAINT "PurchaseRequest_tenantId_siteId_purchaseOrderLineId_fkey" FOREIGN KEY ("tenantId", "siteId", "purchaseOrderLineId") REFERENCES "PurchaseOrderLine"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SubcontractConsumption" ADD CONSTRAINT "SubcontractConsumption_tenantId_siteId_workOrderId_partyId_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId", "partyId", "subcontractOrderId") REFERENCES "SubcontractOrder"("tenantId", "siteId", "workOrderId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SubcontractConsumption" ADD CONSTRAINT "SubcontractConsumption_tenantId_siteId_partyId_subcontract_fkey" FOREIGN KEY ("tenantId", "siteId", "partyId", "subcontractOrderId", "kitLineId") REFERENCES "SubcontractKitLine"("tenantId", "siteId", "partyId", "subcontractOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SubcontractConsumption" ADD CONSTRAINT "SubcontractConsumption_tenantId_siteId_workOrderId_subcont_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId", "subcontractOrderId", "receiptId") REFERENCES "SubcontractReceipt"("tenantId", "siteId", "workOrderId", "subcontractOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SubcontractCostEntry" ADD CONSTRAINT "SubcontractCostEntry_tenantId_siteId_workOrderId_subcontra_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId", "subcontractOrderId") REFERENCES "SubcontractOrder"("tenantId", "siteId", "workOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SubcontractCostEntry" ADD CONSTRAINT "SubcontractCostEntry_operation_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId", "subcontractOrderId", "subcontractOperationId") REFERENCES "SubcontractOperation"("tenantId", "siteId", "workOrderId", "subcontractOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SubcontractCostEntry" ADD CONSTRAINT "SubcontractCostEntry_receipt_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId", "subcontractOrderId", "receiptId") REFERENCES "SubcontractReceipt"("tenantId", "siteId", "workOrderId", "subcontractOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SubcontractCostEntry" ADD CONSTRAINT "SubcontractCostEntry_tenantId_subcontractOrderId_reversalO_fkey" FOREIGN KEY ("tenantId", "subcontractOrderId", "reversalOfId") REFERENCES "SubcontractCostEntry"("tenantId", "subcontractOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Lot" ADD CONSTRAINT "Lot_tenantId_itemId_variantCode_fkey" FOREIGN KEY ("tenantId", "itemId", "variantCode") REFERENCES "ItemVariant"("tenantId", "itemId", "code") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_tenantId_developmentStyleId_fkey" FOREIGN KEY ("tenantId", "developmentStyleId") REFERENCES "Style"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_tenantId_developmentStyleId_sampleRoundId_fkey" FOREIGN KEY ("tenantId", "developmentStyleId", "sampleRoundId") REFERENCES "SampleRound"("tenantId", "styleId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_tenantId_shipToPartyId_fkey" FOREIGN KEY ("tenantId", "shipToPartyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_tenantId_shipToPartyId_shipToAddressId_fkey" FOREIGN KEY ("tenantId", "shipToPartyId", "shipToAddressId") REFERENCES "PartyAddress"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_tenantId_siteId_shipToLocationId_fkey" FOREIGN KEY ("tenantId", "siteId", "shipToLocationId") REFERENCES "Location"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_tenantId_certificateId_fkey" FOREIGN KEY ("tenantId", "certificateId") REFERENCES "Certificate"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_tenantId_itemId_variantCode_fkey" FOREIGN KEY ("tenantId", "itemId", "variantCode") REFERENCES "ItemVariant"("tenantId", "itemId", "code") ON DELETE RESTRICT ON UPDATE RESTRICT;

