-- FP4: per-size / per-line human tag on a Work Order (additive, nullable).
ALTER TABLE "WorkOrder" ADD COLUMN "label" TEXT;
