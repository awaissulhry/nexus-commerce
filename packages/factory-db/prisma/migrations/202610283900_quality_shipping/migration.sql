-- CreateEnum
CREATE TYPE "GarmentTracking" AS ENUM ('BATCH', 'SERIAL');

-- CreateEnum
CREATE TYPE "InspectionStatus" AS ENUM ('OPEN', 'PASSED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DefectClass" AS ENUM ('CRITICAL', 'MAJOR', 'MINOR');

-- CreateEnum
CREATE TYPE "GarmentSerialStatus" AS ENUM ('MADE', 'RELEASED', 'SHIPPED', 'VOID');

-- CreateEnum
CREATE TYPE "PpeRegisterKind" AS ENUM ('COMPLAINT', 'NON_CONFORMITY', 'RECALL');

-- CreateEnum
CREATE TYPE "PpeRegisterStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "TransportBy" AS ENUM ('SENDER', 'RECIPIENT', 'CARRIER');

-- CreateEnum
CREATE TYPE "ShipmentStatus" AS ENUM ('DRAFT', 'PACKED', 'SHIPPED', 'DELIVERED', 'RETURNED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DdtReason" AS ENUM ('SALE', 'WORK_ON_ACCOUNT', 'RETURN_FROM_WORK', 'RETURN', 'ON_APPROVAL', 'REPAIR', 'SAMPLE', 'TRANSFER', 'OTHER');

-- CreateEnum
CREATE TYPE "DdtFreight" AS ENUM ('FREE', 'FORWARD');

-- CreateEnum
CREATE TYPE "TrackingStatus" AS ENUM ('LABEL_CREATED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'EXCEPTION', 'RETURNED');

-- CreateEnum
CREATE TYPE "TrackingSource" AS ENUM ('WEBHOOK', 'POLL', 'MANUAL');

-- AlterTable
ALTER TABLE "Style" ADD COLUMN     "garmentTracking" "GarmentTracking" NOT NULL DEFAULT 'BATCH';

-- CreateTable
CREATE TABLE "Inspection" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "workOrderId" UUID NOT NULL,
    "lotSize" INTEGER NOT NULL,
    "sampleSize" INTEGER NOT NULL,
    "inspectionLevel" TEXT NOT NULL,
    "aqlMajor" DECIMAL(7,3) NOT NULL,
    "aqlMinor" DECIMAL(7,3) NOT NULL,
    "acceptMajor" INTEGER NOT NULL,
    "acceptMinor" INTEGER NOT NULL,
    "checklist" JSONB,
    "status" "InspectionStatus" NOT NULL DEFAULT 'OPEN',
    "inspectorWorkerId" UUID,
    "inspectorUserId" UUID,
    "notMakerStatement" BOOLEAN NOT NULL DEFAULT false,
    "decidedAt" TIMESTAMPTZ(3),
    "signatureSha256" TEXT,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "Inspection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InspectionDefect" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "workOrderId" UUID NOT NULL,
    "inspectionId" UUID NOT NULL,
    "defectClass" "DefectClass" NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "quantity" INTEGER NOT NULL,
    "workOrderSizeId" UUID,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "InspectionDefect_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QualityRelease" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "workOrderId" UUID NOT NULL,
    "workOrderSizeId" UUID NOT NULL,
    "inspectionId" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "certificateIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "releasedById" UUID NOT NULL,
    "releasedAt" TIMESTAMPTZ(3) NOT NULL,
    "signatureSha256" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "QualityRelease_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GarmentSerial" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "workOrderId" UUID NOT NULL,
    "workOrderSizeId" UUID NOT NULL,
    "serial" TEXT NOT NULL,
    "status" "GarmentSerialStatus" NOT NULL DEFAULT 'MADE',
    "releaseId" UUID,
    "shipmentLineId" UUID,
    "voidedAt" TIMESTAMPTZ(3),
    "voidReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "GarmentSerial_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PpeRegisterEntry" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "kind" "PpeRegisterKind" NOT NULL,
    "styleId" UUID NOT NULL,
    "batchNumbers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "serials" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "partyId" UUID,
    "reportedAt" TIMESTAMPTZ(3) NOT NULL,
    "description" TEXT NOT NULL,
    "investigation" TEXT,
    "actionTaken" TEXT,
    "distributorsInformedAt" TIMESTAMPTZ(3),
    "authorityNotifiedAt" TIMESTAMPTZ(3),
    "status" "PpeRegisterStatus" NOT NULL DEFAULT 'OPEN',
    "closedAt" TIMESTAMPTZ(3),
    "closedById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "PpeRegisterEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShippingSettings" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "senderAddress" JSONB NOT NULL,
    "returnAddress" JSONB,
    "integrationAccountId" UUID,
    "defaultCarrierCode" TEXT,
    "defaultServiceCode" TEXT,
    "defaultTransportBy" "TransportBy" NOT NULL DEFAULT 'CARRIER',
    "defaultGoodsAppearance" TEXT,
    "labelPrinterId" UUID,
    "documentPrinterId" UUID,
    "cutOffTime" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "ShippingSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shipment" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "salesOrderId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "status" "ShipmentStatus" NOT NULL DEFAULT 'DRAFT',
    "shipToAddressId" UUID,
    "shipTo" JSONB NOT NULL,
    "transportBy" "TransportBy" NOT NULL DEFAULT 'CARRIER',
    "integrationAccountId" UUID,
    "carrierCode" TEXT,
    "carrierName" TEXT,
    "serviceCode" TEXT,
    "carrierShipmentId" TEXT,
    "ddtRequired" BOOLEAN NOT NULL DEFAULT true,
    "packedAt" TIMESTAMPTZ(3),
    "shippedAt" TIMESTAMPTZ(3),
    "deliveredAt" TIMESTAMPTZ(3),
    "returnedAt" TIMESTAMPTZ(3),
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelReason" TEXT,
    "internalNote" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "Shipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShipmentLine" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "shipmentId" UUID NOT NULL,
    "parcelId" UUID,
    "workOrderId" UUID NOT NULL,
    "workOrderSizeId" UUID NOT NULL,
    "salesOrderLineId" UUID NOT NULL,
    "size" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "ShipmentLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Parcel" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "shipmentId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "grossWeightKg" DECIMAL(18,4),
    "lengthCm" DECIMAL(10,2),
    "widthCm" DECIMAL(10,2),
    "heightCm" DECIMAL(10,2),
    "trackingNumber" TEXT,
    "carrierParcelId" TEXT,
    "labelledAt" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "Parcel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ddt" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "shipmentId" UUID NOT NULL,
    "numberSeriesId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "documentDate" DATE NOT NULL,
    "reason" "DdtReason" NOT NULL,
    "reasonText" TEXT,
    "transportBy" "TransportBy" NOT NULL,
    "carrier" JSONB,
    "startAt" TIMESTAMPTZ(3) NOT NULL,
    "appearance" TEXT NOT NULL,
    "packages" INTEGER NOT NULL,
    "grossWeightKg" DECIMAL(18,4) NOT NULL,
    "netWeightKg" DECIMAL(18,4),
    "freight" "DdtFreight",
    "sender" JSONB NOT NULL,
    "recipient" JSONB NOT NULL,
    "destination" JSONB,
    "lines" JSONB NOT NULL,
    "documentRefs" JSONB,
    "remarks" TEXT,
    "internalNote" TEXT,
    "issuedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdById" UUID,

    CONSTRAINT "Ddt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DdtCancellation" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "ddtId" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "cancelledAt" TIMESTAMPTZ(3) NOT NULL,
    "createdById" UUID,

    CONSTRAINT "DdtCancellation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrackingEvent" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "shipmentId" UUID NOT NULL,
    "parcelId" UUID,
    "status" "TrackingStatus" NOT NULL,
    "carrierStatusCode" TEXT,
    "description" TEXT,
    "location" TEXT,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "recordedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" "TrackingSource" NOT NULL,
    "externalEventId" TEXT,
    "createdById" UUID,

    CONSTRAINT "TrackingEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Inspection_tenantId_workOrderId_idx" ON "Inspection"("tenantId", "workOrderId");

-- CreateIndex
CREATE INDEX "Inspection_tenantId_status_idx" ON "Inspection"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Inspection_tenantId_siteId_workOrderId_id_key" ON "Inspection"("tenantId", "siteId", "workOrderId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "InspectionDefect_tenantId_inspectionId_defectClass_code_key" ON "InspectionDefect"("tenantId", "inspectionId", "defectClass", "code");

-- CreateIndex
CREATE INDEX "QualityRelease_tenantId_workOrderId_idx" ON "QualityRelease"("tenantId", "workOrderId");

-- CreateIndex
CREATE INDEX "QualityRelease_tenantId_inspectionId_idx" ON "QualityRelease"("tenantId", "inspectionId");

-- CreateIndex
CREATE UNIQUE INDEX "QualityRelease_tenantId_siteId_workOrderSizeId_id_key" ON "QualityRelease"("tenantId", "siteId", "workOrderSizeId", "id");

-- CreateIndex
CREATE INDEX "GarmentSerial_tenantId_workOrderSizeId_idx" ON "GarmentSerial"("tenantId", "workOrderSizeId");

-- CreateIndex
CREATE INDEX "GarmentSerial_tenantId_releaseId_idx" ON "GarmentSerial"("tenantId", "releaseId");

-- CreateIndex
CREATE INDEX "GarmentSerial_tenantId_shipmentLineId_idx" ON "GarmentSerial"("tenantId", "shipmentLineId");

-- CreateIndex
CREATE UNIQUE INDEX "GarmentSerial_tenantId_serial_key" ON "GarmentSerial"("tenantId", "serial");

-- CreateIndex
CREATE INDEX "PpeRegisterEntry_tenantId_styleId_idx" ON "PpeRegisterEntry"("tenantId", "styleId");

-- CreateIndex
CREATE UNIQUE INDEX "PpeRegisterEntry_tenantId_companyId_reference_key" ON "PpeRegisterEntry"("tenantId", "companyId", "reference");

-- CreateIndex
CREATE INDEX "ShippingSettings_tenantId_siteId_idx" ON "ShippingSettings"("tenantId", "siteId");

-- CreateIndex
CREATE INDEX "Shipment_tenantId_salesOrderId_idx" ON "Shipment"("tenantId", "salesOrderId");

-- CreateIndex
CREATE INDEX "Shipment_tenantId_status_idx" ON "Shipment"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Shipment_tenantId_companyId_number_key" ON "Shipment"("tenantId", "companyId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "Shipment_tenantId_siteId_partyId_id_key" ON "Shipment"("tenantId", "siteId", "partyId", "id");

-- CreateIndex
CREATE INDEX "ShipmentLine_tenantId_shipmentId_idx" ON "ShipmentLine"("tenantId", "shipmentId");

-- CreateIndex
CREATE INDEX "ShipmentLine_tenantId_workOrderSizeId_idx" ON "ShipmentLine"("tenantId", "workOrderSizeId");

-- CreateIndex
CREATE UNIQUE INDEX "ShipmentLine_tenantId_siteId_workOrderSizeId_id_key" ON "ShipmentLine"("tenantId", "siteId", "workOrderSizeId", "id");

-- CreateIndex
CREATE INDEX "Parcel_tenantId_trackingNumber_idx" ON "Parcel"("tenantId", "trackingNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Parcel_tenantId_shipmentId_seq_key" ON "Parcel"("tenantId", "shipmentId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "Parcel_tenantId_siteId_shipmentId_id_key" ON "Parcel"("tenantId", "siteId", "shipmentId", "id");

-- CreateIndex
CREATE INDEX "Ddt_tenantId_shipmentId_idx" ON "Ddt"("tenantId", "shipmentId");

-- CreateIndex
CREATE UNIQUE INDEX "Ddt_tenantId_numberSeriesId_number_key" ON "Ddt"("tenantId", "numberSeriesId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "Ddt_tenantId_siteId_partyId_id_key" ON "Ddt"("tenantId", "siteId", "partyId", "id");

-- CreateIndex
CREATE INDEX "DdtCancellation_tenantId_ddtId_idx" ON "DdtCancellation"("tenantId", "ddtId");

-- CreateIndex
CREATE INDEX "TrackingEvent_tenantId_shipmentId_occurredAt_idx" ON "TrackingEvent"("tenantId", "shipmentId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "TrackingEvent_tenantId_shipmentId_externalEventId_key" ON "TrackingEvent"("tenantId", "shipmentId", "externalEventId");

-- AddForeignKey
ALTER TABLE "Inspection" ADD CONSTRAINT "Inspection_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Inspection" ADD CONSTRAINT "Inspection_tenantId_siteId_workOrderId_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId") REFERENCES "WorkOrder"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Inspection" ADD CONSTRAINT "Inspection_tenantId_siteId_inspectorWorkerId_fkey" FOREIGN KEY ("tenantId", "siteId", "inspectorWorkerId") REFERENCES "Worker"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InspectionDefect" ADD CONSTRAINT "InspectionDefect_tenantId_siteId_workOrderId_inspectionId_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId", "inspectionId") REFERENCES "Inspection"("tenantId", "siteId", "workOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InspectionDefect" ADD CONSTRAINT "InspectionDefect_tenantId_siteId_workOrderId_workOrderSize_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId", "workOrderSizeId") REFERENCES "WorkOrderSize"("tenantId", "siteId", "workOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "QualityRelease" ADD CONSTRAINT "QualityRelease_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "QualityRelease" ADD CONSTRAINT "QualityRelease_tenantId_siteId_workOrderId_workOrderSizeId_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId", "workOrderSizeId") REFERENCES "WorkOrderSize"("tenantId", "siteId", "workOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "QualityRelease" ADD CONSTRAINT "QualityRelease_tenantId_siteId_workOrderId_inspectionId_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId", "inspectionId") REFERENCES "Inspection"("tenantId", "siteId", "workOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "GarmentSerial" ADD CONSTRAINT "GarmentSerial_tenantId_siteId_workOrderId_workOrderSizeId_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId", "workOrderSizeId") REFERENCES "WorkOrderSize"("tenantId", "siteId", "workOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "GarmentSerial" ADD CONSTRAINT "GarmentSerial_tenantId_siteId_workOrderSizeId_releaseId_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderSizeId", "releaseId") REFERENCES "QualityRelease"("tenantId", "siteId", "workOrderSizeId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "GarmentSerial" ADD CONSTRAINT "GarmentSerial_tenantId_siteId_workOrderSizeId_shipmentLine_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderSizeId", "shipmentLineId") REFERENCES "ShipmentLine"("tenantId", "siteId", "workOrderSizeId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PpeRegisterEntry" ADD CONSTRAINT "PpeRegisterEntry_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PpeRegisterEntry" ADD CONSTRAINT "PpeRegisterEntry_tenantId_styleId_fkey" FOREIGN KEY ("tenantId", "styleId") REFERENCES "Style"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PpeRegisterEntry" ADD CONSTRAINT "PpeRegisterEntry_tenantId_partyId_fkey" FOREIGN KEY ("tenantId", "partyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ShippingSettings" ADD CONSTRAINT "ShippingSettings_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ShippingSettings" ADD CONSTRAINT "ShippingSettings_tenantId_integrationAccountId_fkey" FOREIGN KEY ("tenantId", "integrationAccountId") REFERENCES "IntegrationAccount"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ShippingSettings" ADD CONSTRAINT "ShippingSettings_tenantId_companyId_siteId_labelPrinterId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId", "labelPrinterId") REFERENCES "Printer"("tenantId", "companyId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ShippingSettings" ADD CONSTRAINT "ShippingSettings_tenantId_companyId_siteId_documentPrinter_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId", "documentPrinterId") REFERENCES "Printer"("tenantId", "companyId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_tenantId_companyId_partyId_salesOrderId_fkey" FOREIGN KEY ("tenantId", "companyId", "partyId", "salesOrderId") REFERENCES "SalesOrder"("tenantId", "companyId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_tenantId_partyId_shipToAddressId_fkey" FOREIGN KEY ("tenantId", "partyId", "shipToAddressId") REFERENCES "PartyAddress"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_tenantId_integrationAccountId_fkey" FOREIGN KEY ("tenantId", "integrationAccountId") REFERENCES "IntegrationAccount"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ShipmentLine" ADD CONSTRAINT "ShipmentLine_tenantId_siteId_partyId_shipmentId_fkey" FOREIGN KEY ("tenantId", "siteId", "partyId", "shipmentId") REFERENCES "Shipment"("tenantId", "siteId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ShipmentLine" ADD CONSTRAINT "ShipmentLine_tenantId_siteId_shipmentId_parcelId_fkey" FOREIGN KEY ("tenantId", "siteId", "shipmentId", "parcelId") REFERENCES "Parcel"("tenantId", "siteId", "shipmentId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ShipmentLine" ADD CONSTRAINT "ShipmentLine_tenantId_siteId_workOrderId_workOrderSizeId_fkey" FOREIGN KEY ("tenantId", "siteId", "workOrderId", "workOrderSizeId") REFERENCES "WorkOrderSize"("tenantId", "siteId", "workOrderId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ShipmentLine" ADD CONSTRAINT "ShipmentLine_tenantId_partyId_salesOrderLineId_fkey" FOREIGN KEY ("tenantId", "partyId", "salesOrderLineId") REFERENCES "SalesOrderLine"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Parcel" ADD CONSTRAINT "Parcel_tenantId_siteId_partyId_shipmentId_fkey" FOREIGN KEY ("tenantId", "siteId", "partyId", "shipmentId") REFERENCES "Shipment"("tenantId", "siteId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Ddt" ADD CONSTRAINT "Ddt_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Ddt" ADD CONSTRAINT "Ddt_tenantId_siteId_partyId_shipmentId_fkey" FOREIGN KEY ("tenantId", "siteId", "partyId", "shipmentId") REFERENCES "Shipment"("tenantId", "siteId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Ddt" ADD CONSTRAINT "Ddt_tenantId_companyId_numberSeriesId_fkey" FOREIGN KEY ("tenantId", "companyId", "numberSeriesId") REFERENCES "NumberSeries"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DdtCancellation" ADD CONSTRAINT "DdtCancellation_tenantId_siteId_partyId_ddtId_fkey" FOREIGN KEY ("tenantId", "siteId", "partyId", "ddtId") REFERENCES "Ddt"("tenantId", "siteId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TrackingEvent" ADD CONSTRAINT "TrackingEvent_tenantId_siteId_partyId_shipmentId_fkey" FOREIGN KEY ("tenantId", "siteId", "partyId", "shipmentId") REFERENCES "Shipment"("tenantId", "siteId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TrackingEvent" ADD CONSTRAINT "TrackingEvent_tenantId_siteId_shipmentId_parcelId_fkey" FOREIGN KEY ("tenantId", "siteId", "shipmentId", "parcelId") REFERENCES "Parcel"("tenantId", "siteId", "shipmentId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

