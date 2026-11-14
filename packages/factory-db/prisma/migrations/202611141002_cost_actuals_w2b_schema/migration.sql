-- CreateEnum
CREATE TYPE "WorkOrderVarianceCategory" AS ENUM ('MATERIAL_PRICE', 'MATERIAL_USAGE', 'LABOUR_EFFICIENCY', 'LABOUR_RATE', 'SCRAP', 'REWORK', 'SUBCONTRACT_PRICE', 'LOT_SIZE', 'OVERHEAD');

-- CreateEnum
CREATE TYPE "PurchasePriceVarianceAt" AS ENUM ('RECEIPT', 'INVOICE');

-- CreateEnum
CREATE TYPE "LandedCostBasis" AS ENUM ('VALUE', 'WEIGHT', 'QUANTITY');

-- CreateEnum
CREATE TYPE "LandedCostStatus" AS ENUM ('DRAFT', 'POSTED', 'REVERSED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "WorkOrderCostKind" ADD VALUE 'CLOSE';
ALTER TYPE "WorkOrderCostKind" ADD VALUE 'VARIANCE';

-- CreateTable
CREATE TABLE "ActualCostSettings" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID,
    "closeTolerancePct" DECIMAL(7,4) NOT NULL DEFAULT 5,
    "ppvAt" "PurchasePriceVarianceAt" NOT NULL DEFAULT 'RECEIPT',
    "postingsOn" BOOLEAN NOT NULL DEFAULT false,
    "postingsOnAt" TIMESTAMPTZ(3),
    "postingsOnById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "ActualCostSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkOrderClose" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "workOrderId" UUID NOT NULL,
    "plannedQuantity" INTEGER NOT NULL,
    "actualQuantity" INTEGER NOT NULL,
    "plannedScrapQuantity" INTEGER NOT NULL DEFAULT 0,
    "scrapQuantity" INTEGER NOT NULL DEFAULT 0,
    "plannedMaterialCost" INTEGER NOT NULL,
    "actualMaterialCost" INTEGER NOT NULL,
    "plannedMinutes" DECIMAL(18,4) NOT NULL,
    "actualMinutes" DECIMAL(18,4) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "tolerancePct" DECIMAL(7,4) NOT NULL,
    "reasonCode" TEXT,
    "reasonNote" TEXT,
    "closedAt" TIMESTAMPTZ(3) NOT NULL,
    "closedById" UUID NOT NULL,
    "undoneAt" TIMESTAMPTZ(3),
    "undoneById" UUID,
    "reopenReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "WorkOrderClose_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkOrderVariance" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "workOrderId" UUID NOT NULL,
    "closeId" UUID NOT NULL,
    "category" "WorkOrderVarianceCategory" NOT NULL,
    "itemId" UUID,
    "standardQuantity" DECIMAL(18,4),
    "actualQuantity" DECIMAL(18,4),
    "standardUnitCost" DECIMAL(18,6),
    "actualUnitCost" DECIMAL(18,6),
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "note" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "WorkOrderVariance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchasePriceVariance" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "at" "PurchasePriceVarianceAt" NOT NULL,
    "siteId" UUID,
    "receiptLineId" UUID,
    "supplierInvoiceLineId" UUID,
    "itemId" UUID NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "standardUnitCost" DECIMAL(18,6) NOT NULL,
    "standardCostId" UUID,
    "paidUnitCost" DECIMAL(18,6) NOT NULL,
    "differenceAmount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "postedAt" TIMESTAMPTZ(3) NOT NULL,
    "reversalOfId" UUID,
    "reason" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "PurchasePriceVariance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CostOfSalesEntry" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "siteId" UUID,
    "shipmentLineId" UUID,
    "invoiceLineId" UUID,
    "stockMoveId" UUID,
    "quantity" DECIMAL(18,4) NOT NULL,
    "materialAmount" INTEGER NOT NULL DEFAULT 0,
    "labourAmount" INTEGER NOT NULL DEFAULT 0,
    "subcontractAmount" INTEGER NOT NULL DEFAULT 0,
    "overheadAmount" INTEGER NOT NULL DEFAULT 0,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "postedAt" TIMESTAMPTZ(3) NOT NULL,
    "reversalOfId" UUID,
    "reason" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "CostOfSalesEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LandedCostAllocation" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "supplierInvoiceLineId" UUID NOT NULL,
    "basis" "LandedCostBasis" NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "status" "LandedCostStatus" NOT NULL DEFAULT 'DRAFT',
    "postedAt" TIMESTAMPTZ(3),
    "postedById" UUID,
    "reversedAt" TIMESTAMPTZ(3),
    "reversedById" UUID,
    "reverseReason" TEXT,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "LandedCostAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LandedCostShare" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "allocationId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "lotId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "basisAmount" DECIMAL(18,4) NOT NULL,
    "amount" INTEGER NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "LandedCostShare_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ActualCostSettings_tenantId_companyId_idx" ON "ActualCostSettings"("tenantId", "companyId");

-- CreateIndex
CREATE INDEX "WorkOrderClose_tenantId_workOrderId_closedAt_idx" ON "WorkOrderClose"("tenantId", "workOrderId", "closedAt");

-- CreateIndex
CREATE INDEX "WorkOrderClose_tenantId_companyId_closedAt_idx" ON "WorkOrderClose"("tenantId", "companyId", "closedAt");

-- CreateIndex
CREATE UNIQUE INDEX "WorkOrderClose_tenantId_workOrderId_id_key" ON "WorkOrderClose"("tenantId", "workOrderId", "id");

-- CreateIndex
CREATE INDEX "WorkOrderVariance_tenantId_closeId_idx" ON "WorkOrderVariance"("tenantId", "closeId");

-- CreateIndex
CREATE INDEX "WorkOrderVariance_tenantId_companyId_category_idx" ON "WorkOrderVariance"("tenantId", "companyId", "category");

-- CreateIndex
CREATE INDEX "PurchasePriceVariance_tenantId_companyId_postedAt_idx" ON "PurchasePriceVariance"("tenantId", "companyId", "postedAt");

-- CreateIndex
CREATE INDEX "PurchasePriceVariance_tenantId_receiptLineId_idx" ON "PurchasePriceVariance"("tenantId", "receiptLineId");

-- CreateIndex
CREATE INDEX "PurchasePriceVariance_tenantId_supplierInvoiceLineId_idx" ON "PurchasePriceVariance"("tenantId", "supplierInvoiceLineId");

-- CreateIndex
CREATE UNIQUE INDEX "PurchasePriceVariance_tenantId_idempotencyKey_key" ON "PurchasePriceVariance"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "PurchasePriceVariance_tenantId_id_key" ON "PurchasePriceVariance"("tenantId", "id");

-- CreateIndex
CREATE INDEX "CostOfSalesEntry_tenantId_companyId_postedAt_idx" ON "CostOfSalesEntry"("tenantId", "companyId", "postedAt");

-- CreateIndex
CREATE INDEX "CostOfSalesEntry_tenantId_shipmentLineId_idx" ON "CostOfSalesEntry"("tenantId", "shipmentLineId");

-- CreateIndex
CREATE INDEX "CostOfSalesEntry_tenantId_invoiceLineId_idx" ON "CostOfSalesEntry"("tenantId", "invoiceLineId");

-- CreateIndex
CREATE UNIQUE INDEX "CostOfSalesEntry_tenantId_idempotencyKey_key" ON "CostOfSalesEntry"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "CostOfSalesEntry_tenantId_id_key" ON "CostOfSalesEntry"("tenantId", "id");

-- CreateIndex
CREATE INDEX "LandedCostAllocation_tenantId_supplierInvoiceLineId_idx" ON "LandedCostAllocation"("tenantId", "supplierInvoiceLineId");

-- CreateIndex
CREATE INDEX "LandedCostAllocation_tenantId_companyId_status_idx" ON "LandedCostAllocation"("tenantId", "companyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "LandedCostAllocation_tenantId_id_key" ON "LandedCostAllocation"("tenantId", "id");

-- CreateIndex
CREATE INDEX "LandedCostShare_tenantId_allocationId_idx" ON "LandedCostShare"("tenantId", "allocationId");

-- CreateIndex
CREATE INDEX "LandedCostShare_tenantId_lotId_idx" ON "LandedCostShare"("tenantId", "lotId");

-- CreateIndex
CREATE UNIQUE INDEX "LandedCostShare_tenantId_key_key" ON "LandedCostShare"("tenantId", "key");

-- AddForeignKey
ALTER TABLE "ActualCostSettings" ADD CONSTRAINT "ActualCostSettings_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkOrderClose" ADD CONSTRAINT "WorkOrderClose_tenantId_siteId_workOrderId_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId") REFERENCES "WorkOrder"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkOrderVariance" ADD CONSTRAINT "WorkOrderVariance_tenantId_workOrderId_closeId_fkey" FOREIGN KEY ("tenantId", "workOrderId", "closeId") REFERENCES "WorkOrderClose"("tenantId", "workOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkOrderVariance" ADD CONSTRAINT "WorkOrderVariance_tenantId_itemId_fkey" FOREIGN KEY ("tenantId", "itemId") REFERENCES "Item"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PurchasePriceVariance" ADD CONSTRAINT "PurchasePriceVariance_tenantId_partyId_fkey" FOREIGN KEY ("tenantId", "partyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PurchasePriceVariance" ADD CONSTRAINT "PurchasePriceVariance_tenantId_siteId_receiptLineId_fkey" FOREIGN KEY ("tenantId", "siteId", "receiptLineId") REFERENCES "GoodsReceiptLine"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PurchasePriceVariance" ADD CONSTRAINT "PurchasePriceVariance_tenantId_partyId_supplierInvoiceLine_fkey" FOREIGN KEY ("tenantId", "partyId", "supplierInvoiceLineId") REFERENCES "SupplierInvoiceLine"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PurchasePriceVariance" ADD CONSTRAINT "PurchasePriceVariance_tenantId_itemId_fkey" FOREIGN KEY ("tenantId", "itemId") REFERENCES "Item"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PurchasePriceVariance" ADD CONSTRAINT "PurchasePriceVariance_tenantId_companyId_standardCostId_fkey" FOREIGN KEY ("tenantId", "companyId", "standardCostId") REFERENCES "StandardCost"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PurchasePriceVariance" ADD CONSTRAINT "PurchasePriceVariance_tenantId_reversalOfId_fkey" FOREIGN KEY ("tenantId", "reversalOfId") REFERENCES "PurchasePriceVariance"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CostOfSalesEntry" ADD CONSTRAINT "CostOfSalesEntry_tenantId_siteId_shipmentLineId_fkey" FOREIGN KEY ("tenantId", "siteId", "shipmentLineId") REFERENCES "ShipmentLine"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CostOfSalesEntry" ADD CONSTRAINT "CostOfSalesEntry_tenantId_partyId_invoiceLineId_fkey" FOREIGN KEY ("tenantId", "partyId", "invoiceLineId") REFERENCES "InvoiceLine"("tenantId", "buyerPartyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CostOfSalesEntry" ADD CONSTRAINT "CostOfSalesEntry_tenantId_siteId_stockMoveId_fkey" FOREIGN KEY ("tenantId", "siteId", "stockMoveId") REFERENCES "StockMove"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CostOfSalesEntry" ADD CONSTRAINT "CostOfSalesEntry_tenantId_reversalOfId_fkey" FOREIGN KEY ("tenantId", "reversalOfId") REFERENCES "CostOfSalesEntry"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LandedCostAllocation" ADD CONSTRAINT "LandedCostAllocation_tenantId_partyId_supplierInvoiceLineI_fkey" FOREIGN KEY ("tenantId", "partyId", "supplierInvoiceLineId") REFERENCES "SupplierInvoiceLine"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LandedCostShare" ADD CONSTRAINT "LandedCostShare_tenantId_allocationId_fkey" FOREIGN KEY ("tenantId", "allocationId") REFERENCES "LandedCostAllocation"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LandedCostShare" ADD CONSTRAINT "LandedCostShare_tenantId_siteId_itemId_lotId_fkey" FOREIGN KEY ("tenantId", "siteId", "itemId", "lotId") REFERENCES "Lot"("tenantId", "siteId", "itemId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

