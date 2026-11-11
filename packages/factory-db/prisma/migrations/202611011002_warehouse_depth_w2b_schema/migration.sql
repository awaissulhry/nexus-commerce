-- CreateEnum
CREATE TYPE "LocationBlockReason" AS ENUM ('COUNT', 'DAMAGE', 'CLEAN_UP', 'OTHER');

-- CreateEnum
CREATE TYPE "GoodsReceiptKind" AS ENUM ('STANDARD', 'UNPLANNED');

-- CreateEnum
CREATE TYPE "LotLifecycle" AS ENUM ('QUARANTINE', 'RELEASED', 'IN_USE', 'DEPLETED', 'BLOCKED', 'RETURNED');

-- CreateEnum
CREATE TYPE "DefaultLocationPurpose" AS ENUM ('RECEIVING', 'QUALITY', 'ISSUE', 'RETURN', 'PUT_AWAY');

-- CreateEnum
CREATE TYPE "TransferStatus" AS ENUM ('DRAFT', 'SHIPPED', 'PARTLY_RECEIVED', 'RECEIVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TransferDifferenceResolution" AS ENUM ('ADJUSTMENT', 'CARRIER_CLAIM', 'SENT_BACK');

-- CreateEnum
CREATE TYPE "CountAbcClass" AS ENUM ('A', 'B', 'C');

-- CreateEnum
CREATE TYPE "StockCountPass" AS ENUM ('COUNT', 'RECOUNT');

-- CreateEnum
CREATE TYPE "WarehouseTaskKind" AS ENUM ('RECEIVE', 'PUT_AWAY', 'PICK', 'MOVE', 'COUNT', 'QUARANTINE');

-- CreateEnum
CREATE TYPE "WarehouseTaskStatus" AS ENUM ('OPEN', 'TAKEN', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "MaterialSubstitutionStatus" AS ENUM ('WAITING', 'APPROVED', 'ISSUED', 'REFUSED', 'WITHDRAWN');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "LocationKind" ADD VALUE 'CUSTOMER';
ALTER TYPE "LocationKind" ADD VALUE 'TRANSIT';
ALTER TYPE "LocationKind" ADD VALUE 'PICK_FACE';
ALTER TYPE "LocationKind" ADD VALUE 'BULK';

-- AlterEnum
ALTER TYPE "NumberKind" ADD VALUE 'TRANSFER';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "StockMoveReason" ADD VALUE 'TRANSFER_OUT';
ALTER TYPE "StockMoveReason" ADD VALUE 'TRANSFER_IN';

-- AlterTable
ALTER TABLE "GoodsReceipt" ADD COLUMN     "buyerTaskId" UUID,
ADD COLUMN     "holdingLocationId" UUID,
ADD COLUMN     "kind" "GoodsReceiptKind" NOT NULL DEFAULT 'STANDARD';

-- AlterTable
ALTER TABLE "Location" ADD COLUMN     "blockNote" TEXT,
ADD COLUMN     "blockReason" "LocationBlockReason",
ADD COLUMN     "blockedAt" TIMESTAMPTZ(3),
ADD COLUMN     "blockedById" UUID,
ADD COLUMN     "blockedUntil" DATE,
ADD COLUMN     "labelCode" TEXT;

-- AlterTable
ALTER TABLE "Lot" ADD COLUMN     "attributes" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "lifecycle" "LotLifecycle" NOT NULL DEFAULT 'QUARANTINE',
ADD COLUMN     "parentLotId" UUID;

-- AlterTable
ALTER TABLE "StockCount" ADD COLUMN     "freezeMoves" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "StockCountLine" ADD COLUMN     "frozenAt" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "StockMove" ADD COLUMN     "postingDate" DATE,
ADD COLUMN     "transferLineId" UUID;

-- CreateTable
CREATE TABLE "DefaultLocation" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "itemKind" "ItemKind",
    "purpose" "DefaultLocationPurpose" NOT NULL,
    "locationId" UUID NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,
    "updatedById" UUID,

    CONSTRAINT "DefaultLocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransferOrder" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "fromSiteId" UUID NOT NULL,
    "fromLocationId" UUID,
    "toCompanyId" UUID NOT NULL,
    "toSiteId" UUID NOT NULL,
    "toLocationId" UUID,
    "transitLocationId" UUID NOT NULL,
    "status" "TransferStatus" NOT NULL DEFAULT 'DRAFT',
    "shipOn" DATE,
    "expectedOn" DATE,
    "ddtNumberSeriesId" UUID,
    "ddtNumber" TEXT,
    "ddtDate" DATE,
    "ddtReason" "DdtReason" NOT NULL DEFAULT 'TRANSFER',
    "ddtReasonText" TEXT,
    "transportBy" "TransportBy",
    "carrier" JSONB,
    "packages" INTEGER,
    "grossWeightKg" DECIMAL(18,4),
    "appearance" TEXT,
    "ddtFileId" UUID,
    "trackingRef" TEXT,
    "trackingUrl" TEXT,
    "shippedAt" TIMESTAMPTZ(3),
    "shippedById" UUID,
    "receivedAt" TIMESTAMPTZ(3),
    "receivedById" UUID,
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelReason" TEXT,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "TransferOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransferLine" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "transferId" UUID NOT NULL,
    "fromSiteId" UUID NOT NULL,
    "toSiteId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "itemId" UUID NOT NULL,
    "itemColourId" UUID,
    "lotId" UUID,
    "hideId" UUID,
    "rollId" UUID,
    "fromLocationId" UUID,
    "quantity" DECIMAL(18,4) NOT NULL,
    "uom" "Uom" NOT NULL,
    "baseQuantity" DECIMAL(18,4) NOT NULL,
    "shippedQuantity" DECIMAL(18,4),
    "receivedQuantity" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "toLocationId" UUID,
    "toLotId" UUID,
    "toHideId" UUID,
    "toRollId" UUID,
    "differenceReasonCode" TEXT,
    "differenceNote" TEXT,
    "differenceResolution" "TransferDifferenceResolution",
    "resolvedAt" TIMESTAMPTZ(3),
    "resolvedById" UUID,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "TransferLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CountSchedule" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "locationId" UUID,
    "abcClass" "CountAbcClass",
    "itemKind" "ItemKind",
    "everyDays" INTEGER NOT NULL,
    "nextDueOn" DATE NOT NULL,
    "lastCountedOn" DATE,
    "lastCountId" UUID,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "CountSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockCountScan" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "countId" UUID NOT NULL,
    "lineId" UUID NOT NULL,
    "pass" "StockCountPass" NOT NULL DEFAULT 'COUNT',
    "code" TEXT,
    "quantity" DECIMAL(18,4) NOT NULL,
    "scannedAt" TIMESTAMPTZ(3) NOT NULL,
    "scannedById" UUID,
    "scannedByWorkerId" UUID,
    "deviceId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "StockCountScan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventorySettings" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID,
    "backDatingDays" INTEGER,
    "adjustmentApprovalAmount" INTEGER,
    "receiverNotMatcher" BOOLEAN,
    "counterNotApprover" BOOLEAN,
    "separationOffReason" TEXT,
    "lowStockAlerts" BOOLEAN,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,
    "updatedById" UUID,

    CONSTRAINT "InventorySettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WarehouseTask" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "kind" "WarehouseTaskKind" NOT NULL,
    "sourceType" TEXT,
    "sourceId" UUID,
    "itemId" UUID,
    "itemColourId" UUID,
    "lotId" UUID,
    "hideId" UUID,
    "fromLocationId" UUID,
    "toLocationId" UUID,
    "quantity" DECIMAL(18,4),
    "uom" "Uom",
    "assignedRoleId" UUID,
    "assignedWorkerId" UUID,
    "dueAt" TIMESTAMPTZ(3),
    "status" "WarehouseTaskStatus" NOT NULL DEFAULT 'OPEN',
    "takenAt" TIMESTAMPTZ(3),
    "takenById" UUID,
    "takenByWorkerId" UUID,
    "doneAt" TIMESTAMPTZ(3),
    "doneById" UUID,
    "doneByWorkerId" UUID,
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelledById" UUID,
    "cancelReason" TEXT,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "WarehouseTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaterialSubstitution" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "workOrderId" UUID NOT NULL,
    "styleRevisionId" UUID NOT NULL,
    "bomLineId" UUID NOT NULL,
    "fromItemId" UUID NOT NULL,
    "toItemId" UUID NOT NULL,
    "toItemColourId" UUID,
    "toLotId" UUID,
    "alternateId" UUID,
    "quantity" DECIMAL(18,4) NOT NULL,
    "uom" "Uom" NOT NULL,
    "baseQuantity" DECIMAL(18,4) NOT NULL,
    "reasonCode" TEXT,
    "reason" TEXT NOT NULL,
    "ruleAnswer" JSONB NOT NULL,
    "approvalTaskId" UUID,
    "status" "MaterialSubstitutionStatus" NOT NULL DEFAULT 'WAITING',
    "requestedById" UUID,
    "requestedByWorkerId" UUID,
    "decidedAt" TIMESTAMPTZ(3),
    "decidedById" UUID,
    "refuseReason" TEXT,
    "issuedAt" TIMESTAMPTZ(3),
    "moveIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "withdrawnAt" TIMESTAMPTZ(3),
    "withdrawReason" TEXT,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "MaterialSubstitution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DefaultLocation_tenantId_siteId_purpose_idx" ON "DefaultLocation"("tenantId", "siteId", "purpose");

-- CreateIndex
CREATE INDEX "TransferOrder_tenantId_status_expectedOn_idx" ON "TransferOrder"("tenantId", "status", "expectedOn");

-- CreateIndex
CREATE INDEX "TransferOrder_tenantId_toSiteId_status_idx" ON "TransferOrder"("tenantId", "toSiteId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "TransferOrder_tenantId_companyId_number_key" ON "TransferOrder"("tenantId", "companyId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "TransferOrder_tenantId_ddtNumberSeriesId_ddtNumber_key" ON "TransferOrder"("tenantId", "ddtNumberSeriesId", "ddtNumber");

-- CreateIndex
CREATE UNIQUE INDEX "TransferOrder_tenantId_fromSiteId_toSiteId_id_key" ON "TransferOrder"("tenantId", "fromSiteId", "toSiteId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "TransferLine_tenantId_transferId_seq_key" ON "TransferLine"("tenantId", "transferId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "TransferLine_tenantId_id_key" ON "TransferLine"("tenantId", "id");

-- CreateIndex
CREATE INDEX "CountSchedule_tenantId_siteId_active_nextDueOn_idx" ON "CountSchedule"("tenantId", "siteId", "active", "nextDueOn");

-- CreateIndex
CREATE INDEX "StockCountScan_tenantId_lineId_pass_idx" ON "StockCountScan"("tenantId", "lineId", "pass");

-- CreateIndex
CREATE INDEX "StockCountScan_tenantId_countId_idx" ON "StockCountScan"("tenantId", "countId");

-- CreateIndex
CREATE INDEX "InventorySettings_tenantId_companyId_idx" ON "InventorySettings"("tenantId", "companyId");

-- CreateIndex
CREATE INDEX "WarehouseTask_tenantId_siteId_status_dueAt_idx" ON "WarehouseTask"("tenantId", "siteId", "status", "dueAt");

-- CreateIndex
CREATE INDEX "WarehouseTask_tenantId_sourceType_sourceId_idx" ON "WarehouseTask"("tenantId", "sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "MaterialSubstitution_tenantId_workOrderId_idx" ON "MaterialSubstitution"("tenantId", "workOrderId");

-- CreateIndex
CREATE INDEX "MaterialSubstitution_tenantId_siteId_status_idx" ON "MaterialSubstitution"("tenantId", "siteId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Location_tenantId_labelCode_key" ON "Location"("tenantId", "labelCode");

-- CreateIndex
CREATE INDEX "Lot_tenantId_parentLotId_idx" ON "Lot"("tenantId", "parentLotId");

-- CreateIndex
CREATE UNIQUE INDEX "StockCountLine_tenantId_siteId_countId_id_key" ON "StockCountLine"("tenantId", "siteId", "countId", "id");

-- CreateIndex
CREATE INDEX "StockMove_tenantId_transferLineId_idx" ON "StockMove"("tenantId", "transferLineId");

-- AddForeignKey
ALTER TABLE "GoodsReceipt" ADD CONSTRAINT "GoodsReceipt_tenantId_siteId_holdingLocationId_fkey" FOREIGN KEY ("tenantId", "siteId", "holdingLocationId") REFERENCES "Location"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Lot" ADD CONSTRAINT "Lot_tenantId_siteId_itemId_parentLotId_fkey" FOREIGN KEY ("tenantId", "siteId", "itemId", "parentLotId") REFERENCES "Lot"("tenantId", "siteId", "itemId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StockMove" ADD CONSTRAINT "StockMove_tenantId_transferLineId_fkey" FOREIGN KEY ("tenantId", "transferLineId") REFERENCES "TransferLine"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DefaultLocation" ADD CONSTRAINT "DefaultLocation_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DefaultLocation" ADD CONSTRAINT "DefaultLocation_tenantId_siteId_locationId_fkey" FOREIGN KEY ("tenantId", "siteId", "locationId") REFERENCES "Location"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TransferOrder" ADD CONSTRAINT "TransferOrder_tenantId_companyId_fromSiteId_fkey" FOREIGN KEY ("tenantId", "companyId", "fromSiteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TransferOrder" ADD CONSTRAINT "TransferOrder_tenantId_toCompanyId_toSiteId_fkey" FOREIGN KEY ("tenantId", "toCompanyId", "toSiteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TransferOrder" ADD CONSTRAINT "TransferOrder_tenantId_fromSiteId_fromLocationId_fkey" FOREIGN KEY ("tenantId", "fromSiteId", "fromLocationId") REFERENCES "Location"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TransferOrder" ADD CONSTRAINT "TransferOrder_tenantId_toSiteId_toLocationId_fkey" FOREIGN KEY ("tenantId", "toSiteId", "toLocationId") REFERENCES "Location"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TransferOrder" ADD CONSTRAINT "TransferOrder_tenantId_fromSiteId_transitLocationId_fkey" FOREIGN KEY ("tenantId", "fromSiteId", "transitLocationId") REFERENCES "Location"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TransferOrder" ADD CONSTRAINT "TransferOrder_tenantId_companyId_ddtNumberSeriesId_fkey" FOREIGN KEY ("tenantId", "companyId", "ddtNumberSeriesId") REFERENCES "NumberSeries"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TransferOrder" ADD CONSTRAINT "TransferOrder_tenantId_ddtFileId_fkey" FOREIGN KEY ("tenantId", "ddtFileId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TransferLine" ADD CONSTRAINT "TransferLine_tenantId_fromSiteId_toSiteId_transferId_fkey" FOREIGN KEY ("tenantId", "fromSiteId", "toSiteId", "transferId") REFERENCES "TransferOrder"("tenantId", "fromSiteId", "toSiteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TransferLine" ADD CONSTRAINT "TransferLine_tenantId_itemId_fkey" FOREIGN KEY ("tenantId", "itemId") REFERENCES "Item"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TransferLine" ADD CONSTRAINT "TransferLine_tenantId_itemId_itemColourId_fkey" FOREIGN KEY ("tenantId", "itemId", "itemColourId") REFERENCES "ItemColour"("tenantId", "itemId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TransferLine" ADD CONSTRAINT "TransferLine_tenantId_fromSiteId_itemId_lotId_fkey" FOREIGN KEY ("tenantId", "fromSiteId", "itemId", "lotId") REFERENCES "Lot"("tenantId", "siteId", "itemId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TransferLine" ADD CONSTRAINT "TransferLine_tenantId_fromSiteId_lotId_hideId_fkey" FOREIGN KEY ("tenantId", "fromSiteId", "lotId", "hideId") REFERENCES "Hide"("tenantId", "siteId", "lotId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TransferLine" ADD CONSTRAINT "TransferLine_tenantId_fromSiteId_rollId_fkey" FOREIGN KEY ("tenantId", "fromSiteId", "rollId") REFERENCES "FabricRoll"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TransferLine" ADD CONSTRAINT "TransferLine_tenantId_fromSiteId_fromLocationId_fkey" FOREIGN KEY ("tenantId", "fromSiteId", "fromLocationId") REFERENCES "Location"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TransferLine" ADD CONSTRAINT "TransferLine_tenantId_toSiteId_toLocationId_fkey" FOREIGN KEY ("tenantId", "toSiteId", "toLocationId") REFERENCES "Location"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TransferLine" ADD CONSTRAINT "TransferLine_tenantId_toSiteId_itemId_toLotId_fkey" FOREIGN KEY ("tenantId", "toSiteId", "itemId", "toLotId") REFERENCES "Lot"("tenantId", "siteId", "itemId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TransferLine" ADD CONSTRAINT "TransferLine_tenantId_toSiteId_toLotId_toHideId_fkey" FOREIGN KEY ("tenantId", "toSiteId", "toLotId", "toHideId") REFERENCES "Hide"("tenantId", "siteId", "lotId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TransferLine" ADD CONSTRAINT "TransferLine_tenantId_toSiteId_toRollId_fkey" FOREIGN KEY ("tenantId", "toSiteId", "toRollId") REFERENCES "FabricRoll"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CountSchedule" ADD CONSTRAINT "CountSchedule_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CountSchedule" ADD CONSTRAINT "CountSchedule_tenantId_siteId_locationId_fkey" FOREIGN KEY ("tenantId", "siteId", "locationId") REFERENCES "Location"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CountSchedule" ADD CONSTRAINT "CountSchedule_tenantId_siteId_lastCountId_fkey" FOREIGN KEY ("tenantId", "siteId", "lastCountId") REFERENCES "StockCount"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StockCountScan" ADD CONSTRAINT "StockCountScan_tenantId_siteId_countId_fkey" FOREIGN KEY ("tenantId", "siteId", "countId") REFERENCES "StockCount"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StockCountScan" ADD CONSTRAINT "StockCountScan_tenantId_siteId_countId_lineId_fkey" FOREIGN KEY ("tenantId", "siteId", "countId", "lineId") REFERENCES "StockCountLine"("tenantId", "siteId", "countId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StockCountScan" ADD CONSTRAINT "StockCountScan_tenantId_siteId_scannedByWorkerId_fkey" FOREIGN KEY ("tenantId", "siteId", "scannedByWorkerId") REFERENCES "Worker"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StockCountScan" ADD CONSTRAINT "StockCountScan_tenantId_siteId_deviceId_fkey" FOREIGN KEY ("tenantId", "siteId", "deviceId") REFERENCES "Device"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InventorySettings" ADD CONSTRAINT "InventorySettings_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WarehouseTask" ADD CONSTRAINT "WarehouseTask_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WarehouseTask" ADD CONSTRAINT "WarehouseTask_tenantId_itemId_fkey" FOREIGN KEY ("tenantId", "itemId") REFERENCES "Item"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WarehouseTask" ADD CONSTRAINT "WarehouseTask_tenantId_itemId_itemColourId_fkey" FOREIGN KEY ("tenantId", "itemId", "itemColourId") REFERENCES "ItemColour"("tenantId", "itemId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WarehouseTask" ADD CONSTRAINT "WarehouseTask_tenantId_siteId_itemId_lotId_fkey" FOREIGN KEY ("tenantId", "siteId", "itemId", "lotId") REFERENCES "Lot"("tenantId", "siteId", "itemId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WarehouseTask" ADD CONSTRAINT "WarehouseTask_tenantId_siteId_lotId_hideId_fkey" FOREIGN KEY ("tenantId", "siteId", "lotId", "hideId") REFERENCES "Hide"("tenantId", "siteId", "lotId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WarehouseTask" ADD CONSTRAINT "WarehouseTask_tenantId_siteId_fromLocationId_fkey" FOREIGN KEY ("tenantId", "siteId", "fromLocationId") REFERENCES "Location"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WarehouseTask" ADD CONSTRAINT "WarehouseTask_tenantId_siteId_toLocationId_fkey" FOREIGN KEY ("tenantId", "siteId", "toLocationId") REFERENCES "Location"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WarehouseTask" ADD CONSTRAINT "WarehouseTask_tenantId_assignedRoleId_fkey" FOREIGN KEY ("tenantId", "assignedRoleId") REFERENCES "Role"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WarehouseTask" ADD CONSTRAINT "WarehouseTask_tenantId_siteId_assignedWorkerId_fkey" FOREIGN KEY ("tenantId", "siteId", "assignedWorkerId") REFERENCES "Worker"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WarehouseTask" ADD CONSTRAINT "WarehouseTask_tenantId_siteId_takenByWorkerId_fkey" FOREIGN KEY ("tenantId", "siteId", "takenByWorkerId") REFERENCES "Worker"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WarehouseTask" ADD CONSTRAINT "WarehouseTask_tenantId_siteId_doneByWorkerId_fkey" FOREIGN KEY ("tenantId", "siteId", "doneByWorkerId") REFERENCES "Worker"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MaterialSubstitution" ADD CONSTRAINT "MaterialSubstitution_tenantId_siteId_styleRevisionId_workO_fkey" FOREIGN KEY ("tenantId", "siteId", "styleRevisionId", "workOrderId") REFERENCES "WorkOrder"("tenantId", "siteId", "styleRevisionId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MaterialSubstitution" ADD CONSTRAINT "MaterialSubstitution_tenantId_styleRevisionId_bomLineId_fr_fkey" FOREIGN KEY ("tenantId", "styleRevisionId", "bomLineId", "fromItemId") REFERENCES "BomLine"("tenantId", "revisionId", "id", "itemId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MaterialSubstitution" ADD CONSTRAINT "MaterialSubstitution_tenantId_toItemId_fkey" FOREIGN KEY ("tenantId", "toItemId") REFERENCES "Item"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MaterialSubstitution" ADD CONSTRAINT "MaterialSubstitution_tenantId_toItemId_toItemColourId_fkey" FOREIGN KEY ("tenantId", "toItemId", "toItemColourId") REFERENCES "ItemColour"("tenantId", "itemId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MaterialSubstitution" ADD CONSTRAINT "MaterialSubstitution_tenantId_siteId_toItemId_toLotId_fkey" FOREIGN KEY ("tenantId", "siteId", "toItemId", "toLotId") REFERENCES "Lot"("tenantId", "siteId", "itemId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MaterialSubstitution" ADD CONSTRAINT "MaterialSubstitution_tenantId_siteId_requestedByWorkerId_fkey" FOREIGN KEY ("tenantId", "siteId", "requestedByWorkerId") REFERENCES "Worker"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

