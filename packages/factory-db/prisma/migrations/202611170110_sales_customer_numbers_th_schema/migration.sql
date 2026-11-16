-- AlterTable
ALTER TABLE "Inquiry" ADD COLUMN     "customerSeq" INTEGER;

-- AlterTable
ALTER TABLE "Quote" ADD COLUMN     "customerSeq" INTEGER;

-- AlterTable
ALTER TABLE "SalesOrder" ADD COLUMN     "customerSeq" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "Inquiry_tenantId_companyId_partyId_customerSeq_key" ON "Inquiry"("tenantId", "companyId", "partyId", "customerSeq");

-- CreateIndex
CREATE UNIQUE INDEX "Quote_tenantId_companyId_partyId_customerSeq_key" ON "Quote"("tenantId", "companyId", "partyId", "customerSeq");

-- CreateIndex
CREATE UNIQUE INDEX "SalesOrder_tenantId_companyId_partyId_customerSeq_key" ON "SalesOrder"("tenantId", "companyId", "partyId", "customerSeq");

