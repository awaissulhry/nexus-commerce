-- DropForeignKey
ALTER TABLE "ScheduleChange" DROP CONSTRAINT "ScheduleChange_tenantId_siteId_workOrderId_workOrderOperat_fkey";

-- AlterTable
ALTER TABLE "ScheduleChange" ADD COLUMN     "operationName" TEXT,
ADD COLUMN     "operationSeq" INTEGER;

