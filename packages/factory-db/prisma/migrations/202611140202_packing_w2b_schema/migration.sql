-- CreateEnum
CREATE TYPE "PackagingKind" AS ENUM ('CARTON', 'PALLET', 'POLYBAG', 'HANGER', 'BOX');

-- CreateEnum
CREATE TYPE "PalletKind" AS ENUM ('EUR', 'OTHER');

-- CreateEnum
CREATE TYPE "ShippingMarkField" AS ENUM ('SHIP_TO', 'SENDER', 'CUSTOMER_ORDER', 'ORDER_NUMBER', 'SHIPMENT_NUMBER', 'STYLE', 'CUSTOMER_STYLE', 'COLOUR', 'SIZES', 'QUANTITY', 'CARTON_NUMBER', 'GROSS_WEIGHT', 'NET_WEIGHT', 'DIMENSIONS', 'BATCH', 'ORIGIN');

-- CreateEnum
CREATE TYPE "ShipmentHoldReason" AS ENUM ('CREDIT', 'DEPOSIT', 'BALANCE_UNPAID', 'QUALITY', 'CUSTOMER_REQUEST', 'OTHER');

-- CreateEnum
CREATE TYPE "IsoWeekday" AS ENUM ('MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY');

-- AlterTable
ALTER TABLE "GarmentSerial" ADD COLUMN     "packedAt" TIMESTAMPTZ(3),
ADD COLUMN     "packedById" UUID,
ADD COLUMN     "parcelId" UUID;

-- AlterTable
ALTER TABLE "Parcel" ADD COLUMN     "cartonCount" INTEGER,
ADD COLUMN     "cartonNumber" INTEGER,
ADD COLUMN     "marksPrintedAt" TIMESTAMPTZ(3),
ADD COLUMN     "packagingTypeId" UUID;

-- AlterTable
ALTER TABLE "Shipment" ADD COLUMN     "splitFromId" UUID,
ADD COLUMN     "splitReason" TEXT;

