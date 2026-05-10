-- AET.1 (list-wizard) — operator acceptance telemetry.
--
-- Adds three counter columns to PromptTemplate so the matcher's
-- A/B observability isn't just call volume but also whether the
-- variant's output gets edited or accepted as-is.
--
-- Idempotent: IF NOT EXISTS guards so a re-apply on a partially-
-- migrated env is safe.

ALTER TABLE "PromptTemplate"
  ADD COLUMN IF NOT EXISTS "acceptedCount"  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "editedCount"    INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "totalEditChars" INTEGER NOT NULL DEFAULT 0;
