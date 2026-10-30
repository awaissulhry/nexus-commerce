-- CreateEnum
CREATE TYPE "QualityStage" AS ENUM ('INCOMING', 'STOCK', 'CUTTING', 'IN_LINE', 'FINAL', 'PACKING', 'CUSTOMER', 'AUDIT');

-- CreateEnum
CREATE TYPE "DispositionOutcome" AS ENUM ('USE_AS_IS', 'REWORK', 'REPAIR', 'REGRADE', 'RETURN_TO_SUPPLIER', 'QUARANTINE', 'SCRAP');

-- CreateEnum
CREATE TYPE "DispositionFollowUp" AS ENUM ('REWORK_ORDER', 'REPAIR_ORDER', 'SUPPLIER_CLAIM');

-- CreateEnum
CREATE TYPE "QualityHoldStatus" AS ENUM ('ACTIVE', 'RELEASED', 'CLOSED');

-- CreateEnum
CREATE TYPE "HoldQuarantine" AS ENUM ('NOT_NEEDED', 'ASKED', 'MOVED');

-- CreateEnum
CREATE TYPE "NcrSource" AS ENUM ('INSPECTION', 'BUNDLE', 'COMPLAINT', 'RETURN', 'SUPPLIER', 'AUDIT', 'OTHER');