-- CreateTable
CREATE TABLE "PackagingType" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "kind" "PackagingKind" NOT NULL,
    "name" TEXT NOT NULL,
    "innerLengthCm" DECIMAL(10,2),
    "innerWidthCm" DECIMAL(10,2),
    "innerHeightCm" DECIMAL(10,2),
    "tareKg" DECIMAL(18,4),
    "maxWeightKg" DECIMAL(18,4),
    "palletKind" "PalletKind",
    "costPerUnit" DECIMAL(18,6),
    "costCurrency" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "PackagingType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PackagingDefault" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "packagingTypeId" UUID NOT NULL,
    "kind" "PackagingKind" NOT NULL,
    "styleId" UUID,
    "sizeScaleId" UUID,
    "fromSize" TEXT,
    "toSize" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "PackagingDefault_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ParcelLine" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "shipmentId" UUID NOT NULL,
    "parcelId" UUID NOT NULL,
    "shipmentLineId" UUID NOT NULL,
    "size" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "ParcelLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShippingMarkTemplate" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "partyId" UUID,
    "fields" "ShippingMarkField"[],
    "language" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "ShippingMarkTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShipmentHold" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "shipmentId" UUID NOT NULL,
    "reason" "ShipmentHoldReason" NOT NULL,
    "words" TEXT,
    "placedAt" TIMESTAMPTZ(3) NOT NULL,
    "placedById" UUID,
    "releasedAt" TIMESTAMPTZ(3),
    "releasedById" UUID,
    "releaseWords" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "ShipmentHold_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CarrierCutOff" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "carrierCode" TEXT NOT NULL,
    "weekday" "IsoWeekday" NOT NULL,
    "cutOffTime" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "CarrierCutOff_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PackagingType_tenantId_companyId_name_key" ON "PackagingType"("tenantId", "companyId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "PackagingType_tenantId_companyId_kind_id_key" ON "PackagingType"("tenantId", "companyId", "kind", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PackagingType_tenantId_id_key" ON "PackagingType"("tenantId", "id");

-- CreateIndex
CREATE INDEX "PackagingDefault_tenantId_companyId_styleId_idx" ON "PackagingDefault"("tenantId", "companyId", "styleId");

-- CreateIndex
CREATE INDEX "ParcelLine_tenantId_parcelId_idx" ON "ParcelLine"("tenantId", "parcelId");

-- CreateIndex
CREATE INDEX "ParcelLine_tenantId_shipmentLineId_idx" ON "ParcelLine"("tenantId", "shipmentLineId");

-- CreateIndex
CREATE INDEX "ShippingMarkTemplate_tenantId_companyId_partyId_idx" ON "ShippingMarkTemplate"("tenantId", "companyId", "partyId");

-- CreateIndex
CREATE INDEX "ShipmentHold_tenantId_shipmentId_releasedAt_idx" ON "ShipmentHold"("tenantId", "shipmentId", "releasedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CarrierCutOff_tenantId_siteId_carrierCode_weekday_key" ON "CarrierCutOff"("tenantId", "siteId", "carrierCode", "weekday");

-- CreateIndex
CREATE INDEX "GarmentSerial_tenantId_parcelId_idx" ON "GarmentSerial"("tenantId", "parcelId");

-- CreateIndex
CREATE UNIQUE INDEX "Parcel_tenantId_siteId_id_key" ON "Parcel"("tenantId", "siteId", "id");

-- CreateIndex
CREATE INDEX "Shipment_tenantId_splitFromId_idx" ON "Shipment"("tenantId", "splitFromId");

-- CreateIndex
CREATE UNIQUE INDEX "ShipmentLine_tenantId_siteId_shipmentId_id_key" ON "ShipmentLine"("tenantId", "siteId", "shipmentId", "id");

-- AddForeignKey
ALTER TABLE "PackagingType" ADD CONSTRAINT "PackagingType_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PackagingDefault" ADD CONSTRAINT "PackagingDefault_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PackagingDefault" ADD CONSTRAINT "PackagingDefault_tenantId_companyId_kind_packagingTypeId_fkey" FOREIGN KEY ("tenantId", "companyId", "kind", "packagingTypeId") REFERENCES "PackagingType"("tenantId", "companyId", "kind", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PackagingDefault" ADD CONSTRAINT "PackagingDefault_tenantId_styleId_fkey" FOREIGN KEY ("tenantId", "styleId") REFERENCES "Style"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PackagingDefault" ADD CONSTRAINT "PackagingDefault_tenantId_sizeScaleId_fkey" FOREIGN KEY ("tenantId", "sizeScaleId") REFERENCES "SizeScale"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ParcelLine" ADD CONSTRAINT "ParcelLine_tenantId_siteId_partyId_shipmentId_fkey" FOREIGN KEY ("tenantId", "siteId", "partyId", "shipmentId") REFERENCES "Shipment"("tenantId", "siteId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ParcelLine" ADD CONSTRAINT "ParcelLine_tenantId_siteId_shipmentId_parcelId_fkey" FOREIGN KEY ("tenantId", "siteId", "shipmentId", "parcelId") REFERENCES "Parcel"("tenantId", "siteId", "shipmentId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ParcelLine" ADD CONSTRAINT "ParcelLine_tenantId_siteId_shipmentId_shipmentLineId_fkey" FOREIGN KEY ("tenantId", "siteId", "shipmentId", "shipmentLineId") REFERENCES "ShipmentLine"("tenantId", "siteId", "shipmentId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ShippingMarkTemplate" ADD CONSTRAINT "ShippingMarkTemplate_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ShippingMarkTemplate" ADD CONSTRAINT "ShippingMarkTemplate_tenantId_partyId_fkey" FOREIGN KEY ("tenantId", "partyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ShipmentHold" ADD CONSTRAINT "ShipmentHold_tenantId_siteId_partyId_shipmentId_fkey" FOREIGN KEY ("tenantId", "siteId", "partyId", "shipmentId") REFERENCES "Shipment"("tenantId", "siteId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CarrierCutOff" ADD CONSTRAINT "CarrierCutOff_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "GarmentSerial" ADD CONSTRAINT "GarmentSerial_tenantId_siteId_parcelId_fkey" FOREIGN KEY ("tenantId", "siteId", "parcelId") REFERENCES "Parcel"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_tenantId_siteId_partyId_splitFromId_fkey" FOREIGN KEY ("tenantId", "siteId", "partyId", "splitFromId") REFERENCES "Shipment"("tenantId", "siteId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Parcel" ADD CONSTRAINT "Parcel_tenantId_packagingTypeId_fkey" FOREIGN KEY ("tenantId", "packagingTypeId") REFERENCES "PackagingType"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

