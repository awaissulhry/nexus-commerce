-- CreateEnum
CREATE TYPE "PpeRegisterRisk" AS ENUM ('NO', 'ASSESSING', 'YES');

-- AlterEnum
ALTER TYPE "NumberKind" ADD VALUE 'PPE_REGISTER';

-- AlterTable
ALTER TABLE "PpeRegisterEntry" ADD COLUMN     "actionCompletedAt" TIMESTAMPTZ(3),
ADD COLUMN     "authorityReference" TEXT,
ADD COLUMN     "closeReason" TEXT,
ADD COLUMN     "lotIds" UUID[] DEFAULT ARRAY[]::UUID[],
ADD COLUMN     "ownerId" UUID,
ADD COLUMN     "risk" "PpeRegisterRisk" NOT NULL DEFAULT 'ASSESSING',
ADD COLUMN     "shipmentIds" UUID[] DEFAULT ARRAY[]::UUID[],
ADD COLUMN     "sourceId" UUID,
ADD COLUMN     "sourceType" TEXT,
ADD COLUMN     "styleRevisionId" UUID,
ADD COLUMN     "workOrderIds" UUID[] DEFAULT ARRAY[]::UUID[];

-- CreateIndex
CREATE INDEX "PpeRegisterEntry_tenantId_status_risk_idx" ON "PpeRegisterEntry"("tenantId", "status", "risk");

-- AddForeignKey
ALTER TABLE "PpeRegisterEntry" ADD CONSTRAINT "PpeRegisterEntry_tenantId_styleId_styleRevisionId_fkey" FOREIGN KEY ("tenantId", "styleId", "styleRevisionId") REFERENCES "StyleRevision"("tenantId", "styleId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

