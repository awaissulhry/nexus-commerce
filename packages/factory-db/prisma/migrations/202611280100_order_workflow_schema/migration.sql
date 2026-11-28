-- CreateEnum
CREATE TYPE "BasketMoveKind" AS ENUM ('FORWARD', 'BACK', 'TAKEN_HERE', 'UNDO');

-- CreateEnum
CREATE TYPE "BasketMoveReason" AS ENUM ('REDO', 'MISTAKE', 'OTHER');

-- CreateEnum
CREATE TYPE "BasketRouteEditKind" AS ENUM ('SKIP', 'PUT_BACK', 'ADD', 'NORMAL');

-- CreateEnum
CREATE TYPE "BasketRouteEditReason" AS ENUM ('NOT_NEEDED', 'REDO', 'CUSTOMER', 'OTHER');

-- CreateEnum
CREATE TYPE "FloorLateReason" AS ENUM ('MATERIAL', 'MACHINE', 'PEOPLE', 'REDO');

-- CreateEnum
CREATE TYPE "FloorLateState" AS ENUM ('OPEN', 'KEPT', 'CHANGED');

-- CreateEnum
CREATE TYPE "OrderTeamGivenBy" AS ENUM ('USER', 'RULE');

-- CreateEnum
CREATE TYPE "OrderLineColumnKind" AS ENUM ('TEXT', 'YES_NO', 'CHOICE', 'NUMBER', 'DATE');

-- CreateEnum
CREATE TYPE "TeamPictureKind" AS ENUM ('LETTERS', 'ICON');

