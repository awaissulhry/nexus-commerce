-- CreateEnum
CREATE TYPE "CutOrderKind" AS ENUM ('LEATHER', 'FABRIC');

-- CreateEnum
CREATE TYPE "CutOrderStatus" AS ENUM ('PLANNED', 'RELEASED', 'IN_PROGRESS', 'CUT', 'RECONCILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CutTicketKind" AS ENUM ('CUT', 'RECUT');

-- CreateEnum
CREATE TYPE "CutTicketStatus" AS ENUM ('OPEN', 'STARTED', 'DONE', 'VOID');

-- CreateEnum
CREATE TYPE "LayStatus" AS ENUM ('PLANNED', 'SPREADING', 'CHECKED', 'CUT', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PlyRunStatus" AS ENUM ('PLANNED', 'PRINTED', 'VOID');

-- CreateEnum
CREATE TYPE "SecondaryProcessKind" AS ENUM ('FUSING', 'PERFORATION', 'PRINT', 'EMBROIDERY', 'OTHER');

-- CreateEnum
CREATE TYPE "SecondaryProcessPlace" AS ENUM ('IN_HOUSE', 'OUTSIDE');

-- CreateEnum
CREATE TYPE "SecondaryProcessStatus" AS ENUM ('WAITING', 'IN_PROGRESS', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CutIssueStatus" AS ENUM ('LOADING', 'SENT', 'RECEIVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PatternGrain" AS ENUM ('ALONG', 'ACROSS', 'BIAS', 'ANY');

-- CreateEnum
CREATE TYPE "CutOverrideKind" AS ENUM ('SHADE', 'WRONG_HIDE', 'THICKNESS', 'GRADE');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NumberKind" ADD VALUE 'CUT_ORDER';
ALTER TYPE "NumberKind" ADD VALUE 'CUT_TICKET';

-- AlterTable
ALTER TABLE "CutLog" ADD COLUMN     "measuredThicknessMm" DECIMAL(6,2),
ADD COLUMN     "overrideLeadUserId" UUID,
ADD COLUMN     "overrideLeadWorkerId" UUID,
ADD COLUMN     "overrideReason" TEXT,
ADD COLUMN     "overrides" "CutOverrideKind"[] DEFAULT ARRAY[]::"CutOverrideKind"[],
ADD COLUMN     "photoFileId" UUID;

-- AlterTable
ALTER TABLE "ReplacementRequest" ADD COLUMN     "recutTicketId" UUID;

-- AlterTable
ALTER TABLE "ReworkOrder" ADD COLUMN     "repairInAt" TIMESTAMPTZ(3),
ADD COLUMN     "repairOutAt" TIMESTAMPTZ(3),
ADD COLUMN     "repairStationId" UUID;

-- CreateTable
CREATE TABLE "CutOrder" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "kind" "CutOrderKind" NOT NULL,
    "itemId" UUID NOT NULL,
    "itemColourId" UUID,
    "stationId" UUID,
    "markerName" TEXT,
    "markerLength" DECIMAL(18,4),
    "markerUom" "Uom",
    "markerWidthCm" DECIMAL(10,2),
    "markerFileId" UUID,
    "dueDate" DATE,
    "status" "CutOrderStatus" NOT NULL DEFAULT 'PLANNED',
    "releasedAt" TIMESTAMPTZ(3),
    "releasedById" UUID,
    "cutAt" TIMESTAMPTZ(3),
    "reconciledAt" TIMESTAMPTZ(3),
    "reconciledById" UUID,
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelReason" TEXT,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "CutOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CutOrderLine" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "cutOrderId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "workOrderId" UUID NOT NULL,
    "workOrderSizeId" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "ratio" INTEGER,
    "plies" INTEGER,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "CutOrderLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CutTicket" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "scanCode" TEXT NOT NULL,
    "kind" "CutTicketKind" NOT NULL,
    "cutOrderId" UUID,
    "layId" UUID,
    "workOrderId" UUID,
    "workOrderSizeId" UUID,
    "bundleId" UUID,
    "part" TEXT,
    "quantity" INTEGER,
    "lotItemId" UUID,
    "lotId" UUID,
    "endBits" BOOLEAN NOT NULL DEFAULT false,
    "status" "CutTicketStatus" NOT NULL DEFAULT 'OPEN',
    "printedAt" TIMESTAMPTZ(3),
    "startedAt" TIMESTAMPTZ(3),
    "doneAt" TIMESTAMPTZ(3),
    "voidedAt" TIMESTAMPTZ(3),
    "voidReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "CutTicket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lay" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "cutOrderId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "plies" INTEGER NOT NULL,
    "layLength" DECIMAL(18,4),
    "lengthUom" "Uom",
    "plyCountLeft" INTEGER,
    "plyCountRight" INTEGER,
    "checkedAt" TIMESTAMPTZ(3),
    "status" "LayStatus" NOT NULL DEFAULT 'PLANNED',
    "cutAt" TIMESTAMPTZ(3),
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelReason" TEXT,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "Lay_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LayRoll" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "layId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "rollId" UUID NOT NULL,
    "plies" INTEGER NOT NULL,
    "splices" INTEGER NOT NULL DEFAULT 0,
    "endLoss" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "endReturned" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "LayRoll_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlyRun" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "layId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "firstPly" INTEGER NOT NULL,
    "lastPly" INTEGER NOT NULL,
    "parts" TEXT[],
    "labelCount" INTEGER NOT NULL,
    "status" "PlyRunStatus" NOT NULL DEFAULT 'PLANNED',
    "printedAt" TIMESTAMPTZ(3),
    "voidedAt" TIMESTAMPTZ(3),
    "voidReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "PlyRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CutReconciliation" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "cutOrderId" UUID NOT NULL,
    "cutOrderLineId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "orderedQuantity" INTEGER NOT NULL,
    "cutQuantity" INTEGER NOT NULL,
    "recutQuantity" INTEGER NOT NULL DEFAULT 0,
    "varianceReasonCode" TEXT,
    "note" TEXT,
    "reconciledAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "CutReconciliation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CutConsumption" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "cutOrderId" UUID NOT NULL,
    "layId" UUID,
    "key" TEXT NOT NULL,
    "uom" "Uom" NOT NULL,
    "estimated" DECIMAL(18,4) NOT NULL,
    "recorded" DECIMAL(18,4) NOT NULL,
    "confirmed" DECIMAL(18,4),
    "confirmedAt" TIMESTAMPTZ(3),
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "CutConsumption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SecondaryProcess" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "workOrderId" UUID NOT NULL,
    "bundleId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" "SecondaryProcessKind" NOT NULL,
    "place" "SecondaryProcessPlace" NOT NULL,
    "workCentreId" UUID,
    "subcontractOrderId" UUID,
    "quantity" INTEGER NOT NULL,
    "status" "SecondaryProcessStatus" NOT NULL DEFAULT 'WAITING',
    "startedAt" TIMESTAMPTZ(3),
    "doneAt" TIMESTAMPTZ(3),
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelReason" TEXT,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "SecondaryProcess_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CutIssue" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "trolleyCode" TEXT NOT NULL,
    "lineId" UUID NOT NULL,
    "status" "CutIssueStatus" NOT NULL DEFAULT 'LOADING',
    "sentAt" TIMESTAMPTZ(3),
    "receivedAt" TIMESTAMPTZ(3),
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelReason" TEXT,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "CutIssue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CutIssueLine" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "cutIssueId" UUID NOT NULL,
    "workOrderId" UUID NOT NULL,
    "bundleId" UUID NOT NULL,
    "receivedAt" TIMESTAMPTZ(3),
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "CutIssueLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PatternPiece" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "styleId" UUID NOT NULL,
    "revisionId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "bomLineId" UUID,
    "minGradeId" UUID,
    "grain" "PatternGrain" NOT NULL DEFAULT 'ANY',
    "sizes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "PatternPiece_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GarmentDowngrade" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "workOrderId" UUID NOT NULL,
    "workOrderSizeId" UUID NOT NULL,
    "bundleId" UUID,
    "reworkOrderId" UUID,
    "sourceScanId" UUID,
    "quantity" INTEGER NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "note" TEXT,
    "secondQualityItemId" UUID,
    "variantId" UUID,
    "voidedAt" TIMESTAMPTZ(3),
    "voidedById" UUID,
    "voidReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "GarmentDowngrade_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CutOrder_tenantId_siteId_status_idx" ON "CutOrder"("tenantId", "siteId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CutOrder_tenantId_companyId_number_key" ON "CutOrder"("tenantId", "companyId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "CutOrder_tenantId_siteId_id_key" ON "CutOrder"("tenantId", "siteId", "id");

-- CreateIndex
CREATE INDEX "CutOrderLine_tenantId_workOrderId_idx" ON "CutOrderLine"("tenantId", "workOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "CutOrderLine_tenantId_cutOrderId_seq_key" ON "CutOrderLine"("tenantId", "cutOrderId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "CutOrderLine_tenantId_siteId_cutOrderId_id_key" ON "CutOrderLine"("tenantId", "siteId", "cutOrderId", "id");

-- CreateIndex
CREATE INDEX "CutTicket_tenantId_cutOrderId_idx" ON "CutTicket"("tenantId", "cutOrderId");

-- CreateIndex
CREATE INDEX "CutTicket_tenantId_siteId_kind_status_idx" ON "CutTicket"("tenantId", "siteId", "kind", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CutTicket_tenantId_companyId_number_key" ON "CutTicket"("tenantId", "companyId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "CutTicket_tenantId_scanCode_key" ON "CutTicket"("tenantId", "scanCode");

-- CreateIndex
CREATE UNIQUE INDEX "CutTicket_tenantId_siteId_id_key" ON "CutTicket"("tenantId", "siteId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Lay_tenantId_cutOrderId_seq_key" ON "Lay"("tenantId", "cutOrderId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "Lay_tenantId_siteId_id_key" ON "Lay"("tenantId", "siteId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Lay_tenantId_siteId_cutOrderId_id_key" ON "Lay"("tenantId", "siteId", "cutOrderId", "id");

-- CreateIndex
CREATE INDEX "LayRoll_tenantId_rollId_idx" ON "LayRoll"("tenantId", "rollId");

-- CreateIndex
CREATE UNIQUE INDEX "LayRoll_tenantId_layId_seq_key" ON "LayRoll"("tenantId", "layId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "PlyRun_tenantId_layId_seq_key" ON "PlyRun"("tenantId", "layId", "seq");

-- CreateIndex
CREATE INDEX "CutReconciliation_tenantId_cutOrderId_idx" ON "CutReconciliation"("tenantId", "cutOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "CutReconciliation_tenantId_key_key" ON "CutReconciliation"("tenantId", "key");

-- CreateIndex
CREATE INDEX "CutConsumption_tenantId_cutOrderId_idx" ON "CutConsumption"("tenantId", "cutOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "CutConsumption_tenantId_key_key" ON "CutConsumption"("tenantId", "key");

-- CreateIndex
CREATE INDEX "SecondaryProcess_tenantId_workOrderId_idx" ON "SecondaryProcess"("tenantId", "workOrderId");

-- CreateIndex
CREATE INDEX "SecondaryProcess_tenantId_siteId_status_idx" ON "SecondaryProcess"("tenantId", "siteId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "SecondaryProcess_tenantId_bundleId_seq_key" ON "SecondaryProcess"("tenantId", "bundleId", "seq");

-- CreateIndex
CREATE INDEX "CutIssue_tenantId_siteId_status_idx" ON "CutIssue"("tenantId", "siteId", "status");

-- CreateIndex
CREATE INDEX "CutIssue_tenantId_lineId_idx" ON "CutIssue"("tenantId", "lineId");

-- CreateIndex
CREATE UNIQUE INDEX "CutIssue_tenantId_siteId_id_key" ON "CutIssue"("tenantId", "siteId", "id");

-- CreateIndex
CREATE INDEX "CutIssueLine_tenantId_cutIssueId_idx" ON "CutIssueLine"("tenantId", "cutIssueId");

-- CreateIndex
CREATE INDEX "CutIssueLine_tenantId_bundleId_idx" ON "CutIssueLine"("tenantId", "bundleId");

-- CreateIndex
CREATE UNIQUE INDEX "PatternPiece_tenantId_revisionId_seq_key" ON "PatternPiece"("tenantId", "revisionId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "PatternPiece_tenantId_revisionId_name_key" ON "PatternPiece"("tenantId", "revisionId", "name");

-- CreateIndex
CREATE INDEX "GarmentDowngrade_tenantId_workOrderId_idx" ON "GarmentDowngrade"("tenantId", "workOrderId");

-- CreateIndex
CREATE INDEX "GarmentDowngrade_tenantId_siteId_createdAt_idx" ON "GarmentDowngrade"("tenantId", "siteId", "createdAt");

-- AddForeignKey
ALTER TABLE "CutOrder" ADD CONSTRAINT "CutOrder_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CutOrder" ADD CONSTRAINT "CutOrder_tenantId_itemId_fkey" FOREIGN KEY ("tenantId", "itemId") REFERENCES "Item"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CutOrder" ADD CONSTRAINT "CutOrder_tenantId_itemId_itemColourId_fkey" FOREIGN KEY ("tenantId", "itemId", "itemColourId") REFERENCES "ItemColour"("tenantId", "itemId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CutOrder" ADD CONSTRAINT "CutOrder_tenantId_siteId_stationId_fkey" FOREIGN KEY ("tenantId", "siteId", "stationId") REFERENCES "Station"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CutOrder" ADD CONSTRAINT "CutOrder_tenantId_markerFileId_fkey" FOREIGN KEY ("tenantId", "markerFileId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CutOrderLine" ADD CONSTRAINT "CutOrderLine_tenantId_siteId_cutOrderId_fkey" FOREIGN KEY ("tenantId", "siteId", "cutOrderId") REFERENCES "CutOrder"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CutOrderLine" ADD CONSTRAINT "CutOrderLine_tenantId_siteId_workOrderId_workOrderSizeId_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId", "workOrderSizeId") REFERENCES "WorkOrderSize"("tenantId", "siteId", "workOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CutTicket" ADD CONSTRAINT "CutTicket_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CutTicket" ADD CONSTRAINT "CutTicket_tenantId_siteId_cutOrderId_fkey" FOREIGN KEY ("tenantId", "siteId", "cutOrderId") REFERENCES "CutOrder"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CutTicket" ADD CONSTRAINT "CutTicket_tenantId_siteId_cutOrderId_layId_fkey" FOREIGN KEY ("tenantId", "siteId", "cutOrderId", "layId") REFERENCES "Lay"("tenantId", "siteId", "cutOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CutTicket" ADD CONSTRAINT "CutTicket_tenantId_siteId_workOrderId_workOrderSizeId_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId", "workOrderSizeId") REFERENCES "WorkOrderSize"("tenantId", "siteId", "workOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CutTicket" ADD CONSTRAINT "CutTicket_tenantId_siteId_workOrderId_bundleId_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId", "bundleId") REFERENCES "Bundle"("tenantId", "siteId", "workOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CutTicket" ADD CONSTRAINT "CutTicket_tenantId_siteId_lotItemId_lotId_fkey" FOREIGN KEY ("tenantId", "siteId", "lotItemId", "lotId") REFERENCES "Lot"("tenantId", "siteId", "itemId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Lay" ADD CONSTRAINT "Lay_tenantId_siteId_cutOrderId_fkey" FOREIGN KEY ("tenantId", "siteId", "cutOrderId") REFERENCES "CutOrder"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LayRoll" ADD CONSTRAINT "LayRoll_tenantId_siteId_layId_fkey" FOREIGN KEY ("tenantId", "siteId", "layId") REFERENCES "Lay"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LayRoll" ADD CONSTRAINT "LayRoll_tenantId_siteId_rollId_fkey" FOREIGN KEY ("tenantId", "siteId", "rollId") REFERENCES "FabricRoll"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PlyRun" ADD CONSTRAINT "PlyRun_tenantId_siteId_layId_fkey" FOREIGN KEY ("tenantId", "siteId", "layId") REFERENCES "Lay"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CutReconciliation" ADD CONSTRAINT "CutReconciliation_tenantId_siteId_cutOrderId_fkey" FOREIGN KEY ("tenantId", "siteId", "cutOrderId") REFERENCES "CutOrder"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CutReconciliation" ADD CONSTRAINT "CutReconciliation_tenantId_siteId_cutOrderId_cutOrderLineI_fkey" FOREIGN KEY ("tenantId", "siteId", "cutOrderId", "cutOrderLineId") REFERENCES "CutOrderLine"("tenantId", "siteId", "cutOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CutConsumption" ADD CONSTRAINT "CutConsumption_tenantId_siteId_cutOrderId_fkey" FOREIGN KEY ("tenantId", "siteId", "cutOrderId") REFERENCES "CutOrder"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CutConsumption" ADD CONSTRAINT "CutConsumption_tenantId_siteId_cutOrderId_layId_fkey" FOREIGN KEY ("tenantId", "siteId", "cutOrderId", "layId") REFERENCES "Lay"("tenantId", "siteId", "cutOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SecondaryProcess" ADD CONSTRAINT "SecondaryProcess_tenantId_siteId_workOrderId_bundleId_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId", "bundleId") REFERENCES "Bundle"("tenantId", "siteId", "workOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SecondaryProcess" ADD CONSTRAINT "SecondaryProcess_tenantId_siteId_workCentreId_fkey" FOREIGN KEY ("tenantId", "siteId", "workCentreId") REFERENCES "WorkCentre"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SecondaryProcess" ADD CONSTRAINT "SecondaryProcess_tenantId_siteId_workOrderId_subcontractOr_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId", "subcontractOrderId") REFERENCES "SubcontractOrder"("tenantId", "siteId", "workOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CutIssue" ADD CONSTRAINT "CutIssue_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CutIssue" ADD CONSTRAINT "CutIssue_tenantId_siteId_lineId_fkey" FOREIGN KEY ("tenantId", "siteId", "lineId") REFERENCES "Line"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CutIssueLine" ADD CONSTRAINT "CutIssueLine_tenantId_siteId_cutIssueId_fkey" FOREIGN KEY ("tenantId", "siteId", "cutIssueId") REFERENCES "CutIssue"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CutIssueLine" ADD CONSTRAINT "CutIssueLine_tenantId_siteId_workOrderId_bundleId_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId", "bundleId") REFERENCES "Bundle"("tenantId", "siteId", "workOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PatternPiece" ADD CONSTRAINT "PatternPiece_tenantId_styleId_revisionId_fkey" FOREIGN KEY ("tenantId", "styleId", "revisionId") REFERENCES "StyleRevision"("tenantId", "styleId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PatternPiece" ADD CONSTRAINT "PatternPiece_tenantId_revisionId_bomLineId_fkey" FOREIGN KEY ("tenantId", "revisionId", "bomLineId") REFERENCES "BomLine"("tenantId", "revisionId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PatternPiece" ADD CONSTRAINT "PatternPiece_tenantId_minGradeId_fkey" FOREIGN KEY ("tenantId", "minGradeId") REFERENCES "LeatherGrade"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "GarmentDowngrade" ADD CONSTRAINT "GarmentDowngrade_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "GarmentDowngrade" ADD CONSTRAINT "GarmentDowngrade_tenantId_siteId_workOrderId_workOrderSize_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId", "workOrderSizeId") REFERENCES "WorkOrderSize"("tenantId", "siteId", "workOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "GarmentDowngrade" ADD CONSTRAINT "GarmentDowngrade_tenantId_siteId_workOrderId_bundleId_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId", "bundleId") REFERENCES "Bundle"("tenantId", "siteId", "workOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "GarmentDowngrade" ADD CONSTRAINT "GarmentDowngrade_tenantId_siteId_workOrderId_reworkOrderId_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId", "reworkOrderId") REFERENCES "ReworkOrder"("tenantId", "siteId", "workOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "GarmentDowngrade" ADD CONSTRAINT "GarmentDowngrade_tenantId_siteId_sourceScanId_fkey" FOREIGN KEY ("tenantId", "siteId", "sourceScanId") REFERENCES "OperationScan"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "GarmentDowngrade" ADD CONSTRAINT "GarmentDowngrade_tenantId_secondQualityItemId_fkey" FOREIGN KEY ("tenantId", "secondQualityItemId") REFERENCES "Item"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "GarmentDowngrade" ADD CONSTRAINT "GarmentDowngrade_tenantId_variantId_fkey" FOREIGN KEY ("tenantId", "variantId") REFERENCES "Variant"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CutLog" ADD CONSTRAINT "CutLog_tenantId_photoFileId_fkey" FOREIGN KEY ("tenantId", "photoFileId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CutLog" ADD CONSTRAINT "CutLog_tenantId_siteId_overrideLeadWorkerId_fkey" FOREIGN KEY ("tenantId", "siteId", "overrideLeadWorkerId") REFERENCES "Worker"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ReworkOrder" ADD CONSTRAINT "ReworkOrder_tenantId_siteId_repairStationId_fkey" FOREIGN KEY ("tenantId", "siteId", "repairStationId") REFERENCES "Station"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ReplacementRequest" ADD CONSTRAINT "ReplacementRequest_tenantId_siteId_recutTicketId_fkey" FOREIGN KEY ("tenantId", "siteId", "recutTicketId") REFERENCES "CutTicket"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

