-- SQP.3 — how many upserted rows actually CHANGED a value.
-- Purely additive: one nullable column, nothing altered.
ALTER TABLE "SqpReportRequest" ADD COLUMN "rowsChanged" INTEGER;
