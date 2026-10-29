-- CreateEnum
CREATE TYPE "PurchaseProposalDecision" AS ENUM ('ACCEPTED', 'REFUSED');

-- AlterEnum
ALTER TYPE "PurchaseOrderStatus" ADD VALUE 'CHANGES_PROPOSED';

-- AlterTable
ALTER TABLE "PurchaseOrder" ADD COLUMN     "proposalDecidedAt" TIMESTAMPTZ(3),
ADD COLUMN     "proposalDecidedById" UUID,
ADD COLUMN     "proposalDecision" "PurchaseProposalDecision",
ADD COLUMN     "proposalDecisionNote" TEXT,
ADD COLUMN     "proposalLinkId" UUID,
ADD COLUMN     "proposalNote" TEXT,
ADD COLUMN     "proposalSupplierRef" TEXT,
ADD COLUMN     "proposedAt" TIMESTAMPTZ(3),
ADD COLUMN     "proposedByName" TEXT;

-- AlterTable
ALTER TABLE "PurchaseOrderLine" ADD COLUMN     "proposalReason" TEXT,
ADD COLUMN     "proposedDate" DATE,
ADD COLUMN     "proposedQuantity" DECIMAL(18,4),
ADD COLUMN     "proposedSplitDate" DATE,
ADD COLUMN     "proposedSplitQuantity" DECIMAL(18,4);

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_tenantId_partyId_proposalLinkId_fkey" FOREIGN KEY ("tenantId", "partyId", "proposalLinkId") REFERENCES "OneOffLink"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

