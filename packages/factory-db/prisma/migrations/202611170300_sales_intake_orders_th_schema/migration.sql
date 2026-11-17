-- AlterEnum
ALTER TYPE "InquiryDeclineReason" ADD VALUE 'NOT_AN_ORDER';

-- AlterEnum
ALTER TYPE "InquiryStatus" ADD VALUE 'ORDERED';

-- AlterTable
ALTER TABLE "Inquiry" ADD COLUMN     "salesOrderId" UUID,
ADD COLUMN     "styleIds" UUID[] DEFAULT ARRAY[]::UUID[];

-- AddForeignKey
ALTER TABLE "Inquiry" ADD CONSTRAINT "Inquiry_tenantId_companyId_partyId_salesOrderId_fkey" FOREIGN KEY ("tenantId", "companyId", "partyId", "salesOrderId") REFERENCES "SalesOrder"("tenantId", "companyId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

