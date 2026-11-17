-- AlterTable
ALTER TABLE "Inquiry" ADD COLUMN     "customerRef" TEXT,
ADD COLUMN     "shipToAddressId" UUID;

-- AlterTable
ALTER TABLE "InquiryLine" ADD COLUMN     "partyId" UUID,
ADD COLUMN     "unitPriceShown" DECIMAL(18,6);

-- CreateIndex
CREATE INDEX "InquiryLine_tenantId_partyId_idx" ON "InquiryLine"("tenantId", "partyId");

-- AddForeignKey
ALTER TABLE "Inquiry" ADD CONSTRAINT "Inquiry_tenantId_partyId_shipToAddressId_fkey" FOREIGN KEY ("tenantId", "partyId", "shipToAddressId") REFERENCES "PartyAddress"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

