-- ADX N2 — the intensity dial.
-- Additive, and backfilled from the existing binary so behaviour is identical on ship:
-- a dry-run rule proposes (what it does today), a live rule acts (what it does today).
ALTER TABLE "AutomationRule" ADD COLUMN "autonomyLevel" TEXT NOT NULL DEFAULT 'PROPOSE';

UPDATE "AutomationRule" SET "autonomyLevel" = CASE
  WHEN "dryRun" THEN 'PROPOSE'
  ELSE 'AUTO'
END;
