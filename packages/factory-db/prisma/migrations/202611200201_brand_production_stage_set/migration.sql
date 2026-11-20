-- CreateEnum
CREATE TYPE "StageSetReason" AS ENUM ('OUTAGE', 'FEW_PEOPLE', 'OUTSIDE', 'OTHER');

-- AlterTable
ALTER TABLE "BrandOrderProduction" ADD COLUMN     "stageSet" "BrandStage",
ADD COLUMN     "stageSetAt" TIMESTAMPTZ(3),
ADD COLUMN     "stageSetById" UUID,
ADD COLUMN     "stageSetNote" TEXT,
ADD COLUMN     "stageSetReason" "StageSetReason";

