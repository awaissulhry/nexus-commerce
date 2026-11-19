-- CreateEnum
CREATE TYPE "ShipmentOrigin" AS ENUM ('NEXUS', 'ELSEWHERE');

-- AlterTable
ALTER TABLE "Shipment" ADD COLUMN     "externalDdtDate" DATE,
ADD COLUMN     "externalDdtNumber" TEXT,
ADD COLUMN     "manualTrackingUrl" TEXT,
ADD COLUMN     "origin" "ShipmentOrigin" NOT NULL DEFAULT 'NEXUS';

-- CreateIndex
CREATE UNIQUE INDEX "Shipment_external_ddt_key" ON "Shipment"("tenantId", "companyId", "partyId", "externalDdtNumber", "externalDdtDate");

-- CreateIndex
CREATE INDEX "ShipmentLine_tenantId_salesOrderLineId_idx" ON "ShipmentLine"("tenantId", "salesOrderLineId");

