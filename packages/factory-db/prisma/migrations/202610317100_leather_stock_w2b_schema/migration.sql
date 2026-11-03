-- CreateEnum
CREATE TYPE "HideMarkKind" AS ENUM ('DEFECT', 'ZONE');

-- CreateEnum
CREATE TYPE "RemnantState" AS ENUM ('IN_STOCK', 'ISSUED', 'USED', 'SCRAPPED', 'VOID');

-- CreateEnum
CREATE TYPE "FabricRollState" AS ENUM ('FULL', 'PARTIAL', 'END', 'CONSUMED', 'SCRAPPED', 'RETURNED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NumberKind" ADD VALUE 'ROLL';
ALTER TYPE "NumberKind" ADD VALUE 'REMNANT';

-- AlterEnum
ALTER TYPE "StockMoveReason" ADD VALUE 'REMNANT';

-- AlterTable
ALTER TABLE "Hide" ADD COLUMN     "gradeId" UUID,
ADD COLUMN     "shadeGroupId" UUID;

-- AlterTable
ALTER TABLE "Item" ADD COLUMN     "packSize" DECIMAL(18,4),
ADD COLUMN     "packUom" "Uom";

-- CreateTable
CREATE TABLE "LeatherGrade" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "code" TEXT NOT NULL,
    "labelIt" TEXT NOT NULL,
    "labelEn" TEXT NOT NULL,
    "labelI18n" JSONB NOT NULL DEFAULT '{}',
    "usableShare" DECIMAL(5,2) NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "LeatherGrade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ItemGradeRule" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "itemId" UUID NOT NULL,
    "gradeId" UUID NOT NULL,
    "usableShare" DECIMAL(5,2) NOT NULL,
    "panels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "ItemGradeRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HideMark" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "lotId" UUID NOT NULL,
    "hideId" UUID NOT NULL,
    "kind" "HideMarkKind" NOT NULL,
    "x" DECIMAL(6,5) NOT NULL,
    "y" DECIMAL(6,5) NOT NULL,
    "outline" JSONB NOT NULL DEFAULT '[]',
    "defectCodeId" UUID,
    "zoneGradeId" UUID,
    "photoFileId" UUID,
    "incomingInspectionId" UUID,
    "note" TEXT,
    "voidedAt" TIMESTAMPTZ(3),
    "voidedById" UUID,
    "voidReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "HideMark_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HideMeasure" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "lotId" UUID NOT NULL,
    "hideId" UUID NOT NULL,
    "declaredArea" DECIMAL(18,4),
    "measuredArea" DECIMAL(18,4) NOT NULL,
    "areaUom" "Uom" NOT NULL,
    "incomingInspectionId" UUID,
    "measuredById" UUID,
    "measuredByWorkerId" UUID,
    "deviceId" UUID,
    "measuredAt" TIMESTAMPTZ(3) NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "HideMeasure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShadeGroup" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "itemId" UUID NOT NULL,
    "itemColourId" UUID,
    "lotSiteId" UUID,
    "lotId" UUID,
    "label" TEXT NOT NULL,
    "outOfShade" BOOLEAN NOT NULL DEFAULT false,
    "swatchFileId" UUID,
    "swatchRef" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "ShadeGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Remnant" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "lotId" UUID NOT NULL,
    "hideId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "area" DECIMAL(18,4) NOT NULL,
    "areaUom" "Uom" NOT NULL,
    "baseArea" DECIMAL(18,4) NOT NULL,
    "gradeId" UUID,
    "locationId" UUID,
    "state" "RemnantState" NOT NULL DEFAULT 'IN_STOCK',
    "moveId" UUID NOT NULL,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "Remnant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FabricRoll" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "lotId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "supplierRollRef" TEXT,
    "length" DECIMAL(18,4) NOT NULL,
    "uom" "Uom" NOT NULL,
    "lengthLeft" DECIMAL(18,4) NOT NULL,
    "widthCm" DECIMAL(10,2),
    "shade" TEXT,
    "shadeGroupId" UUID,
    "shrinkageLengthPercent" DECIMAL(5,2),
    "shrinkageWidthPercent" DECIMAL(5,2),
    "shrinkageGroup" TEXT,
    "defects" TEXT,
    "locationId" UUID,
    "state" "FabricRollState" NOT NULL DEFAULT 'FULL',
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "FabricRoll_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GarmentProtectorLot" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "workOrderId" UUID NOT NULL,
    "garmentSerialId" UUID,
    "itemId" UUID NOT NULL,
    "lotId" UUID NOT NULL,
    "placement" TEXT,
    "voidedAt" TIMESTAMPTZ(3),
    "voidedById" UUID,
    "voidReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "GarmentProtectorLot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LeatherGrade_tenantId_code_key" ON "LeatherGrade"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "LeatherGrade_tenantId_id_key" ON "LeatherGrade"("tenantId", "id");

-- CreateIndex
CREATE INDEX "ItemGradeRule_tenantId_itemId_idx" ON "ItemGradeRule"("tenantId", "itemId");

-- CreateIndex
CREATE INDEX "HideMark_tenantId_hideId_idx" ON "HideMark"("tenantId", "hideId");

-- CreateIndex
CREATE INDEX "HideMark_tenantId_incomingInspectionId_idx" ON "HideMark"("tenantId", "incomingInspectionId");

-- CreateIndex
CREATE INDEX "HideMeasure_tenantId_hideId_measuredAt_idx" ON "HideMeasure"("tenantId", "hideId", "measuredAt");

-- CreateIndex
CREATE INDEX "HideMeasure_tenantId_lotId_idx" ON "HideMeasure"("tenantId", "lotId");

-- CreateIndex
CREATE INDEX "ShadeGroup_tenantId_lotId_idx" ON "ShadeGroup"("tenantId", "lotId");

-- CreateIndex
CREATE UNIQUE INDEX "ShadeGroup_tenantId_itemId_itemColourId_lotId_label_key" ON "ShadeGroup"("tenantId", "itemId", "itemColourId", "lotId", "label");

-- CreateIndex
CREATE UNIQUE INDEX "ShadeGroup_tenantId_id_key" ON "ShadeGroup"("tenantId", "id");

-- CreateIndex
CREATE INDEX "Remnant_tenantId_hideId_idx" ON "Remnant"("tenantId", "hideId");

-- CreateIndex
CREATE INDEX "Remnant_tenantId_moveId_idx" ON "Remnant"("tenantId", "moveId");

-- CreateIndex
CREATE INDEX "Remnant_tenantId_siteId_state_idx" ON "Remnant"("tenantId", "siteId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "Remnant_tenantId_code_key" ON "Remnant"("tenantId", "code");

-- CreateIndex
CREATE INDEX "FabricRoll_tenantId_lotId_idx" ON "FabricRoll"("tenantId", "lotId");

-- CreateIndex
CREATE INDEX "FabricRoll_tenantId_siteId_state_idx" ON "FabricRoll"("tenantId", "siteId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "FabricRoll_tenantId_code_key" ON "FabricRoll"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "FabricRoll_tenantId_siteId_id_key" ON "FabricRoll"("tenantId", "siteId", "id");

-- CreateIndex
CREATE INDEX "GarmentProtectorLot_tenantId_lotId_idx" ON "GarmentProtectorLot"("tenantId", "lotId");

-- CreateIndex
CREATE INDEX "GarmentProtectorLot_tenantId_workOrderId_idx" ON "GarmentProtectorLot"("tenantId", "workOrderId");

-- CreateIndex
CREATE INDEX "GarmentProtectorLot_tenantId_garmentSerialId_idx" ON "GarmentProtectorLot"("tenantId", "garmentSerialId");

-- CreateIndex
CREATE UNIQUE INDEX "GarmentSerial_tenantId_siteId_workOrderId_id_key" ON "GarmentSerial"("tenantId", "siteId", "workOrderId", "id");

-- CreateIndex
CREATE INDEX "Hide_tenantId_gradeId_idx" ON "Hide"("tenantId", "gradeId");

-- CreateIndex
CREATE INDEX "Hide_tenantId_shadeGroupId_idx" ON "Hide"("tenantId", "shadeGroupId");

-- AddForeignKey
ALTER TABLE "Hide" ADD CONSTRAINT "Hide_tenantId_gradeId_fkey" FOREIGN KEY ("tenantId", "gradeId") REFERENCES "LeatherGrade"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Hide" ADD CONSTRAINT "Hide_tenantId_shadeGroupId_fkey" FOREIGN KEY ("tenantId", "shadeGroupId") REFERENCES "ShadeGroup"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ItemGradeRule" ADD CONSTRAINT "ItemGradeRule_tenantId_itemId_fkey" FOREIGN KEY ("tenantId", "itemId") REFERENCES "Item"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ItemGradeRule" ADD CONSTRAINT "ItemGradeRule_tenantId_gradeId_fkey" FOREIGN KEY ("tenantId", "gradeId") REFERENCES "LeatherGrade"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "HideMark" ADD CONSTRAINT "HideMark_tenantId_siteId_lotId_hideId_fkey" FOREIGN KEY ("tenantId", "siteId", "lotId", "hideId") REFERENCES "Hide"("tenantId", "siteId", "lotId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "HideMark" ADD CONSTRAINT "HideMark_tenantId_defectCodeId_fkey" FOREIGN KEY ("tenantId", "defectCodeId") REFERENCES "DefectCode"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "HideMark" ADD CONSTRAINT "HideMark_tenantId_zoneGradeId_fkey" FOREIGN KEY ("tenantId", "zoneGradeId") REFERENCES "LeatherGrade"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "HideMark" ADD CONSTRAINT "HideMark_tenantId_photoFileId_fkey" FOREIGN KEY ("tenantId", "photoFileId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "HideMark" ADD CONSTRAINT "HideMark_tenantId_siteId_lotId_incomingInspectionId_fkey" FOREIGN KEY ("tenantId", "siteId", "lotId", "incomingInspectionId") REFERENCES "IncomingInspection"("tenantId", "siteId", "lotId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "HideMeasure" ADD CONSTRAINT "HideMeasure_tenantId_siteId_lotId_hideId_fkey" FOREIGN KEY ("tenantId", "siteId", "lotId", "hideId") REFERENCES "Hide"("tenantId", "siteId", "lotId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "HideMeasure" ADD CONSTRAINT "HideMeasure_tenantId_siteId_lotId_incomingInspectionId_fkey" FOREIGN KEY ("tenantId", "siteId", "lotId", "incomingInspectionId") REFERENCES "IncomingInspection"("tenantId", "siteId", "lotId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "HideMeasure" ADD CONSTRAINT "HideMeasure_tenantId_siteId_measuredByWorkerId_fkey" FOREIGN KEY ("tenantId", "siteId", "measuredByWorkerId") REFERENCES "Worker"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "HideMeasure" ADD CONSTRAINT "HideMeasure_tenantId_siteId_deviceId_fkey" FOREIGN KEY ("tenantId", "siteId", "deviceId") REFERENCES "Device"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ShadeGroup" ADD CONSTRAINT "ShadeGroup_tenantId_itemId_fkey" FOREIGN KEY ("tenantId", "itemId") REFERENCES "Item"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ShadeGroup" ADD CONSTRAINT "ShadeGroup_tenantId_itemId_itemColourId_fkey" FOREIGN KEY ("tenantId", "itemId", "itemColourId") REFERENCES "ItemColour"("tenantId", "itemId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ShadeGroup" ADD CONSTRAINT "ShadeGroup_tenantId_lotSiteId_itemId_lotId_fkey" FOREIGN KEY ("tenantId", "lotSiteId", "itemId", "lotId") REFERENCES "Lot"("tenantId", "siteId", "itemId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ShadeGroup" ADD CONSTRAINT "ShadeGroup_tenantId_swatchFileId_fkey" FOREIGN KEY ("tenantId", "swatchFileId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Remnant" ADD CONSTRAINT "Remnant_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Remnant" ADD CONSTRAINT "Remnant_tenantId_siteId_lotId_hideId_fkey" FOREIGN KEY ("tenantId", "siteId", "lotId", "hideId") REFERENCES "Hide"("tenantId", "siteId", "lotId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Remnant" ADD CONSTRAINT "Remnant_tenantId_gradeId_fkey" FOREIGN KEY ("tenantId", "gradeId") REFERENCES "LeatherGrade"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Remnant" ADD CONSTRAINT "Remnant_tenantId_siteId_locationId_fkey" FOREIGN KEY ("tenantId", "siteId", "locationId") REFERENCES "Location"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Remnant" ADD CONSTRAINT "Remnant_tenantId_siteId_moveId_fkey" FOREIGN KEY ("tenantId", "siteId", "moveId") REFERENCES "StockMove"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FabricRoll" ADD CONSTRAINT "FabricRoll_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FabricRoll" ADD CONSTRAINT "FabricRoll_tenantId_siteId_itemId_lotId_fkey" FOREIGN KEY ("tenantId", "siteId", "itemId", "lotId") REFERENCES "Lot"("tenantId", "siteId", "itemId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FabricRoll" ADD CONSTRAINT "FabricRoll_tenantId_shadeGroupId_fkey" FOREIGN KEY ("tenantId", "shadeGroupId") REFERENCES "ShadeGroup"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FabricRoll" ADD CONSTRAINT "FabricRoll_tenantId_siteId_locationId_fkey" FOREIGN KEY ("tenantId", "siteId", "locationId") REFERENCES "Location"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "GarmentProtectorLot" ADD CONSTRAINT "GarmentProtectorLot_tenantId_siteId_workOrderId_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId") REFERENCES "WorkOrder"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "GarmentProtectorLot" ADD CONSTRAINT "GarmentProtectorLot_tenantId_siteId_workOrderId_garmentSer_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId", "garmentSerialId") REFERENCES "GarmentSerial"("tenantId", "siteId", "workOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "GarmentProtectorLot" ADD CONSTRAINT "GarmentProtectorLot_tenantId_siteId_itemId_lotId_fkey" FOREIGN KEY ("tenantId", "siteId", "itemId", "lotId") REFERENCES "Lot"("tenantId", "siteId", "itemId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

