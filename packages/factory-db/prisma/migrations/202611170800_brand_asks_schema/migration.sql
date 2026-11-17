-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ApprovalKind" ADD VALUE 'FABRIC';
ALTER TYPE "ApprovalKind" ADD VALUE 'TRIM';
ALTER TYPE "ApprovalKind" ADD VALUE 'REPROMISE';
ALTER TYPE "ApprovalKind" ADD VALUE 'COUNTER_OFFER';

-- AlterEnum
ALTER TYPE "ApprovalTaskKind" ADD VALUE 'BRAND_OVERRIDE';

-- AlterEnum
ALTER TYPE "GateKind" ADD VALUE 'SIZE_SET';

-- AlterEnum
ALTER TYPE "OrderChangeRequestStatus" ADD VALUE 'COUNTERED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "SampleKind" ADD VALUE 'SIZE_SET';
ALTER TYPE "SampleKind" ADD VALUE 'TOP_OF_PRODUCTION';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "SwatchKind" ADD VALUE 'FABRIC';
ALTER TYPE "SwatchKind" ADD VALUE 'TRIM';

-- AlterTable
ALTER TABLE "ApprovalRequest" ADD COLUMN     "decidedForPartyById" UUID,
ADD COLUMN     "decidedForPartyReason" TEXT,
ADD COLUMN     "reverseReason" TEXT,
ADD COLUMN     "reversedAt" TIMESTAMPTZ(3),
ADD COLUMN     "reversedById" UUID;

-- AlterTable
ALTER TABLE "OrderChangeRequest" ADD COLUMN     "batchId" UUID,
ADD COLUMN     "counterApprovalId" UUID,
ADD COLUMN     "counterDate" DATE,
ADD COLUMN     "counterFee" INTEGER,
ADD COLUMN     "counterNote" TEXT,
ADD COLUMN     "counteredAt" TIMESTAMPTZ(3),
ADD COLUMN     "counteredById" UUID,
ADD COLUMN     "impact" JSONB,
ADD COLUMN     "sampleKind" "SampleKind",
ADD COLUMN     "sampleRoundId" UUID;

-- AlterTable
ALTER TABLE "OrderChangeRequestLine" ADD COLUMN     "colourwayId" UUID,
ADD COLUMN     "styleId" UUID;

-- CreateIndex
CREATE INDEX "OrderChangeRequest_tenantId_batchId_idx" ON "OrderChangeRequest"("tenantId", "batchId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderChangeRequest_tenantId_counterApprovalId_key" ON "OrderChangeRequest"("tenantId", "counterApprovalId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderChangeRequest_tenantId_sampleRoundId_key" ON "OrderChangeRequest"("tenantId", "sampleRoundId");

-- AddForeignKey
ALTER TABLE "ApprovalRequest" ADD CONSTRAINT "ApprovalRequest_tenantId_decidedForPartyById_fkey" FOREIGN KEY ("tenantId", "decidedForPartyById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ApprovalRequest" ADD CONSTRAINT "ApprovalRequest_tenantId_reversedById_fkey" FOREIGN KEY ("tenantId", "reversedById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OrderChangeRequest" ADD CONSTRAINT "OrderChangeRequest_tenantId_partyId_counterApprovalId_fkey" FOREIGN KEY ("tenantId", "partyId", "counterApprovalId") REFERENCES "ApprovalRequest"("tenantId", "partyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OrderChangeRequest" ADD CONSTRAINT "OrderChangeRequest_tenantId_counteredById_fkey" FOREIGN KEY ("tenantId", "counteredById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OrderChangeRequest" ADD CONSTRAINT "OrderChangeRequest_tenantId_sampleRoundId_fkey" FOREIGN KEY ("tenantId", "sampleRoundId") REFERENCES "SampleRound"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OrderChangeRequestLine" ADD CONSTRAINT "OrderChangeRequestLine_tenantId_styleId_colourwayId_fkey" FOREIGN KEY ("tenantId", "styleId", "colourwayId") REFERENCES "Colourway"("tenantId", "styleId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

