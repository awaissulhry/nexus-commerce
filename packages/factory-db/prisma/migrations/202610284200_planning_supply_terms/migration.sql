-- AlterTable
ALTER TABLE "Item" ADD COLUMN     "leadTimeDays" INTEGER,
ADD COLUMN     "minOrderQty" DECIMAL(18,4),
ADD COLUMN     "orderMultiple" DECIMAL(18,4);

-- AlterTable
ALTER TABLE "Party" ADD COLUMN     "leadTimeDays" INTEGER;

-- AlterTable
ALTER TABLE "PlanningRun" ADD COLUMN     "warnings" JSONB NOT NULL DEFAULT '[]';

