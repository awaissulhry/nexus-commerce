-- FP6: link a Work Order to the order line it produces (BOM reservation demand),
-- and add a pause marker for clean stage Start/Pause/Resume/Finish timing.
ALTER TABLE "WorkOrder" ADD COLUMN "orderLineId" TEXT;
ALTER TABLE "WorkOrderStage" ADD COLUMN "pausedAt" DATETIME;
