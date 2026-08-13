-- SQP.3 — how many upserted rows actually CHANGED a value.
-- Purely additive: one nullable column, nothing altered.
--
-- 🔴 IF NOT EXISTS is not decoration. This column was applied to production by hand before the
-- migration shipped, and the bare `ADD COLUMN` then failed on deploy with 42701 — which Prisma
-- escalates to P3009, blocking EVERY subsequent migration on the service, not just this one.
ALTER TABLE "SqpReportRequest" ADD COLUMN IF NOT EXISTS "rowsChanged" INTEGER;
