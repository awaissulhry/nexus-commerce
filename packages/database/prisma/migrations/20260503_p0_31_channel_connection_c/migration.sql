-- Final P0 #31 follow-up: ensure VariantChannelListing has every
-- column its schema describes.
--
-- Why this exists: the original Rithum-architecture migration
-- (20260423004054) created VariantChannelListing without
-- syncRetryCount / lastSyncError / createdAt / updatedAt. A later
-- migration (20260424_add_missing_schema_columns) tried to recreate
-- the table with `CREATE TABLE IF NOT EXISTS`, but because the table
-- already existed, the entire statement was a no-op and those four
-- columns were silently never added. The drift gate doesn't catch
-- column-level drift, and Prisma's default findMany selects every
-- schema-declared column, so the listings handler 500s on the first
-- missing column it encounters. Each round of verification has
-- exposed a different one (channel → syncRetryCount → ...).
--
-- This migration belt-and-braces every remaining schema column with
-- ADD COLUMN IF NOT EXISTS so the table is fully consistent with
-- schema.prisma after this point.

ALTER TABLE "VariantChannelListing"
  ADD COLUMN IF NOT EXISTS "syncRetryCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "lastSyncError"  TEXT,
  ADD COLUMN IF NOT EXISTS "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN IF NOT EXISTS "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
