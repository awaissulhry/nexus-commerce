-- CreateEnum
CREATE TYPE "TrackingExceptionKind" AS ENUM ('DELAYED', 'ADDRESS_PROBLEM', 'FAILED_DELIVERY', 'NO_SCAN');

-- CreateEnum
CREATE TYPE "ReturnLabelStatus" AS ENUM ('OFFERED', 'BOOKED', 'USED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CustomsDeclarationStatus" AS ENUM ('PACK_SENT', 'FILED', 'EXITED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "GeneratedDocumentKind" ADD VALUE 'COMMERCIAL_INVOICE';
ALTER TYPE "GeneratedDocumentKind" ADD VALUE 'CN22';
ALTER TYPE "GeneratedDocumentKind" ADD VALUE 'CN23';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "LinkPurpose" ADD VALUE 'BROKER_PACK';
ALTER TYPE "LinkPurpose" ADD VALUE 'RETURN_LABEL';

-- AlterEnum
ALTER TYPE "SalesOrderStatus" ADD VALUE 'DELIVERED';

-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "eori" TEXT;

-- AlterTable
ALTER TABLE "SalesOrder" ADD COLUMN     "deliveredAt" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "Shipment" ADD COLUMN     "podAt" TIMESTAMPTZ(3),
ADD COLUMN     "podFileId" UUID,
ADD COLUMN     "podSignedBy" TEXT;

-- AlterTable
ALTER TABLE "ShippingSettings" ADD COLUMN     "brokerPackOn" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "customerNoticeOn" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "TrackingException" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "siteId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "shipmentId" UUID NOT NULL,
    "kind" "TrackingExceptionKind" NOT NULL,
    "raisedAt" TIMESTAMPTZ(3) NOT NULL,
    "taskId" UUID,
    "resolvedAt" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "TrackingException_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReturnLabel" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "returnId" UUID NOT NULL,
    "carrierCode" TEXT NOT NULL,
    "status" "ReturnLabelStatus" NOT NULL,
    "bookingReference" TEXT,
    "labelFileId" UUID,
    "linkId" UUID,
    "usedAt" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "ReturnLabel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomsDeclaration" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "shipmentId" UUID NOT NULL,
    "invoiceId" UUID,
    "brokerPartyId" UUID,
    "status" "CustomsDeclarationStatus" NOT NULL DEFAULT 'PACK_SENT',
    "mrn" TEXT,
    "exitConfirmedAt" TIMESTAMPTZ(3),
    "exitFileId" UUID,
    "alertAfterDays" INTEGER NOT NULL DEFAULT 30,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "CustomsDeclaration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TrackingException_tenantId_shipmentId_kind_idx" ON "TrackingException"("tenantId", "shipmentId", "kind");

-- CreateIndex
CREATE INDEX "TrackingException_tenantId_resolvedAt_idx" ON "TrackingException"("tenantId", "resolvedAt");

-- CreateIndex
CREATE INDEX "ReturnLabel_tenantId_returnId_idx" ON "ReturnLabel"("tenantId", "returnId");

-- CreateIndex
CREATE INDEX "ReturnLabel_tenantId_status_idx" ON "ReturnLabel"("tenantId", "status");

-- CreateIndex
CREATE INDEX "CustomsDeclaration_tenantId_shipmentId_idx" ON "CustomsDeclaration"("tenantId", "shipmentId");

-- CreateIndex
CREATE INDEX "CustomsDeclaration_tenantId_status_idx" ON "CustomsDeclaration"("tenantId", "status");

-- CreateIndex
CREATE INDEX "CustomsDeclaration_tenantId_invoiceId_idx" ON "CustomsDeclaration"("tenantId", "invoiceId");

-- AddForeignKey
ALTER TABLE "TrackingException" ADD CONSTRAINT "TrackingException_tenantId_siteId_partyId_shipmentId_fkey" FOREIGN KEY ("tenantId", "siteId", "partyId", "shipmentId") REFERENCES "Shipment"("tenantId", "siteId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ReturnLabel" ADD CONSTRAINT "ReturnLabel_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ReturnLabel" ADD CONSTRAINT "ReturnLabel_tenantId_siteId_partyId_returnId_fkey" FOREIGN KEY ("tenantId", "siteId", "partyId", "returnId") REFERENCES "ReturnAuthorisation"("tenantId", "siteId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ReturnLabel" ADD CONSTRAINT "ReturnLabel_tenantId_labelFileId_fkey" FOREIGN KEY ("tenantId", "labelFileId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ReturnLabel" ADD CONSTRAINT "ReturnLabel_tenantId_partyId_linkId_fkey" FOREIGN KEY ("tenantId", "partyId", "linkId") REFERENCES "OneOffLink"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CustomsDeclaration" ADD CONSTRAINT "CustomsDeclaration_tenantId_companyId_siteId_fkey" FOREIGN KEY ("tenantId", "companyId", "siteId") REFERENCES "Site"("tenantId", "companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CustomsDeclaration" ADD CONSTRAINT "CustomsDeclaration_tenantId_siteId_partyId_shipmentId_fkey" FOREIGN KEY ("tenantId", "siteId", "partyId", "shipmentId") REFERENCES "Shipment"("tenantId", "siteId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CustomsDeclaration" ADD CONSTRAINT "CustomsDeclaration_tenantId_companyId_partyId_invoiceId_fkey" FOREIGN KEY ("tenantId", "companyId", "partyId", "invoiceId") REFERENCES "Invoice"("tenantId", "companyId", "buyerPartyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CustomsDeclaration" ADD CONSTRAINT "CustomsDeclaration_tenantId_brokerPartyId_fkey" FOREIGN KEY ("tenantId", "brokerPartyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CustomsDeclaration" ADD CONSTRAINT "CustomsDeclaration_tenantId_exitFileId_fkey" FOREIGN KEY ("tenantId", "exitFileId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_tenantId_podFileId_fkey" FOREIGN KEY ("tenantId", "podFileId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

