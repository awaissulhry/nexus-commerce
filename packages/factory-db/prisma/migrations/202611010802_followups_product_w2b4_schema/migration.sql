-- CreateEnum
CREATE TYPE "PpeTextTemplateKind" AS ENUM ('DOC', 'USER_INFORMATION', 'LABEL_WARNING');

-- AlterTable
ALTER TABLE "InspectionMeasurement" ADD COLUMN     "toleranceMinus" DECIMAL(12,3),
ADD COLUMN     "tolerancePlus" DECIMAL(12,3);

-- AlterTable
ALTER TABLE "LabResult" ADD COLUMN     "costAmount" INTEGER,
ADD COLUMN     "costCurrency" TEXT;

-- AlterTable
ALTER TABLE "ProductSettings" ADD COLUMN     "updatedById" UUID;

-- AlterTable
ALTER TABLE "ProductTypeProfile" ADD COLUMN     "updatedById" UUID;

-- AlterTable
ALTER TABLE "Style" ADD COLUMN     "marketCodes" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "WorkOrderSize" ALTER COLUMN "salesOrderLineId" DROP NOT NULL,
ALTER COLUMN "partyId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "PpeTextApproval" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT (NULLIF(current_setting('factory.tenant_id'::text, true), ''::text))::uuid,
    "companyId" UUID,
    "templateKind" "PpeTextTemplateKind" NOT NULL,
    "templateKey" TEXT NOT NULL,
    "templateVersion" INTEGER NOT NULL,
    "languages" TEXT[],
    "checkedBy" TEXT NOT NULL,
    "recordedById" UUID NOT NULL,
    "recordedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "evidenceFileId" UUID NOT NULL,
    "withdrawnAt" TIMESTAMPTZ(3),
    "withdrawnById" UUID,
    "withdrawReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "PpeTextApproval_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PpeTextApproval_tenantId_templateKind_templateKey_templateV_idx" ON "PpeTextApproval"("tenantId", "templateKind", "templateKey", "templateVersion");

-- AddForeignKey
ALTER TABLE "PpeTextApproval" ADD CONSTRAINT "PpeTextApproval_tenantId_companyId_fkey" FOREIGN KEY ("tenantId", "companyId") REFERENCES "Company"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PpeTextApproval" ADD CONSTRAINT "PpeTextApproval_tenantId_evidenceFileId_fkey" FOREIGN KEY ("tenantId", "evidenceFileId") REFERENCES "StoredFile"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SampleMeasurement" ADD CONSTRAINT "SampleMeasurement_tenantId_pointOfMeasureId_fkey" FOREIGN KEY ("tenantId", "pointOfMeasureId") REFERENCES "PointOfMeasure"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SampleComment" ADD CONSTRAINT "SampleComment_tenantId_pointOfMeasureId_fkey" FOREIGN KEY ("tenantId", "pointOfMeasureId") REFERENCES "PointOfMeasure"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

