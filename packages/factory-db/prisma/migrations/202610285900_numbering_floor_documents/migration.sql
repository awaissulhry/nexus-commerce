-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NumberKind" ADD VALUE 'INSPECTION';
ALTER TYPE "NumberKind" ADD VALUE 'RELEASE';

-- AlterTable
ALTER TABLE "Inspection" ADD COLUMN     "number" TEXT;

-- AlterTable
ALTER TABLE "QualityRelease" ADD COLUMN     "number" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Inspection_tenantId_number_key" ON "Inspection"("tenantId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "QualityRelease_tenantId_number_key" ON "QualityRelease"("tenantId", "number");

