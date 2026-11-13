-- CreateEnum
CREATE TYPE "OptionGroupTakes" AS ENUM ('COLOUR', 'MATERIAL');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ApprovalTaskKind" ADD VALUE 'PURCHASE_ORDER_COMPLIANCE';
ALTER TYPE "ApprovalTaskKind" ADD VALUE 'RECEIPT_OVER_TOLERANCE';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "FileCategory" ADD VALUE 'MTM_PHOTO';
ALTER TYPE "FileCategory" ADD VALUE 'FITTING_PHOTO';

-- AlterEnum
ALTER TYPE "GeneratedDocumentKind" ADD VALUE 'PRICE_LIST';

-- AlterEnum
ALTER TYPE "PurchaseReminderKind" ADD VALUE 'CHASE';

-- AlterEnum
ALTER TYPE "ReasonList" ADD VALUE 'SUPPLIER_DOCUMENT_TYPE';

-- AlterEnum
ALTER TYPE "ReturnOutcomeWanted" ADD VALUE 'REMAKE';

-- AlterTable
ALTER TABLE "GoodsReceiptLine" ADD COLUMN     "heldForApprovalAt" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "OptionGroup" ADD COLUMN     "takes" "OptionGroupTakes";

-- AlterTable
ALTER TABLE "PurchasingSettings" ADD COLUMN     "confirmByHours" INTEGER,
ADD COLUMN     "reminderCadenceDays" INTEGER;

-- AlterTable
ALTER TABLE "ReasonCode" ADD COLUMN     "group" TEXT;

-- AlterTable
ALTER TABLE "SalesOrderLine" ADD COLUMN     "feeCreditOrderId" UUID,
ADD COLUMN     "feeCreditedAt" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "StoredFile" ADD COLUMN     "deleteAfter" TIMESTAMPTZ(3),
ADD COLUMN     "documentTypeCode" TEXT;

-- CreateIndex
CREATE INDEX "SalesOrderLine_tenantId_feeCreditOrderId_idx" ON "SalesOrderLine"("tenantId", "feeCreditOrderId");

-- CreateIndex
CREATE INDEX "StoredFile_tenantId_deleteAfter_idx" ON "StoredFile"("tenantId", "deleteAfter");

-- AddForeignKey
ALTER TABLE "SalesOrderLine" ADD CONSTRAINT "SalesOrderLine_tenantId_companyId_partyId_feeCreditOrderId_fkey" FOREIGN KEY ("tenantId", "companyId", "partyId", "feeCreditOrderId") REFERENCES "SalesOrder"("tenantId", "companyId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

