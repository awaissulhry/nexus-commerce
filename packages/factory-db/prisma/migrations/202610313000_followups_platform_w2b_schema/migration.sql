-- CreateEnum
CREATE TYPE "DeviceNetwork" AS ENUM ('WIFI', 'ETHERNET', 'CELLULAR', 'OTHER');

-- CreateEnum
CREATE TYPE "StyleGender" AS ENUM ('MEN', 'WOMEN', 'UNISEX');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "IntegrationProvider" ADD VALUE 'CLAMAV';
ALTER TYPE "IntegrationProvider" ADD VALUE 'ERROR_TRACKING';

-- DropForeignKey
ALTER TABLE "ExportJob" DROP CONSTRAINT "ExportJob_tenantId_viewId_fkey";

-- DropIndex
DROP INDEX "Suppression_tenantId_address_key";

-- AlterTable
ALTER TABLE "Device" ADD COLUMN     "inUseSince" TIMESTAMPTZ(3),
ADD COLUMN     "network" "DeviceNetwork";

-- AlterTable
ALTER TABLE "Role" ADD COLUMN     "requireMfaSince" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "SalesOrderLine" ADD COLUMN     "closedShortReasonCode" TEXT;

-- AlterTable
ALTER TABLE "SavedView" ADD COLUMN     "isPersonalDefault" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Style" ADD COLUMN     "copiedFromRevisionId" UUID,
ADD COLUMN     "copiedFromStyleId" UUID,
ADD COLUMN     "gender" "StyleGender";

-- AlterTable
ALTER TABLE "Suppression" ADD COLUMN     "liftReason" TEXT,
ADD COLUMN     "liftedAt" TIMESTAMPTZ(3),
ADD COLUMN     "liftedById" UUID;

-- AlterTable
ALTER TABLE "WorkCalendar" ADD COLUMN     "timeZone" TEXT;

-- CreateTable
CREATE TABLE "FirstLoadStep" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID NOT NULL,
    "step" TEXT NOT NULL,
    "jobId" UUID,
    "nothingToLoad" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,
    "doneAt" TIMESTAMPTZ(3) NOT NULL,
    "doneById" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "FirstLoadStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReportRun" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "userId" UUID NOT NULL,
    "reportKey" TEXT NOT NULL,
    "params" JSONB NOT NULL DEFAULT '{}',
    "at" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "ReportRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartyPriceListAssignment" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "partyId" UUID NOT NULL,
    "priceListId" UUID NOT NULL,
    "validFrom" DATE NOT NULL,
    "validTo" DATE,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "PartyPriceListAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FirstLoadStep_tenantId_jobId_idx" ON "FirstLoadStep"("tenantId", "jobId");

-- CreateIndex
CREATE UNIQUE INDEX "FirstLoadStep_tenantId_companyId_step_key" ON "FirstLoadStep"("tenantId", "companyId", "step");

-- CreateIndex
CREATE INDEX "ReportRun_tenantId_userId_reportKey_at_idx" ON "ReportRun"("tenantId", "userId", "reportKey", "at");

-- CreateIndex
CREATE INDEX "PartyPriceListAssignment_tenantId_priceListId_idx" ON "PartyPriceListAssignment"("tenantId", "priceListId");

-- CreateIndex
CREATE UNIQUE INDEX "PartyPriceListAssignment_tenantId_partyId_validFrom_key" ON "PartyPriceListAssignment"("tenantId", "partyId", "validFrom");

-- CreateIndex
CREATE UNIQUE INDEX "PartyPriceListAssignment_tenantId_partyId_validTo_key" ON "PartyPriceListAssignment"("tenantId", "partyId", "validTo");

-- CreateIndex
CREATE UNIQUE INDEX "Suppression_tenantId_address_liftedAt_key" ON "Suppression"("tenantId", "address", "liftedAt");

-- AddForeignKey
ALTER TABLE "FirstLoadStep" ADD CONSTRAINT "FirstLoadStep_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FirstLoadStep" ADD CONSTRAINT "FirstLoadStep_tenantId_jobId_fkey" FOREIGN KEY ("tenantId", "jobId") REFERENCES "ImportJob"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ReportRun" ADD CONSTRAINT "ReportRun_tenantId_userId_fkey" FOREIGN KEY ("tenantId", "userId") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PartyPriceListAssignment" ADD CONSTRAINT "PartyPriceListAssignment_tenantId_partyId_fkey" FOREIGN KEY ("tenantId", "partyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PartyPriceListAssignment" ADD CONSTRAINT "PartyPriceListAssignment_tenantId_priceListId_fkey" FOREIGN KEY ("tenantId", "priceListId") REFERENCES "PriceList"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Style" ADD CONSTRAINT "Style_tenantId_copiedFromStyleId_fkey" FOREIGN KEY ("tenantId", "copiedFromStyleId") REFERENCES "Style"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Style" ADD CONSTRAINT "Style_tenantId_copiedFromStyleId_copiedFromRevisionId_fkey" FOREIGN KEY ("tenantId", "copiedFromStyleId", "copiedFromRevisionId") REFERENCES "StyleRevision"("tenantId", "styleId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ExportJob" ADD CONSTRAINT "ExportJob_tenantId_viewId_fkey" FOREIGN KEY ("tenantId", "viewId") REFERENCES "SavedView"("tenantId", "id") ON DELETE SET NULL ON UPDATE RESTRICT;

