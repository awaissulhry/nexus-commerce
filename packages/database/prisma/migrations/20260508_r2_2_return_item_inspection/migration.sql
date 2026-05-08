-- R2.2 — ReturnItem inspection artifacts.
--
-- Two columns:
--
--   photoUrls           — Cloudinary secure URLs the operator
--                         uploaded during the inspect step (mirror
--                         of the H.7 inbound pattern). Defaults
--                         to '{}' so existing rows are array-safe;
--                         no backfill needed.
--
--   inspectionChecklist — JSON blob holding the structured
--                         inspection answers (packagingPresent,
--                         tagsIntact, visibleDamage + damageNotes,
--                         functionalTestPassed, signsOfUse).
--                         JSONB so we can iterate the checklist
--                         shape without a migration.
--
-- Both adds are idempotent.

ALTER TABLE "ReturnItem"
  ADD COLUMN IF NOT EXISTS "photoUrls" TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE "ReturnItem"
  ADD COLUMN IF NOT EXISTS "inspectionChecklist" JSONB;
