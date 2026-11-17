-- AlterTable
ALTER TABLE "SearchEntry" ADD COLUMN     "everyParty" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "WorkOrder" ADD COLUMN     "partyId" UUID;

-- CreateIndex
CREATE INDEX "WorkOrder_tenantId_partyId_status_idx" ON "WorkOrder"("tenantId", "partyId", "status");

-- AddForeignKey
ALTER TABLE "WorkOrder" ADD CONSTRAINT "WorkOrder_tenantId_partyId_fkey" FOREIGN KEY ("tenantId", "partyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

