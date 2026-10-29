-- CreateEnum
CREATE TYPE "InspectionResult" AS ENUM ('PASS', 'FAIL');

-- CreateEnum
CREATE TYPE "ReleaseSecondPersonReason" AS ENUM ('OVERRIDE', 'CUSTOMER', 'ALWAYS');

-- CreateEnum
CREATE TYPE "ReleaseReversalReason" AS ENUM ('WRONG_RESULT', 'DEFECT_FOUND_LATER', 'CERTIFICATE_PROBLEM', 'CUSTOMER_COMPLAINT', 'RECALL');

-- CreateEnum
CREATE TYPE "ReleaseFourEyesRule" AS ENUM ('WHEN_REQUIRED', 'ALWAYS');

-- AlterTable
ALTER TABLE "Inspection" ADD COLUMN     "computedResult" "InspectionResult",
ADD COLUMN     "overrideReason" TEXT;

-- AlterTable
ALTER TABLE "QualityRelease" ADD COLUMN     "releasedByWorkerId" UUID,
ADD COLUMN     "secondPersonReasons" "ReleaseSecondPersonReason"[] DEFAULT ARRAY[]::"ReleaseSecondPersonReason"[],
ALTER COLUMN "releasedById" DROP NOT NULL;

-- AlterTable
ALTER TABLE "QualityReleaseReversal" ADD COLUMN     "reasonCode" "ReleaseReversalReason",
ADD COLUMN     "serialsTo" "GarmentSerialStatus";

-- AlterTable
ALTER TABLE "QualitySettings" ADD COLUMN     "releaseFourEyes" "ReleaseFourEyesRule",
ADD COLUMN     "secondPersonPartyIds" UUID[] DEFAULT ARRAY[]::UUID[];

-- AddForeignKey
ALTER TABLE "QualityRelease" ADD CONSTRAINT "QualityRelease_tenantId_siteId_releasedByWorkerId_fkey" FOREIGN KEY ("tenantId", "siteId", "releasedByWorkerId") REFERENCES "Worker"("tenantId", "siteId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

