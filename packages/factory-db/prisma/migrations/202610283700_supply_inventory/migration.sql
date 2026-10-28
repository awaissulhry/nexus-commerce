-- CreateEnum
CREATE TYPE "LocationKind" AS ENUM ('WAREHOUSE', 'ZONE', 'BIN', 'RECEIVING', 'QUARANTINE', 'PRODUCTION', 'SHIPPING');

-- CreateEnum
CREATE TYPE "GoodsReceiptStatus" AS ENUM ('OPEN', 'POSTED', 'REVERSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "LotQualityStatus" AS ENUM ('QUARANTINE', 'RELEASED', 'REJECTED', 'BLOCKED');

-- CreateEnum
CREATE TYPE "CrViStatus" AS ENUM ('NOT_REQUIRED', 'PENDING', 'PASS', 'FAIL');

-- CreateEnum
CREATE TYPE "CrViEvidence" AS ENUM ('LOT_REPORT', 'SUPPLIER_REPORT');

-- CreateEnum
CREATE TYPE "HideState" AS ENUM ('FULL', 'PARTLY_CUT', 'REMNANT', 'CONSUMED', 'SCRAPPED');

-- CreateEnum
CREATE TYPE "StockMoveReason" AS ENUM ('OPENING', 'RECEIPT', 'ISSUE', 'RETURN', 'TRANSFER', 'ADJUSTMENT', 'COUNT', 'SCRAP');

-- CreateEnum
CREATE TYPE "StockValuationMethod" AS ENUM ('PURCHASE_PRICE', 'LOT_COST', 'STANDARD_COST', 'MANUAL');

-- CreateEnum
CREATE TYPE "PurchaseOrderStatus" AS ENUM ('DRAFT', 'SENT', 'CONFIRMED', 'DECLINED', 'PARTLY_RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PurchaseConfirmationChannel" AS ENUM ('LINK', 'OFFICE');

-- CreateEnum
CREATE TYPE "PlanningTrigger" AS ENUM ('MANUAL', 'ORDER', 'SCHEDULED');

-- CreateEnum
CREATE TYPE "PlanningRunStatus" AS ENUM ('RUNNING', 'DONE', 'FAILED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "RequirementAction" AS ENUM ('BUY', 'MAKE');

-- CreateEnum
CREATE TYPE "RequirementDecision" AS ENUM ('OPEN', 'ORDERED', 'IGNORED');

-- CreateTable
CREATE TABLE "Location" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "parentId" UUID,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "LocationKind" NOT NULL,
    "status" "MasterStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "Location_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoodsReceipt" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "supplierId" UUID NOT NULL,
    "purchaseOrderId" UUID,
    "supplierDdtNumber" TEXT,
    "supplierDdtDate" DATE,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL,
    "status" "GoodsReceiptStatus" NOT NULL DEFAULT 'OPEN',
    "note" TEXT,
    "postedAt" TIMESTAMPTZ(3),
    "postedById" UUID,
    "reversedAt" TIMESTAMPTZ(3),
    "reversedById" UUID,
    "reversalReason" TEXT,
    "cancelledAt" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "GoodsReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoodsReceiptLine" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "receiptId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "purchaseOrderLineId" UUID,
    "itemId" UUID NOT NULL,
    "itemColourId" UUID,
    "quantity" DECIMAL(18,4) NOT NULL,
    "uom" "Uom" NOT NULL,
    "baseQuantity" DECIMAL(18,4) NOT NULL,
    "hideCount" INTEGER,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "GoodsReceiptLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lot" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "itemColourId" UUID,
    "code" TEXT NOT NULL,
    "supplierId" UUID,
    "supplierLotRef" TEXT,
    "dyeBatch" TEXT,
    "shade" TEXT,
    "receiptLineId" UUID,
    "receivedAt" TIMESTAMPTZ(3),
    "qualityStatus" "LotQualityStatus" NOT NULL DEFAULT 'QUARANTINE',
    "qualityNote" TEXT,
    "qualityDecidedAt" TIMESTAMPTZ(3),
    "qualityDecidedById" UUID,
    "requiresCrViTest" BOOLEAN NOT NULL DEFAULT false,
    "crViLimitMgKg" DECIMAL(8,3),
    "crViStatus" "CrViStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
    "crViMgKg" DECIMAL(8,3),
    "crViEvidence" "CrViEvidence",
    "crViTestedAt" DATE,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "Lot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Hide" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "lotId" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "supplierCode" TEXT,
    "area" DECIMAL(18,4) NOT NULL,
    "areaUom" "Uom" NOT NULL,
    "baseArea" DECIMAL(18,4) NOT NULL,
    "grade" TEXT,
    "shade" TEXT,
    "thicknessMm" DECIMAL(6,2),
    "defects" TEXT,
    "state" "HideState" NOT NULL DEFAULT 'FULL',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "Hide_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockMove" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "reason" "StockMoveReason" NOT NULL,
    "itemId" UUID NOT NULL,
    "itemColourId" UUID,
    "lotId" UUID,
    "hideId" UUID,
    "fromLocationId" UUID,
    "toLocationId" UUID,
    "quantity" DECIMAL(18,4) NOT NULL,
    "uom" "Uom" NOT NULL,
    "baseQuantity" DECIMAL(18,4) NOT NULL,
    "receiptLineId" UUID,
    "workOrderId" UUID,
    "reference" TEXT,
    "note" TEXT,
    "reversalOfId" UUID,
    "idempotencyKey" TEXT NOT NULL,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "deviceId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "StockMove_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockValuation" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "moveId" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "lotId" UUID,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unitCost" DECIMAL(18,6) NOT NULL,
    "valueAmount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "method" "StockValuationMethod" NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "StockValuation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrder" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "partyId" UUID NOT NULL,
    "contactId" UUID,
    "status" "PurchaseOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "orderDate" DATE NOT NULL,
    "requestedDate" DATE,
    "incoterms" TEXT,
    "paymentTerms" TEXT,
    "note" TEXT,
    "internalNote" TEXT,
    "netAmount" INTEGER NOT NULL DEFAULT 0,
    "sentAt" TIMESTAMPTZ(3),
    "sentById" UUID,
    "confirmedAt" TIMESTAMPTZ(3),
    "confirmedVia" "PurchaseConfirmationChannel",
    "confirmLinkId" UUID,
    "confirmedByName" TEXT,
    "supplierRef" TEXT,
    "confirmNote" TEXT,
    "declinedAt" TIMESTAMPTZ(3),
    "declineReason" TEXT,
    "closedAt" TIMESTAMPTZ(3),
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "PurchaseOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrderLine" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "purchaseOrderId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "itemId" UUID NOT NULL,
    "itemColourId" UUID,
    "description" TEXT,
    "supplierArticleCode" TEXT,
    "supplierColourCode" TEXT,
    "quantity" DECIMAL(18,4) NOT NULL,
    "uom" "Uom" NOT NULL,
    "baseQuantity" DECIMAL(18,4) NOT NULL,
    "unitPrice" DECIMAL(18,6) NOT NULL,
    "netAmount" INTEGER NOT NULL,
    "needDate" DATE NOT NULL,
    "grade" TEXT,
    "thicknessMinMm" DECIMAL(6,2),
    "thicknessMaxMm" DECIMAL(6,2),
    "oneDyeBatch" BOOLEAN NOT NULL DEFAULT false,
    "areaTolerancePct" DECIMAL(7,4),
    "estimatedHides" INTEGER,
    "requiresCrViTest" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "confirmedQuantity" DECIMAL(18,4),
    "confirmedDate" DATE,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "PurchaseOrderLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlanningRun" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "trigger" "PlanningTrigger" NOT NULL,
    "status" "PlanningRunStatus" NOT NULL DEFAULT 'RUNNING',
    "orderLines" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMPTZ(3) NOT NULL,
    "finishedAt" TIMESTAMPTZ(3),
    "error" TEXT,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "PlanningRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaterialRequirement" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "itemId" UUID NOT NULL,
    "itemColourId" UUID,
    "action" "RequirementAction" NOT NULL,
    "uom" "Uom" NOT NULL,
    "grossQuantity" DECIMAL(18,4) NOT NULL,
    "usableStock" DECIMAL(18,4) NOT NULL,
    "heldStock" DECIMAL(18,4) NOT NULL,
    "onOrder" DECIMAL(18,4) NOT NULL,
    "netQuantity" DECIMAL(18,4) NOT NULL,
    "suggestedQuantity" DECIMAL(18,4) NOT NULL,
    "suggestedUom" "Uom" NOT NULL,
    "needDate" DATE NOT NULL,
    "supplierId" UUID,
    "sources" JSONB NOT NULL,
    "decision" "RequirementDecision" NOT NULL DEFAULT 'OPEN',
    "decisionNote" TEXT,
    "purchaseOrderLineId" UUID,
    "decidedAt" TIMESTAMPTZ(3),
    "decidedById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "MaterialRequirement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Location_tenantId_siteId_code_key" ON "Location"("tenantId", "siteId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Location_tenantId_siteId_id_key" ON "Location"("tenantId", "siteId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "GoodsReceipt_tenantId_companyId_number_key" ON "GoodsReceipt"("tenantId", "companyId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "GoodsReceipt_tenantId_siteId_id_key" ON "GoodsReceipt"("tenantId", "siteId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "GoodsReceiptLine_tenantId_receiptId_seq_key" ON "GoodsReceiptLine"("tenantId", "receiptId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "GoodsReceiptLine_tenantId_siteId_id_key" ON "GoodsReceiptLine"("tenantId", "siteId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Lot_tenantId_code_key" ON "Lot"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Lot_tenantId_siteId_itemId_id_key" ON "Lot"("tenantId", "siteId", "itemId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Hide_tenantId_code_key" ON "Hide"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Hide_tenantId_siteId_lotId_id_key" ON "Hide"("tenantId", "siteId", "lotId", "id");

-- CreateIndex
CREATE INDEX "StockMove_tenantId_siteId_itemId_lotId_hideId_idx" ON "StockMove"("tenantId", "siteId", "itemId", "lotId", "hideId");

-- CreateIndex
CREATE UNIQUE INDEX "StockMove_tenantId_idempotencyKey_key" ON "StockMove"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "StockMove_tenantId_siteId_id_key" ON "StockMove"("tenantId", "siteId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "StockValuation_tenantId_idempotencyKey_key" ON "StockValuation"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_tenantId_companyId_number_key" ON "PurchaseOrder"("tenantId", "companyId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_tenantId_partyId_siteId_id_key" ON "PurchaseOrder"("tenantId", "partyId", "siteId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_tenantId_siteId_id_key" ON "PurchaseOrder"("tenantId", "siteId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrderLine_tenantId_purchaseOrderId_seq_key" ON "PurchaseOrderLine"("tenantId", "purchaseOrderId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrderLine_tenantId_siteId_id_key" ON "PurchaseOrderLine"("tenantId", "siteId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PlanningRun_tenantId_siteId_id_key" ON "PlanningRun"("tenantId", "siteId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "MaterialRequirement_tenantId_runId_seq_key" ON "MaterialRequirement"("tenantId", "runId", "seq");

-- AddForeignKey
ALTER TABLE "Location" ADD CONSTRAINT "Location_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Location" ADD CONSTRAINT "Location_tenantId_siteId_parentId_fkey" FOREIGN KEY ("tenantId", "siteId", "parentId") REFERENCES "Location"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "GoodsReceipt" ADD CONSTRAINT "GoodsReceipt_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "GoodsReceipt" ADD CONSTRAINT "GoodsReceipt_tenantId_supplierId_fkey" FOREIGN KEY ("tenantId", "supplierId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "GoodsReceipt" ADD CONSTRAINT "GoodsReceipt_tenantId_siteId_purchaseOrderId_fkey" FOREIGN KEY ("tenantId", "siteId", "purchaseOrderId") REFERENCES "PurchaseOrder"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "GoodsReceiptLine" ADD CONSTRAINT "GoodsReceiptLine_tenantId_siteId_receiptId_fkey" FOREIGN KEY ("tenantId", "siteId", "receiptId") REFERENCES "GoodsReceipt"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "GoodsReceiptLine" ADD CONSTRAINT "GoodsReceiptLine_tenantId_siteId_purchaseOrderLineId_fkey" FOREIGN KEY ("tenantId", "siteId", "purchaseOrderLineId") REFERENCES "PurchaseOrderLine"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "GoodsReceiptLine" ADD CONSTRAINT "GoodsReceiptLine_tenantId_itemId_fkey" FOREIGN KEY ("tenantId", "itemId") REFERENCES "Item"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "GoodsReceiptLine" ADD CONSTRAINT "GoodsReceiptLine_tenantId_itemId_itemColourId_fkey" FOREIGN KEY ("tenantId", "itemId", "itemColourId") REFERENCES "ItemColour"("tenantId", "itemId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Lot" ADD CONSTRAINT "Lot_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Lot" ADD CONSTRAINT "Lot_tenantId_itemId_fkey" FOREIGN KEY ("tenantId", "itemId") REFERENCES "Item"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Lot" ADD CONSTRAINT "Lot_tenantId_itemId_itemColourId_fkey" FOREIGN KEY ("tenantId", "itemId", "itemColourId") REFERENCES "ItemColour"("tenantId", "itemId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Lot" ADD CONSTRAINT "Lot_tenantId_supplierId_fkey" FOREIGN KEY ("tenantId", "supplierId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Lot" ADD CONSTRAINT "Lot_tenantId_siteId_receiptLineId_fkey" FOREIGN KEY ("tenantId", "siteId", "receiptLineId") REFERENCES "GoodsReceiptLine"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Hide" ADD CONSTRAINT "Hide_tenantId_siteId_itemId_lotId_fkey" FOREIGN KEY ("tenantId", "siteId", "itemId", "lotId") REFERENCES "Lot"("tenantId", "siteId", "itemId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StockMove" ADD CONSTRAINT "StockMove_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StockMove" ADD CONSTRAINT "StockMove_tenantId_itemId_fkey" FOREIGN KEY ("tenantId", "itemId") REFERENCES "Item"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StockMove" ADD CONSTRAINT "StockMove_tenantId_itemId_itemColourId_fkey" FOREIGN KEY ("tenantId", "itemId", "itemColourId") REFERENCES "ItemColour"("tenantId", "itemId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StockMove" ADD CONSTRAINT "StockMove_tenantId_siteId_itemId_lotId_fkey" FOREIGN KEY ("tenantId", "siteId", "itemId", "lotId") REFERENCES "Lot"("tenantId", "siteId", "itemId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StockMove" ADD CONSTRAINT "StockMove_tenantId_siteId_lotId_hideId_fkey" FOREIGN KEY ("tenantId", "siteId", "lotId", "hideId") REFERENCES "Hide"("tenantId", "siteId", "lotId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StockMove" ADD CONSTRAINT "StockMove_tenantId_siteId_fromLocationId_fkey" FOREIGN KEY ("tenantId", "siteId", "fromLocationId") REFERENCES "Location"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StockMove" ADD CONSTRAINT "StockMove_tenantId_siteId_toLocationId_fkey" FOREIGN KEY ("tenantId", "siteId", "toLocationId") REFERENCES "Location"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StockMove" ADD CONSTRAINT "StockMove_tenantId_siteId_receiptLineId_fkey" FOREIGN KEY ("tenantId", "siteId", "receiptLineId") REFERENCES "GoodsReceiptLine"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StockMove" ADD CONSTRAINT "StockMove_tenantId_siteId_reversalOfId_fkey" FOREIGN KEY ("tenantId", "siteId", "reversalOfId") REFERENCES "StockMove"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StockMove" ADD CONSTRAINT "StockMove_tenantId_siteId_deviceId_fkey" FOREIGN KEY ("tenantId", "siteId", "deviceId") REFERENCES "Device"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StockValuation" ADD CONSTRAINT "StockValuation_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StockValuation" ADD CONSTRAINT "StockValuation_tenantId_siteId_moveId_fkey" FOREIGN KEY ("tenantId", "siteId", "moveId") REFERENCES "StockMove"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StockValuation" ADD CONSTRAINT "StockValuation_tenantId_itemId_fkey" FOREIGN KEY ("tenantId", "itemId") REFERENCES "Item"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StockValuation" ADD CONSTRAINT "StockValuation_tenantId_siteId_itemId_lotId_fkey" FOREIGN KEY ("tenantId", "siteId", "itemId", "lotId") REFERENCES "Lot"("tenantId", "siteId", "itemId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_tenantId_partyId_fkey" FOREIGN KEY ("tenantId", "partyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_tenantId_partyId_contactId_fkey" FOREIGN KEY ("tenantId", "partyId", "contactId") REFERENCES "PartyContact"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_tenantId_partyId_confirmLinkId_fkey" FOREIGN KEY ("tenantId", "partyId", "confirmLinkId") REFERENCES "OneOffLink"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_tenantId_partyId_siteId_purchaseOrderId_fkey" FOREIGN KEY ("tenantId", "partyId", "siteId", "purchaseOrderId") REFERENCES "PurchaseOrder"("tenantId", "partyId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_tenantId_itemId_fkey" FOREIGN KEY ("tenantId", "itemId") REFERENCES "Item"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_tenantId_itemId_itemColourId_fkey" FOREIGN KEY ("tenantId", "itemId", "itemColourId") REFERENCES "ItemColour"("tenantId", "itemId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PlanningRun" ADD CONSTRAINT "PlanningRun_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MaterialRequirement" ADD CONSTRAINT "MaterialRequirement_tenantId_siteId_runId_fkey" FOREIGN KEY ("tenantId", "siteId", "runId") REFERENCES "PlanningRun"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MaterialRequirement" ADD CONSTRAINT "MaterialRequirement_tenantId_itemId_fkey" FOREIGN KEY ("tenantId", "itemId") REFERENCES "Item"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MaterialRequirement" ADD CONSTRAINT "MaterialRequirement_tenantId_itemId_itemColourId_fkey" FOREIGN KEY ("tenantId", "itemId", "itemColourId") REFERENCES "ItemColour"("tenantId", "itemId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MaterialRequirement" ADD CONSTRAINT "MaterialRequirement_tenantId_supplierId_fkey" FOREIGN KEY ("tenantId", "supplierId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MaterialRequirement" ADD CONSTRAINT "MaterialRequirement_tenantId_siteId_purchaseOrderLineId_fkey" FOREIGN KEY ("tenantId", "siteId", "purchaseOrderLineId") REFERENCES "PurchaseOrderLine"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

