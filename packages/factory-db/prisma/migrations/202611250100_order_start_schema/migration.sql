-- CreateEnum
CREATE TYPE "PortalDraftSizing" AS ENUM ('STANDARD', 'MADE_TO_MEASURE');

-- AlterTable
ALTER TABLE "PortalOrderRequest" ADD COLUMN     "styleIds" UUID[] DEFAULT ARRAY[]::UUID[],
ADD COLUMN     "subject" TEXT;

-- AlterTable
ALTER TABLE "PortalOrderRequestLine" ADD COLUMN     "choices" JSONB,
ADD COLUMN     "sizing" "PortalDraftSizing";

