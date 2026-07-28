-- AX-IE.5 — dry-run plan handshake. Additive, nullable, no backfill.
-- planToken fingerprints the plan the operator approved; apply must present a
-- token that still matches, so a plan that shifted underneath is refused rather
-- than executed.
ALTER TABLE "ImportJob" ADD COLUMN IF NOT EXISTS "planToken" TEXT;
ALTER TABLE "ImportJob" ADD COLUMN IF NOT EXISTS "planComputedAt" TIMESTAMP(3);
ALTER TABLE "ImportJob" ADD COLUMN IF NOT EXISTS "planSummary" JSONB;
