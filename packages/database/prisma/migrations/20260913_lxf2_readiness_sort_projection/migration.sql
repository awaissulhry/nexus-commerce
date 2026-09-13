-- LX.F2 · ruling R-LX-17 (LX.R finding P2-21) · 2026-09-13
--
-- A sortable projection of the resolved per-language title/description beside ReadinessIndex, so a
-- `title@<lang>` / `description@<lang>` catalogue sort is one SQL ORDER BY instead of re-reading every
-- filtered product (with its translations and its parent's) to order one page.
--
-- Additive, nullable, no backfill, no existing index touched. NULL means NOT COMPUTED and sorts last.
-- Rows gain their values the next time the readiness producer runs for that family — a write on the
-- family, or the nightly reconcile at 02:17 UTC (the same one-shot backfill that is already the R-LX-9
-- deploy prerequisite; no second command is needed).
--
-- 🔴 This folder is deliberately NOT `packages/database/prisma/migrations/`: an unapplied folder there is
-- applied by the next sibling's `migrate deploy` (PES.0 hub ruling #12).
--
-- APPLIED TO LOCAL ONLY on 2026-09-13 (current_database() asserted = nexus_development, port 55439,
-- GALE-JACKET Product.version 59). NOT applied to production: that is the Owner's word to give.

ALTER TABLE "ReadinessIndex" ADD COLUMN IF NOT EXISTS "sortTitle" TEXT;
ALTER TABLE "ReadinessIndex" ADD COLUMN IF NOT EXISTS "sortDescription" TEXT;

CREATE INDEX IF NOT EXISTS "ReadinessIndex_sortTitle_idx"
  ON "ReadinessIndex" ("workspaceId", "language", "sortTitle")
  WHERE "sortTitle" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "ReadinessIndex_sortDescription_idx"
  ON "ReadinessIndex" ("workspaceId", "language", "sortDescription")
  WHERE "sortDescription" IS NOT NULL;