-- CreateEnum
CREATE TYPE "NcrStage" AS ENUM ('OPEN', 'CONTAINED', 'DECIDED', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ContainmentKind" AS ENUM ('HOLD_STOCK', 'CHECK_WIP', 'CHECK_SHIPPED', 'TELL_CUSTOMER', 'OTHER');

-- CreateEnum
CREATE TYPE "ContainmentStatus" AS ENUM ('OPEN', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "MachineStatus" AS ENUM ('RUNNING', 'DOWN', 'UNDER_MAINTENANCE', 'DO_NOT_USE', 'RETIRED');

-- CreateEnum
CREATE TYPE "MaintenanceRequestStatus" AS ENUM ('NEW', 'ACKNOWLEDGED', 'JOB_MADE', 'MERGED', 'CLOSED');

-- CreateEnum
CREATE TYPE "RequestCloseReason" AS ENUM ('SOLVED_BY_OPERATOR', 'NOT_A_FAULT', 'DUPLICATE', 'OTHER');

-- CreateEnum
CREATE TYPE "MaintenanceJobType" AS ENUM ('CORRECTIVE', 'PREVENTIVE', 'INSPECTION', 'IMPROVEMENT', 'SAFETY');

-- CreateEnum
CREATE TYPE "MaintenanceJobSource" AS ENUM ('REQUEST', 'PM_PLAN', 'STATUTORY_CHECK', 'INCIDENT', 'MANUAL');

-- CreateEnum
CREATE TYPE "MaintenancePriority" AS ENUM ('P1', 'P2', 'P3');

-- CreateEnum
CREATE TYPE "MaintenanceJobStatus" AS ENUM ('NEW', 'PLANNED', 'IN_PROGRESS', 'WAITING_PARTS', 'HANDED_BACK', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "FreightRule" AS ENUM ('NONE', 'PER_SHIPMENT', 'PER_PARCEL');

-- CreateEnum
CREATE TYPE "TransportEvidenceStatus" AS ENUM ('NOT_NEEDED', 'AWAITED', 'PARTIAL', 'COMPLETE');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NumberKind" ADD VALUE 'NCR';
ALTER TYPE "NumberKind" ADD VALUE 'MAINTENANCE_JOB';

-- AlterTable
ALTER TABLE "Ddt" ADD COLUMN     "sourceId" UUID,
ADD COLUMN     "sourceType" TEXT,
ALTER COLUMN "shipmentId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Inspection" ADD COLUMN     "assignedInspectorId" UUID,
ADD COLUMN     "assignedInspectorWorkerId" UUID;

-- AlterTable
ALTER TABLE "InspectionDefect" ADD COLUMN     "defectCodeId" UUID,
ADD COLUMN     "zone" TEXT;

-- AlterTable
ALTER TABLE "Shipment" ADD COLUMN     "freightCharge" INTEGER,
ADD COLUMN     "transportEvidence" "TransportEvidenceStatus" NOT NULL DEFAULT 'NOT_NEEDED',
ADD COLUMN     "transportEvidenceAt" TIMESTAMPTZ(3),
ADD COLUMN     "transportEvidenceById" UUID,
ADD COLUMN     "transportEvidenceNote" TEXT;

-- AlterTable
ALTER TABLE "ShippingSettings" ADD COLUMN     "freightAmount" INTEGER,
ADD COLUMN     "freightFreeFrom" INTEGER,
ADD COLUMN     "freightRule" "FreightRule" NOT NULL DEFAULT 'NONE';

-- CreateTable
CREATE TABLE "DefectCode" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "parentId" UUID,
    "code" TEXT NOT NULL,
    "labelIt" TEXT NOT NULL,
    "labelEn" TEXT NOT NULL,
    "labelI18n" JSONB NOT NULL DEFAULT '{}',
    "icon" TEXT,
    "colour" TEXT,
    "pictureFileId" UUID,
    "severity" "DefectClass",
    "zone" TEXT,
    "stages" "QualityStage"[] DEFAULT ARRAY[]::"QualityStage"[],
    "needsDetail" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "DefectCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DispositionCode" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "code" TEXT NOT NULL,
    "labelIt" TEXT NOT NULL,
    "labelEn" TEXT NOT NULL,
    "labelI18n" JSONB NOT NULL DEFAULT '{}',
    "icon" TEXT,
    "colour" TEXT,
    "outcome" "DispositionOutcome" NOT NULL,
    "stockMoveReason" "StockMoveReason",
    "followUp" "DispositionFollowUp",
    "reinspection" BOOLEAN NOT NULL DEFAULT false,
    "approvalSeverity" "DefectClass",
    "approvalAmount" INTEGER,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "DispositionCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QualityHold" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectIds" UUID[],
    "reasonCode" TEXT NOT NULL,
    "reasonNote" TEXT,
    "sourceType" TEXT,
    "sourceId" UUID,
    "status" "QualityHoldStatus" NOT NULL DEFAULT 'ACTIVE',
    "placedAt" TIMESTAMPTZ(3) NOT NULL,
    "placedById" UUID,
    "placedByWorkerId" UUID,
    "ownerId" UUID,
    "expectedReleaseOn" DATE,
    "quarantine" "HoldQuarantine" NOT NULL DEFAULT 'NOT_NEEDED',
    "quarantineLocationId" UUID,
    "quarantineMovedAt" TIMESTAMPTZ(3),
    "ncrId" UUID,
    "releasedAt" TIMESTAMPTZ(3),
    "releasedById" UUID,
    "releasedByWorkerId" UUID,
    "releaseNote" TEXT,
    "releaseSignatureSha256" TEXT,
    "notMakerStatement" BOOLEAN NOT NULL DEFAULT false,
    "closedAt" TIMESTAMPTZ(3),
    "closedById" UUID,
    "closeNote" TEXT,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "QualityHold_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Nonconformance" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "source" "NcrSource" NOT NULL,
    "sourceType" TEXT,
    "sourceId" UUID,
    "foundAt" "QualityStage" NOT NULL,
    "foundOn" TIMESTAMPTZ(3) NOT NULL,
    "foundById" UUID,
    "foundByWorkerId" UUID,
    "quantityAffected" DECIMAL(18,4) NOT NULL,
    "quantitySuspect" DECIMAL(18,4),
    "uom" "Uom" NOT NULL,
    "defectCodeId" UUID,
    "severity" "DefectClass" NOT NULL,
    "zone" TEXT,
    "styleId" UUID,
    "colourwayId" UUID,
    "size" TEXT,
    "serial" TEXT,
    "workOrderId" UUID,
    "itemId" UUID,
    "lotId" UUID,
    "supplierId" UUID,
    "stage" "NcrStage" NOT NULL DEFAULT 'OPEN',
    "ownerId" UUID,
    "containmentDueAt" TIMESTAMPTZ(3),
    "containedAt" TIMESTAMPTZ(3),
    "decidedAt" TIMESTAMPTZ(3),
    "closedAt" TIMESTAMPTZ(3),
    "closedById" UUID,
    "closeNote" TEXT,
    "closeSignatureSha256" TEXT,
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "Nonconformance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NcrContainmentAction" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "ncrId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" "ContainmentKind" NOT NULL,
    "description" TEXT,
    "ownerId" UUID,
    "dueAt" TIMESTAMPTZ(3),
    "status" "ContainmentStatus" NOT NULL DEFAULT 'OPEN',
    "doneAt" TIMESTAMPTZ(3),
    "doneById" UUID,
    "evidenceNote" TEXT,
    "recordType" TEXT,
    "recordId" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "NcrContainmentAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NcrDispositionLine" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "ncrId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "dispositionCodeId" UUID NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "note" TEXT,
    "decidedAt" TIMESTAMPTZ(3) NOT NULL,
    "decidedById" UUID,
    "approvalRequired" BOOLEAN NOT NULL DEFAULT false,
    "approvedAt" TIMESTAMPTZ(3),
    "approvedById" UUID,
    "doneAt" TIMESTAMPTZ(3),
    "stockMoveId" UUID,
    "followUpType" TEXT,
    "followUpId" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "NcrDispositionLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NcrLink" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "ncrId" UUID NOT NULL,
    "recordType" TEXT NOT NULL,
    "recordId" UUID NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "NcrLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MachineClass" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "code" TEXT NOT NULL,
    "labelIt" TEXT NOT NULL,
    "labelEn" TEXT NOT NULL,
    "labelI18n" JSONB NOT NULL DEFAULT '{}',
    "icon" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "MachineClass_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MachineSymptom" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "classId" UUID,
    "code" TEXT NOT NULL,
    "labelIt" TEXT NOT NULL,
    "labelEn" TEXT NOT NULL,
    "labelI18n" JSONB NOT NULL DEFAULT '{}',
    "icon" TEXT,
    "colour" TEXT,
    "unsafe" BOOLEAN NOT NULL DEFAULT false,
    "needsDetail" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "MachineSymptom_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Machine" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "assetNumber" TEXT NOT NULL,
    "classId" UUID NOT NULL,
    "make" TEXT,
    "modelName" TEXT,
    "serialNumber" TEXT,
    "year" INTEGER,
    "stationId" UUID,
    "workCentreId" UUID,
    "supplierId" UUID,
    "purchaseCost" INTEGER,
    "status" "MachineStatus" NOT NULL DEFAULT 'RUNNING',
    "statusSince" TIMESTAMPTZ(3) NOT NULL,
    "statusReason" TEXT,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "Machine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaintenanceRequest" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "machineId" UUID NOT NULL,
    "symptomId" UUID,
    "description" TEXT,
    "unsafe" BOOLEAN NOT NULL DEFAULT false,
    "reportedAt" TIMESTAMPTZ(3) NOT NULL,
    "reportedById" UUID,
    "reportedByWorkerId" UUID,
    "stationId" UUID,
    "deviceId" UUID,
    "status" "MaintenanceRequestStatus" NOT NULL DEFAULT 'NEW',
    "acknowledgedAt" TIMESTAMPTZ(3),
    "acknowledgedById" UUID,
    "jobId" UUID,
    "mergedIntoId" UUID,
    "closedAt" TIMESTAMPTZ(3),
    "closedById" UUID,
    "closeReason" "RequestCloseReason",
    "closeNote" TEXT,
    "signedSafeAt" TIMESTAMPTZ(3),
    "signedSafeById" UUID,
    "signedSafeByWorkerId" UUID,
    "signedSafeNote" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "MaintenanceRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaintenanceJob" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "machineId" UUID NOT NULL,
    "type" "MaintenanceJobType" NOT NULL,
    "source" "MaintenanceJobSource" NOT NULL,
    "problem" TEXT NOT NULL,
    "symptomId" UUID,
    "priority" "MaintenancePriority" NOT NULL DEFAULT 'P2',
    "assigneeId" UUID,
    "assigneeWorkerId" UUID,
    "dueAt" TIMESTAMPTZ(3),
    "status" "MaintenanceJobStatus" NOT NULL DEFAULT 'NEW',
    "startedAt" TIMESTAMPTZ(3),
    "handedBackAt" TIMESTAMPTZ(3),
    "handedBackById" UUID,
    "handedBackByWorkerId" UUID,
    "workDone" TEXT,
    "machineAfter" "MachineStatus",
    "closedAt" TIMESTAMPTZ(3),
    "closedById" UUID,
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "MaintenanceJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DefectCode_tenantId_code_key" ON "DefectCode"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "DefectCode_tenantId_id_key" ON "DefectCode"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "DispositionCode_tenantId_code_key" ON "DispositionCode"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "DispositionCode_tenantId_id_key" ON "DispositionCode"("tenantId", "id");

-- CreateIndex
CREATE INDEX "QualityHold_tenantId_status_idx" ON "QualityHold"("tenantId", "status");

-- CreateIndex
CREATE INDEX "QualityHold_tenantId_ncrId_idx" ON "QualityHold"("tenantId", "ncrId");

-- CreateIndex
CREATE INDEX "QualityHold_subjectIds_idx" ON "QualityHold" USING GIN ("subjectIds" array_ops);

-- CreateIndex
CREATE INDEX "Nonconformance_tenantId_stage_idx" ON "Nonconformance"("tenantId", "stage");

-- CreateIndex
CREATE INDEX "Nonconformance_tenantId_sourceType_sourceId_idx" ON "Nonconformance"("tenantId", "sourceType", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "Nonconformance_tenantId_companyId_number_key" ON "Nonconformance"("tenantId", "companyId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "Nonconformance_tenantId_siteId_id_key" ON "Nonconformance"("tenantId", "siteId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "NcrContainmentAction_tenantId_ncrId_seq_key" ON "NcrContainmentAction"("tenantId", "ncrId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "NcrDispositionLine_tenantId_ncrId_seq_key" ON "NcrDispositionLine"("tenantId", "ncrId", "seq");

-- CreateIndex
CREATE INDEX "NcrLink_tenantId_ncrId_idx" ON "NcrLink"("tenantId", "ncrId");

-- CreateIndex
CREATE INDEX "NcrLink_tenantId_recordType_recordId_idx" ON "NcrLink"("tenantId", "recordType", "recordId");

-- CreateIndex
CREATE UNIQUE INDEX "MachineClass_tenantId_code_key" ON "MachineClass"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "MachineClass_tenantId_id_key" ON "MachineClass"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "MachineSymptom_tenantId_code_key" ON "MachineSymptom"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "MachineSymptom_tenantId_id_key" ON "MachineSymptom"("tenantId", "id");

-- CreateIndex
CREATE INDEX "Machine_tenantId_stationId_idx" ON "Machine"("tenantId", "stationId");

-- CreateIndex
CREATE UNIQUE INDEX "Machine_tenantId_assetNumber_key" ON "Machine"("tenantId", "assetNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Machine_tenantId_siteId_id_key" ON "Machine"("tenantId", "siteId", "id");

-- CreateIndex
CREATE INDEX "MaintenanceRequest_tenantId_machineId_idx" ON "MaintenanceRequest"("tenantId", "machineId");

-- CreateIndex
CREATE INDEX "MaintenanceRequest_tenantId_status_idx" ON "MaintenanceRequest"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "MaintenanceRequest_tenantId_siteId_id_key" ON "MaintenanceRequest"("tenantId", "siteId", "id");

-- CreateIndex
CREATE INDEX "MaintenanceJob_tenantId_machineId_idx" ON "MaintenanceJob"("tenantId", "machineId");

-- CreateIndex
CREATE INDEX "MaintenanceJob_tenantId_status_idx" ON "MaintenanceJob"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "MaintenanceJob_tenantId_companyId_number_key" ON "MaintenanceJob"("tenantId", "companyId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "MaintenanceJob_tenantId_siteId_id_key" ON "MaintenanceJob"("tenantId", "siteId", "id");

-- CreateIndex
CREATE INDEX "Ddt_tenantId_sourceType_sourceId_idx" ON "Ddt"("tenantId", "sourceType", "sourceId");

-- AddForeignKey
ALTER TABLE "DefectCode" ADD CONSTRAINT "DefectCode_tenantId_parentId_fkey" FOREIGN KEY ("tenantId", "parentId") REFERENCES "DefectCode"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DefectCode" ADD CONSTRAINT "DefectCode_tenantId_pictureFileId_fkey" FOREIGN KEY ("tenantId", "pictureFileId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "QualityHold" ADD CONSTRAINT "QualityHold_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "QualityHold" ADD CONSTRAINT "QualityHold_tenantId_siteId_placedByWorkerId_fkey" FOREIGN KEY ("tenantId", "siteId", "placedByWorkerId") REFERENCES "Worker"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "QualityHold" ADD CONSTRAINT "QualityHold_tenantId_siteId_releasedByWorkerId_fkey" FOREIGN KEY ("tenantId", "siteId", "releasedByWorkerId") REFERENCES "Worker"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "QualityHold" ADD CONSTRAINT "QualityHold_tenantId_siteId_quarantineLocationId_fkey" FOREIGN KEY ("tenantId", "siteId", "quarantineLocationId") REFERENCES "Location"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "QualityHold" ADD CONSTRAINT "QualityHold_tenantId_siteId_ncrId_fkey" FOREIGN KEY ("tenantId", "siteId", "ncrId") REFERENCES "Nonconformance"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Nonconformance" ADD CONSTRAINT "Nonconformance_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Nonconformance" ADD CONSTRAINT "Nonconformance_tenantId_siteId_foundByWorkerId_fkey" FOREIGN KEY ("tenantId", "siteId", "foundByWorkerId") REFERENCES "Worker"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Nonconformance" ADD CONSTRAINT "Nonconformance_tenantId_defectCodeId_fkey" FOREIGN KEY ("tenantId", "defectCodeId") REFERENCES "DefectCode"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Nonconformance" ADD CONSTRAINT "Nonconformance_tenantId_styleId_fkey" FOREIGN KEY ("tenantId", "styleId") REFERENCES "Style"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Nonconformance" ADD CONSTRAINT "Nonconformance_tenantId_styleId_colourwayId_fkey" FOREIGN KEY ("tenantId", "styleId", "colourwayId") REFERENCES "Colourway"("tenantId", "styleId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Nonconformance" ADD CONSTRAINT "Nonconformance_tenantId_siteId_workOrderId_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId") REFERENCES "WorkOrder"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Nonconformance" ADD CONSTRAINT "Nonconformance_tenantId_itemId_fkey" FOREIGN KEY ("tenantId", "itemId") REFERENCES "Item"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Nonconformance" ADD CONSTRAINT "Nonconformance_tenantId_siteId_itemId_lotId_fkey" FOREIGN KEY ("tenantId", "siteId", "itemId", "lotId") REFERENCES "Lot"("tenantId", "siteId", "itemId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Nonconformance" ADD CONSTRAINT "Nonconformance_tenantId_supplierId_fkey" FOREIGN KEY ("tenantId", "supplierId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "NcrContainmentAction" ADD CONSTRAINT "NcrContainmentAction_tenantId_siteId_ncrId_fkey" FOREIGN KEY ("tenantId", "siteId", "ncrId") REFERENCES "Nonconformance"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "NcrDispositionLine" ADD CONSTRAINT "NcrDispositionLine_tenantId_siteId_ncrId_fkey" FOREIGN KEY ("tenantId", "siteId", "ncrId") REFERENCES "Nonconformance"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "NcrDispositionLine" ADD CONSTRAINT "NcrDispositionLine_tenantId_dispositionCodeId_fkey" FOREIGN KEY ("tenantId", "dispositionCodeId") REFERENCES "DispositionCode"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "NcrDispositionLine" ADD CONSTRAINT "NcrDispositionLine_tenantId_siteId_stockMoveId_fkey" FOREIGN KEY ("tenantId", "siteId", "stockMoveId") REFERENCES "StockMove"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "NcrLink" ADD CONSTRAINT "NcrLink_tenantId_siteId_ncrId_fkey" FOREIGN KEY ("tenantId", "siteId", "ncrId") REFERENCES "Nonconformance"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MachineSymptom" ADD CONSTRAINT "MachineSymptom_tenantId_classId_fkey" FOREIGN KEY ("tenantId", "classId") REFERENCES "MachineClass"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Machine" ADD CONSTRAINT "Machine_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Machine" ADD CONSTRAINT "Machine_tenantId_classId_fkey" FOREIGN KEY ("tenantId", "classId") REFERENCES "MachineClass"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Machine" ADD CONSTRAINT "Machine_tenantId_siteId_stationId_fkey" FOREIGN KEY ("tenantId", "siteId", "stationId") REFERENCES "Station"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Machine" ADD CONSTRAINT "Machine_tenantId_siteId_workCentreId_fkey" FOREIGN KEY ("tenantId", "siteId", "workCentreId") REFERENCES "WorkCentre"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Machine" ADD CONSTRAINT "Machine_tenantId_supplierId_fkey" FOREIGN KEY ("tenantId", "supplierId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MaintenanceRequest" ADD CONSTRAINT "MaintenanceRequest_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MaintenanceRequest" ADD CONSTRAINT "MaintenanceRequest_tenantId_siteId_machineId_fkey" FOREIGN KEY ("tenantId", "siteId", "machineId") REFERENCES "Machine"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MaintenanceRequest" ADD CONSTRAINT "MaintenanceRequest_tenantId_symptomId_fkey" FOREIGN KEY ("tenantId", "symptomId") REFERENCES "MachineSymptom"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MaintenanceRequest" ADD CONSTRAINT "MaintenanceRequest_tenantId_siteId_reportedByWorkerId_fkey" FOREIGN KEY ("tenantId", "siteId", "reportedByWorkerId") REFERENCES "Worker"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MaintenanceRequest" ADD CONSTRAINT "MaintenanceRequest_tenantId_siteId_signedSafeByWorkerId_fkey" FOREIGN KEY ("tenantId", "siteId", "signedSafeByWorkerId") REFERENCES "Worker"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MaintenanceRequest" ADD CONSTRAINT "MaintenanceRequest_tenantId_siteId_stationId_fkey" FOREIGN KEY ("tenantId", "siteId", "stationId") REFERENCES "Station"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MaintenanceRequest" ADD CONSTRAINT "MaintenanceRequest_tenantId_siteId_deviceId_fkey" FOREIGN KEY ("tenantId", "siteId", "deviceId") REFERENCES "Device"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MaintenanceRequest" ADD CONSTRAINT "MaintenanceRequest_tenantId_siteId_jobId_fkey" FOREIGN KEY ("tenantId", "siteId", "jobId") REFERENCES "MaintenanceJob"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MaintenanceRequest" ADD CONSTRAINT "MaintenanceRequest_tenantId_siteId_mergedIntoId_fkey" FOREIGN KEY ("tenantId", "siteId", "mergedIntoId") REFERENCES "MaintenanceRequest"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MaintenanceJob" ADD CONSTRAINT "MaintenanceJob_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MaintenanceJob" ADD CONSTRAINT "MaintenanceJob_tenantId_siteId_machineId_fkey" FOREIGN KEY ("tenantId", "siteId", "machineId") REFERENCES "Machine"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MaintenanceJob" ADD CONSTRAINT "MaintenanceJob_tenantId_symptomId_fkey" FOREIGN KEY ("tenantId", "symptomId") REFERENCES "MachineSymptom"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MaintenanceJob" ADD CONSTRAINT "MaintenanceJob_tenantId_siteId_assigneeWorkerId_fkey" FOREIGN KEY ("tenantId", "siteId", "assigneeWorkerId") REFERENCES "Worker"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MaintenanceJob" ADD CONSTRAINT "MaintenanceJob_tenantId_siteId_handedBackByWorkerId_fkey" FOREIGN KEY ("tenantId", "siteId", "handedBackByWorkerId") REFERENCES "Worker"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Inspection" ADD CONSTRAINT "Inspection_tenantId_siteId_assignedInspectorWorkerId_fkey" FOREIGN KEY ("tenantId", "siteId", "assignedInspectorWorkerId") REFERENCES "Worker"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InspectionDefect" ADD CONSTRAINT "InspectionDefect_tenantId_defectCodeId_fkey" FOREIGN KEY ("tenantId", "defectCodeId") REFERENCES "DefectCode"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

