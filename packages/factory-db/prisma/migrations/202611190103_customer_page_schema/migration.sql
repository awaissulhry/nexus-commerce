-- CreateEnum
CREATE TYPE "PortalDraftLineKind" AS ENUM ('CATALOGUE', 'DESCRIBED', 'MADE_TO_MEASURE');

-- CreateEnum
CREATE TYPE "PortalDraftMeasureBy" AS ENUM ('SIZE', 'SHEET', 'LATER');

-- CreateEnum
CREATE TYPE "PortalDraftPart" AS ENUM ('LOGOS', 'REFERENCES', 'PEOPLE');

-- CreateEnum
CREATE TYPE "OrderBrandPriceSource" AS ENUM ('PORTAL', 'CUSTOMER_PO', 'OFFICE');

-- AlterTable
ALTER TABLE "PortalOrderRequest" ADD COLUMN     "lastEditedAt" TIMESTAMPTZ(3),
ADD COLUMN     "lastEditedById" UUID,
ADD COLUMN     "laterParts" "PortalDraftPart"[] DEFAULT ARRAY[]::"PortalDraftPart"[];

-- AlterTable
ALTER TABLE "PortalOrderRequestLine" ADD COLUMN     "brandUnitPrice" DECIMAL(18,6),
ADD COLUMN     "byPerson" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "colourText" TEXT,
ADD COLUMN     "description" TEXT,
ADD COLUMN     "garmentType" TEXT,
ADD COLUMN     "kind" "PortalDraftLineKind" NOT NULL DEFAULT 'CATALOGUE',
ADD COLUMN     "quantity" INTEGER,
ALTER COLUMN "styleId" DROP NOT NULL,
ALTER COLUMN "colourwayId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "PortalSettings" ADD COLUMN     "factoryDesignerBackupId" UUID,
ADD COLUMN     "factoryDesignerId" UUID,
ADD COLUMN     "factoryDesignerSetAt" TIMESTAMPTZ(3),
ADD COLUMN     "mtmDraftsOn" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "StoredFile" ADD COLUMN     "priced" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "PortalOrderRequestPerson" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "partyId" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "lineId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "number" TEXT,
    "measureBy" "PortalDraftMeasureBy" NOT NULL,
    "size" TEXT,
    "measurementFileId" UUID,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "PortalOrderRequestPerson_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderBrandPrice" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "partyId" UUID NOT NULL,
    "salesOrderId" UUID NOT NULL,
    "salesOrderLineId" UUID,
    "unitPrice" DECIMAL(18,6),
    "netAmount" INTEGER,
    "currency" TEXT NOT NULL,
    "source" "OrderBrandPriceSource" NOT NULL,
    "sourceFileId" UUID,
    "note" TEXT,
    "enteredById" UUID,
    "enteredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderBrandPrice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PortalOrderRequestPerson_tenantId_requestId_idx" ON "PortalOrderRequestPerson"("tenantId", "requestId");

-- CreateIndex
CREATE UNIQUE INDEX "PortalOrderRequestPerson_tenantId_lineId_seq_key" ON "PortalOrderRequestPerson"("tenantId", "lineId", "seq");

-- CreateIndex
CREATE INDEX "OrderBrandPrice_tenantId_salesOrderId_idx" ON "OrderBrandPrice"("tenantId", "salesOrderId");

-- CreateIndex
CREATE INDEX "OrderBrandPrice_tenantId_partyId_idx" ON "OrderBrandPrice"("tenantId", "partyId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderBrandPrice_tenantId_salesOrderLineId_key" ON "OrderBrandPrice"("tenantId", "salesOrderLineId");

-- AddForeignKey
ALTER TABLE "PortalSettings" ADD CONSTRAINT "PortalSettings_tenantId_factoryDesignerId_fkey" FOREIGN KEY ("tenantId", "factoryDesignerId") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PortalSettings" ADD CONSTRAINT "PortalSettings_tenantId_factoryDesignerBackupId_fkey" FOREIGN KEY ("tenantId", "factoryDesignerBackupId") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PortalOrderRequestPerson" ADD CONSTRAINT "PortalOrderRequestPerson_tenantId_partyId_requestId_fkey" FOREIGN KEY ("tenantId", "partyId", "requestId") REFERENCES "PortalOrderRequest"("tenantId", "partyId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PortalOrderRequestPerson" ADD CONSTRAINT "PortalOrderRequestPerson_tenantId_partyId_lineId_fkey" FOREIGN KEY ("tenantId", "partyId", "lineId") REFERENCES "PortalOrderRequestLine"("tenantId", "partyId", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PortalOrderRequestPerson" ADD CONSTRAINT "PortalOrderRequestPerson_tenantId_measurementFileId_fkey" FOREIGN KEY ("tenantId", "measurementFileId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OrderBrandPrice" ADD CONSTRAINT "OrderBrandPrice_tenantId_companyId_partyId_salesOrderId_fkey" FOREIGN KEY ("tenantId", "companyId", "partyId", "salesOrderId") REFERENCES "SalesOrder"("tenantId", "companyId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OrderBrandPrice" ADD CONSTRAINT "OrderBrandPrice_tenantId_partyId_salesOrderLineId_fkey" FOREIGN KEY ("tenantId", "partyId", "salesOrderLineId") REFERENCES "SalesOrderLine"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OrderBrandPrice" ADD CONSTRAINT "OrderBrandPrice_tenantId_sourceFileId_fkey" FOREIGN KEY ("tenantId", "sourceFileId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