-- CreateEnum
CREATE TYPE "PaymentNoticeState" AS ENUM ('OPEN', 'RECORDED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "DepartmentStatus" AS ENUM ('ACTIVE', 'CLOSED');

-- CreateEnum
CREATE TYPE "OrderPrintKind" AS ENUM ('FIRST', 'AGAIN');

-- CreateEnum
CREATE TYPE "OrderPrintReason" AS ENUM ('LOST', 'DAMAGED', 'SMALL_CHANGE', 'ONE_MORE_COPY');

-- AlterEnum
ALTER TYPE "FileCategory" ADD VALUE 'CUSTOMER_LABEL';

-- AlterTable
ALTER TABLE "Bundle" ADD COLUMN     "madeAtPrint" BOOLEAN NOT NULL DEFAULT ('false'::text)::boolean;

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "eventArgs" JSONB,
ADD COLUMN     "eventKey" TEXT;

-- AlterTable
ALTER TABLE "Operation" ADD COLUMN     "departmentDefault" BOOLEAN NOT NULL DEFAULT ('false'::text)::boolean,
ADD COLUMN     "departmentId" UUID;

-- AlterTable
ALTER TABLE "PortalOrderRequest" ADD COLUMN     "pictureFileId" UUID,
ADD COLUMN     "pictureSetAt" TIMESTAMPTZ(3),
ADD COLUMN     "pictureSetById" UUID;

-- AlterTable
ALTER TABLE "PortalOrderRequestLine" ADD COLUMN     "removedAt" TIMESTAMPTZ(3),
ADD COLUMN     "removedById" UUID;

-- AlterTable
ALTER TABLE "ProductionSettings" ADD COLUMN     "basketsAtPrint" BOOLEAN NOT NULL DEFAULT ('false'::text)::boolean;

-- AlterTable
ALTER TABLE "RoutingOperation" ADD COLUMN     "departmentId" UUID;

-- AlterTable
ALTER TABLE "SalesOrder" ADD COLUMN     "floorRestricted" BOOLEAN NOT NULL DEFAULT ('false'::text)::boolean,
ADD COLUMN     "floorRestrictedAt" TIMESTAMPTZ(3),
ADD COLUMN     "floorRestrictedById" UUID,
ADD COLUMN     "pictureFileId" UUID,
ADD COLUMN     "pictureSetAt" TIMESTAMPTZ(3),
ADD COLUMN     "pictureSetById" UUID;

-- AlterTable
ALTER TABLE "Team" ADD COLUMN     "pictureColour" TEXT,
ADD COLUMN     "pictureIcon" TEXT,
ADD COLUMN     "pictureKind" "TeamPictureKind" NOT NULL DEFAULT ('LETTERS'::text)::"TeamPictureKind";

-- CreateTable
CREATE TABLE "BasketMove" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "workOrderId" UUID NOT NULL,
    "bundleId" UUID NOT NULL,
    "fromOperationId" UUID,
    "toOperationId" UUID,
    "kind" "BasketMoveKind" NOT NULL,
    "reason" "BasketMoveReason",
    "note" TEXT,
    "undoesId" UUID,
    "groupId" UUID NOT NULL,
    "workerId" UUID,
    "employeeId" UUID,
    "userId" UUID,
    "deviceId" UUID,
    "clientEventId" TEXT,
    "deviceTime" TIMESTAMPTZ(3),
    "serverTime" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BasketMove_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BasketRouteEdit" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "workOrderId" UUID NOT NULL,
    "bundleId" UUID NOT NULL,
    "operationId" UUID NOT NULL,
    "kind" "BasketRouteEditKind" NOT NULL,
    "reason" "BasketRouteEditReason" NOT NULL,
    "note" TEXT,
    "groupId" UUID NOT NULL,
    "workerId" UUID,
    "employeeId" UUID,
    "userId" UUID,
    "deviceId" UUID,
    "clientEventId" TEXT,
    "deviceTime" TIMESTAMPTZ(3),
    "serverTime" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BasketRouteEdit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FloorLateWarning" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "workOrderId" UUID NOT NULL,
    "bundleId" UUID,
    "days" INTEGER NOT NULL,
    "reason" "FloorLateReason" NOT NULL,
    "state" "FloorLateState" NOT NULL DEFAULT 'OPEN',
    "answeredAt" TIMESTAMPTZ(3),
    "answeredById" UUID,
    "workerId" UUID,
    "employeeId" UUID,
    "deviceId" UUID,
    "clientEventId" TEXT,
    "deviceTime" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "FloorLateWarning_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderTeam" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "salesOrderId" UUID NOT NULL,
    "teamId" UUID NOT NULL,
    "inCharge" BOOLEAN NOT NULL DEFAULT false,
    "basketShare" INTEGER,
    "bundleIds" UUID[] DEFAULT ('{}'::text)::uuid[],
    "givenBy" "OrderTeamGivenBy" NOT NULL DEFAULT 'USER',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,
    "endedAt" TIMESTAMPTZ(3),
    "endedById" UUID,

    CONSTRAINT "OrderTeam_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartyLineColumn" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "partyId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "OrderLineColumnKind" NOT NULL,
    "choices" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "seq" INTEGER NOT NULL,
    "closedAt" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "PartyLineColumn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderLineColumnUse" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "salesOrderId" UUID,
    "portalOrderRequestId" UUID,
    "columnId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "OrderLineColumnUse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderLineOwnValue" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "partyId" UUID NOT NULL,
    "columnId" UUID NOT NULL,
    "salesOrderLineId" UUID,
    "portalOrderRequestLineId" UUID,
    "valueText" TEXT,
    "valueNumber" DECIMAL(18,4),
    "valueDate" DATE,
    "valueBool" BOOLEAN,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "OrderLineOwnValue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartyOfficePerson" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,
    "endedAt" TIMESTAMPTZ(3),
    "endedById" UUID,

    CONSTRAINT "PartyOfficePerson_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentNotice" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "salesOrderId" UUID NOT NULL,
    "depositRequestId" UUID,
    "milestoneId" UUID,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "paidOn" DATE NOT NULL,
    "method" TEXT,
    "note" TEXT,
    "fileId" UUID,
    "state" "PaymentNoticeState" NOT NULL DEFAULT 'OPEN',
    "answeredAt" TIMESTAMPTZ(3),
    "answeredById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "PaymentNotice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Department" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID,
    "number" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "shortName" TEXT NOT NULL,
    "nameI18n" JSONB,
    "tone" TEXT NOT NULL,
    "icon" TEXT NOT NULL,
    "workCentreKind" "WorkCentreKind" NOT NULL,
    "seq" INTEGER NOT NULL DEFAULT 0,
    "floorReady" BOOLEAN NOT NULL DEFAULT false,
    "status" "DepartmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "Department_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderPrint" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "salesOrderId" UUID NOT NULL,
    "kind" "OrderPrintKind" NOT NULL,
    "reason" "OrderPrintReason",
    "note" TEXT,
    "pages" JSONB NOT NULL,
    "cards" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "OrderPrint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShipmentWarehouseLeg" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "shipmentId" UUID NOT NULL,
    "warehouseSiteId" UUID NOT NULL,
    "arrivedAt" TIMESTAMPTZ(3),
    "arrivedById" UUID,
    "forwardedAt" TIMESTAMPTZ(3),
    "forwardedById" UUID,
    "forwardedWithoutLabel" BOOLEAN NOT NULL DEFAULT ('false'::text)::boolean,
    "customerLabelFileId" UUID,
    "customerLabelAt" TIMESTAMPTZ(3),
    "customerLabelById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "ShipmentWarehouseLeg_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BasketMove_tenantId_bundleId_serverTime_idx" ON "BasketMove"("tenantId", "bundleId", "serverTime");

-- CreateIndex
CREATE INDEX "BasketMove_tenantId_workOrderId_serverTime_idx" ON "BasketMove"("tenantId", "workOrderId", "serverTime");

-- CreateIndex
CREATE INDEX "BasketMove_tenantId_groupId_idx" ON "BasketMove"("tenantId", "groupId");

-- CreateIndex
CREATE INDEX "BasketMove_tenantId_employeeId_idx" ON "BasketMove"("tenantId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "BasketMove_tenantId_siteId_bundleId_id_key" ON "BasketMove"("tenantId", "siteId", "bundleId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "BasketMove_tenantId_deviceId_clientEventId_bundleId_key" ON "BasketMove"("tenantId", "deviceId", "clientEventId", "bundleId");

-- CreateIndex
CREATE INDEX "BasketRouteEdit_tenantId_bundleId_serverTime_idx" ON "BasketRouteEdit"("tenantId", "bundleId", "serverTime");

-- CreateIndex
CREATE INDEX "BasketRouteEdit_tenantId_workOrderId_serverTime_idx" ON "BasketRouteEdit"("tenantId", "workOrderId", "serverTime");

-- CreateIndex
CREATE INDEX "BasketRouteEdit_tenantId_groupId_idx" ON "BasketRouteEdit"("tenantId", "groupId");

-- CreateIndex
CREATE INDEX "BasketRouteEdit_tenantId_employeeId_idx" ON "BasketRouteEdit"("tenantId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "BasketRouteEdit_tenantId_deviceId_clientEventId_bundleId_op_key" ON "BasketRouteEdit"("tenantId", "deviceId", "clientEventId", "bundleId", "operationId");

-- CreateIndex
CREATE INDEX "FloorLateWarning_tenantId_siteId_state_idx" ON "FloorLateWarning"("tenantId", "siteId", "state");

-- CreateIndex
CREATE INDEX "FloorLateWarning_tenantId_workOrderId_idx" ON "FloorLateWarning"("tenantId", "workOrderId");

-- CreateIndex
CREATE INDEX "FloorLateWarning_tenantId_employeeId_idx" ON "FloorLateWarning"("tenantId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "FloorLateWarning_tenantId_deviceId_clientEventId_key" ON "FloorLateWarning"("tenantId", "deviceId", "clientEventId");

-- CreateIndex
CREATE INDEX "OrderTeam_tenantId_salesOrderId_idx" ON "OrderTeam"("tenantId", "salesOrderId");

-- CreateIndex
CREATE INDEX "OrderTeam_tenantId_teamId_idx" ON "OrderTeam"("tenantId", "teamId");

-- CreateIndex
CREATE INDEX "OrderTeam_tenantId_siteId_idx" ON "OrderTeam"("tenantId", "siteId");

-- CreateIndex
CREATE UNIQUE INDEX "PartyLineColumn_tenantId_partyId_id_key" ON "PartyLineColumn"("tenantId", "partyId", "id");

-- CreateIndex
CREATE INDEX "OrderLineColumnUse_tenantId_salesOrderId_idx" ON "OrderLineColumnUse"("tenantId", "salesOrderId");

-- CreateIndex
CREATE INDEX "OrderLineColumnUse_tenantId_portalOrderRequestId_idx" ON "OrderLineColumnUse"("tenantId", "portalOrderRequestId");

-- CreateIndex
CREATE INDEX "OrderLineColumnUse_tenantId_columnId_idx" ON "OrderLineColumnUse"("tenantId", "columnId");

-- CreateIndex
CREATE INDEX "OrderLineOwnValue_tenantId_salesOrderLineId_idx" ON "OrderLineOwnValue"("tenantId", "salesOrderLineId");

-- CreateIndex
CREATE INDEX "OrderLineOwnValue_tenantId_portalOrderRequestLineId_idx" ON "OrderLineOwnValue"("tenantId", "portalOrderRequestLineId");

-- CreateIndex
CREATE INDEX "OrderLineOwnValue_tenantId_columnId_idx" ON "OrderLineOwnValue"("tenantId", "columnId");

-- CreateIndex
CREATE INDEX "PartyOfficePerson_tenantId_partyId_idx" ON "PartyOfficePerson"("tenantId", "partyId");

-- CreateIndex
CREATE INDEX "PartyOfficePerson_tenantId_userId_idx" ON "PartyOfficePerson"("tenantId", "userId");

-- CreateIndex
CREATE INDEX "PaymentNotice_tenantId_salesOrderId_state_idx" ON "PaymentNotice"("tenantId", "salesOrderId", "state");

-- CreateIndex
CREATE INDEX "PaymentNotice_tenantId_partyId_state_idx" ON "PaymentNotice"("tenantId", "partyId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "Department_tenantId_number_key" ON "Department"("tenantId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "Department_tenantId_id_key" ON "Department"("tenantId", "id");

-- CreateIndex
CREATE INDEX "OrderPrint_tenantId_salesOrderId_createdAt_idx" ON "OrderPrint"("tenantId", "salesOrderId", "createdAt");

-- CreateIndex
CREATE INDEX "ShipmentWarehouseLeg_tenantId_warehouseSiteId_idx" ON "ShipmentWarehouseLeg"("tenantId", "warehouseSiteId");

-- CreateIndex
CREATE UNIQUE INDEX "ShipmentWarehouseLeg_tenantId_siteId_partyId_shipmentId_key" ON "ShipmentWarehouseLeg"("tenantId", "siteId", "partyId", "shipmentId");

-- AddForeignKey
ALTER TABLE "BasketMove" ADD CONSTRAINT "BasketMove_tenantId_siteId_workOrderId_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId") REFERENCES "WorkOrder"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BasketMove" ADD CONSTRAINT "BasketMove_tenantId_siteId_workOrderId_bundleId_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId", "bundleId") REFERENCES "Bundle"("tenantId", "siteId", "workOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BasketMove" ADD CONSTRAINT "BasketMove_tenantId_siteId_workOrderId_fromOperationId_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId", "fromOperationId") REFERENCES "WorkOrderOperation"("tenantId", "siteId", "workOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BasketMove" ADD CONSTRAINT "BasketMove_tenantId_siteId_workOrderId_toOperationId_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId", "toOperationId") REFERENCES "WorkOrderOperation"("tenantId", "siteId", "workOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BasketMove" ADD CONSTRAINT "BasketMove_tenantId_siteId_bundleId_undoesId_fkey" FOREIGN KEY ("tenantId", "siteId", "bundleId", "undoesId") REFERENCES "BasketMove"("tenantId", "siteId", "bundleId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BasketMove" ADD CONSTRAINT "BasketMove_tenantId_siteId_workerId_fkey" FOREIGN KEY ("tenantId", "siteId", "workerId") REFERENCES "Worker"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BasketMove" ADD CONSTRAINT "BasketMove_tenantId_employeeId_fkey" FOREIGN KEY ("tenantId", "employeeId") REFERENCES "Employee"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BasketMove" ADD CONSTRAINT "BasketMove_tenantId_siteId_deviceId_fkey" FOREIGN KEY ("tenantId", "siteId", "deviceId") REFERENCES "Device"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BasketRouteEdit" ADD CONSTRAINT "BasketRouteEdit_tenantId_siteId_workOrderId_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId") REFERENCES "WorkOrder"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BasketRouteEdit" ADD CONSTRAINT "BasketRouteEdit_tenantId_siteId_workOrderId_bundleId_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId", "bundleId") REFERENCES "Bundle"("tenantId", "siteId", "workOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BasketRouteEdit" ADD CONSTRAINT "BasketRouteEdit_tenantId_siteId_workOrderId_operationId_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId", "operationId") REFERENCES "WorkOrderOperation"("tenantId", "siteId", "workOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BasketRouteEdit" ADD CONSTRAINT "BasketRouteEdit_tenantId_siteId_workerId_fkey" FOREIGN KEY ("tenantId", "siteId", "workerId") REFERENCES "Worker"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BasketRouteEdit" ADD CONSTRAINT "BasketRouteEdit_tenantId_employeeId_fkey" FOREIGN KEY ("tenantId", "employeeId") REFERENCES "Employee"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BasketRouteEdit" ADD CONSTRAINT "BasketRouteEdit_tenantId_siteId_deviceId_fkey" FOREIGN KEY ("tenantId", "siteId", "deviceId") REFERENCES "Device"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FloorLateWarning" ADD CONSTRAINT "FloorLateWarning_tenantId_siteId_workOrderId_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId") REFERENCES "WorkOrder"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FloorLateWarning" ADD CONSTRAINT "FloorLateWarning_tenantId_siteId_workOrderId_bundleId_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId", "bundleId") REFERENCES "Bundle"("tenantId", "siteId", "workOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FloorLateWarning" ADD CONSTRAINT "FloorLateWarning_tenantId_siteId_workerId_fkey" FOREIGN KEY ("tenantId", "siteId", "workerId") REFERENCES "Worker"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FloorLateWarning" ADD CONSTRAINT "FloorLateWarning_tenantId_employeeId_fkey" FOREIGN KEY ("tenantId", "employeeId") REFERENCES "Employee"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FloorLateWarning" ADD CONSTRAINT "FloorLateWarning_tenantId_siteId_deviceId_fkey" FOREIGN KEY ("tenantId", "siteId", "deviceId") REFERENCES "Device"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OrderTeam" ADD CONSTRAINT "OrderTeam_tenantId_companyId_partyId_salesOrderId_fkey" FOREIGN KEY ("tenantId", "companyId", "partyId", "salesOrderId") REFERENCES "SalesOrder"("tenantId", "companyId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OrderTeam" ADD CONSTRAINT "OrderTeam_tenantId_siteId_teamId_fkey" FOREIGN KEY ("tenantId", "siteId", "teamId") REFERENCES "Team"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PartyLineColumn" ADD CONSTRAINT "PartyLineColumn_tenantId_partyId_fkey" FOREIGN KEY ("tenantId", "partyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OrderLineColumnUse" ADD CONSTRAINT "OrderLineColumnUse_tenantId_companyId_partyId_salesOrderId_fkey" FOREIGN KEY ("tenantId", "companyId", "partyId", "salesOrderId") REFERENCES "SalesOrder"("tenantId", "companyId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OrderLineColumnUse" ADD CONSTRAINT "OrderLineColumnUse_tenantId_partyId_portalOrderRequestId_fkey" FOREIGN KEY ("tenantId", "partyId", "portalOrderRequestId") REFERENCES "PortalOrderRequest"("tenantId", "partyId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OrderLineColumnUse" ADD CONSTRAINT "OrderLineColumnUse_tenantId_partyId_columnId_fkey" FOREIGN KEY ("tenantId", "partyId", "columnId") REFERENCES "PartyLineColumn"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OrderLineOwnValue" ADD CONSTRAINT "OrderLineOwnValue_tenantId_partyId_columnId_fkey" FOREIGN KEY ("tenantId", "partyId", "columnId") REFERENCES "PartyLineColumn"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OrderLineOwnValue" ADD CONSTRAINT "OrderLineOwnValue_tenantId_partyId_salesOrderLineId_fkey" FOREIGN KEY ("tenantId", "partyId", "salesOrderLineId") REFERENCES "SalesOrderLine"("tenantId", "partyId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OrderLineOwnValue" ADD CONSTRAINT "OrderLineOwnValue_tenantId_partyId_portalOrderRequestLineI_fkey" FOREIGN KEY ("tenantId", "partyId", "portalOrderRequestLineId") REFERENCES "PortalOrderRequestLine"("tenantId", "partyId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PartyOfficePerson" ADD CONSTRAINT "PartyOfficePerson_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PartyOfficePerson" ADD CONSTRAINT "PartyOfficePerson_tenantId_partyId_fkey" FOREIGN KEY ("tenantId", "partyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PartyOfficePerson" ADD CONSTRAINT "PartyOfficePerson_tenantId_userId_fkey" FOREIGN KEY ("tenantId", "userId") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PortalOrderRequest" ADD CONSTRAINT "PortalOrderRequest_tenantId_pictureFileId_fkey" FOREIGN KEY ("tenantId", "pictureFileId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PaymentNotice" ADD CONSTRAINT "PaymentNotice_tenantId_companyId_partyId_salesOrderId_fkey" FOREIGN KEY ("tenantId", "companyId", "partyId", "salesOrderId") REFERENCES "SalesOrder"("tenantId", "companyId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PaymentNotice" ADD CONSTRAINT "PaymentNotice_tenantId_companyId_partyId_depositRequestId_fkey" FOREIGN KEY ("tenantId", "companyId", "partyId", "depositRequestId") REFERENCES "DepositRequest"("tenantId", "companyId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PaymentNotice" ADD CONSTRAINT "PaymentNotice_tenantId_partyId_milestoneId_fkey" FOREIGN KEY ("tenantId", "partyId", "milestoneId") REFERENCES "SalesOrderMilestone"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PaymentNotice" ADD CONSTRAINT "PaymentNotice_tenantId_fileId_fkey" FOREIGN KEY ("tenantId", "fileId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Department" ADD CONSTRAINT "Department_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Operation" ADD CONSTRAINT "Operation_tenantId_departmentId_fkey" FOREIGN KEY ("tenantId", "departmentId") REFERENCES "Department"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RoutingOperation" ADD CONSTRAINT "RoutingOperation_tenantId_departmentId_fkey" FOREIGN KEY ("tenantId", "departmentId") REFERENCES "Department"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OrderPrint" ADD CONSTRAINT "OrderPrint_tenantId_companyId_partyId_salesOrderId_fkey" FOREIGN KEY ("tenantId", "companyId", "partyId", "salesOrderId") REFERENCES "SalesOrder"("tenantId", "companyId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SalesOrder" ADD CONSTRAINT "SalesOrder_tenantId_pictureFileId_fkey" FOREIGN KEY ("tenantId", "pictureFileId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ShipmentWarehouseLeg" ADD CONSTRAINT "ShipmentWarehouseLeg_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ShipmentWarehouseLeg" ADD CONSTRAINT "ShipmentWarehouseLeg_tenantId_siteId_partyId_shipmentId_fkey" FOREIGN KEY ("tenantId", "siteId", "partyId", "shipmentId") REFERENCES "Shipment"("tenantId", "siteId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ShipmentWarehouseLeg" ADD CONSTRAINT "ShipmentWarehouseLeg_tenantId_companyId_warehouseSiteId_fkey" FOREIGN KEY ("tenantId", "companyId", "warehouseSiteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ShipmentWarehouseLeg" ADD CONSTRAINT "ShipmentWarehouseLeg_tenantId_customerLabelFileId_fkey" FOREIGN KEY ("tenantId", "customerLabelFileId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

