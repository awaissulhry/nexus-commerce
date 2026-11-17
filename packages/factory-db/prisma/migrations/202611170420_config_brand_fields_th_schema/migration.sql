-- AlterTable
ALTER TABLE "CustomField" ADD COLUMN     "partyId" UUID;

-- CreateIndex
CREATE INDEX "CustomField_tenantId_partyId_idx" ON "CustomField"("tenantId", "partyId");

-- AddForeignKey
ALTER TABLE "CustomField" ADD CONSTRAINT "CustomField_tenantId_partyId_fkey" FOREIGN KEY ("tenantId", "partyId") REFERENCES "Party"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

