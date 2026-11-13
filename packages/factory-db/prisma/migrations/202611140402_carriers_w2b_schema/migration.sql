-- CreateEnum
CREATE TYPE "FreightBilling" AS ENUM ('SENDER', 'COLLECT', 'THIRD_PARTY');

-- CreateEnum
CREATE TYPE "DutyPayer" AS ENUM ('SENDER', 'RECEIVER');

-- CreateEnum
CREATE TYPE "PrinterMode" AS ENUM ('DIRECT', 'RELAY', 'PDF');

-- CreateEnum
CREATE TYPE "PickupStatus" AS ENUM ('REQUESTED', 'CONFIRMED', 'FAILED', 'CANCELLED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "GeneratedDocumentKind" ADD VALUE 'PROFORMA';
ALTER TYPE "GeneratedDocumentKind" ADD VALUE 'MANIFEST';
ALTER TYPE "GeneratedDocumentKind" ADD VALUE 'SHIPPING_MARKS';
ALTER TYPE "GeneratedDocumentKind" ADD VALUE 'SHIPMENT_PACK';

-- AlterEnum
ALTER TYPE "NumberKind" ADD VALUE 'PROFORMA';

-- AlterTable
ALTER TABLE "Parcel" ADD COLUMN     "declaredValue" INTEGER,
ADD COLUMN     "insuredValue" INTEGER;

-- AlterTable
ALTER TABLE "Party" ADD COLUMN     "carrierAccountSecretId" UUID,
ADD COLUMN     "defaultCarrierService" TEXT,
ADD COLUMN     "freightBilling" "FreightBilling" NOT NULL DEFAULT 'SENDER';

-- AlterTable
ALTER TABLE "PrintJob" ADD COLUMN     "reprintOfId" UUID,
ADD COLUMN     "reprintReason" TEXT;

-- AlterTable
ALTER TABLE "Printer" ADD COLUMN     "mode" "PrinterMode" NOT NULL DEFAULT 'RELAY';

-- AlterTable
ALTER TABLE "Shipment" ADD COLUMN     "collectedByName" TEXT,
ADD COLUMN     "collectionSignatureFileId" UUID,
ADD COLUMN     "dutyPayer" "DutyPayer",
ADD COLUMN     "express" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "manifestId" UUID,
ADD COLUMN     "manualTrackingNumber" TEXT,
ADD COLUMN     "paperless" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "vehiclePlate" TEXT;

-- AlterTable
ALTER TABLE "ShippingSettings" ADD COLUMN     "insureAbove" INTEGER,
ADD COLUMN     "liveSetById" UUID,
ADD COLUMN     "liveSince" TIMESTAMPTZ(3),
ADD COLUMN     "testMode" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "CarrierAccount" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID,
    "carrierCode" TEXT NOT NULL,
    "accountNumberSecretId" UUID,
    "ownRatesOnly" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "CarrierAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PickupRequest" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "carrierCode" TEXT NOT NULL,
    "readyAt" TIMESTAMPTZ(3) NOT NULL,
    "parcels" INTEGER NOT NULL,
    "pallets" INTEGER NOT NULL,
    "address" JSONB NOT NULL,
    "repeatWeekdays" "IsoWeekday"[] DEFAULT ARRAY[]::"IsoWeekday"[],
    "status" "PickupStatus" NOT NULL DEFAULT 'REQUESTED',
    "providerReference" TEXT,
    "errorWords" TEXT,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "PickupRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DispatchManifest" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "carrierCode" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "closedAt" TIMESTAMPTZ(3),
    "closedById" UUID,
    "fileId" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "DispatchManifest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CarrierAccount_tenantId_companyId_carrierCode_idx" ON "CarrierAccount"("tenantId", "companyId", "carrierCode");

-- CreateIndex
CREATE UNIQUE INDEX "CarrierAccount_tenantId_accountNumberSecretId_key" ON "CarrierAccount"("tenantId", "accountNumberSecretId");

-- CreateIndex
CREATE INDEX "PickupRequest_tenantId_siteId_readyAt_idx" ON "PickupRequest"("tenantId", "siteId", "readyAt");

-- CreateIndex
CREATE UNIQUE INDEX "DispatchManifest_tenantId_siteId_carrierCode_day_key" ON "DispatchManifest"("tenantId", "siteId", "carrierCode", "day");

-- CreateIndex
CREATE UNIQUE INDEX "DispatchManifest_tenantId_siteId_id_key" ON "DispatchManifest"("tenantId", "siteId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Party_tenantId_carrierAccountSecretId_key" ON "Party"("tenantId", "carrierAccountSecretId");

-- CreateIndex
CREATE UNIQUE INDEX "PrintJob_tenantId_companyId_id_key" ON "PrintJob"("tenantId", "companyId", "id");

-- CreateIndex
CREATE INDEX "Shipment_tenantId_manifestId_idx" ON "Shipment"("tenantId", "manifestId");

-- AddForeignKey
ALTER TABLE "CarrierAccount" ADD CONSTRAINT "CarrierAccount_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CarrierAccount" ADD CONSTRAINT "CarrierAccount_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CarrierAccount" ADD CONSTRAINT "CarrierAccount_tenantId_accountNumberSecretId_fkey" FOREIGN KEY ("tenantId", "accountNumberSecretId") REFERENCES "SecretValue"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PickupRequest" ADD CONSTRAINT "PickupRequest_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DispatchManifest" ADD CONSTRAINT "DispatchManifest_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DispatchManifest" ADD CONSTRAINT "DispatchManifest_tenantId_fileId_fkey" FOREIGN KEY ("tenantId", "fileId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Party" ADD CONSTRAINT "Party_tenantId_carrierAccountSecretId_fkey" FOREIGN KEY ("tenantId", "carrierAccountSecretId") REFERENCES "SecretValue"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PrintJob" ADD CONSTRAINT "PrintJob_tenantId_companyId_reprintOfId_fkey" FOREIGN KEY ("tenantId", "companyId", "reprintOfId") REFERENCES "PrintJob"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_tenantId_collectionSignatureFileId_fkey" FOREIGN KEY ("tenantId", "collectionSignatureFileId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_tenantId_siteId_manifestId_fkey" FOREIGN KEY ("tenantId", "siteId", "manifestId") REFERENCES "DispatchManifest"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

