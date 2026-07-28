-- AX2.0 — orphan tracking for Amazon ad entities.
--
-- Amazon answers a write for a deleted entity with entityNotFoundError. We had
-- nowhere to record that, so the rank engine regenerated the same dead write
-- every day: 662 dead-lettered AD_BID_UPDATE rows from exactly 23 AdTarget
-- rows, ~23/day since 2026-07-02.
--
-- orphanedAt marks "Amazon says this no longer exists"; it is cleared the
-- moment a write or read succeeds again, so a re-created entity self-heals.
-- Additive only — no data is modified by this migration.

ALTER TABLE "AdTarget"
  ADD COLUMN IF NOT EXISTS "orphanedAt"   TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "orphanReason" TEXT;

ALTER TABLE "AdGroup"
  ADD COLUMN IF NOT EXISTS "orphanedAt"   TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "orphanReason" TEXT;

-- Partial indexes: the interesting set is always the (small) orphaned one.
CREATE INDEX IF NOT EXISTS "AdTarget_orphanedAt_idx" ON "AdTarget" ("orphanedAt") WHERE "orphanedAt" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "AdGroup_orphanedAt_idx"  ON "AdGroup"  ("orphanedAt") WHERE "orphanedAt" IS NOT NULL;
